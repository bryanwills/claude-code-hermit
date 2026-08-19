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
// Reads only — no writes, no module-level state. Safe to import from CLI scripts.
import path from 'node:path';
import { readJson as readJSON } from './cli';

export const AUTO_CLOSE_LULL_MINUTES = 10;
export const AUTO_CLOSE_LULL_MS = AUTO_CLOSE_LULL_MINUTES * 60_000;

// Backoff between drain emissions from the routine poll. Not the lull: that one
// asks "is the operator away", this one asks "did we already nudge recently".
// Conflating them would defeat the lull constant's sync-pin purpose. Generous on
// purpose — the cooldown never delays the FIRST emission (no marker exists yet),
// and each emission dispatches a model wake, so a close that keeps failing must
// not retry every 60 seconds.
export const PENDING_CLOSE_DRAIN_COOLDOWN_MINUTES = 30;

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
