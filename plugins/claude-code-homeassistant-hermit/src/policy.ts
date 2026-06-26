import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadEnvFile } from './config';

export const SENSITIVE_DOMAINS = new Set(['lock', 'alarm_control_panel']);

export const SAFE_RELOAD_DOMAINS = new Set(['automation', 'script', 'scene']);

// Read-only MCP tools on the `homeassistant` server. The safety gate matches the
// whole `mcp__homeassistant__.*` namespace (default-deny chokepoint), so these
// query tools — which carry no entity_id and would otherwise hit the fail-closed
// branch and be blocked — must be short-circuited to allow. Explicit names, NOT a
// `*Get*` pattern: a permissive regex could silently grant a future mutating tool
// whose name happens to contain "Get". Extend this set against the live server's
// tool inventory if it exposes more read-only tools.
export const READ_ONLY_TOOLS = new Set(['GetLiveContext', 'GetDateTime']);

const MCP_TOOL_PREFIX = 'mcp__homeassistant__';

/** True if `toolName` is a known read-only tool on the homeassistant MCP server. */
export function isReadOnlyTool(toolName: string): boolean {
  const bare = toolName.startsWith(MCP_TOOL_PREFIX)
    ? toolName.slice(MCP_TOOL_PREFIX.length)
    : toolName;
  return READ_ONLY_TOOLS.has(bare);
}

export const Severity = {
  BLOCK: 'block',
  ASK: 'ask',
  ALLOW: 'allow', // sentinel for non-sensitive entities; no ha_safety_mode maps to it
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

const MODE_TO_SEVERITY: Record<string, Severity> = {
  strict: Severity.BLOCK,
  ask: Severity.ASK,
};

const SEVERITY_ORDER: Record<Severity, number> = {
  [Severity.ALLOW]: 0,
  [Severity.ASK]: 1,
  [Severity.BLOCK]: 2,
};

interface PolicyOverrides {
  safeEntities: Set<string>;
  extraDomains: Set<string>;
}

const overridesCache = new Map<string, PolicyOverrides>();
const safetyModeCache = new Map<string, string>();
const assistControlCache = new Map<string, boolean>();

/** Test hook — replaces Python's `_load_policy_overrides.cache_clear()` etc. */
export function clearPolicyCaches(): void {
  overridesCache.clear();
  safetyModeCache.clear();
  assistControlCache.clear();
}

function loadPolicyOverrides(root: string): PolicyOverrides {
  const cached = overridesCache.get(root);
  if (cached) return cached;
  const env = loadEnvFile(root);
  const set = (name: string): Set<string> =>
    new Set(
      (env[name] ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    );
  const overrides: PolicyOverrides = {
    safeEntities: set('HA_SAFE_ENTITIES'),
    extraDomains: set('HA_EXTRA_SENSITIVE_DOMAINS'),
  };
  overridesCache.set(root, overrides);
  return overrides;
}

function loadSafetyMode(root: string): string {
  const cached = safetyModeCache.get(root);
  if (cached !== undefined) return cached;
  let mode = 'strict';
  try {
    const cfg = JSON.parse(readFileSync(join(root, '.claude-code-hermit', 'config.json'), 'utf8'));
    const value = cfg?.ha_safety_mode ?? 'strict';
    mode = typeof value === 'string' && Object.hasOwn(MODE_TO_SEVERITY, value) ? value : 'strict';
  } catch {
    mode = 'strict';
  }
  safetyModeCache.set(root, mode);
  return mode;
}

/** Read ha_safety_mode from .claude-code-hermit/config.json. Fail-closed: returns 'strict'. */
export function safetyMode(root?: string | null): string {
  return loadSafetyMode(resolve(root ?? process.cwd()));
}

function loadAssistControl(root: string): boolean {
  const cached = assistControlCache.get(root);
  if (cached !== undefined) return cached;
  let enabled = false;
  try {
    const cfg = JSON.parse(readFileSync(join(root, '.claude-code-hermit', 'config.json'), 'utf8'));
    enabled = cfg?.ha_assist_control_enabled === true;
  } catch {
    enabled = false;
  }
  assistControlCache.set(root, enabled);
  return enabled;
}

/** Read ha_assist_control_enabled from .claude-code-hermit/config.json. Fail-closed: returns false. */
export function assistControl(root?: string | null): boolean {
  return loadAssistControl(resolve(root ?? process.cwd()));
}

export interface MutationGate {
  allowed: boolean;
  requiresConfirm: boolean;
  mode: string;
  reason: string;
}

/**
 * Gate for structural WebSocket mutations (helpers, areas, entity/device
 * registries). Reads are never gated — only call this for writes.
 *
 *   strict (default): blocked — surface the work as a proposal.
 *   ask: allowed only with operator confirmation. The CLI is non-interactive,
 *        so the caller passes `confirmed` (the `--confirm` flag) after the main
 *        session has prompted the operator; without it the gate asks for it.
 */
export function gateStructuralMutation(root?: string | null, confirmed = false): MutationGate {
  const mode = safetyMode(root);
  if (mode === 'strict') {
    return {
      allowed: false,
      requiresConfirm: false,
      mode,
      reason:
        'Blocked under strict ha_safety_mode — surface this as a proposal for the operator to approve.',
    };
  }
  if (confirmed) {
    return { allowed: true, requiresConfirm: false, mode, reason: 'Approved via --confirm.' };
  }
  return {
    allowed: false,
    requiresConfirm: true,
    mode,
    reason:
      'Requires operator confirmation under ask ha_safety_mode — re-run with --confirm once the operator approves.',
  };
}

export interface PolicyDecision {
  severity: Severity;
  blocked: boolean;
  reasons: string[];
}

/** Return [Severity, reasons] for a single entity. */
export function classifyEntity(entityId: string, root?: string | null): [Severity, string[]] {
  const resolved = resolve(root ?? process.cwd());
  const overrides = loadPolicyOverrides(resolved);
  if (overrides.safeEntities.has(entityId)) return [Severity.ALLOW, []];
  // Lowercase to catch calls carrying `LOCK.front_door` (HA ids are lowercase
  // in practice, but a mis-formed call must not slip past the domain check).
  const domain = entityId.split('.', 1)[0]!.toLowerCase();
  if (SENSITIVE_DOMAINS.has(domain) || overrides.extraDomains.has(domain)) {
    return [MODE_TO_SEVERITY[loadSafetyMode(resolved)]!, [`Domain '${domain}' is always sensitive`]];
  }
  return [Severity.ALLOW, []];
}

export function isSensitiveEntity(entityId: string, root?: string | null): boolean {
  const [sev] = classifyEntity(entityId, root);
  return sev !== Severity.ALLOW;
}

export function isSensitiveService(serviceName: string): boolean {
  const [sev] = classifyEntity(serviceName);
  return sev !== Severity.ALLOW;
}

export function evaluateReferences(
  entityIds: string[],
  services: string[],
  root?: string | null,
): PolicyDecision {
  let maxSev: Severity = Severity.ALLOW;
  const reasons: string[] = [];
  for (const entityId of [...new Set(entityIds)].sort()) {
    const [sev] = classifyEntity(entityId, root);
    if (sev !== Severity.ALLOW) {
      reasons.push(`Sensitive or ambiguous entity (${sev}): ${entityId}`);
      if (SEVERITY_ORDER[sev] > SEVERITY_ORDER[maxSev]) maxSev = sev;
    }
  }
  for (const service of [...new Set(services)].sort()) {
    const [sev] = classifyEntity(service, root);
    if (sev !== Severity.ALLOW) {
      reasons.push(`Sensitive or ambiguous service (${sev}): ${service}`);
      if (SEVERITY_ORDER[sev] > SEVERITY_ORDER[maxSev]) maxSev = sev;
    }
  }
  return { severity: maxSev, blocked: maxSev === Severity.BLOCK, reasons };
}

export function canReloadDomain(domain: string): boolean {
  return SAFE_RELOAD_DOMAINS.has(domain);
}

export interface EntityCheck {
  entity_id: string;
  sensitive: boolean;
  severity: Severity;
  reasons: string[];
}

/** Return a JSON-friendly policy check for a single entity. */
export function checkEntity(entityId: string): EntityCheck {
  const [sev, reasons] = classifyEntity(entityId);
  return {
    entity_id: entityId,
    sensitive: sev !== Severity.ALLOW,
    severity: sev,
    reasons,
  };
}

export function normalizeEntityIndex(
  states: Array<Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const index: Record<string, Record<string, unknown>> = {};
  for (const state of states) {
    const entityId = state['entity_id'];
    if (typeof entityId === 'string') index[entityId] = state;
  }
  return index;
}
