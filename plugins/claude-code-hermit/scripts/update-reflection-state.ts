// Updates reflection-state.json after a reflect run — increments diagnostic counters,
// sets last_reflection/last_run_at, preserves all other keys.
// Zero npm dependencies, Node stdlib only. Always exits 0 on I/O failure (fail-open).
// Usage: bun update-reflection-state.ts <state-file-path> '<json-payload>'
//    or: bun update-reflection-state.ts <state-file-path> --quick-hash <hash>
//    or: bun update-reflection-state.ts <state-file-path> --graduation-cursor [<iso>]
//    or: bun update-reflection-state.ts <state-file-path> --reset-counters
//    or: bun update-reflection-state.ts <state-file-path> --scheduled-check-run <id>
//
// --quick-hash is a distinct write path for the reflect --quick cursor: it writes ONLY
// the top-level last_quick_hash key and does not touch last_run_at/last_reflection/counters
// below — mutating those would suppress the next scheduled reflect (see reflect/SKILL.md's
// quick-mode note on why it never calls the counter-incrementing path below).
//
// --graduation-cursor is step 3b's promote cursor: it writes ONLY
// counters.last_graduation_at and does not touch last_run_at. The value is the
// timestamp 3b captured *before* Candidate processing appended its reflect-noticed
// rows — passed explicitly, because the write happens later, at State Update, and only
// on a clean run. Stamping it inside 3b instead meant a candidate that then hit
// GATE_FAILED was gone until a brand-new row arrived, breaking the fail-closed
// "re-surfaces on the next reflect cycle" promise for exactly the best-evidenced
// patterns. Bare (no value) still stamps now, for callers with nothing to preserve.
//
// --reset-counters zeroes the judge verdict tallies and drops their window
// (counters.judge_accept/judge_downgrade/judge_suppress = 0, judge_suppress_by_code
// emptied, counters.judge_since = now). The ratio now reads counters.judge_window,
// so judge_since is only a reset audit marker: nothing measures a window from it.
// This reset stays for the 1.2.49 upgrade step and as a manual escape hatch. It
// deliberately does NOT touch counters.since: that is the hatch
// stamp the reflect phase ladder (newborn/juvenile/adult) and doctor's run-rate line
// are measured from, and moving it would make an established install newborn again.
//
// --scheduled-check-run is the session skill's step-4b cursor: it writes ONLY
// scheduled_checks.<id>.last_run (today's date), preserving sibling per-check
// fields and everything else. reflect/branches.md step 7 keeps its own richer
// inline per-check writer (last_unavailable_at/last_error_at/consecutive_empty)
// — deliberately separate surfaces; do not unify them onto this flag.

import fs from 'node:fs';
import { resolveHermitNowMs } from './lib/time';
import { pinUnderStateDirOrExit } from './lib/cc-compat';

type Json = any;

const stateFileArg = process.argv[2];
const arg3 = process.argv[3];

// The state file is not caller-chosen. Unlike the other pinned scripts this
// argument is a FILE inside the state dir, not the dir itself, so the guard
// is containment, not equality. Reachable through a pre-approved
// `Bash(bun */scripts/update-reflection-state.ts*)` grant that covers every
// argument — this was the worst-shaped instance of the defect: an unvalidated
// file path let one such call write arbitrary JSON at arbitrary depth on
// disk, not just inside a project's own state dir. Missing stays a
// downstream usage error (each branch below already checks it); only a
// PRESENT-but-foreign path is refused here.
//
// Bounded to `<hermit>/state`, not the hermit root: every branch below reads
// with a parse-failure fallback to `{}` and then rewrites the file whole, so a
// root-wide bound would still let a pre-approved call replace OPERATOR.md,
// sessions/SHELL.md or bin/hermit-run with a counters blob. The only argument
// production ever passes is `state/reflection-state.json`.
const stateFile = stateFileArg
  ? pinUnderStateDirOrExit(stateFileArg, 'update-reflection-state', 'state file', 'state')
  : stateFileArg;

if (arg3 === '--quick-hash') {
  const hash = process.argv[4];
  if (!stateFile || !hash) {
    console.error('Usage: bun update-reflection-state.ts <state-file-path> --quick-hash <hash>');
    process.exit(1);
  }
  let state: Json = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')); } catch { /* first run before state file exists */ }
  state.last_quick_hash = hash;
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch (err: any) {
    console.error(`update-reflection-state: write failed: ${err.message}`);
  }
  process.exit(0);
}

if (arg3 === '--graduation-cursor') {
  const explicit = process.argv[4];
  if (!stateFile) {
    console.error('Usage: bun update-reflection-state.ts <state-file-path> --graduation-cursor [<iso>]');
    process.exit(1);
  }
  if (explicit && Number.isNaN(Date.parse(explicit))) {
    console.error(`update-reflection-state: --graduation-cursor value is not an ISO timestamp: ${explicit}`);
    process.exit(1);
  }
  let state: Json = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')); } catch { /* first run */ }
  if (!state.counters || typeof state.counters !== 'object') state.counters = {};
  state.counters.last_graduation_at = explicit ?? new Date().toISOString();
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch (err: any) {
    console.error(`update-reflection-state: write failed: ${err.message}`);
  }
  process.exit(0);
}

if (arg3 === '--reset-counters') {
  if (!stateFile) {
    console.error('Usage: bun update-reflection-state.ts <state-file-path> --reset-counters');
    process.exit(1);
  }
  let state: Json = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')); } catch { /* first run */ }
  if (!state.counters || typeof state.counters !== 'object') state.counters = {};
  state.counters.judge_accept = 0;
  state.counters.judge_downgrade = 0;
  state.counters.judge_suppress = 0;
  state.counters.judge_suppress_by_code = {};
  state.counters.judge_since = new Date().toISOString();
  delete state.counters.judge_window;
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch (err: any) {
    console.error(`update-reflection-state: write failed: ${err.message}`);
  }
  process.exit(0);
}

if (arg3 === '--scheduled-check-run') {
  const id = process.argv[4];
  if (!stateFile || !id) {
    console.error('Usage: bun update-reflection-state.ts <state-file-path> --scheduled-check-run <id>');
    process.exit(1);
  }
  let state: Json = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')); } catch { /* first run before state file exists */ }
  if (!state.scheduled_checks || typeof state.scheduled_checks !== 'object') state.scheduled_checks = {};
  if (!state.scheduled_checks[id] || typeof state.scheduled_checks[id] !== 'object') state.scheduled_checks[id] = {};
  state.scheduled_checks[id].last_run = new Date(resolveHermitNowMs()).toISOString().slice(0, 10);
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch (err: any) {
    console.error(`update-reflection-state: write failed: ${err.message}`);
  }
  process.exit(0);
}

const payloadJson = arg3;

if (!stateFile || !payloadJson) {
  console.error('Usage: bun update-reflection-state.ts <state-file-path> \'<json-payload>\'');
  process.exit(1);
}

let payload: Json;
try {
  payload = JSON.parse(payloadJson);
} catch (err: any) {
  console.error(`update-reflection-state: invalid payload JSON: ${err.message}`);
  process.exit(1);
}

let state: Json = {};
try {
  state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
} catch {
  // first run before state file exists, or unreadable — counters start at zero
}

const now = new Date().toISOString();

// Ring of the last 20 judge verdicts as a/d/s letters. An old runs array is folded in once.
const WINDOW_VERDICTS = 20;

const c: Json = (state.counters && typeof state.counters === 'object') ? { ...state.counters } : {};
const intOf = (v: any) => Math.max(0, typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0);

// Normalize existing counter fields once so the increment lines below use plain +
c.total_runs = intOf(c.total_runs);
c.runs_with_candidates = intOf(c.runs_with_candidates);
c.empty_runs = intOf(c.empty_runs);
c.judge_accept = intOf(c.judge_accept);
c.judge_downgrade = intOf(c.judge_downgrade);
c.judge_suppress = intOf(c.judge_suppress);
if (!c.judge_suppress_by_code || typeof c.judge_suppress_by_code !== 'object') c.judge_suppress_by_code = {};
c.proposals_created = intOf(c.proposals_created);
c.micro_proposals_queued = intOf(c.micro_proposals_queued);

const ranWithCandidates = !!payload.ran_with_candidates;
const proposalsCreated = intOf(payload.proposals_created);
const microQueued = intOf(payload.micro_proposals_queued);

c.total_runs += 1;
c.last_run_at = now;
c.runs_with_candidates += ranWithCandidates ? 1 : 0;
c.empty_runs += ranWithCandidates ? 0 : 1;
c.judge_accept += intOf(payload.judge_accept);
c.judge_downgrade += intOf(payload.judge_downgrade);
c.judge_suppress += intOf(payload.judge_suppress);
if (payload.judge_suppress_by_code && typeof payload.judge_suppress_by_code === 'object') {
  for (const [code, n] of Object.entries(payload.judge_suppress_by_code)) {
    c.judge_suppress_by_code[code] = intOf(c.judge_suppress_by_code[code]) + intOf(n);
  }
}
c.proposals_created += proposalsCreated;
c.micro_proposals_queued += microQueued;
c.last_output_at = (proposalsCreated + microQueued > 0) ? now : (c.last_output_at ?? null);

const judgeRun = {
  at: now,
  accept: intOf(payload.judge_accept),
  downgrade: intOf(payload.judge_downgrade),
  suppress: intOf(payload.judge_suppress),
};
const judgeVerdicts = judgeRun.accept + judgeRun.downgrade + judgeRun.suppress;
if (judgeVerdicts > 0) {
  const storedRuns = Array.isArray(c.judge_window?.runs) && c.judge_window.runs.every((run: Json) =>
    run && typeof run === 'object' && !Array.isArray(run) &&
    typeof run.at === 'string' && !Number.isNaN(Date.parse(run.at)) &&
    ['accept', 'downgrade', 'suppress'].every((key) =>
      typeof run[key] === 'number' && Number.isFinite(run[key]) && run[key] >= 0
    )
  ) ? c.judge_window.runs : [];
  const priorRing = typeof c.judge_window?.ring === 'string' && /^[ads]{1,20}$/.test(c.judge_window.ring)
    ? c.judge_window.ring
    : storedRuns.map((run: Json) =>
        'a'.repeat(intOf(run.accept)) + 'd'.repeat(intOf(run.downgrade)) + 's'.repeat(intOf(run.suppress))
      ).join('');
  const ring = (priorRing + 'a'.repeat(judgeRun.accept) + 'd'.repeat(judgeRun.downgrade) + 's'.repeat(judgeRun.suppress))
    .slice(-WINDOW_VERDICTS);
  c.judge_window = {
    ring,
    accept: ring.split('a').length - 1,
    downgrade: ring.split('d').length - 1,
    suppress: ring.split('s').length - 1,
    verdicts: ring.length,
  };
}

if (!('since' in c)) c.since = null;

const preserve = (key: string) => (key in payload) ? payload[key] : (state[key] ?? null);

// Merge last_sparse_nudge map: payload may carry new PROP-NNN → ISO entries.
const existingNudge = (state.last_sparse_nudge && typeof state.last_sparse_nudge === 'object') ? state.last_sparse_nudge : {};
const payloadNudge = (payload.last_sparse_nudge && typeof payload.last_sparse_nudge === 'object') ? payload.last_sparse_nudge : {};
const mergedNudge = { ...existingNudge, ...payloadNudge };

const updated = {
  ...state,
  last_reflection: now,
  last_resolution_check: preserve('last_resolution_check'),
  last_digest_at: preserve('last_digest_at'),
  last_behavior_digest_at: preserve('last_behavior_digest_at'),
  last_sparse_nudge: Object.keys(mergedNudge).length > 0 ? mergedNudge : null,
  counters: c,
};

try {
  fs.writeFileSync(stateFile, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
} catch (err: any) {
  console.error(`update-reflection-state: write failed: ${err.message}`);
}

process.exit(0);
