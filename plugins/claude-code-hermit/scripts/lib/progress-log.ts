// progress-log.ts — SHELL.md ## Progress Log append helper, shared by reflect-precheck.ts
// and the two autonomous context-reset flush paths (precompact-stamp.ts, hermit-watchdog.ts).
//
// Extracted from reflect-precheck.ts so a reset flush can reuse the exact same
// section-boundary logic instead of re-deriving it.

import fs from 'node:fs';
import { findSection } from './md-write';
import { acquireLock, releaseLock } from './lockfile';

/** Long enough for a peer's append (a few ms), short enough not to stall a caller. */
const LOCK_WAIT_MS = 2000;
/** Backstop for a holder whose PID was reused after a reboot; a dead PID is reclaimed at once. */
const LOCK_STALE_MS = 10_000;

/**
 * Serialize the read-modify-write below against the other autonomous writers.
 *
 * The append rewrites the whole file from a buffer it read a moment earlier, so two
 * concurrent appends do not merely drop a line — the loser's whole read is written
 * back, reverting whatever the winner added. That is now reachable on a schedule:
 * the reflect wake gate runs reflect-precheck.ts inside the routine-monitor
 * subprocess, so its EMPTY-path append can land while the watchdog or a PreCompact
 * flush is mid-append. Advisory and best-effort by design — a lock we cannot take
 * within the wait window is not worth losing the line over, so we proceed anyway,
 * and an fs error on the lock path itself must not cost the caller its line either.
 */
function withProgressLogLock<T>(shellPath: string, fn: () => T): T {
  const lockPath = `${shellPath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held && Date.now() < deadline) {
    try {
      held = acquireLock(lockPath, LOCK_STALE_MS);
    } catch {
      break; // the lock path is unwritable — the append below may still succeed
    }
    if (!held) Bun.sleepSync(20);
  }
  try {
    return fn();
  } finally {
    if (held) releaseLock(lockPath);
  }
}

// Deliberately not md-write's appendToSection: this path must never throw on a
// missing heading (it appends at EOF instead), and it inserts the raw line
// without appendToSection's blank-line normalization, so an operator's SHELL.md
// spacing survives an autonomous flush untouched.
function appendToProgressLog(shellPath: string, line: string): void {
  try {
    withProgressLogLock(shellPath, () => {
      let content = fs.readFileSync(shellPath, 'utf-8');
      const section = findSection(content, 'Progress Log');
      if (!section) {
        content = content.trimEnd() + '\n\n' + line + '\n';
      } else if (section.end === content.length) {
        content = content.trimEnd() + '\n' + line + '\n';
      } else {
        content = content.slice(0, section.end) + '\n' + line + content.slice(section.end);
      }
      fs.writeFileSync(shellPath, content, 'utf-8');
    });
  } catch { /* fail-open */ }
}

type ResetKind = 'compacted' | 'cleared';

// Breadcrumb for an autonomous context reset (PreCompact hook, or the watchdog's
// emergency /clear) — a durable Progress Log line so the next session can see that a
// mid-arc reset happened. Deliberately NOT a rescue of unsaved observations (those live
// only in context and aren't deterministically extractable); this is a trace, nothing more.
// Fully fail-open: appendToProgressLog swallows all I/O errors, so this never throws.
function flushResetBreadcrumb(shellPath: string, opts: {
  kind: ResetKind;
  trigger: string;
  hhmm: string;
  tokens?: number;
}): void {
  const verb = opts.kind === 'compacted' ? 'compacted' : 'cleared';
  const tokenSuffix = typeof opts.tokens === 'number' ? ` at ~${Math.round(opts.tokens / 1000)}k tokens` : '';
  const line = `- [${opts.hhmm}] context ${verb} (${opts.trigger})${tokenSuffix} — arc may have unfinished work`;
  appendToProgressLog(shellPath, line);
}

export { appendToProgressLog, flushResetBreadcrumb };
