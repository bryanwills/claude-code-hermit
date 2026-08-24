// Unit tests for scripts/lib/progress-log.ts — the shared SHELL.md Progress Log
// append helper (extracted from reflect-precheck.ts) and flushResetBreadcrumb, the
// context-reset breadcrumb used by precompact-stamp.ts and hermit-watchdog.ts's
// emergency /clear path. Pure exported helpers, tested in-process.
//
// Usage: bun test tests/progress-log-lib.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendToProgressLog, flushResetBreadcrumb } from '../scripts/lib/progress-log';

function withTmpShell(fn: (shellPath: string) => void) {
  return () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-progresslog-'));
    const shellPath = path.join(dir, 'SHELL.md');
    fs.writeFileSync(shellPath, '## Progress Log\n', 'utf-8');
    try { fn(shellPath); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

describe('appendToProgressLog', () => {
  test('appends under the ## Progress Log marker', withTmpShell((shellPath) => {
    appendToProgressLog(shellPath, '- [10:00] did a thing');
    expect(fs.readFileSync(shellPath, 'utf-8')).toContain('- [10:00] did a thing');
  }));

  test('fail-open: missing file does not throw', () => {
    expect(() => appendToProgressLog('/nonexistent/dir/SHELL.md', '- [10:00] x')).not.toThrow();
  });

  test('concurrent appends from separate processes all survive', async () => {
    // The append rewrites the whole file from a buffer read a moment earlier, so
    // an unserialized loser does not merely drop its own line — it writes back its
    // stale read and reverts the winner's. Reachable on a schedule now that the
    // reflect wake gate runs reflect-precheck.ts inside the routine monitor, where
    // it can land on top of a watchdog or PreCompact flush.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-progresslog-race-'));
    try {
      const shellPath = path.join(dir, 'SHELL.md');
      fs.writeFileSync(shellPath, '## Progress Log\n', 'utf-8');
      const lib = path.resolve(import.meta.dir, '..', 'scripts', 'lib', 'progress-log.ts');
      const writer = path.join(dir, 'writer.ts');
      fs.writeFileSync(
        writer,
        `import { appendToProgressLog } from ${JSON.stringify(lib)};\n` +
        'appendToProgressLog(process.argv[2], process.argv[3]);\n',
        'utf-8',
      );

      const writers = Array.from({ length: 6 }, (_, i) =>
        Bun.spawn({
          cmd: [process.execPath, writer, shellPath, `- [10:0${i}] writer ${i}`],
          stdout: 'ignore',
          stderr: 'ignore',
        }));
      await Promise.all(writers.map((w) => w.exited));

      const shell = fs.readFileSync(shellPath, 'utf-8');
      for (let i = 0; i < writers.length; i++) expect(shell).toContain(`writer ${i}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});

describe('flushResetBreadcrumb', () => {
  test('kind:"compacted" writes a "context compacted" line with the trigger', withTmpShell((shellPath) => {
    flushResetBreadcrumb(shellPath, { kind: 'compacted', trigger: 'auto', hhmm: '10:00' });
    const shell = fs.readFileSync(shellPath, 'utf-8');
    expect(shell).toContain('- [10:00] context compacted (auto) — arc may have unfinished work');
  }));

  test('kind:"cleared" writes a "context cleared" line with the trigger', withTmpShell((shellPath) => {
    flushResetBreadcrumb(shellPath, { kind: 'cleared', trigger: 'watchdog-700k', hhmm: '23:45' });
    const shell = fs.readFileSync(shellPath, 'utf-8');
    expect(shell).toContain('- [23:45] context cleared (watchdog-700k) — arc may have unfinished work');
  }));

  test('tokens, when provided, render as an approximate k-token suffix', withTmpShell((shellPath) => {
    flushResetBreadcrumb(shellPath, { kind: 'cleared', trigger: 'watchdog-700k', hhmm: '23:45', tokens: 712_340 });
    const shell = fs.readFileSync(shellPath, 'utf-8');
    expect(shell).toContain('at ~712k tokens');
  }));

  test('omitted tokens produce no token suffix', withTmpShell((shellPath) => {
    flushResetBreadcrumb(shellPath, { kind: 'compacted', trigger: 'manual', hhmm: '09:00' });
    const shell = fs.readFileSync(shellPath, 'utf-8');
    expect(shell).not.toContain('tokens');
  }));

  test('a guest reset is labeled so the resident log keeps its provenance', withTmpShell((shellPath) => {
    flushResetBreadcrumb(shellPath, { kind: 'compacted', trigger: 'auto', hhmm: '09:00', guest: true });
    const shell = fs.readFileSync(shellPath, 'utf-8');
    expect(shell).toContain('context compacted (auto) — guest session — arc may have unfinished work');
  }));

  test('fail-open: unwritable target does not throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-progresslog-bad-'));
    try {
      const dirAsFile = path.join(dir, 'SHELL.md');
      fs.mkdirSync(dirAsFile); // SHELL.md is a directory, not a file — read/write will fail
      expect(() => flushResetBreadcrumb(dirAsFile, { kind: 'cleared', trigger: 'watchdog-700k', hhmm: '00:00' })).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
