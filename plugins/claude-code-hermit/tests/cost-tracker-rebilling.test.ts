// Tests for cost-tracker's re-billing guards: a Stop hook that reads a transcript
// mid-flush must never bill an OLDER turn again under a fresh timestamp. Measured live:
// a pre-compaction turn re-billed hours later, whose dead 173k context then drove a
// watchdog compaction of a context 47k under the threshold.
//
// Subprocess-driven (like cost-tracker.test.ts) — cost-tracker.ts resolves HERMIT_DIR at
// load time, so an in-process import would bind the wrong cwd.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';

function assistantEntry(timestamp: string, cacheRead: number, cacheWrite = 0, outputTokens = 50): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
        output_tokens: outputTokens,
      },
      content: [{ type: 'text', text: 'ok' }],
    },
  });
}

function triggerPrompt(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: text } });
}

function compactBoundary(timestamp: string, preTokens: number, postTokens: number): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    timestamp,
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens, postTokens },
  });
}

type Case = {
  /** Write the transcript; `trailingPartial` appends a half-flushed record. */
  writeTranscript(lines: string[], opts?: { trailingPartial?: boolean }): void;
  /** Seed the cost log with pre-existing rows. */
  seedCostLog(rows: any[]): void;
  /** Run one Stop-hook invocation of cost-tracker. */
  run(): Promise<void>;
  /** Main (non-subagent) cost-log rows written so far. */
  mainRows(): any[];
};

// Per-test hermit dir — a module-level one leaks between tests, and cost-tracker's
// subprocess spawns against it while the next test's cleanup is racing.
function withCase(fn: (c: Case) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-rebilling-'));
    const logPath = path.join(dir, '.claude', 'cost-log.jsonl');
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    try {
      fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
      const stateDir = path.join(dir, '.claude-code-hermit', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'runtime.json'),
        JSON.stringify({ session_id: 'test-session', session_state: 'active' }));

      await fn({
        writeTranscript(lines, opts = {}) {
          let body = lines.join('\n') + '\n';
          if (opts.trailingPartial) body += '{"type":"assistant","message":{"usage":{"input_';
          fs.writeFileSync(transcriptPath, body);
        },
        seedCostLog(rows) {
          fs.writeFileSync(logPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
        },
        async run() {
          const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
          await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
        },
        mainRows() {
          if (!fs.existsSync(logPath)) return [];
          return fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
            .map(l => JSON.parse(l)).filter(r => r.subagent !== true);
        },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe('cost-tracker: transcript-not-ready guards', () => {
  test('a half-written trailing record bills nothing', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('older turn'),
      assistantEntry('2026-08-02T11:32:06.830Z', 173_240),
    ], { trailingPartial: true });

    await c.run();

    expect(c.mainRows()).toHaveLength(0);
  }));

  test('a compaction boundary newer than the last usage bills nothing', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('pre-compaction turn'),
      assistantEntry('2026-08-02T11:32:06.830Z', 173_240),
      compactBoundary('2026-08-02T12:31:54.377Z', 173_921, 30_000),
    ]);

    await c.run();

    expect(c.mainRows()).toHaveLength(0);
  }));

  test('a queued next-turn prompt after the billed turn still bills once', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('turn one'),
      assistantEntry('2026-08-02T19:30:31.797Z', 29_313, 73_918),
      triggerPrompt('queued follow-up, not answered yet'),
    ]);

    await c.run();

    expect(c.mainRows()).toHaveLength(1);
  }));
});

describe('cost-tracker: duplicate-turn guard', () => {
  test('re-running against an unchanged transcript does not bill twice', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('turn one'),
      assistantEntry('2026-08-02T19:30:31.797Z', 29_313, 73_918),
    ]);

    await c.run();
    await c.run();

    expect(c.mainRows()).toHaveLength(1);
  }));

  test('a newly appended turn bills again', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('turn one'),
      assistantEntry('2026-08-02T19:30:31.797Z', 29_313, 73_918),
    ]);
    await c.run();

    c.writeTranscript([
      triggerPrompt('turn one'),
      assistantEntry('2026-08-02T19:30:31.797Z', 29_313, 73_918),
      triggerPrompt('turn two'),
      assistantEntry('2026-08-02T19:45:00.000Z', 103_298),
    ]);
    await c.run();

    const rows = c.mainRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].observed_at).toBe('2026-08-02T19:45:00.000Z');
  }));

  test('a legacy last row without observed_at never blocks the next bill', withCase(async c => {
    // Shaped like the row that caused the live incident: a re-billed pre-compaction turn.
    c.seedCostLog([{
      timestamp: '2026-08-02T19:30:31.923Z',
      session_id: 'test-session',
      source: 'other',
      model: 'sonnet',
      input_tokens: 12,
      cache_write_tokens: 3106,
      cache_read_tokens: 1_035_114,
      output_tokens: 1913,
      total_tokens: 1_040_145,
      api_calls: 6,
      max_prompt_tokens: 173_831,
      estimated_cost_usd: 0.35,
    }]);

    c.writeTranscript([
      triggerPrompt('first turn after upgrade'),
      assistantEntry('2026-08-02T19:00:00.000Z', 103_298),
    ]);
    await c.run();

    expect(c.mainRows()).toHaveLength(2);
  }));
});

describe('cost-tracker: context signal', () => {
  test('the row carries observed_at and the newest call prompt size', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('turn one'),
      assistantEntry('2026-08-02T19:30:31.797Z', 29_313, 73_918),
    ]);

    await c.run();

    const [row] = c.mainRows();
    expect(row.observed_at).toBe('2026-08-02T19:30:31.797Z');
    expect(row.last_call_prompt_tokens).toBe(29_313 + 73_918 + 2);
  }));

  test('a turn spanning a compaction bills every call but reports only the newest context', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('long turn that compacts mid-flight'),
      assistantEntry('2026-08-02T19:00:00.000Z', 170_000),
      compactBoundary('2026-08-02T19:10:00.000Z', 173_921, 30_000),
      assistantEntry('2026-08-02T19:20:00.000Z', 30_000),
    ]);

    await c.run();

    const [row] = c.mainRows();
    expect(row.api_calls).toBe(2);                       // billing still covers both calls
    expect(row.max_prompt_tokens).toBe(170_002);         // turn peak — the dead context
    expect(row.last_call_prompt_tokens).toBe(30_002);    // what the hygiene tiers must see
  }));
});
