// Shared context-reset bookkeeping.
//
// Destroying a context (/clear) or shrinking it (/compact) is not just a keystroke:
// hermit-owned state has to be updated in the same breath or the hermit's own view
// of the world silently disagrees with reality. Before this lib the sequence lived
// only inside hermit-watchdog.ts's private maybeContextClear/maybePostCloseClear, so
// any other caller — notably an operator-initiated reset arriving over a channel —
// would have bypassed it.
//
// What stays OUT of here on purpose: the cost-log idempotence stamps
// (last_cleared_cost_ts / last_compacted_cost_ts / last_pane_hash_ctx) and
// setHygieneEval. Those exist to stop a *threshold-triggered* reset re-firing against
// the same cost entry; a reset the operator asked for has no cost entry and no
// threshold, so they are the watchdog's business, not this lib's. Callers also own
// their own keystroke and event-log line, which legitimately differ per trigger.

import fs from 'node:fs';
import path from 'node:path';
import { flushResetBreadcrumb } from './progress-log';
import { writeRuntimeJson, readRuntimeJson, runtimeTmpPath } from './runtime';

type Json = any;

/**
 * Delete the cached status file after a context reset.
 *
 * The status cache is the fallback source for "which session id am I?". Once /clear
 * destroys a context its last cost entry is stale, and leaving the cache in place lets
 * that DEFUNCT entry resolve again — firing a spurious /compact or /clear into the
 * fresh, near-empty context. Removing it makes the fallback cleanly return "no session
 * id" until a real turn repopulates it. cost-tracker treats a missing file as first-run
 * and rebuilds cumulative totals from the index, so nothing is lost.
 *
 * Moved here from hermit-start.ts (was clearStatusCacheOnBoot) so both the boot path
 * and every mid-run reset path share one implementation.
 */
export function clearStatusCache(hermitRoot: string): void {
  try { fs.unlinkSync(path.join(hermitRoot, 'sessions', '.status.json')); } catch {}
}

/**
 * Record WHEN the context was last reset, machine-readably.
 *
 * The breadcrumb below is prose for the next session to read; this stamp is for the
 * watchdog, which needs to know that a cost-log entry observed before it describes a
 * context that no longer exists. Every reset path records it — manual or native-auto
 * /compact through this function (precompact-stamp.ts), /clear through
 * applyContextReset's own write — because the watchdog's own last_compacted_at only
 * ever sees the resets it caused.
 *
 * Fresh read-modify-write against an absolute path: hooks don't share a cwd, and a
 * cached runtime object would clobber fields another process wrote meanwhile. Fail-open
 * and never fabricates a partial runtime.json (session_state/session_id must survive).
 */
export function stampContextReset(hermitRoot: string): void {
  const stateDir = path.join(hermitRoot, 'state');
  const runtime = readRuntimeJson(stateDir);
  if (!runtime) return; // missing/unreadable/malformed — never fabricate a partial record
  runtime.last_context_reset_at = new Date().toISOString();
  try {
    // Not writeRuntimeJson: that stamps updated_at, and this runs from the PreCompact
    // hook, where refreshing the liveness marker would tell checkStaleRuntime the
    // runtime is fresh on the strength of a compaction alone.
    const tmpPath = runtimeTmpPath(stateDir);
    fs.writeFileSync(tmpPath, JSON.stringify(runtime, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, path.join(stateDir, 'runtime.json'));
  } catch { /* fail-open */ }
}

/**
 * Apply the hermit-owned bookkeeping that must accompany a context reset.
 *
 * Call this immediately BEFORE the destructive keystroke: the breadcrumb is the only
 * trace a /clear leaves behind (PreCompact never fires for /clear — see
 * precompact-stamp.ts), so writing it first means an interrupted reset is still visible.
 *
 * Fail-open throughout: a bookkeeping failure must never suppress the reset itself.
 */
export function applyContextReset(
  hermitRoot: string,
  runtime: Json,
  opts: { kind: 'cleared' | 'compacted'; trigger: string; hhmm: string; tokens?: number },
): void {
  // One anchored write, not writeRuntimeJson() + stampContextReset(): those disagreed on
  // path mode. writeRuntimeJson() resolves .claude-code-hermit/state RELATIVE TO THE CWD
  // and mkdirs it, so a caller running anywhere but the project root wrote context_cleared
  // into a freshly created decoy state dir while the timestamp landed in the real one.
  try {
    runtime.context_cleared = true;
    runtime.last_context_reset_at = new Date().toISOString();
    writeRuntimeJson(runtime, path.join(hermitRoot, 'state'));
  } catch { /* fail-open */ }

  try {
    flushResetBreadcrumb(path.join(hermitRoot, 'sessions', 'SHELL.md'), {
      kind: opts.kind,
      trigger: opts.trigger,
      hhmm: opts.hhmm,
      tokens: opts.tokens,
    });
  } catch { /* fail-open — must never delay or suppress the reset */ }

  clearStatusCache(hermitRoot);
}
