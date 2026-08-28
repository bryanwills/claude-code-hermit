// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// PermissionDenied hook (matcher "*") — fires after Claude Code's own auto-mode
// classifier (or the permissions system) has already denied a tool call. The
// payload carries tool_name, tool_input, tool_use_id, and reason (usually the
// fixed text "Blocked by classifier"). This hook cannot block or retry the call;
// it records a maintainer-tier diagnostic, routed by tier: the maintainer chat
// when one is configured, the primary chat on a technical profile without one,
// and SHELL.md Findings on a non-technical profile (fail-closed on disclosure)
// or whenever the channel is absent or unreachable.
//
// Gating mirrors ask-gate.ts: only the managed unattended session
// (HERMIT_MANAGED, stamped into the tmux env-file by hermit-start) with
// always_on config records anything — an attended session sees the denial
// natively in its own transcript. Channel reachability gates the POST only;
// the record itself always happens.
//
// Fail-open and side-effect-only: every path exits 0. The harness ignores
// this hook's stdout/stderr and its exit code; it never emits
// hookSpecificOutput.retry (auto-retrying a classifier denial is exactly the
// bypass the security model forbids).

import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { readSettledConfig } from './lib/config-read';
import { channelLikelyDown } from './lib/channel-health';
import { resolve as resolveOutboundChannel, resolveMaintainerTarget } from './resolve-outbound-channel';
import { sendOperatorNotice, appendMaintainerFindings } from './lib/channel-send';
import { readAlertState, writeAlertState } from './lib/alert-state';
import { safe } from './lib/sanitize';
import { localISOStamp } from './lib/time';
import { DENY, resolveLocale } from './lib/messages';

type Json = any;

const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MESSAGE_MAX_LEN = 300;
// The reason is bounded on its own so a long one (permission-rule denials are
// far wordier than the classifier's fixed string) cannot push the trailing
// "what to do about it" guidance past MESSAGE_MAX_LEN and truncate it away.
const REASON_MAX_LEN = 150;
// tool_name is model-supplied and is now a state-file key, so bound it. Plain
// truncation would be wrong: long MCP names share a prefix (`mcp__<server>__`),
// so two distinct tools on a verbose server could truncate to the same key and
// silently share one dedup window. Overflow keeps a hash tail instead, which
// stays distinct.
const TOOL_NAME_MAX_LEN = 60;
const TOOL_NAME_HASH_LEN = 6;

// One open window per tool: when it opened, and how many further denials of the
// same tool it has absorbed since.
interface DenyWindow {
  at: string;
  suppressed: number;
}

function alertsPath(dir: string): string {
  return path.join(dir, 'state', 'permission-denied-alerts.json');
}

// Reuse lib/alert-state.ts's atomic read/write — the same single-writer
// alert-file pattern cost-tracker.ts and report-export.ts already use for
// budget-alerts.json / telemetry-alert.json, instead of a hand-rolled
// tmp+rename write. This file's shape is a flat tool->window map, so only
// the generic readAlertState/writeAlertState pair applies (not
// mutateOwnedAlerts/readMergedAlerts, which assume the `{alerts: {...}}` shape).
function readAlerts(dir: string): Record<string, DenyWindow> {
  const read = readAlertState(alertsPath(dir));
  if (read.kind !== 'ok' || !read.value || typeof read.value !== 'object') return {};
  const out: Record<string, DenyWindow> = {};
  // Anything not shaped like a window is dropped — which is also what happens to
  // the pre-upgrade entries, keyed by a tool+input hash no new key can match.
  for (const [k, v] of Object.entries(read.value as Record<string, unknown>)) {
    if (v && typeof v === 'object' && typeof (v as Json).at === 'string') {
      out[k] = { at: (v as Json).at, suppressed: Number((v as Json).suppressed) || 0 };
    }
  }
  return out;
}

function writeAlerts(dir: string, alerts: Record<string, DenyWindow>): void {
  fs.mkdirSync(path.dirname(alertsPath(dir)), { recursive: true });
  writeAlertState(alertsPath(dir), alerts);
}

// Bounded, distinct identity for one tool: itself when short enough, otherwise
// a truncation carrying a hash tail of the full name. Bun.hash is 64-bit wyhash
// — non-cryptographic on purpose, since this only has to keep two tool names
// apart, not resist an adversary (lib/hash.ts's sha256 is for the
// template-manifest baseline, where the digest is the security property).
function toolKey(rawName: unknown): string {
  const name = safe(typeof rawName === 'string' ? rawName : '');
  if (!name) return 'unknown_tool';
  if (name.length <= TOOL_NAME_MAX_LEN) return name;
  const tail = Bun.hash(name).toString(16).slice(0, TOOL_NAME_HASH_LEN);
  return `${name.slice(0, TOOL_NAME_MAX_LEN - TOOL_NAME_HASH_LEN - 1)}~${tail}`;
}

async function main(raw: string): Promise<void> {
  let payload: Json;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // malformed stdin
  }
  if (!payload || typeof payload !== 'object') return;

  if (process.env.HERMIT_DENY_NOTIFY === 'off') return; // explicit per-session escape hatch
  if (process.env.HERMIT_MANAGED !== '1') return; // attended session sees the denial natively

  const dir = hermitDir();
  const config = readSettledConfig(dir); // settled: absent/malformed -> defaults (always_on false -> no-op)
  if (config.always_on !== true) return;

  // Dedup is keyed on the tool alone. Keying it on tool + input made a burst of
  // N distinct commands N separate keys, so the window collapsed nothing: the
  // incident this hook exists to report (four denials in nine minutes) produced
  // four messages. One message per tool per window, carrying how many further
  // denials it stood in for, is the signal worth having — whether the session
  // hit one wall or twelve.
  const key = toolKey(payload.tool_name);
  // PermissionDenied normally supplies the fixed reason "Blocked by classifier";
  // keep it optional so older or synthetic payloads remain fail-open.
  const reason = typeof payload.reason === 'string' ? safe(payload.reason).slice(0, REASON_MAX_LEN) : '';

  const now = Date.now();
  const alerts = readAlerts(dir);

  // Prune before reading this tool's window, so a stale one can neither hold the
  // window open nor contribute a day-old suppressed count.
  for (const [k, w] of Object.entries(alerts)) {
    const t = Date.parse(w.at);
    if (Number.isNaN(t) || now - t > PRUNE_AGE_MS) delete alerts[k];
  }

  // Pruning above guarantees a surviving entry's `at` parses.
  const entry = alerts[key];
  if (entry && now - Date.parse(entry.at) < DEDUP_WINDOW_MS) {
    // Count it and stay quiet. The count rides out on the next window's message,
    // the only place it can be truthful — a burst's size isn't known when the
    // window opens.
    alerts[key] = { at: entry.at, suppressed: entry.suppressed + 1 };
    writeAlerts(dir, alerts);
    return;
  }

  const suppressed = entry?.suppressed ?? 0;
  alerts[key] = { at: localISOStamp(), suppressed: 0 };
  writeAlerts(dir, alerts);

  const locale = resolveLocale(config.language);
  let maintainerText = DENY[locale].maintainerBase(key);
  if (reason) maintainerText += ` — ${reason}`;
  if (suppressed > 0) maintainerText += DENY[locale].maintainerSuppressed(suppressed);
  maintainerText += DENY[locale].maintainerTail();
  maintainerText = maintainerText.slice(0, MESSAGE_MAX_LEN);

  // The diagnostic is recorded whatever the channel is doing. An absent or dead
  // channel is a reason not to POST, never a reason to lose the record: with no
  // client leg left, Findings (injected into the next session by
  // startup-context.ts) is the only surface some installs have.
  const target = resolveMaintainerTarget(config.channels) ?? resolveOutboundChannel(config.channels);
  if (target && !channelLikelyDown(dir, target.id)) {
    // 'client', not 'findings': routing follows the general tiered-disclosure
    // policy instead of making this diagnostic an exception to it. Maintainer
    // chat when configured; primary chat on a technical profile without one;
    // Findings on a non-technical profile, which stays fail-closed.
    await sendOperatorNotice(dir, {
      maintainer: { text: maintainerText, fallback: 'client', sensitive: true },
    });
    return;
  }
  appendMaintainerFindings(dir, maintainerText);
}

try {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buf += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    main(buf)
      .catch(() => {})
      .finally(() => process.exit(0));
  });
} catch {
  process.exit(0);
}
