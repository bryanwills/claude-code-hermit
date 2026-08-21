/**
 * apply-settings.ts — additive, non-weakening settings.json helper for hatch/docker-setup.
 *
 * Usage: bun apply-settings.ts <target-file> <op> [args...]
 *
 * Operations:
 *   allow                    Merge hermit's fixed permissions.allow list
 *   permissions-plan         Print {"missing":[],"obsolete":[]} for the target — read-only,
 *                            writes nothing. `missing` is the sealed HERMIT_ALLOW entries the
 *                            target lacks; `obsolete` is the sealed HERMIT_OBSOLETE entries it
 *                            still carries. Callers (hatch, hermit-evolve) show this diff.
 *   permissions-sync         Apply that plan: add every missing HERMIT_ALLOW entry and remove
 *                            only entries listed in HERMIT_OBSOLETE. Prints the applied plan.
 *                            Operator-authored entries are structurally untouchable — removal
 *                            is filtered by the sealed registry, never by shape or heuristic.
 *   artifact-allow           Merge just ["Artifact"] into permissions.allow — kept as its
 *                            own op (not folded into `allow`) so declining the Artifact
 *                            publish-authorization ask never touches hook permissions.
 *   output-style             Set outputStyle to the sealed "hermit-voice" value, but only when
 *                            the key is absent. An operator's own /config choice is preserved
 *                            untouched (file left byte-identical); prints "applied" or
 *                            "kept:<value>" so callers can report the mismatch.
 *   automode-seed            Merge the hermit's sealed autoMode.allow exception + autoMode.
 *                            environment context into settings.local.json, so the auto-mode
 *                            classifier's soft-tier self-modification check clears sealed
 *                            settings writes made unattended. Target MUST be settings.local.json
 *                            — the classifier never reads autoMode from committed project settings.
 *   deny <minimal|hardened>  Merge deny-patterns from state-templates/deny-patterns.json
 *   channel-env <CH> <dir>   Set env.<CH>_STATE_DIR and strip any stale env.*_BOT_TOKEN
 *
 * Rules:
 * - Never removes existing keys or array entries — except channel-env, which strips
 *   any *_BOT_TOKEN from the env block (tokens must live only in .env, never settings),
 *   and permissions-sync, which removes only entries named in the sealed HERMIT_OBSOLETE
 *   registry below (scripts this plugin itself shipped and has since deleted).
 * - Permission sets are read from state-templates — callers cannot inject arbitrary JSON.
 * - Safe to call under AGENT_HOOK_PROFILE=strict: writes via fs, not the Edit/Write tools.
 */

import fs from 'node:fs';
import path from 'node:path';
import { auditConfigChange } from './lib/config-audit';
import { channelStateDirKey } from './lib/channel-config';
import { HERMIT_OUTPUT_STYLE } from './lib/voice';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');

// Fixed allow-list — sealed here; cannot be extended by callers. This array is the
// single source of truth: hatch and hermit-evolve reach it through permissions-plan /
// permissions-sync rather than restating it, so there is nothing to keep in sync.
const HERMIT_ALLOW = [
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(bun */scripts/cost-tracker.ts*)',
  'Bash(bun */scripts/heartbeat.ts precheck*)',
  'Bash(bun */scripts/reflect-precheck.ts*)',
  'Bash(bun */scripts/archive-shell.ts*)',
  'Bash(bun */scripts/evaluate-session.ts*)',
  // Verb-scoped: `observe` is the only thing this script does, and pinning it keeps
  // the grant from widening if it ever grows a second verb. Replaces the old
  // append-metrics.ts entry, which granted "write any JSON to any path".
  'Bash(bun */scripts/observations.ts observe *)',
  'Bash(bun */scripts/proposal.ts*)',
  'Bash(bun */scripts/generate-summary.ts*)',
  'Bash(bun */scripts/update-reflection-state.ts*)',
  'Bash(bun */scripts/apply-reflection-actions.ts*)',
  'Bash(bun */scripts/transcript-digest.ts*)',
  'Bash(bun */scripts/setup-token-mint.ts*)',
  'Bash(bun */scripts/routines.ts tz-shift*)',
  // Monitor evaluates its subprocess command against command permissions.
  // Keep this grant pinned to the one shipped monitor script.
  'Bash(bash */scripts/routine-monitor.sh *)',
  'Bash(bun */scripts/evolve-plan.ts*)',
  'Bash(bun */scripts/evolve-finalize.ts*)',
  'Bash(bun */scripts/manifest-seed.ts*)',
  'Bash(bun */scripts/apply-settings.ts*)',
  'Bash(bun */scripts/channel-log.ts*)',
  'Bash(bun */scripts/channel-send.ts*)',
  'Bash(bun */scripts/session-archive.ts*)',
  'Bash(bun */scripts/routines.ts precheck*)',
  'Bash(bun */scripts/routines.ts finish*)',
  'Bash(bun */scripts/routines.ts cron-registry*)',
  'Bash(bun */scripts/routines.ts health*)',
  // Domain plugins reach core's shared scripts through the project-resident
  // bin/hermit-run (their own ${CLAUDE_PLUGIN_ROOT} can't reach core's versioned
  // cache dir). Pinned to the two verbs they actually need, not a bare
  // `hermit-run proposal *` — that would also hand them create, patch,
  // shell-append, next-task and routine, i.e. arbitrary state-dir writes. The
  // space before * is a word boundary: `proposal micro *` matches
  // `proposal micro .claude-code-hermit brief-cycle` but not a
  // `micro…`-prefixed verb.
  'Bash(.claude-code-hermit/bin/hermit-run proposal micro *)',
  'Bash(.claude-code-hermit/bin/hermit-run proposal metrics *)',
  // The shared domain-hatch protocol, pinned per verb for the same reason:
  // `domain-hatch *` would hand every caller `ensure-target` and `sync-block`
  // — writes to core state and to the operator's CLAUDE.md — when most of a
  // hatch run only needs to read `preflight`.
  'Bash(.claude-code-hermit/bin/hermit-run domain-hatch preflight *)',
  'Bash(.claude-code-hermit/bin/hermit-run domain-hatch ensure-target *)',
  'Bash(.claude-code-hermit/bin/hermit-run domain-hatch sync-block *)',
  // The three routes above exist because a domain plugin can't resolve core's
  // path. These three exist for a different reason: they are the scripts the
  // MODEL invokes ad hoc mid-session rather than from a skill's verbatim command
  // block. CLAUDE-APPEND names the first two, and its "log it in the Progress
  // Log" rules lead to the third. Their `bun */scripts/*.ts*` twins above are
  // wildcarded-interpreter rules, which auto mode suspends (docs/security.md
  // § Auto-mode Classifier) — so on the fleet's default permission mode the
  // model was left deriving a versioned plugin-cache path by hand, and the
  // shortenings it improvised (an env-var prefix) draw classifier denials AND
  // fall outside every prefix-match rule.
  //
  // `channel-send` is granted without a verb pin because it has modes
  // (--notice/--tier), not verbs. That is only safe because channel-send.ts now
  // pins its own state dir: the grant confers exactly what the existing
  // `Bash(bun */scripts/channel-send.ts*)` entry already confers, and no more.
  'Bash(.claude-code-hermit/bin/hermit-run channel-send *)',
  'Bash(.claude-code-hermit/bin/hermit-run observations observe *)',
  'Bash(.claude-code-hermit/bin/hermit-run proposal shell-append *)',
  "Bash(bash -c 'AGENT_DIR=\".claude-code-hermit\"*)",
  'Edit(.claude-code-hermit/**)',
];

// Entries this plugin itself shipped in an earlier version and has since retired.
// permissions-sync removes these from an operator's settings; nothing else is ever
// removed, so an operator's own rules cannot be caught by a shape or prefix match.
// Append here in the same change that deletes a permissioned script — this registry
// is what makes a deletion reach already-hatched hermits.
const HERMIT_OBSOLETE = [
  'Bash(python3:*)',
  'Bash(node:*)',
  'Edit(.claude/.claude-code-hermit/**)',
  'Write(.claude/.claude-code-hermit/**)',
  'Bash(bun */scripts/run-with-profile.ts*)',
  'Bash(bun */scripts/suggest-compact.ts*)',
  'Bash(bun */scripts/next-prop-id.ts*)',
  // Retired with the script: an arbitrary-path, arbitrary-JSON writer is a wider
  // grant than any caller needed. Replaced by `observations.ts observe *` above and
  // by proposal.ts's existing grant, which now covers the `event` verb.
  'Bash(bun */scripts/append-metrics.ts*)',
  // Proposal satellites absorbed into proposal.ts verbs — the scripts are gone,
  // so these grants now name nothing.
  'Bash(bun */scripts/resolve-prop.ts*)',
  'Bash(bun */scripts/record-gate.ts*)',
  'Bash(bun */scripts/queue-micro-proposal.ts*)',
  'Bash(bun */scripts/micro-proposal.ts*)',
  'Bash(bun */scripts/proposals-index.ts*)',
  // …and the two hermit-run routes that pointed at the pre-absorption names.
  'Bash(.claude-code-hermit/bin/hermit-run micro-proposal *)',
  'Bash(.claude-code-hermit/bin/hermit-run proposal-metrics-report *)',
  // Heartbeat/routine scripts absorbed into heartbeat.ts and routines.ts verbs.
  'Bash(bun */scripts/heartbeat-precheck.ts*)',
  'Bash(bun */scripts/routine-precheck.ts*)',
  'Bash(bun */scripts/cron-registry.ts*)',
  'Bash(bun */scripts/cron-tz-shift.ts*)',
];

// Sealed autoMode entries — operator-owned policy seeded at attended hatch and
// re-ensured by hermit-start at boot. Declarative, no persuasion prose (a live
// probe model flags over-argued entries as planted justification). Keep in sync
// with docs/security.md § Auto-mode classifier.
const AUTOMODE_ALLOW_ENTRY =
  'Operator policy, set at hatch: hermit self-maintenance may run ' +
  '`bun */scripts/apply-settings.ts <settings-file> <op>` unattended — approval for ' +
  'these sealed settings operations is granted here in advance, including when the ' +
  'run is initiated by plugin upgrade or migration instructions rather than a live ' +
  'operator message.';

const AUTOMODE_ENV_ENTRIES = [
  'Key internal services: this project runs a claude-code-hermit autonomous session; ' +
    '.claude-code-hermit/ is its internal working state and the installed hermit ' +
    "plugins' scripts/*.ts are its trusted maintenance tooling.",
  "Trusted internal domains: api.telegram.org and discord.com are the operator's own " +
    'hermit notification channels (bot DM liveness probes and message sends).',
];

// Hardened extras — a subset of always_on patterns safe to persist to settings.
// Excludes docker/kubectl/ssh: valid in devops contexts on the host; hook-enforced at runtime.
// Matches what hatch Step 9 "hardened" option produces.
const HARDENED_DENY_EXTRAS = [
  'Bash(npm publish*)',
  'Bash(git push --force*)',
  'Bash(git push origin main*)',
  'Bash(git reset --hard*)',
  'Bash(*--no-verify*)',
];

type Json = any;

function readJson(filePath: string): Json {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

// Strict read for the operator's target settings file: an existing-but-malformed
// file must abort, never fall through to {} — otherwise the additive merge below
// would overwrite the whole file with only hermit's subset, silently discarding
// the operator's settings.
function readTargetJson(filePath: string): Json {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(
      `Refusing to overwrite ${filePath}: file exists but is not valid JSON ` +
        `(${(err as Error).message}). Fix or remove it, then re-run.`,
    );
    process.exit(1);
  }
}

function writeJson(filePath: string, data: Json): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// Returns the entries that were newly added (absent before) — the `allow` op
// prints these so hermit-evolve's Step 8 report can list what it granted.
function mergeAllow(settings: Json, entries: string[]): string[] {
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  const existing = new Set<string>(settings.permissions.allow);
  const added: string[] = [];
  for (const e of entries) {
    if (!existing.has(e)) { settings.permissions.allow.push(e); added.push(e); }
  }
  return added;
}

interface PermissionsPlan {
  missing: string[];
  obsolete: string[];
}

// Read-only diff of the target against the two sealed registries above.
function planPermissions(settings: Json): PermissionsPlan {
  const allow: string[] = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  const existing = new Set<string>(allow);
  return {
    missing: HERMIT_ALLOW.filter((e) => !existing.has(e)),
    obsolete: HERMIT_OBSOLETE.filter((e) => existing.has(e)),
  };
}

// Removes exactly the entries handed in — always a subset of HERMIT_OBSOLETE.
function removeAllow(settings: Json, entries: string[]): void {
  if (entries.length === 0 || !Array.isArray(settings?.permissions?.allow)) return;
  const drop = new Set(entries);
  settings.permissions.allow = settings.permissions.allow.filter((e: string) => !drop.has(e));
}

function mergeAutoModeList(settings: Json, key: 'allow' | 'environment', entries: string[]): void {
  settings.autoMode ??= {};
  const block = settings.autoMode as Record<string, unknown>;
  // Create with "$defaults" so built-in rules are inherited. If an array
  // pre-exists WITHOUT "$defaults", that is the operator's deliberate
  // replacement of the defaults — do not inject it.
  if (!Array.isArray(block[key])) block[key] = ['$defaults'];
  const list = block[key] as string[];
  for (const e of entries) {
    if (!list.includes(e)) list.push(e);
  }
}

function mergeDeny(settings: Json, entries: string[]): void {
  settings.permissions ??= {};
  settings.permissions.deny ??= [];
  const existing = new Set<string>(settings.permissions.deny);
  for (const e of entries) {
    if (!existing.has(e)) settings.permissions.deny.push(e);
  }
}

// Claude Code's permission engine treats an Edit(glob) rule as covering the
// Write tool too, and (v2.1.211+) warns at boot on Write(glob) rules. So a
// Write(<glob>) whose Edit(<glob>) twin is present is a dead no-op that only
// produces that warning — drop it before seeding settings.json. deny-patterns.json
// keeps both spellings on purpose: the runtime enforce-deny-patterns hook matches
// tool-name-specifically and still needs the Write variant.
function dropRedundantWriteRules(entries: string[]): string[] {
  const editGlobs = new Set(
    entries.map((e) => e.match(/^Edit\((.+)\)$/)?.[1]).filter(Boolean) as string[],
  );
  return entries.filter((e) => {
    const writeGlob = e.match(/^Write\((.+)\)$/)?.[1];
    return writeGlob === undefined || !editGlobs.has(writeGlob);
  });
}

const [, , targetFile, op, ...rest] = process.argv;

if (!targetFile || !op) {
  console.error('Usage: apply-settings.ts <target-file> <op> [args...]');
  process.exit(1);
}

const settings = readTargetJson(targetFile);
// Snapshot before the ops below mutate in place — the audit ledger records what
// this run actually changed in the operator's settings file.
const settingsBefore = structuredClone(settings);

// permissions-plan reports without touching the file; every other op falls through
// to the write below.
let readOnly = false;

switch (op) {
  // Legacy alias for permissions-sync's additive half. No in-repo caller since
  // hatch and hermit-evolve moved to the verbs — kept for already-hatched hermits
  // still running older skill text.
  case 'allow': {
    mergeAllow(settings, HERMIT_ALLOW);
    break;
  }

  case 'permissions-plan': {
    console.log(JSON.stringify(planPermissions(settings)));
    readOnly = true;
    break;
  }

  case 'permissions-sync': {
    // Plan first: the diff is computed against the pre-merge state, so the printed
    // result is exactly what this run changed.
    const plan = planPermissions(settings);
    // Nothing to do — don't rewrite the file. hermit-evolve runs this on every
    // upgrade, and a target that is already current must not come back reformatted
    // (or with a fresh mtime) just for having been checked.
    if (plan.missing.length === 0 && plan.obsolete.length === 0) readOnly = true;
    else {
      mergeAllow(settings, HERMIT_ALLOW);
      removeAllow(settings, plan.obsolete);
    }
    console.log(JSON.stringify(plan));
    break;
  }

  case 'artifact-allow': {
    mergeAllow(settings, ['Artifact']);
    break;
  }

  case 'output-style': {
    // Only-if-absent, and the value is the sealed constant — never caller text.
    // A style the operator chose in /config is their decision: this op leaves it
    // (and the file's bytes) alone and prints what it found, so hatch and
    // hermit-doctor can surface the mismatch rather than the hermit silently
    // reclaiming the key on every boot.
    const current = settings.outputStyle;
    if (current === undefined) settings.outputStyle = HERMIT_OUTPUT_STYLE;
    else readOnly = true;
    console.log(current === undefined ? 'applied' : `kept:${current}`);
    break;
  }

  case 'automode-seed': {
    // autoMode is only read from local/user/managed scope — a committed
    // .claude/settings.json target would be a silent no-op trap.
    if (path.basename(targetFile) !== 'settings.local.json') {
      console.error('automode-seed must target a settings.local.json file — autoMode is not read from committed project settings.');
      process.exit(1);
    }
    mergeAutoModeList(settings, 'allow', [AUTOMODE_ALLOW_ENTRY]);
    mergeAutoModeList(settings, 'environment', AUTOMODE_ENV_ENTRIES);
    break;
  }

  case 'deny': {
    const profile = rest[0];
    if (profile !== 'minimal' && profile !== 'hardened') {
      console.error(`deny requires 'minimal' or 'hardened', got: ${profile ?? '(none)'}`);
      process.exit(1);
    }
    const patternsFile = path.join(PLUGIN_ROOT, 'state-templates', 'deny-patterns.json');
    const patterns = readJson(patternsFile);
    const deny = [
      ...(patterns.default ?? []),
      ...(profile === 'hardened' ? HARDENED_DENY_EXTRAS : []),
    ];
    mergeDeny(settings, dropRedundantWriteRules(deny));
    break;
  }

  case 'channel-env': {
    const channel = rest[0];
    const stateDir = rest[1];
    if (!channel || !stateDir) {
      console.error('channel-env requires <CHANNEL_UPPER> and <abs_state_dir> arguments');
      process.exit(1);
    }
    const stateDirKey = channelStateDirKey(channel);
    if (!stateDirKey) {
      console.error(`channel-env: "${channel}" is not a valid env-var name — refusing to write a key hermit-start would never export`);
      process.exit(1);
    }
    settings.env ??= {};
    // Tokens must live only in .env — strip any stale *_BOT_TOKEN from settings.
    for (const key of Object.keys(settings.env)) {
      if (/_BOT_TOKEN$/.test(key)) delete settings.env[key];
    }
    settings.env[stateDirKey] = stateDir;
    break;
  }

  default: {
    console.error(`Unknown operation: ${op}. Valid ops: task-id, allow, permissions-plan, permissions-sync, artifact-allow, output-style, automode-seed, deny, channel-env`);
    process.exit(1);
  }
}

if (!readOnly) {
  writeJson(targetFile, settings);
  // The hermit state dir is a sibling of .claude/ — the ledger lives with the
  // rest of the hermit's state, not next to the settings file it describes.
  const stateDir = path.resolve(path.dirname(targetFile), '..', '.claude-code-hermit');
  const target = path.basename(targetFile) === 'settings.local.json'
    ? '.claude/settings.local.json'
    : '.claude/settings.json';
  auditConfigChange(stateDir, settingsBefore, settings, 'apply-settings', target);
}
