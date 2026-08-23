// Contract tests for the rc-server spawn-gate verb.
// Covers gc (the only subcommand with real logic that runs without a live
// Remote Control server), status against a fake tmux, and argument handling.
// No live RC server is started here — `start` is exercised manually.
//
// Usage: bun test tests/rc-server.test.ts   (from the plugin root)

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runScript } from './helpers/run';
import { setupGitWorkdir } from './helpers/workdir';

// A fake `tmux` on PATH so status/gc never touch the real server.
function fakeTmux(dir: string, exitCode: number): string {
  const binDir = path.join(dir, 'fakebin');
  fs.mkdirSync(binDir, { recursive: true });
  const tmux = path.join(binDir, 'tmux');
  fs.writeFileSync(tmux, `#!/bin/sh\nexit ${exitCode}\n`);
  fs.chmodSync(tmux, 0o755);
  return `${binDir}:${process.env.PATH ?? ''}`;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' });
}

async function rcServer(dir: string, args: string[], pathOverride?: string) {
  return runScript('rc-server.ts', {
    args,
    cwd: dir,
    env: { PATH: pathOverride ?? fakeTmux(dir, 1) },
  });
}

describe('rc-server.ts', () => {
  it('gc removes an orphaned locked bridge worktree and its branch', async () => {
    const wd = setupGitWorkdir();
    try {
      const wt = path.join(wd.dir, '.claude', 'worktrees', 'bridge-fake123');
      // Branch name deliberately unrelated to the directory name: gc must read
      // the branch from `git worktree list`, not derive it from the path.
      git(wd.dir, 'worktree', 'add', '-q', '-b', 'cse-session-xyz', wt);
      git(wd.dir, 'worktree', 'lock', wt);

      const res = await rcServer(wd.dir, ['gc']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('removed bridge-fake123');
      expect(fs.existsSync(wt)).toBe(false);
      expect(git(wd.dir, 'branch', '--list', 'cse-session-xyz').trim()).toBe('');
    } finally {
      wd.cleanup();
    }
  });

  it('gc on a repo with no bridge worktrees is a silent no-op', async () => {
    const wd = setupGitWorkdir();
    try {
      const res = await rcServer(wd.dir, ['gc']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe('');
    } finally {
      wd.cleanup();
    }
  });

  it('gc leaves a bridge worktree that a live process is sitting in', async () => {
    const wd = setupGitWorkdir();
    try {
      const wt = path.join(wd.dir, '.claude', 'worktrees', 'bridge-live456');
      git(wd.dir, 'worktree', 'add', '-q', '-b', 'worktree-bridge-live456', wt);

      // A live process whose cwd IS the worktree — the liveness signal gc reads.
      const holder = Bun.spawn({ cmd: ['sleep', '30'], cwd: wt });
      try {
        const res = await rcServer(wd.dir, ['gc']);
        expect(res.exitCode).toBe(0);
        expect(res.stdout).not.toContain('bridge-live456');
        expect(fs.existsSync(wt)).toBe(true);
      } finally {
        holder.kill();
      }
    } finally {
      wd.cleanup();
    }
  });

  it('status reports down when no gate session exists', async () => {
    const wd = setupGitWorkdir();
    try {
      const res = await rcServer(wd.dir, ['status']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe('down');
    } finally {
      wd.cleanup();
    }
  });

  it('unknown subcommand exits 2 with usage', async () => {
    const wd = setupGitWorkdir();
    try {
      const res = await rcServer(wd.dir, ['bogus']);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain('Usage: hermit-run rc-server');
    } finally {
      wd.cleanup();
    }
  });

  it('missing subcommand exits 2', async () => {
    const wd = setupGitWorkdir();
    try {
      const res = await rcServer(wd.dir, []);
      expect(res.exitCode).toBe(2);
    } finally {
      wd.cleanup();
    }
  });
});
