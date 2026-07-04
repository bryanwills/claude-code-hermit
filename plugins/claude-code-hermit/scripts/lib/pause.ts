// Shared read/write/is-paused helpers for state/pause.json — the binding
// pause/stop/resume flag (PROP-015).
//
// Dedicated file, NOT runtime.json: runtime.json has four concurrent
// read-modify-write writers doing full-object overwrites (hermit-start,
// hermit-stop, hermit-watchdog, in-session skills — see lib/runtime.ts), and
// a pause write racing hermit-start's initial seed write would vanish.
// Absent file = unpaused.
//
// Atomic write mirrors lib/alert-state.ts's tmp+rename. Any read failure
// (missing, unreadable, corrupt) resolves to unpaused — pause-gate.ts is a
// PreToolUse hook and hooks must fail open (never block Claude Code); a
// pause-gate that fails closed on a bad flag file would brick the hermit with
// no way to recover except manual file surgery, which is worse than the gate
// occasionally missing a stale/garbled flag.
//
// Auto-expiry is evaluated by READERS: a `paused_until` in the past reads as
// unpaused, so a snooze needs no unpause writer — see isPaused().

import fs from 'node:fs';
import path from 'node:path';

export type PauseReason = 'operator' | 'budget' | 'watchdog';

export interface PauseFlag {
  paused: boolean;
  paused_until: string | null; // ISO timestamp, or null = indefinite
  reason: PauseReason;
  by: string;
  ts: string; // ISO timestamp this flag was written
}

export interface PauseStatus {
  paused: boolean;
  reason?: PauseReason;
  until?: string | null;
  by?: string;
  ts?: string; // when this pause episode was written — lets a one-shot consumer (e.g. the watchdog's Escape-to-pane) dedup per episode
}

export function pausePath(stateDir: string): string {
  return path.join(stateDir, 'state', 'pause.json');
}

/** Read state/pause.json. Returns null on missing/unreadable/corrupt — fail-open. */
function readPauseFlag(stateDir: string): PauseFlag | null {
  let raw: string;
  try {
    raw = fs.readFileSync(pausePath(stateDir), 'utf-8');
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as PauseFlag;
  } catch {
    return null;
  }
}

/**
 * Resolve current pause status, applying reader-side snooze expiry: a
 * `paused_until` in the past is treated as unpaused with no writer needed to
 * clear it. Indefinite pause has `paused_until: null`.
 */
export function isPaused(stateDir: string): PauseStatus {
  const flag = readPauseFlag(stateDir);
  if (!flag || flag.paused !== true) return { paused: false };
  if (flag.paused_until) {
    const until = new Date(flag.paused_until).getTime();
    if (!isNaN(until) && until <= Date.now()) return { paused: false };
  }
  return { paused: true, reason: flag.reason, until: flag.paused_until, by: flag.by, ts: flag.ts };
}

/** Atomic write via tmp + rename (mirrors lib/alert-state.ts). */
function writePauseFlag(stateDir: string, flag: PauseFlag): void {
  const p = pausePath(stateDir);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(flag, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, p);
  } catch { /* fail-open */ }
}

/** Set the pause flag. `until` omitted/null = indefinite pause. */
export function setPause(
  stateDir: string,
  opts: { reason: PauseReason; by: string; until?: string | null },
): void {
  writePauseFlag(stateDir, {
    paused: true,
    paused_until: opts.until ?? null,
    reason: opts.reason,
    by: opts.by,
    ts: new Date().toISOString(),
  });
}

/** Clear the pause flag (resume). Deletes the file — absent means unpaused. */
export function clearPause(stateDir: string): void {
  try { fs.rmSync(pausePath(stateDir), { force: true }); } catch { /* fail-open */ }
}

/**
 * Parses a snooze duration ("30m", "2h", "1d") to milliseconds. Returns null
 * on anything unparseable — callers must hard-reject, never silently fall
 * back to a default (a mistyped duration must never turn into an indefinite
 * pause or a no-op).
 */
export function parseSnoozeDuration(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(String(s).trim());
  if (!m) return null;
  const mult: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return Math.round(parseFloat(m[1]) * mult[m[2].toLowerCase()]);
}
