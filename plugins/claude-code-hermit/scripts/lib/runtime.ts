/**
 * Shared runtime.json state helpers for the lifecycle scripts
 * (hermit-start, hermit-stop, hermit-watchdog). Paths are CWD-relative —
 * callers run from the project root, like the Python originals did.
 */

import fs from 'node:fs';
import path from 'node:path';
import { localISOStamp } from './time';

type Json = any;

const STATE_DIR = '.claude-code-hermit/state';
const RUNTIME_JSON = path.join(STATE_DIR, 'runtime.json');
const RUNTIME_TMP = path.join(STATE_DIR, '.runtime.json.tmp');
const LIFECYCLE_LOCK = path.join(STATE_DIR, '.lifecycle.lock');

/** Atomic write to state/runtime.json; stamps updated_at. */
function writeRuntimeJson(data: Json): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  data.updated_at = localISOStamp();
  fs.writeFileSync(RUNTIME_TMP, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(RUNTIME_TMP, RUNTIME_JSON);
}

/** Read state/runtime.json; null when missing or invalid. Pass an absolute
 *  stateDir to read from an anchored location instead of the cwd-relative default. */
function readRuntimeJson(stateDir?: string): Json | null {
  const p = stateDir ? path.join(stateDir, 'runtime.json') : RUNTIME_JSON;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Outcome of a runtime.json read, keeping "absent" distinct from "unusable".
 *
 * readRuntimeJson() collapses both into null, which is fine for callers that
 * only branch on "do I have state?" — but a caller deciding whether it may
 * WRITE lifecycle state must not treat a corrupt or unreadable record as an
 * empty slot: overwriting it destroys the only copy of transition/last_error
 * markers that session-start recovery reads.
 */
type RuntimeRead =
  | { kind: 'ok'; data: Json }
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string };

/** Read state/runtime.json as a tri-state. See RuntimeRead. */
function readRuntimeState(stateDir?: string): RuntimeRead {
  const p = stateDir ? path.join(stateDir, 'runtime.json') : RUNTIME_JSON;
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err: any) {
    // Only a genuine absence is 'missing'. EACCES/EISDIR/EIO mean the file may
    // well hold live state we simply cannot see — that is 'invalid', not empty.
    if (err?.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', reason: err?.code ? `unreadable (${err.code})` : 'unreadable' };
  }
  try {
    return { kind: 'ok', data: JSON.parse(raw) };
  } catch (err: any) {
    return { kind: 'invalid', reason: `malformed JSON (${err?.message ?? 'parse error'})` };
  }
}

/** Read-modify-write runtime.json with atomic write. */
function updateRuntimeField(updates: Json): void {
  const runtime = readRuntimeJson() || {};
  Object.assign(runtime, updates);
  writeRuntimeJson(runtime);
}

export { writeRuntimeJson, readRuntimeJson, readRuntimeState, updateRuntimeField, STATE_DIR, RUNTIME_JSON, RUNTIME_TMP, LIFECYCLE_LOCK };
export type { RuntimeRead };
