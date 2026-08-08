// `routines.ts precheck` — consolidates a routine fire's pre-dispatch gate (waiting-check +
// pause-check) and the `started` stamp into one script call, replacing 2-3 separate
// model-issued tool calls per fire with one. Mirrors reflect-precheck.ts's /
// `heartbeat.ts precheck`'s verdict-token contract. Delegates the JSONL write to lib/routines/event.ts,
// which stays the single writer — the #464 dedup guard and JSONL schema live in exactly
// one place.
// Usage: bun routines.ts precheck <routine-id> <rdw:true|false> [delivery]
// Output (stdout, one line): SKIP | PROCEED
// Side effect: stamps skipped-waiting | skipped-paused | started via logRoutineEvent().
// Exit 0 always — fail-open to PROCEED on any read error (a malformed runtime.json must
// never silently kill a routine).

import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from '../cc-compat';
import { loadConfig } from '../channel-auth';
import { isPaused } from '../pause';
import { logRoutineEvent } from './event';
import { resolveArtifactPath, statIdentity, writeRunRecord } from './run-record';
import { utcISOStamp } from '../time';

function emit(verdict: string): never {
  process.stdout.write(verdict + '\n');
  process.exit(0);
}

const id = process.argv[2];
const rdw = process.argv[3] === 'true';
const delivery = process.argv[4] || 'cron-create';

if (!id) emit('PROCEED');

let HERMIT_ROOT: string;
try {
  HERMIT_ROOT = hermitDir();
} catch {
  emit('PROCEED'); // fail-open: can't resolve the hermit dir → never silently kill the routine
}
const PROJECT_ROOT = path.dirname(HERMIT_ROOT);

function stamp(event: string): void {
  try {
    logRoutineEvent(id, event, delivery, PROJECT_ROOT);
  } catch { /* fail-open — a stamp failure must not block the routine */ }
}

/**
 * For a routine declaring `expect_artifact`, freeze this fire's contract: the
 * `{date}` token resolved against `config.timezone` NOW (a routine crossing local
 * midnight must be checked against the path it was meant to write, not the next
 * day's), plus the target's current filesystem identity. `routines.ts finish`
 * compares against that baseline instead of against the `started` timestamp,
 * which utcISOStamp() truncates to whole seconds.
 *
 * Silent no-op for routines without a contract, and on any read failure — the
 * gate above has already decided this fire proceeds, and `finish` treats a
 * missing record for a declared contract as a verification error anyway.
 */
function captureArtifactBaseline(): void {
  try {
    const config: any = loadConfig(HERMIT_ROOT);
    if (!config || !Array.isArray(config.routines)) return;
    const entry = config.routines.find((r: any) => r && r.id === id);
    const pattern = entry?.expect_artifact;
    if (typeof pattern !== 'string' || !pattern.trim()) return;

    const timezone = typeof config.timezone === 'string' ? config.timezone : null;
    const resolved = resolveArtifactPath(pattern.trim(), timezone);
    writeRunRecord(HERMIT_ROOT, id, {
      started_ts: utcISOStamp(),
      resolved_path: resolved,
      baseline: statIdentity(path.join(HERMIT_ROOT, resolved)),
    });
  } catch { /* fail-open: a broken capture must not block the routine */ }
}

function sessionStateIsWaiting(): boolean {
  try {
    const runtime = JSON.parse(fs.readFileSync(path.join(HERMIT_ROOT, 'state', 'runtime.json'), 'utf-8'));
    return runtime.session_state === 'waiting';
  } catch {
    return false; // fail-open: unreadable/missing runtime.json reads as not-waiting
  }
}

if (!rdw && sessionStateIsWaiting()) {
  stamp('skipped-waiting');
  emit('SKIP');
}

let paused = false;
try {
  paused = isPaused(HERMIT_ROOT).paused;
} catch {
  paused = false; // fail-open: unresolvable pause state reads as unpaused (see header contract)
}
if (paused) {
  stamp('skipped-paused');
  emit('SKIP');
}

stamp('started');
captureArtifactBaseline();
emit('PROCEED');
