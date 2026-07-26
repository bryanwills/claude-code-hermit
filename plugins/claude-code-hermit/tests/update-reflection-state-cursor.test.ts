// --scheduled-check-run: the session skill's step-4b cursor write. Contract:
// it writes ONLY scheduled_checks.<id>.last_run (HERMIT_NOW-aware date) and
// preserves everything else — sibling per-check fields included, since
// reflect/branches.md step 7 owns those through a separate writer.
//
// Usage: bun test tests/update-reflection-state-cursor.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, runPinnedScript } from './helpers/run';

const NOW = '2026-07-20T12:00:00Z';
const CHECK_ID = 'ha-anomaly';

function withTmp(fn: (stateFile: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-reflcursor-'));
    try { await fn(path.join(dir, 'reflection-state.json')); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

async function runCursor(stateFile: string, id?: string) {
  // update-reflection-state.ts's argv is the state FILE, not the hermit root, so
  // the pin is containment — pass the file's parent dir as the pinned root.
  return runPinnedScript('update-reflection-state.ts', path.dirname(stateFile), [stateFile, '--scheduled-check-run', ...(id ? [id] : [])], {
    env: { HERMIT_NOW: NOW },
  });
}

describe('update-reflection-state --scheduled-check-run', () => {
  test('no state file → creates the scheduled_checks cursor from scratch', withTmp(async (stateFile) => {
    const r = await runCursor(stateFile, CHECK_ID);
    expect(r.exitCode).toBe(0);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(state).toEqual({ scheduled_checks: { [CHECK_ID]: { last_run: '2026-07-20' } } });
  }));

  test('rich existing state: only <id>.last_run changes, everything else deep-equal', withTmp(async (stateFile) => {
    const existing = {
      last_reflection: '2026-07-01T09:00:00.000Z',
      last_quick_hash: 'abc123',
      counters: { total_runs: 5, judge_accept: 2, judge_suppress_by_code: { 'covered-by-memory': 1 } },
      scheduled_checks: {
        'other-check': { last_run: '2026-06-30', consecutive_empty: 2 },
        [CHECK_ID]: {
          last_run: '2026-06-01',
          consecutive_empty: 3,
          last_error_at: '2026-06-15T00:00:00Z',
        },
      },
    };
    fs.writeFileSync(stateFile, JSON.stringify(existing, null, 2) + '\n');
    const r = await runCursor(stateFile, CHECK_ID);
    expect(r.exitCode).toBe(0);
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    const expected = structuredClone(existing);
    expected.scheduled_checks[CHECK_ID].last_run = '2026-07-20';
    expect(after).toEqual(expected);
  }));

  test('missing id argument → exit 1 with usage on stderr', withTmp(async (stateFile) => {
    const r = await runCursor(stateFile);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Usage');
    expect(r.stderr).toContain('--scheduled-check-run');
    expect(fs.existsSync(stateFile)).toBe(false);
  }));
});

// update-reflection-state.ts is reachable through a pre-approved
// `Bash(bun */scripts/update-reflection-state.ts*)` grant that covers every
// argument — the worst-shaped instance of this defect class, since its argv
// is a file path, not a directory (see docs/security.md § Script Argument
// Trust). Containment (assertUnderStateDir), not equality: a caller may
// legitimately pass a file several levels under the pinned root.
describe('update-reflection-state: state-dir pin', () => {
  test('refuses a state file belonging to another project', withTmp(async (myStateFile) => {
    const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-reflcursor-victim-'));
    const victimFile = path.join(victimDir, 'reflection-state.json');
    const before = JSON.stringify({ scheduled_checks: { [CHECK_ID]: { last_run: '2020-01-01' } } });
    fs.writeFileSync(victimFile, before);
    try {
      // AGENT_DIR pins hermitDir() to my own project's dir; argv still names the victim file.
      const r = await runScript('update-reflection-state.ts', {
        args: [victimFile, '--scheduled-check-run', CHECK_ID],
        env: { AGENT_DIR: path.dirname(myStateFile), HERMIT_NOW: NOW },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('state file must be under');
      expect(fs.readFileSync(victimFile, 'utf-8')).toBe(before);
    } finally {
      fs.rmSync(victimDir, { recursive: true, force: true });
    }
  }));
});
