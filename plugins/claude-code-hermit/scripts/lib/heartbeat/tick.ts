// `heartbeat.ts tick <hermit-dir>` — one deterministic heartbeat tick.
//
// The precheck verdict plus everything the `run` handler used to narrate before
// dispatching: the waiting-timeout transition, the budget-alert composition, and
// the AUTO_CLOSE monitoring line. All three are pure bookkeeping over files this
// process already reads, so paying a full-context model turn to walk them was the
// whole cost of a waking tick.
//
// Output (stdout, one JSON line):
//   {"verdict":"SKIP"|"OK"|"AUTO_CLOSE"|"EVALUATE"|"ALERT",
//    "reason"?:string, "alert"?:string,
//    "notifications":[{"text":string,"mark_key"?:string}]}
//
// Owner contract (write-field split with SKILL.md):
//   This verb owns: the precheck's own fields (see precheck.ts), runtime.json's
//                   waiting→idle transition, the auto-closed Monitoring line.
//   SKILL.md owns:  sending the notifications, `--mark-budget-notified` for each
//                   `mark_key` AFTER a confirmed send, and the injection branch's
//                   injection-alert.json bookkeeping.
// `notified` is deliberately left untouched here: a tick that composes a budget
// alert but whose send then fails must re-compose it next tick, and only the
// skill knows whether the send landed.

import path from 'node:path';
import { runPrecheck } from './precheck';
import { readSettledConfig } from '../config-read';
import { readMergedAlerts } from '../alert-state';
import { isPaused } from '../pause';
import { appendShellLine } from '../md-write';
import { readRuntimeJson, writeRuntimeJson } from '../runtime';
import { currentHHMMOrUTC, parseDuration, resolveHermitNowMs } from '../time';
import { HEARTBEAT, resolveLocale } from '../messages';

type Json = any;

type Notification = { text: string; mark_key?: string };

type TickResult = {
  verdict: string;
  reason?: string;
  alert?: string;
  notifications: Notification[];
};

/** Split the precheck's one-line grammar into the JSON fields the skill branches on. */
function parseVerdict(raw: string): TickResult {
  if (raw.startsWith('SKIP|')) return { verdict: 'SKIP', reason: raw.slice(5), notifications: [] };
  if (raw.startsWith('ALERT|')) return { verdict: 'ALERT', alert: raw.slice(6), notifications: [] };
  return { verdict: raw, notifications: [] };
}

/**
 * `waiting` past its timeout returns to idle. Deterministic: the elapsed check the
 * model used to compute by hand, over two fields it had to read anyway. An absent or
 * unparseable `waiting_since`/`waiting_timeout` skips the transition rather than
 * forcing one — a spurious idle drops the operator's waiting_reason.
 */
function applyWaitingTimeout(hermitDir: string, config: Json, nowMs: number, out: Notification[]): void {
  if (config.heartbeat?.waiting_timeout == null) return;
  const stateDir = path.join(hermitDir, 'state');
  const runtime = readRuntimeJson(stateDir);
  if (runtime?.session_state !== 'waiting') return;
  if (typeof runtime.waiting_since !== 'string') return;
  const since = Date.parse(runtime.waiting_since);
  const timeoutMs = parseDuration(config.heartbeat.waiting_timeout, 0);
  if (!Number.isFinite(since) || timeoutMs <= 0 || nowMs - since <= timeoutMs) return;

  runtime.session_state = 'idle';
  delete runtime.waiting_reason;
  writeRuntimeJson(runtime, stateDir);
  out.push({ text: HEARTBEAT[resolveLocale(config.language)].waitingTimeout(config.heartbeat.waiting_timeout) });
}

/**
 * One notification per un-notified budget entry, composed with cost-tracker's own
 * wording so the heartbeat path and the Stop-hook push read identically. `mark_key`
 * is the alert key the skill hands back to `--mark-budget-notified`; cost-tracker
 * stays the sole writer of that flag.
 */
async function composeBudgetAlerts(hermitDir: string, config: Json, out: Notification[]): Promise<void> {
  const merged = readMergedAlerts(hermitDir);
  const pending = Object.keys(merged).sort()
    .filter(k => merged[k]?.kind === 'budget' && merged[k].notified === false);
  if (pending.length === 0) return;

  // Lazy, for the reason the dispatchers are: cost-tracker pulls in pricing, the
  // cost log and the channel sender, and a breach is rare. The common tick pays
  // nothing for a branch it does not take.
  const { composeBudgetMessage } = await import('../../cost-tracker');
  const timezone = config.timezone ?? 'UTC';
  const locale = resolveLocale(config.language);
  for (const key of pending) {
    const entry = merged[key];
    const action = entry.action === 'pause' ? 'pause' : 'alert';
    // The auto-resume boundary is only quotable while the pause it describes is
    // actually in force — a lapsed one would promise a resume that already happened.
    let until: string | null = null;
    if (action === 'pause' && entry.level === 'breach') {
      const status = isPaused(hermitDir);
      if (status.paused && status.reason === 'budget') until = status.until ?? null;
    }
    out.push({ text: composeBudgetMessage([entry], action, until, timezone, locale), mark_key: key });
  }
}

export async function run(args: string[]): Promise<void> {
  const hermitDir = args[0];
  // Mutating precheck, exactly once — before anything below can throw, so a tick
  // is never double-counted by a retry.
  const result = parseVerdict(runPrecheck(hermitDir, false));

  try {
    const config = readSettledConfig(hermitDir);
    const nowMs = resolveHermitNowMs();

    if (result.verdict === 'AUTO_CLOSE') {
      // Step 2 of the auto-close sequence replaces SHELL.md with a fresh template,
      // so this line has to land before the skill starts closing.
      const hhmm = currentHHMMOrUTC(config.timezone ?? 'UTC', new Date(nowMs));
      appendShellLine(path.join(hermitDir, 'sessions'), 'Monitoring', `[${hhmm}] Heartbeat: auto-closed.`);
    } else if (result.verdict === 'EVALUATE' || result.verdict === 'ALERT') {
      // Both gates are pre-dispatch and read no HEARTBEAT.md, so a suspended
      // checklist still surfaces them — the reason ALERT exists as a verdict.
      applyWaitingTimeout(hermitDir, config, nowMs, result.notifications);
      await composeBudgetAlerts(hermitDir, config, result.notifications);
    }
  } catch { /* fail-open: the verdict still ships, minus the bookkeeping */ }

  process.stdout.write(JSON.stringify(result) + '\n');
}
