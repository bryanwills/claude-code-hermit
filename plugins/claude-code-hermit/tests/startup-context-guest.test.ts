// Residency branch in startup-context.ts's SessionStart injection.
// Verifies: the managed session (HERMIT_MANAGED=1) always gets the full
// framing; an unmanaged session in a project whose managed tmux session is
// alive gets the short guest banner and nothing else; and a dead or absent
// tmux session falls back to the full framing (fail-open).
//
// The tmux probe runs through spawnSync, so the fake tmux must be a real
// executable on PATH — an in-process PATH edit would not reach it.
//
// Usage: bun test tests/startup-context-guest.test.ts   (from the plugin root)

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir } from './helpers/workdir';

const SESSION = 'hermit-fixture';

// Writes a runtime.json naming the managed tmux session, plus a fake `tmux`
// on PATH that exits with `exitCode` for `has-session`. Returns the env
// overlay a run needs to see both.
function fixture(dir: string, opts: { tmuxSession?: string; tmuxExit?: number }): Record<string, string> {
  const stateDir = path.join(dir, '.claude-code-hermit', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'runtime.json'),
    JSON.stringify({ version: 1, session_state: 'idle', tmux_session: opts.tmuxSession ?? null }),
  );

  const binDir = path.join(dir, 'fakebin');
  fs.mkdirSync(binDir, { recursive: true });
  const tmux = path.join(binDir, 'tmux');
  fs.writeFileSync(tmux, `#!/bin/sh\nexit ${opts.tmuxExit ?? 0}\n`);
  fs.chmodSync(tmux, 0o755);

  return {
    AGENT_DIR: path.join(dir, '.claude-code-hermit'),
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };
}

async function run(dir: string, env: Record<string, string>, sessionId?: string) {
  const payload = sessionId === undefined ? {} : { session_id: sessionId };
  return runScript('startup-context.ts', { stdin: JSON.stringify(payload), env });
}

const markerFor = (dir: string, sessionId: string) =>
  path.join(dir, '.claude-code-hermit', 'state', `.guest-${sessionId}`);

describe('startup-context.ts — resident vs guest', () => {
  it('managed session gets the full framing even while its tmux session is alive', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0 });
      const res = await run(wd.dir, { ...env, HERMIT_MANAGED: '1' });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toContain('---Guest Session---');
      expect(res.stdout).toContain('---Active Session---');
    } finally {
      wd.cleanup();
    }
  });

  it('unmanaged session with a live resident gets the guest banner and nothing else', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0 });
      const res = await run(wd.dir, { ...env, HERMIT_MANAGED: '' });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('---Guest Session---');
      expect(res.stdout).toContain('a managed hermit session is already running here');
      expect(res.stdout).not.toContain('---Active Session---');
      expect(res.stdout.trim().split('\n').length).toBeLessThanOrEqual(8);
    } finally {
      wd.cleanup();
    }
  });

  it('unmanaged session with a dead resident gets the full framing', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 1 });
      const res = await run(wd.dir, { ...env, HERMIT_MANAGED: '' });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toContain('---Guest Session---');
      expect(res.stdout).toContain('---Active Session---');
    } finally {
      wd.cleanup();
    }
  });

  it('unmanaged session with no tmux_session recorded gets the full framing', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxExit: 0 });
      const res = await run(wd.dir, { ...env, HERMIT_MANAGED: '' });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toContain('---Guest Session---');
      expect(res.stdout).toContain('---Active Session---');
    } finally {
      wd.cleanup();
    }
  });
});

// The banner tells the model; the marker tells the state-writing hooks, which run
// per turn with no model in the loop.
describe('startup-context.ts — guest marker', () => {
  it('marks the guest session so the per-turn hooks can read the verdict', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0 });
      const res = await run(wd.dir, { ...env, HERMIT_MANAGED: '' }, 'sess-guest');
      expect(res.stdout).toContain('---Guest Session---');
      expect(fs.existsSync(markerFor(wd.dir, 'sess-guest'))).toBe(true);
    } finally {
      wd.cleanup();
    }
  });

  it('marks nothing for the resident or for a session with no live resident', async () => {
    const wd = setupWorkdir();
    try {
      const live = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0 });
      await run(wd.dir, { ...live, HERMIT_MANAGED: '1' }, 'sess-resident');
      expect(fs.existsSync(markerFor(wd.dir, 'sess-resident'))).toBe(false);

      const dead = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 1 });
      await run(wd.dir, { ...dead, HERMIT_MANAGED: '' }, 'sess-solo');
      expect(fs.existsSync(markerFor(wd.dir, 'sess-solo'))).toBe(false);
    } finally {
      wd.cleanup();
    }
  });

  it('marks nothing when the payload carries no session id', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0 });
      const res = await run(wd.dir, { ...env, HERMIT_MANAGED: '' });
      expect(res.stdout).toContain('---Guest Session---');
      const stateDir = path.join(wd.dir, '.claude-code-hermit', 'state');
      expect(fs.readdirSync(stateDir).filter(n => n.startsWith('.guest-'))).toEqual([]);
    } finally {
      wd.cleanup();
    }
  });

  it('clears its own marker once the resident is gone', async () => {
    const wd = setupWorkdir();
    try {
      const live = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0 });
      await run(wd.dir, { ...live, HERMIT_MANAGED: '' }, 'sess-guest');
      expect(fs.existsSync(markerFor(wd.dir, 'sess-guest'))).toBe(true);

      // Same session id, resident now dead — resume/clear/compact all re-fire SessionStart.
      const dead = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 1 });
      const res = await run(wd.dir, { ...dead, HERMIT_MANAGED: '' }, 'sess-guest');
      expect(res.stdout).not.toContain('---Guest Session---');
      expect(fs.existsSync(markerFor(wd.dir, 'sess-guest'))).toBe(false);
    } finally {
      wd.cleanup();
    }
  });

  it('prunes a marker left behind by a long-gone session', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0 });
      const stale = markerFor(wd.dir, 'sess-ancient');
      fs.writeFileSync(stale, 'old\n');
      const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
      fs.utimesSync(stale, old / 1000, old / 1000);

      await run(wd.dir, { ...env, HERMIT_MANAGED: '' }, 'sess-guest');

      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(markerFor(wd.dir, 'sess-guest'))).toBe(true);
    } finally {
      wd.cleanup();
    }
  });
});
