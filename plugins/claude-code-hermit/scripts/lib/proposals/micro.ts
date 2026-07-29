// `proposal.ts micro <stateDir> …` — mutates state/micro-proposals.json for the
// micro-approval queue. Every mutation goes through here so the file is only ever
// written by JSON.stringify (issue 649: hand-edited JSON left a trailing comma, and
// every reader treats an unparseable file as an empty queue).
// Usage:
//   proposal.ts micro <hermit-state-dir> resolve <MP-id> --action approved|rejected|answered|expired [--answer "<label>"]
//   proposal.ts micro <hermit-state-dir> nudge <MP-id>
//   proposal.ts micro <hermit-state-dir> brief-cycle
// Output (stdout, one line):
//   RESOLVED|<id>|<action>
//   NUDGED|<id>|<follow_up_count>
//   NONE|no-match
//   brief-cycle: JSON {"new":[{id,tier,question,options}],
//                      "renudged":[{id,tier,question,options,follow_up_count}],
//                      "expired":[{id,question}],
//                      "dropped":[<id>]}
// brief-cycle ages the whole queue in one pass so the brief skills drive the
// count-0/1/2+ lifecycle through one call instead of one per entry: any entry
// whose status isn't "pending" (issue 676 - a caller resolved it elsewhere but
// left it in the array) is pruned into `dropped`, no ledger event (its
// resolution is already recorded). Of the rest: count-0 entries are reported
// for first display and bumped to 1, count-1 entries reported and re-nudged
// (bumped to 2), count>=2 entries expired. One atomic write (only when
// something changed), one micro-resolved ledger line per expiry.
// Exit 1 (+ stderr) on: unparseable micro-proposals.json (never overwritten),
// unknown verb/action, a missing/flag-shaped <MP-id>, missing --action, or a
// ledger-append failure. Every malformed invocation fails loud rather than
// exiting 0 on `NONE|no-match` — a silent no-op is the failure mode this script
// exists to remove. (Targeted resolve/nudge keep `NONE|no-match` exit 0 for a
// well-formed but absent id — channel-responder's benign double-resolve relies
// on it; brief-cycle never emits NONE.)
// Implements channel-responder/SKILL.md § Micro-approval response and
// brief/SKILL.md's MP lifecycle step.

import path from 'node:path';
import { utcISOStamp } from '../time';
import { appendJsonlLine } from '../append-jsonl';
import { writeFileAtomic } from '../md-write';
import { emit, flagValue } from '../cli';
import { readMicroProposals } from '../micro-proposals-io';

type Json = any;

const VERBS = ['resolve', 'nudge'];
const ACTIONS = ['approved', 'rejected', 'answered', 'expired'];

const USAGE = 'Usage: proposal.ts micro <hermit-state-dir> resolve|nudge <MP-id> [--action <a>] [--answer <label>] | brief-cycle';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// Age the whole pending queue in one pass. Bucketing mirrors the per-entry rules
// the brief skills used to issue one call at a time: any non-"pending" status is
// pruned first (issue 676), then count 0 -> report + bump to 1, count 1 ->
// report + bump to 2, count >=2 -> expire. Ledger lines are appended only after
// the queue write lands (same ordering as the resolve path).
function briefCycle(dir: string): never {
  const mp = path.join(dir, 'state', 'micro-proposals.json');
  const r = readMicroProposals(mp);
  if (r.status === 'corrupt') fail(`${r.error} — refusing to write. Repair it first.`);
  const data: Json = r.status === 'missing' ? { pending: [] } : r.data;
  // readMicroProposals guarantees data.pending is an array on 'ok' (non-array is
  // 'corrupt', bailed above; undefined/null is healed to []), and 'missing' set [].
  const pending: Json[] = data.pending;

  const fresh: Json[] = [];
  const renudged: Json[] = [];
  const expired: Json[] = [];
  const dropped: Json[] = [];
  const kept: Json[] = [];

  for (const e of pending) {
    // Whitelist, not blacklist — the wild holds accepted/dismissed/rejected/
    // approved/resolved, none of which the script itself ever writes.
    if (e.status !== 'pending') {
      dropped.push(e.id);
      continue; // already resolved elsewhere; no ledger event, no re-report
    }
    const c = typeof e.follow_up_count === 'number' ? e.follow_up_count : 0;
    if (c >= 2) {
      expired.push({ id: e.id, question: e.question });
      continue; // dropped from the queue
    }
    // `tier` rides along: the brief skills render "MP-… (tier N): <question>" and
    // are told not to re-read the queue file, so the verdict is their only source.
    if (c === 1) {
      e.follow_up_count = 2;
      renudged.push({ id: e.id, tier: e.tier, question: e.question, options: e.options, follow_up_count: 2 });
    } else {
      // Bump 0 -> 1 on first display so the documented lifecycle actually ages
      // the entry (issue 676 also found nothing else ever calls `micro nudge`).
      e.follow_up_count = 1;
      fresh.push({ id: e.id, tier: e.tier, question: e.question, options: e.options });
    }
    kept.push(e);
  }

  // Every entry lands in exactly one of dropped/expired/renudged/fresh, so a
  // non-empty queue always changes something on this pass.
  if (pending.length > 0) {
    data.pending = kept;
    writeFileAtomic(mp, JSON.stringify(data, null, 2) + '\n');
    const ledger = path.join(dir, 'state', 'proposal-metrics.jsonl');
    for (const e of expired) {
      const event: Json = { ts: utcISOStamp(), type: 'micro-resolved', micro_id: e.id, action: 'expired', question: e.question };
      const err = appendJsonlLine(ledger, JSON.stringify(event));
      if (err) fail(`${err} — the queue write landed but the micro-resolved event for ${e.id} was NOT recorded. Do not re-run; append it by hand.`);
    }
  }

  emit(JSON.stringify({ new: fresh, renudged, expired, dropped }));
}

export function run(stateDir: string, args: string[]): never {
  const verb = args[0];
  const id = args[1];

  if (!verb) fail(USAGE);

  // brief-cycle takes no <MP-id> — dispatch it before the id requirement below.
  if (verb === 'brief-cycle') briefCycle(stateDir);

  if (!id) fail(USAGE);

  // Validate the whole invocation before touching disk. Otherwise a dropped id
  // (`resolve --action approved`) makes `--action` the id, misses, and exits 0 on
  // NONE|no-match — the entry stays pending and the caller believes it resolved.
  if (!VERBS.includes(verb)) fail(`Unknown verb: ${verb} (expected ${VERBS.join('|')})`);
  if (id.startsWith('-')) fail(`Missing <MP-id> — got the flag "${id}" in its place.`);

  const action = verb === 'resolve' ? flagValue(args, '--action') : undefined;
  if (verb === 'resolve' && (!action || !ACTIONS.includes(action))) {
    fail(`--action must be one of: ${ACTIONS.join(', ')}`);
  }
  const answer = flagValue(args, '--answer');

  const microPath = path.join(stateDir, 'state', 'micro-proposals.json');

  // Deliberately NOT lib/cli.ts's readJson — it flattens "missing" and "corrupt"
  // to null. Corrupt must fail loud so the file is never silently replaced.
  const read = readMicroProposals(microPath);
  if (read.status === 'missing') emit('NONE|no-match'); // nothing queued, nothing to mutate
  if (read.status === 'corrupt') fail(`${read.error} — refusing to write. Repair it first.`);
  const micro: Json = read.data;

  const idx = micro.pending.findIndex((e: Json) => e.id === id);
  if (idx === -1) emit('NONE|no-match');
  const entry = micro.pending[idx];

  if (verb === 'nudge') {
    const next = (typeof entry.follow_up_count === 'number' ? entry.follow_up_count : 0) + 1;
    entry.follow_up_count = next;
    writeFileAtomic(microPath, JSON.stringify(micro, null, 2) + '\n');
    emit(`NUDGED|${id}|${next}`);
  }

  // Capture the question before removal — the ledger event carries it.
  const question = entry.question;
  micro.pending.splice(idx, 1);
  writeFileAtomic(microPath, JSON.stringify(micro, null, 2) + '\n');

  const event: Json = { ts: utcISOStamp(), type: 'micro-resolved', micro_id: id, action, question };
  if (answer !== undefined) event.answer = answer;
  const err = appendJsonlLine(path.join(stateDir, 'state', 'proposal-metrics.jsonl'), JSON.stringify(event));
  // The queue write already landed, so re-running this command would only report
  // NONE|no-match — say so, or the caller retries and loses the event for good.
  if (err) fail(`${err} — ${id} was already removed from pending; the micro-resolved event was NOT recorded. Do not re-run; append it by hand.`);

  emit(`RESOLVED|${id}|${action}`);
}
