// Regression tests for evaluate-session.ts's in_progress progress-nudge, which
// used to anchor the last date-less [HH:MM] Progress Log entry to the session's
// **Started:** date — inflating elapsed by 24h per session day on any session
// spanning midnight (false "No progress logged in Nh" stderr nudges).
//
// Usage: bun test tests/evaluate-session-stale.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, PLUGIN_ROOT } from './helpers/run';

function makeTmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-eval-session-stale-'));
  fs.mkdirSync(path.join(dir, '.claude-code-hermit', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude-code-hermit', 'sessions'), { recursive: true });
  return dir;
}

function withTmpdir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = makeTmpdir();
    try {
      await fn(dir);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  };
}

function seedHermit(dir: string, opts: { shell: string; sessionState?: string }) {
  const hd = path.join(dir, '.claude-code-hermit');
  fs.writeFileSync(
    path.join(hd, 'state', 'runtime.json'),
    JSON.stringify({ session_state: opts.sessionState ?? 'in_progress' }),
  );
  fs.writeFileSync(path.join(hd, 'sessions', 'SHELL.md'), opts.shell);
  return path.join(hd, 'sessions', 'SHELL.md');
}

const CROSS_MIDNIGHT_SHELL = `# Active Session

## Session Info
- **ID:** S-NNN (assigned on close)
- **Started:** 2026-07-13 20:00

## Progress Log
- [21:23] worked on queue item 1
- [14:38] resumed queue work
- [15:50] finished item 3

## Blockers
`;

const staleShell = (lastEntry: string) => `# Active Session

## Session Info
- **ID:** S-NNN (assigned on close)
- **Started:** 2026-07-13 20:00

## Progress Log
- [21:23] worked on queue item 1
- ${lastEntry}

## Blockers
`;

async function runEval(dir: string, hermitNow?: string) {
  const env: Record<string, string> = {
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    AGENT_HOOK_PROFILE: 'standard',
    TZ: 'UTC',
  };
  if (hermitNow) env.HERMIT_NOW = hermitNow;
  return runScript('evaluate-session.ts', { stdin: '{}', cwd: dir, env });
}

describe('evaluate-session: in_progress progress nudge (stale-timestamp regression)', () => {
  test('cross-midnight fresh activity does not nudge', withTmpdir(async (dir) => {
    seedHermit(dir, { shell: CROSS_MIDNIGHT_SHELL });
    const r = await runEval(dir, '2026-07-14T16:30:00Z');
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toMatch(/No progress logged/);
    expect(r.stderr).not.toMatch(/Session may be complete/);
  }));

  test('genuinely stale session nudges with correct elapsed hours', withTmpdir(async (dir) => {
    seedHermit(dir, { shell: staleShell('[09:00] last thing') });
    const r = await runEval(dir, '2026-07-14T15:00:00Z');
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/No progress logged in 6h/);
  }));

  test('midnight wraparound with a recent entry does not nudge', withTmpdir(async (dir) => {
    seedHermit(dir, { shell: staleShell('[23:50] late-night item') });
    const r = await runEval(dir, '2026-07-14T00:30:00Z');
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toMatch(/No progress logged/);
  }));

  test('SHELL.md untouched for 48h nudges "session may be complete"', withTmpdir(async (dir) => {
    const shellPath = seedHermit(dir, { shell: CROSS_MIDNIGHT_SHELL });
    const past = new Date(Date.now() - 72 * 3600 * 1000);
    fs.utimesSync(shellPath, past, past);
    const r = await runEval(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/Session may be complete/);
  }));

  test('idle session never nudges', withTmpdir(async (dir) => {
    seedHermit(dir, { shell: staleShell('[09:00] last thing'), sessionState: 'idle' });
    const r = await runEval(dir, '2026-07-14T15:00:00Z');
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toMatch(/No progress logged/);
    expect(r.stderr).not.toMatch(/Session may be complete/);
  }));
});
