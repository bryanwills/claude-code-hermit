// `routines.ts log-event <routine-id> <event> [delivery]` — appends one line to
// state/routine-metrics.jsonl. Events: fired | skipped-waiting | skipped-paused |
// started. delivery: cron-create (default) | monitor.
//
// Ported from log-routine-event.sh, and still emitting the same four keys with
// the same UTC second-precision stamp. The row shape is pinned (tests assert it,
// and run-record.ts exists because of it), but only the shape — no consumer reads
// the serialized byte order any more. Cost attribution moved to the cost log's
// v2 rows, and the doctor's routine-cost check went with it.

import fs from 'node:fs';
import path from 'node:path';
import { utcISOStamp } from '../time';
import { appendJsonlLine } from '../append-jsonl';
import { lastRoutineEvent } from './history';

// Deliberately not an enum check: the shell version accepted any event string,
// and rejecting one here would refuse input that used to be recorded.
const USAGE = 'Usage: routines.ts log-event <routine-id> <event> [delivery]';

// CronCreate prompts fire with cwd set to the session's primary working
// directory, which may be a subdirectory of the hermit project root. Walk up to
// the nearest ancestor containing .claude-code-hermit/ so the relative path
// resolves correctly regardless of launch cwd.
function findHermitRoot(from: string): string | null {
  let dir = path.resolve(from);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.claude-code-hermit'))) return dir;
    dir = path.dirname(dir);
  }
  return fs.existsSync(path.join(dir, '.claude-code-hermit')) ? dir : null;
}

/**
 * Appends one routine event. Returns null on success, or an error message.
 *
 * `fromDir` is where the .claude-code-hermit/ walk-up starts — the in-process
 * callers (due.ts, precheck.ts) pass the project root they already resolved,
 * which is what they used to pass as the subprocess `cwd`. They now call this
 * directly rather than spawning, saving a process per stamp on the routine
 * fire path.
 */
export function logRoutineEvent(
  id: string,
  event: string,
  delivery = 'cron-create',
  fromDir: string = process.cwd(),
): string | null {
  const root = findHermitRoot(fromDir);
  if (!root) return `could not find .claude-code-hermit/ in any parent of ${fromDir}`;
  const metrics = path.join(root, '.claude-code-hermit', 'state', 'routine-metrics.jsonl');

  // Dedup guard (issue #464): heartbeat-restart re-invokes `hermit-routines
  // load` at its own prompt tail, which can re-trigger the cron and emit a
  // second `fired` with no intervening `started`. The prompt always logs
  // `started` immediately before `fired`, so a `fired` whose latest same-routine
  // event is already `fired` can only be the spurious re-trigger.
  // A missing or unreadable ledger reads as "no prior event", so nothing is
  // suppressed — same fail-open behavior as the inline scan this replaced.
  if (event === 'fired' && lastRoutineEvent(metrics, id) === 'fired') return null;

  return appendJsonlLine(
    metrics,
    JSON.stringify({ ts: utcISOStamp(), routine_id: id, event, delivery }),
  );
}

export function run(args: string[]): void {
  const [id, event, delivery] = args;
  if (!id || !event) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }
  const err = logRoutineEvent(id, event, delivery || 'cron-create');
  if (err) {
    process.stderr.write(`routines.ts log-event: ${err}\n`);
    process.exit(1);
  }
}
