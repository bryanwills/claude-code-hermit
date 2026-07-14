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

/** Read-modify-write runtime.json with atomic write. */
function updateRuntimeField(updates: Json): void {
  const runtime = readRuntimeJson() || {};
  Object.assign(runtime, updates);
  writeRuntimeJson(runtime);
}

export { writeRuntimeJson, readRuntimeJson, updateRuntimeField, STATE_DIR, RUNTIME_JSON, RUNTIME_TMP, LIFECYCLE_LOCK };
