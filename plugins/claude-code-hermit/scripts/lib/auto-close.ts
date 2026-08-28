// Shared daily-auto-close thresholds and the pending-close drain predicate.
//
// The 10-minute operator lull gates the session-archive.ts auto-close-decision
// verb, this file's drain predicate, and the hermit-watchdog.ts post-close-clear
// backoff. `pendingCloseDrainDue` is the shared verdict behind BOTH drainers:
// lib/heartbeat/precheck.ts (heartbeat tick) and lib/routines/due.ts (60s routine
// poll). Two drainers is deliberate — neither subsystem is present on every
// hermit (heartbeat needs `heartbeat.enabled`; the routine poll needs Monitor
// mode plus at least one enabled non-anchor routine), and a duplicate emission is
// harmless because session-close --scheduled re-derives the decision from live
// state via auto-close-decision. The drain is a nudge, never an authority.
//
// No module-level state; safe to import from CLI scripts. Reads only, with one
// sanctioned write: `stampDrainCooldown` persists the drain backoff marker, which
// both drainers must record before emitting.
import fs from 'node:fs';
import path from 'node:path';
import { readJson as readJSON } from './cli';
import { writeFileAtomic } from './md-write';

export const AUTO_CLOSE_LULL_MINUTES = 10;
export const AUTO_CLOSE_LULL_MS = AUTO_CLOSE_LULL_MINUTES * 60_000;

// Backoff between drain emissions from the routine poll. Not the lull: that one
// asks "is the operator away", this one asks "did we already nudge recently".
// Conflating them would defeat the lull constant's sync-pin purpose. Generous on
// purpose — the cooldown never delays the FIRST emission (no marker exists yet),
// and each emission dispatches a model wake, so a close that keeps failing must
// not retry every 60 seconds.
export const PENDING_CLOSE_DRAIN_COOLDOWN_MINUTES = 30;

// Backstop for a turn marker orphaned by a Stop hook that never ran. Long enough
// that a real turn is never cut short, short enough that a crashed session cannot
// strand a queued close indefinitely.
export const TURN_OPEN_TTL_MS = 60 * 60 * 1000;

// Backoff marker for the pending-close drain. Deliberately its own file and NOT a
// key inside pending-close.json: that file today has exactly one atomic writer and
// one deleter with singleton semantics, so adding attempt metadata would introduce
// the first read-modify-write on it — and a delete landing inside that window would
// resurrect a flag session-archive.ts had just cleared, which can auto-close a
// freshly-started session. A separate file only ever suppresses, so its worst
// failure is one delayed drain, and cooldown expiry self-heals.
const drainMarkerPath = (hermitDir: string) =>
  path.join(hermitDir, 'state', 'pending-close-drain.json');

// A live operator exchange is open: the marker is written by user-prompt-pipeline.ts
// at hook exit for kept prompts the pipeline did not block (a blocked prompt runs
// no model turn, so no Stop would ever clear it), and cleared by stop-pipeline.ts
// at Stop. This is NOT the 10-min lull — that one ages from prompt submission,
// so an operator watching a long agent turn goes quiet while still present. Absent,
// malformed, stale, or future-dated (clock skew) all read as no-open-turn. Fail-open:
// a broken marker must never starve the drain or the routine poll.
export function operatorTurnOpen(hermitDir: string, nowMs: number): boolean {
  const marker = readJSON(path.join(hermitDir, 'state', 'operator-turn-open.json'));
  const at = marker && typeof marker.at === 'string' ? new Date(marker.at).getTime() : NaN;
  const age = nowMs - at;
  return age >= 0 && age <= TURN_OPEN_TTL_MS; // NaN fails both
}

// True when no drain has been emitted recently. Absent/malformed/future-dated all
// read as expired (fail-open) — a broken marker must never strand a queued close.
// The marker is shared by both drainers on purpose: the cooldown means "don't re-wake
// for this close too soon", not "don't re-wake via this specific poller".
//
// The default is tuned for the 60s routine poll. A slower poller must pass a cooldown
// below its own interval, or it can never clear the gate on the next tick: the marker
// is stamped by the non-peek run, i.e. AFTER the peek that emitted, so one interval
// later the age is short of the interval by that wake latency (#771).
export function drainCooldownExpired(
  hermitDir: string,
  nowMs: number,
  cooldownMinutes: number = PENDING_CLOSE_DRAIN_COOLDOWN_MINUTES,
): boolean {
  const marker = readJSON(drainMarkerPath(hermitDir));
  const at = marker && typeof marker.last_emitted_at === 'string'
    ? new Date(marker.last_emitted_at).getTime() : NaN;
  if (isNaN(at)) return true;
  const ageMin = (nowMs - at) / 60_000;
  return ageMin < 0 || ageMin > cooldownMinutes;
}

// Records a drain emission. Callers stamp BEFORE emitting: if the write fails the
// emission must be suppressed, or a read-only state dir turns a failing close into a
// wake every poll. Returns whether the marker landed.
export function stampDrainCooldown(hermitDir: string, nowMs: number): boolean {
  const p = drainMarkerPath(hermitDir);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeFileAtomic(p, JSON.stringify({ last_emitted_at: new Date(nowMs).toISOString() }, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

// True when a queued midnight close is ready to drain. Lifted verbatim from the
// heartbeat precheck block so both callers share one verdict; the caller decides
// what to do with `true` (emit AUTO_CLOSE, or queue a ROUTINE_DUE id).
//
// `nowMs` is passed in rather than read here: precheck.ts and due.ts each resolve
// HERMIT_NOW their own way and both must keep working under their own harnesses.
//
// Note the session_state test is strict membership on a possibly-absent runtime —
// NOT staleAutoCloseDue's `?? 'idle'` default, which belongs to the separate 12h
// path. An unreadable runtime yields undefined here and must NOT drain.
// Session states from which a queued close can still be drained. Shared so the
// drain and the doctor's auto-close check cannot drift apart — an absent runtime
// yields undefined here and correctly fails, which is NOT the `?? 'idle'` default
// used by the separate 12h stale path.
export function isCloseableSessionState(state: any): boolean {
  return state === 'in_progress' || state === 'idle';
}

export function pendingCloseDrainDue(hermitDir: string, nowMs: number): boolean {
  const pendingClose = readJSON(path.join(hermitDir, 'state', 'pending-close.json'));
  if (pendingClose === null) return false;

  const runtime = readJSON(path.join(hermitDir, 'state', 'runtime.json')) ?? {};
  if (!isCloseableSessionState(runtime.session_state)) return false;

  const lastAction = readJSON(path.join(hermitDir, 'state', 'last-operator-action.json'));
  const tStr = lastAction && typeof lastAction.at === 'string' ? lastAction.at : null;
  const t = tStr ? new Date(tStr).getTime() : NaN;
  if (!isNaN(t)) {
    // Valid last-operator-action → standard 10-min lull check.
    return (nowMs - t) / (1000 * 60) > AUTO_CLOSE_LULL_MINUTES;
  }
  // Absent/malformed last-operator-action → fail-open per daily-auto-close
  // SKILL.md step 5, BUT only when the flag itself is recent. A stale flag left
  // over from a crashed prior session must not auto-close a fresh session whose
  // last-op clock has not yet been seeded. The routine fires every 24h and
  // overwrites or cleans up the flag, so a queued_at older than 24h means the
  // routine has stopped firing and the flag cannot be trusted.
  const qStr = typeof pendingClose.queued_at === 'string' ? pendingClose.queued_at : null;
  const q = qStr ? new Date(qStr).getTime() : NaN;
  return !isNaN(q) && (nowMs - q) / (1000 * 60 * 60) <= 24;
}
