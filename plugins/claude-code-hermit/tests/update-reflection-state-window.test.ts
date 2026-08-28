import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPinnedScript } from './helpers/run';

function withTmp(fn: (stateFile: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-reflwindow-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    try { await fn(path.join(dir, 'state', 'reflection-state.json')); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

const rootOf = (stateFile: string) => path.dirname(path.dirname(stateFile));

function writeState(stateFile: string, state: unknown) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
}

function readState(stateFile: string) {
  return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
}

async function runPayload(stateFile: string, payload: Record<string, unknown>) {
  const result = await runPinnedScript(
    'update-reflection-state.ts',
    rootOf(stateFile),
    [stateFile, JSON.stringify({ ran_with_candidates: true, ...payload })],
  );
  expect(result.exitCode).toBe(0);
  return readState(stateFile);
}

describe('update-reflection-state judge window', () => {
  test('first verdict-bearing run creates the window with derived sums and since', withTmp(async (stateFile) => {
    const state = await runPayload(stateFile, { judge_accept: 2, judge_downgrade: 1, judge_suppress: 3 });
    const window = state.counters.judge_window;

    expect(window.runs).toHaveLength(1);
    expect(window.runs[0]).toEqual({
      at: window.runs[0].at,
      accept: 2,
      downgrade: 1,
      suppress: 3,
    });
    expect(Number.isNaN(Date.parse(window.runs[0].at))).toBe(false);
    expect(window).toMatchObject({ accept: 2, downgrade: 1, suppress: 3, verdicts: 6 });
    expect(window.since).toBe(window.runs[0].at);
  }));

  test('a zero-verdict run preserves an existing window and does not create one when absent', withTmp(async (stateFile) => {
    const existingWindow = {
      runs: [{ at: '2026-08-01T00:00:00.000Z', accept: 3, downgrade: 1, suppress: 2 }],
      accept: 3,
      downgrade: 1,
      suppress: 2,
      verdicts: 6,
      since: '2026-08-01T00:00:00.000Z',
    };
    writeState(stateFile, { counters: { judge_window: existingWindow } });

    const existing = await runPayload(stateFile, {});
    expect(existing.counters.judge_window).toEqual(existingWindow);

    writeState(stateFile, { counters: {} });
    const absent = await runPayload(stateFile, {});
    expect(absent.counters).not.toHaveProperty('judge_window');
  }));

  test('trimming keeps whole runs and never takes the remainder below 20 verdicts', withTmp(async (stateFile) => {
    for (let run = 0; run < 3; run += 1) {
      await runPayload(stateFile, { judge_accept: 8 });
    }
    const initialWindow = readState(stateFile).counters.judge_window;
    expect(initialWindow.runs).toHaveLength(3);
    expect(initialWindow.verdicts).toBe(24);

    await runPayload(stateFile, { judge_accept: 8 });
    const window = readState(stateFile).counters.judge_window;
    expect(window.runs).toHaveLength(3);
    expect(window.verdicts).toBe(24);
  }));

  test('reported sums equal the surviving runs after the window advances', withTmp(async (stateFile) => {
    const payloads = [
      { judge_accept: 8 },
      { judge_downgrade: 5, judge_suppress: 3 },
      { judge_accept: 2, judge_suppress: 6 },
      { judge_accept: 4, judge_downgrade: 3, judge_suppress: 1 },
    ];
    for (const payload of payloads) await runPayload(stateFile, payload);

    const window = readState(stateFile).counters.judge_window;
    const sums = window.runs.reduce((total: any, run: any) => ({
      accept: total.accept + run.accept,
      downgrade: total.downgrade + run.downgrade,
      suppress: total.suppress + run.suppress,
    }), { accept: 0, downgrade: 0, suppress: 0 });
    expect(window).toMatchObject(sums);
    expect(window.verdicts).toBe(sums.accept + sums.downgrade + sums.suppress);
  }));

  test('cumulative judge tallies keep growing past the window totals', withTmp(async (stateFile) => {
    writeState(stateFile, { counters: { judge_suppress: 40, judge_accept: 2 } });
    for (let run = 0; run < 3; run += 1) {
      await runPayload(stateFile, { judge_accept: 3, judge_suppress: 1 });
    }

    const counters = readState(stateFile).counters;
    expect(counters.judge_window).toMatchObject({ accept: 9, suppress: 3 });
    expect(counters.judge_accept).toBe(11);
    expect(counters.judge_suppress).toBe(43);
  }));

  test('a malformed window is replaced by a fresh ring', withTmp(async (stateFile) => {
    writeState(stateFile, { counters: { judge_window: 'malformed' } });
    const state = await runPayload(stateFile, { judge_accept: 1, judge_suppress: 2 });

    expect(state.counters.judge_window.runs).toHaveLength(1);
    expect(state.counters.judge_window).toMatchObject({
      accept: 1,
      downgrade: 0,
      suppress: 2,
      verdicts: 3,
    });
  }));

  test('--reset-counters clears the judge window and stamps judge_since', withTmp(async (stateFile) => {
    writeState(stateFile, {
      counters: {
        judge_accept: 3,
        judge_suppress: 2,
        judge_window: {
          runs: [{ at: '2026-08-01T00:00:00.000Z', accept: 3, downgrade: 0, suppress: 2 }],
          accept: 3,
          downgrade: 0,
          suppress: 2,
          verdicts: 5,
          since: '2026-08-01T00:00:00.000Z',
        },
      },
    });

    const result = await runPinnedScript(
      'update-reflection-state.ts',
      rootOf(stateFile),
      [stateFile, '--reset-counters'],
    );
    expect(result.exitCode).toBe(0);
    const counters = readState(stateFile).counters;
    expect(counters).not.toHaveProperty('judge_window');
    expect(typeof counters.judge_since).toBe('string');
  }));
});
