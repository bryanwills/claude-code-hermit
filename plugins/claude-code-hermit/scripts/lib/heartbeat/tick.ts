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
//    "notifications":[{"text":string,"mark_key"?:string,"ack_next_task"?:string}],
//    "next_task"?:{"action":"waiting"|"start"},
//    "model":string|null}
//
// Owner contract (write-field split with SKILL.md):
//   This verb owns: the precheck's own fields (see precheck.ts), runtime.json's
//                   waiting-to-idle transition and the
//                   auto-closed Monitoring line. ack-next-task parks after delivery.
//   SKILL.md owns:  sending the notifications, `--mark-budget-notified` for each
//                   `mark_key` AFTER a confirmed send, and the injection branch's
//                   injection-alert.json bookkeeping.
// `notified` is deliberately left untouched here: a tick that composes a budget
// alert but whose send then fails must re-compose it next tick, and only the
// skill knows whether the send landed.

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runPrecheck, nextTaskQueued } from './precheck';
import { readSettledConfig } from '../config-read';
import { readMergedAlerts } from '../alert-state';
import { isPaused } from '../pause';
import { appendShellLine, withShellLock, extractSection, firstContentLine } from '../md-write';
import { readRuntimeJson, writeRuntimeJson } from '../runtime';
import { currentHHMMOrUTC, parseDuration, resolveHermitNowMs } from '../time';
import { HEARTBEAT, resolveLocale } from '../messages';

type Json = any;

type Notification = { text: string; mark_key?: string; ack_next_task?: string };

type NextTask = { action: 'waiting' | 'start' };

type TickResult = {
  verdict: string;
  reason?: string;
  alert?: string;
  notifications: Notification[];
  next_task?: NextTask;
  model: string | null;
};

/** Split the precheck's one-line grammar into the JSON fields the skill branches on. */
function parseVerdict(raw: string): Omit<TickResult, 'model'> {
  if (raw.startsWith('SKIP|')) return { verdict: 'SKIP', reason: raw.slice(5), notifications: [] };
  if (raw.startsWith('ALERT|')) return { verdict: 'ALERT', alert: raw.slice(6), notifications: [] };
  return { verdict: raw, notifications: [] };
}

/**
 * `waiting` past its timeout returns to idle. Deterministic: the elapsed check the
 * model used to compute by hand, over two fields it had to read anyway. An absent or
 * unparseable `waiting_since`/`waiting_timeout` skips the transition rather than
 * forcing one — a spurious idle drops the operator's waiting_reason.
 *
 * Returns whether it released the session, so the queued-task pass below can stay off
 * the tick that just freed it: composing there would read the idle state this wrote and
 * park the session straight back into `waiting`, which is not a transition at all.
 */
function applyWaitingTimeout(hermitDir: string, config: Json, nowMs: number, out: Notification[]): boolean {
  if (config.heartbeat?.waiting_timeout == null) return false;
  const stateDir = path.join(hermitDir, 'state');
  const runtime = readRuntimeJson(stateDir);
  if (runtime?.session_state !== 'waiting') return false;
  if (typeof runtime.waiting_since !== 'string') return false;
  const since = Date.parse(runtime.waiting_since);
  const timeoutMs = parseDuration(config.heartbeat.waiting_timeout, 0);
  if (!Number.isFinite(since) || timeoutMs <= 0 || nowMs - since <= timeoutMs) return false;

  runtime.session_state = 'idle';
  delete runtime.waiting_reason;
  // The stamp goes with the wait it measured. Left behind on an idle runtime it becomes
  // the elapsed baseline for the *next* wait, and the writers that park without stamping
  // (channel-responder's `operator_input`) would have their wait torn down on its first
  // tick, measured against a timestamp from a wait that already ended.
  delete runtime.waiting_since;
  writeRuntimeJson(runtime, stateDir);
  out.push({ text: HEARTBEAT[resolveLocale(config.language)].waitingTimeout(config.heartbeat.waiting_timeout) });
  return true;
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

/** The queued task's headline — the `## Task` section's first non-empty line. */
function queuedTaskLine(content: string): string | null {
  const body = extractSection(content, 'Task');
  return body ? firstContentLine(body) || null : null;
}

// Bind delivery to the exact queue and runtime observed before the send. No receipt
// file is needed: a later acknowledgement can only park that unchanged idle state.
function nextTaskToken(content: string, runtime: Json): string {
  return createHash('sha256').update(JSON.stringify([content, runtime])).digest('hex');
}

export function acknowledgeNextTask(hermitDir: string, token: string): { parked: boolean; reason?: string } {
  try {
    return withShellLock(path.join(hermitDir, 'sessions', 'SHELL.md'), () => acknowledgeIdleTask(hermitDir, token));
  } catch { return { parked: false, reason: 'lock-unavailable' }; }
}

function acknowledgeIdleTask(hermitDir: string, token: string): { parked: boolean; reason?: string } {
  const config = readSettledConfig(hermitDir);
  if (config.always_on !== true || config.escalation !== 'conservative') return { parked: false, reason: 'disabled' };
  const stateDir = path.join(hermitDir, 'state');
  const runtime = readRuntimeJson(stateDir);
  if (!runtime || runtime.session_state !== 'idle' || runtime.transition) return { parked: false, reason: 'not-idle' };
  try {
    if (!nextTaskQueued(hermitDir)) return { parked: false, reason: 'queue-missing' };
    const content = fs.readFileSync(path.join(hermitDir, 'sessions', 'NEXT-TASK.md'), 'utf-8');
    if (nextTaskToken(content, runtime) !== token) return { parked: false, reason: 'changed' };
    runtime.session_state = 'waiting';
    runtime.waiting_reason = 'conservative_pickup';
    runtime.waiting_since = new Date(resolveHermitNowMs()).toISOString();
    writeRuntimeJson(runtime, stateDir);
    return { parked: true };
  } catch { return { parked: false, reason: 'io-error' }; }
}

/**
 * A task queued while the session sits idle. Conservative mode composes a notice;
 * only its delivery acknowledgement parks the session, so a failed send can retry.
 * Balanced/autonomous modes mutate nothing and hand the skill a `start`, leaving session-start to adopt and delete the file.
 */
function composeNextTask(hermitDir: string, config: Json, out: Notification[]): NextTask | undefined {
  // The same gate precheck applies to the queued-task pierce, mirrored because EVALUATE
  // arrives here for a dozen unrelated reasons (the 20-tick boundary, a pending budget
  // alert, a stale session) that carry no always_on condition of their own. Only an
  // unattended hermit's session-start consumes NEXT-TASK.md; an interactive one presents
  // it at the operator's next boot, so starting or parking on its behalf is not ours.
  // First, because it reads settled config already in memory and the queue check stats.
  if (config.always_on !== true) return undefined;
  if (!nextTaskQueued(hermitDir)) return undefined;
  const stateDir = path.join(hermitDir, 'state');
  const runtime = readRuntimeJson(stateDir) ?? {};
  if ((runtime.session_state ?? 'idle') !== 'idle') return undefined;
  if (config.escalation !== 'conservative') return { action: 'start' };

  if (runtime.session_state !== 'idle' || runtime.transition) return undefined;
  const content = fs.readFileSync(path.join(hermitDir, 'sessions', 'NEXT-TASK.md'), 'utf-8');
  out.push({
    text: HEARTBEAT[resolveLocale(config.language)].queuedTask(queuedTaskLine(content)),
    ack_next_task: nextTaskToken(content, runtime),
  });
  return { action: 'waiting' };
}

export async function run(args: string[]): Promise<void> {
  const hermitDir = args[0];
  // Settled once, shared by the model field and the bookkeeping below. Settling
  // preserves an explicit `heartbeat.model: null` (the skill reads it as "inherit
  // the session model") while folding absent/""/wrong-typed to 'haiku'; the
  // reader never writes and never throws.
  const config = readSettledConfig(hermitDir);
  // Mutating precheck, exactly once — before anything below can throw, so a tick
  // is never double-counted by a retry.
  const result: TickResult = {
    ...parseVerdict(runPrecheck(hermitDir, false)),
    model: config.heartbeat.model,
  };

  try {
    const nowMs = resolveHermitNowMs();

    if (result.verdict === 'AUTO_CLOSE') {
      // Step 2 of the auto-close sequence replaces SHELL.md with a fresh template,
      // so this line has to land before the skill starts closing.
      const hhmm = currentHHMMOrUTC(config.timezone ?? 'UTC', new Date(nowMs));
      const appendError = appendShellLine(path.join(hermitDir, 'sessions'), 'Monitoring', `[${hhmm}] Heartbeat: auto-closed.`);
      if (appendError) console.error(`[heartbeat] ${appendError}`);
    } else if (result.verdict === 'EVALUATE' || result.verdict === 'ALERT') {
      // Both gates are pre-dispatch and read no HEARTBEAT.md, so a suspended
      // checklist still surfaces them — the reason ALERT exists as a verdict.
      const released = applyWaitingTimeout(hermitDir, config, nowMs, result.notifications);
      await composeBudgetAlerts(hermitDir, config, result.notifications);
      if (result.verdict === 'EVALUATE' && !released) {
        const nextTask = composeNextTask(hermitDir, config, result.notifications);
        if (nextTask) result.next_task = nextTask;
      }
    }
  } catch { /* fail-open: the verdict still ships, minus the bookkeeping */ }

  process.stdout.write(JSON.stringify(result) + '\n');
}
