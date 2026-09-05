// progress-log.ts — SHELL.md ## Progress Log append helper, shared by reflect-precheck.ts
// and the two autonomous context-reset flush paths (precompact-stamp.ts, hermit-watchdog.ts).
//
// Extracted from reflect-precheck.ts so a reset flush can reuse the exact same
// section-boundary logic instead of re-deriving it.

import fs from 'node:fs';
import { findSection, withShellLock, writeFileAtomic } from './md-write';

// Deliberately not md-write's appendToSection: this path must never throw on a
// missing heading (it appends at EOF instead), and it inserts the raw line
// without appendToSection's blank-line normalization, so an operator's SHELL.md
// spacing survives an autonomous flush untouched.
// Returns null on success or a retryable error, also logged for hook callers.
function appendToProgressLog(shellPath: string, line: string): string | null {
  try {
    withShellLock(shellPath, () => {
      let content = fs.readFileSync(shellPath, 'utf-8');
      const section = findSection(content, 'Progress Log');
      if (!section) {
        content = content.trimEnd() + '\n\n' + line + '\n';
      } else if (section.end === content.length) {
        content = content.trimEnd() + '\n' + line + '\n';
      } else {
        content = content.slice(0, section.end) + '\n' + line + content.slice(section.end);
      }
      writeFileAtomic(shellPath, content);
    });
    return null;
  } catch (e: any) {
    const error = `SHELL.md append failed: ${e.message}`;
    console.error(`[progress-log] ${error}`);
    return error;
  }
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
  guest?: boolean;
}): void {
  const verb = opts.kind === 'compacted' ? 'compacted' : 'cleared';
  const tokenSuffix = typeof opts.tokens === 'number' ? ` at ~${Math.round(opts.tokens / 1000)}k tokens` : '';
  // SHELL.md is one session's narrative, archived as that session's report — a guest's
  // reset is a real event in the folder but not the resident's work, so it says so.
  const guestSuffix = opts.guest ? ' — guest session' : '';
  const line = `- [${opts.hhmm}] context ${verb} (${opts.trigger})${tokenSuffix}${guestSuffix} — arc may have unfinished work`;
  appendToProgressLog(shellPath, line);
}

// True for a Progress Log line that records a context reset rather than work: the
// `context compacted|cleared` breadcrumb written above, and the `[archived] previous
// entries` pointer archive-shell.ts leaves when it snapshots the log. Readers that ask
// "what was this session actually doing" (the archived report's Task line, the
// compaction capsule's `last progress`) must skip both — they are the newest entries
// exactly when the question is asked, and neither names any work.
function isResetBreadcrumb(line: string): boolean {
  const text = line.trim().replace(/^-\s+/, '');
  return /^\[archived\]\s+previous entries\b/i.test(text)
    || /^\[\d{2}:\d{2}\]\s+context (?:compacted|cleared)\b/i.test(text);
}

export { appendToProgressLog, flushResetBreadcrumb, isResetBreadcrumb };
