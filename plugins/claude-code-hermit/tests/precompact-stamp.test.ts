// precompact-stamp.test.ts — PreCompact hook: stamps SHELL.md's Progress Log with a
// breadcrumb before Claude Code compacts context, and only ever on a genuine PreCompact
// payload with a recognized trigger. See scripts/precompact-stamp.ts and
// scripts/lib/progress-log.ts.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runScript } from './helpers/run';

function makeDir(): string {
  const hermitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-precompact-'));
  fs.mkdirSync(path.join(hermitDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(hermitDir, 'sessions', 'SHELL.md'), '## Progress Log\n', 'utf-8');
  fs.writeFileSync(path.join(hermitDir, 'config.json'), JSON.stringify({ timezone: 'UTC' }), 'utf-8');
  return hermitDir;
}

async function runHook(stdin: string, hermitDir: string) {
  return runScript('precompact-stamp.ts', { stdin, env: { AGENT_DIR: hermitDir } });
}

describe('precompact-stamp: valid PreCompact payloads', () => {
  test('trigger:"auto" writes a breadcrumb, empty stdout, exit 0', async () => {
    const hermitDir = makeDir();
    try {
      const shellPath = path.join(hermitDir, 'sessions', 'SHELL.md');
      const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto' }), hermitDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      const shell = fs.readFileSync(shellPath, 'utf-8');
      expect(shell).toContain('context compacted (auto)');
      expect(shell).toContain('arc may have unfinished work');
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('trigger:"manual" writes a breadcrumb, empty stdout, exit 0', async () => {
    const hermitDir = makeDir();
    try {
      const shellPath = path.join(hermitDir, 'sessions', 'SHELL.md');
      const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'manual' }), hermitDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      const shell = fs.readFileSync(shellPath, 'utf-8');
      expect(shell).toContain('context compacted (manual)');
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });
});

// The breadcrumb is prose for the next session; this stamp is what stops the watchdog
// acting on a cost entry that describes the context this compaction just replaced. For an
// operator-typed or native-auto compaction it is the ONLY signal — the watchdog's own
// stamps cover the compactions it initiated.
describe('precompact-stamp: machine-readable reset stamp', () => {
  function runtimePath(hermitDir: string): string {
    return path.join(hermitDir, 'state', 'runtime.json');
  }

  function seedRuntime(hermitDir: string): void {
    fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
    fs.writeFileSync(runtimePath(hermitDir),
      JSON.stringify({ session_id: 'S-001', session_state: 'idle' }), 'utf-8');
  }

  test('a real compaction stamps last_context_reset_at without disturbing runtime state', async () => {
    const hermitDir = makeDir();
    try {
      seedRuntime(hermitDir);
      const before = new Date().toISOString();
      const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'manual' }), hermitDir);
      expect(result.exitCode).toBe(0);
      const runtime = JSON.parse(fs.readFileSync(runtimePath(hermitDir), 'utf-8'));
      expect(runtime.last_context_reset_at >= before).toBe(true);
      expect(runtime.session_id).toBe('S-001');       // never fabricates a partial runtime
      expect(runtime.session_state).toBe('idle');
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('a payload that writes no breadcrumb writes no stamp either', async () => {
    const hermitDir = makeDir();
    try {
      seedRuntime(hermitDir);
      await runHook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'bogus' }), hermitDir);
      const runtime = JSON.parse(fs.readFileSync(runtimePath(hermitDir), 'utf-8'));
      expect(runtime.last_context_reset_at).toBeUndefined();
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('a missing runtime.json fails open — breadcrumb still written, exit 0', async () => {
    const hermitDir = makeDir(); // no state/ dir at all
    try {
      const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto' }), hermitDir);
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(runtimePath(hermitDir))).toBe(false);
      const shell = fs.readFileSync(path.join(hermitDir, 'sessions', 'SHELL.md'), 'utf-8');
      expect(shell).toContain('context compacted (auto)');
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });
});

describe('precompact-stamp: no-op on anything that is not a genuine PreCompact payload', () => {
  test('malformed stdin: no write, no stdout, exit 0', async () => {
    const hermitDir = makeDir();
    try {
      const shellPath = path.join(hermitDir, 'sessions', 'SHELL.md');
      const before = fs.readFileSync(shellPath, 'utf-8');
      const result = await runHook('not json{{{', hermitDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(fs.readFileSync(shellPath, 'utf-8')).toBe(before);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('empty stdin: no write, no stdout, exit 0', async () => {
    const hermitDir = makeDir();
    try {
      const shellPath = path.join(hermitDir, 'sessions', 'SHELL.md');
      const before = fs.readFileSync(shellPath, 'utf-8');
      const result = await runHook('', hermitDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(fs.readFileSync(shellPath, 'utf-8')).toBe(before);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('wrong hook_event_name: no write', async () => {
    const hermitDir = makeDir();
    try {
      const shellPath = path.join(hermitDir, 'sessions', 'SHELL.md');
      const before = fs.readFileSync(shellPath, 'utf-8');
      const result = await runHook(JSON.stringify({ hook_event_name: 'SessionStart', trigger: 'auto' }), hermitDir);
      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(shellPath, 'utf-8')).toBe(before);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('invalid trigger value: no write', async () => {
    const hermitDir = makeDir();
    try {
      const shellPath = path.join(hermitDir, 'sessions', 'SHELL.md');
      const before = fs.readFileSync(shellPath, 'utf-8');
      const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'bogus' }), hermitDir);
      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(shellPath, 'utf-8')).toBe(before);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('missing trigger: no write', async () => {
    const hermitDir = makeDir();
    try {
      const shellPath = path.join(hermitDir, 'sessions', 'SHELL.md');
      const before = fs.readFileSync(shellPath, 'utf-8');
      const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact' }), hermitDir);
      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(shellPath, 'utf-8')).toBe(before);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });
});

describe('precompact-stamp: fail-open', () => {
  test('unwritable SHELL.md target does not crash the hook (still exit 0, no stdout)', async () => {
    // Point AGENT_DIR at a hermit dir whose sessions/SHELL.md path is actually a directory —
    // an unwritable-as-a-file target — and confirm the hook still exits cleanly.
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-precompact-bad-'));
    fs.mkdirSync(path.join(badDir, 'sessions', 'SHELL.md'), { recursive: true }); // SHELL.md is a directory, not a file
    fs.writeFileSync(path.join(badDir, 'config.json'), JSON.stringify({ timezone: 'UTC' }), 'utf-8');
    try {
      const result = await runScript('precompact-stamp.ts', {
        stdin: JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto' }),
        env: { AGENT_DIR: badDir },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });
});
