// Tests for the fixed-surface derivation: lib/context-surface.ts I/O plus the
// cost-tracker end of it (maybeDeriveSurface) driven end-to-end through one
// Stop-hook invocation against a fixture transcript. Subprocess-driven for the
// e2e half (cost-tracker resolves HERMIT_DIR at load time); in-process for the
// lib I/O half (path-parameterized).

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { readContextSurface, writeContextSurface, contextSurfacePath } from '../scripts/lib/context-surface';

function assistantEntry(timestamp: string, cacheRead: number, cacheWrite = 0, inputTokens = 2): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
        output_tokens: 50,
      },
      content: [{ type: 'text', text: 'ok' }],
    },
  });
}

function triggerPrompt(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: text } });
}

function compactBoundary(timestamp: string, postTokens: any): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    timestamp,
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens: 150000, postTokens },
  });
}

function withHermitDir(fn: (dir: string, hermitDir: string) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-surface-'));
    const hermitDir = path.join(dir, '.claude-code-hermit');
    try {
      fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
      fs.writeFileSync(path.join(hermitDir, 'state', 'runtime.json'),
        JSON.stringify({ session_id: 'test-session', session_state: 'active' }));
      await fn(dir, hermitDir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function runCostTracker(dir: string, transcriptLines: string[]) {
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');
  const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
  await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
}

describe('context-surface lib I/O', () => {
  test('write/read round-trip, PID temp cleaned, mode 0600', withHermitDir(async (_dir, hermitDir) => {
    const rec = {
      surface_upper_bound_tokens: 65_000, post_tokens: 30_000,
      boundary_at: '2026-08-11T00:00:00Z', observed_at: '2026-08-11T00:01:00Z', prev: null,
    };
    writeContextSurface(hermitDir, rec);
    expect(readContextSurface(hermitDir)).toEqual(rec);
    const p = contextSurfacePath(hermitDir);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${p}.${process.pid}.tmp`)).toBe(false);
  }));

  test('missing, malformed, and implausible files read as null', withHermitDir(async (_dir, hermitDir) => {
    expect(readContextSurface(hermitDir)).toBeNull();
    const p = contextSurfacePath(hermitDir);
    fs.writeFileSync(p, '{ truncated');
    expect(readContextSurface(hermitDir)).toBeNull();
    fs.writeFileSync(p, JSON.stringify({ surface_upper_bound_tokens: -5 }));
    expect(readContextSurface(hermitDir)).toBeNull();
    fs.writeFileSync(p, JSON.stringify({ surface_upper_bound_tokens: 'lots' }));
    expect(readContextSurface(hermitDir)).toBeNull();
  }));
});

describe('cost-tracker surface derivation', () => {
  test('derives from earliest post-boundary call minus postTokens', withHermitDir(async (dir, hermitDir) => {
    await runCostTracker(dir, [
      triggerPrompt('before'),
      assistantEntry('2026-08-11T10:00:00Z', 140_000),
      compactBoundary('2026-08-11T10:05:00Z', 30_000),
      triggerPrompt('wake'),
      assistantEntry('2026-08-11T10:06:00Z', 95_000), // earliest: surface = 95_002 − 30_000
      assistantEntry('2026-08-11T10:07:00Z', 99_000), // later, larger — must NOT be used
    ]);
    const rec = readContextSurface(hermitDir);
    expect(rec).not.toBeNull();
    expect(rec!.surface_upper_bound_tokens).toBe(65_002);
    expect(rec!.post_tokens).toBe(30_000);
    expect(rec!.boundary_at).toBe('2026-08-11T10:05:00Z');
    expect(rec!.prev).toBeNull();
  }), 20000);

  test('unchanged boundary is a no-op; new boundary rotates prev', withHermitDir(async (dir, hermitDir) => {
    const lines = [
      compactBoundary('2026-08-11T10:05:00Z', 30_000),
      triggerPrompt('wake'),
      assistantEntry('2026-08-11T10:06:00Z', 95_000),
    ];
    await runCostTracker(dir, lines);
    const first = readContextSurface(hermitDir)!;
    await runCostTracker(dir, [...lines, assistantEntry('2026-08-11T10:08:00Z', 99_000)]);
    // Same boundary → record untouched (still the earliest-call derivation)
    expect(readContextSurface(hermitDir)).toEqual(first);

    await runCostTracker(dir, [
      ...lines,
      compactBoundary('2026-08-11T12:00:00Z', 31_000),
      triggerPrompt('wake2'),
      assistantEntry('2026-08-11T12:01:00Z', 97_000),
    ]);
    const second = readContextSurface(hermitDir)!;
    expect(second.boundary_at).toBe('2026-08-11T12:00:00Z');
    expect(second.surface_upper_bound_tokens).toBe(66_002);
    expect(second.prev).toEqual({ surface_upper_bound_tokens: first.surface_upper_bound_tokens, boundary_at: first.boundary_at });
  }), 20000);

  test('missing, non-numeric, or non-positive postTokens writes nothing', withHermitDir(async (dir, hermitDir) => {
    for (const bad of [undefined, 'many', 0, -3] as any[]) {
      await runCostTracker(dir, [
        compactBoundary('2026-08-11T10:05:00Z', bad),
        triggerPrompt('wake'),
        assistantEntry('2026-08-11T10:06:00Z', 95_000),
      ]);
    }
    expect(readContextSurface(hermitDir)).toBeNull();
  }), 20000);

  test('non-positive derived surface keeps the previous record', withHermitDir(async (dir, hermitDir) => {
    const good = {
      surface_upper_bound_tokens: 65_000, post_tokens: 30_000,
      boundary_at: '2026-08-11T09:00:00Z', observed_at: '2026-08-11T09:01:00Z', prev: null,
    };
    writeContextSurface(hermitDir, good);
    await runCostTracker(dir, [
      compactBoundary('2026-08-11T10:05:00Z', 200_000), // postTokens > first call → surface ≤ 0
      triggerPrompt('wake'),
      assistantEntry('2026-08-11T10:06:00Z', 95_000),
    ]);
    expect(readContextSurface(hermitDir)).toEqual(good);
  }), 20000);

  test('no boundary in the tail writes nothing', withHermitDir(async (dir, hermitDir) => {
    await runCostTracker(dir, [
      triggerPrompt('plain'),
      assistantEntry('2026-08-11T10:06:00Z', 95_000),
    ]);
    expect(readContextSurface(hermitDir)).toBeNull();
  }), 20000);
});
