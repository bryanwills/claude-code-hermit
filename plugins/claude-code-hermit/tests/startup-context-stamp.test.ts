// Launch stamp in startup-context.ts's SessionStart injection.
// Verifies: the managed session records the config dir and auth-env shape it
// actually resolved into state/runtime.json, an unmanaged session records
// nothing, and no credential value is ever written.
//
// Why the hook and not hermit-start: the watchdog that later reads these fields
// runs from a systemd unit / launchd job / cron entry carrying only PATH, and a
// CLAUDE_CONFIG_DIR set in user or managed settings never passes through
// hermit-start's environment at all. Only a process inside the session sees it.
//
// Usage: bun test tests/startup-context-stamp.test.ts   (from the plugin root)

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir } from './helpers/workdir';

const API_KEY = 'sk-ant-api03-fixture-value';

function runtimePath(dir: string): string {
  return path.join(dir, '.claude-code-hermit', 'state', 'runtime.json');
}

function seedRuntime(dir: string): void {
  fs.writeFileSync(
    runtimePath(dir),
    JSON.stringify({ version: 1, session_state: 'idle', tmux_session: null }),
  );
}

const readRuntime = (dir: string) => JSON.parse(fs.readFileSync(runtimePath(dir), 'utf-8'));

async function run(dir: string, env: Record<string, string>) {
  return runScript('startup-context.ts', {
    stdin: JSON.stringify({ source: 'startup' }),
    env: { AGENT_DIR: path.join(dir, '.claude-code-hermit'), ...env },
  });
}

describe('startup-context.ts — session launch stamp', () => {
  it('managed session records its config dir and auth-env shape, never the secret', async () => {
    const wd = setupWorkdir();
    try {
      seedRuntime(wd.dir);
      const configDir = path.join(wd.dir, 'session-config');
      const res = await run(wd.dir, {
        HERMIT_MANAGED: '1',
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_API_KEY: API_KEY,
      });
      expect(res.exitCode).toBe(0);
      const runtime = readRuntime(wd.dir);
      expect(runtime.config_dir).toBe(configDir);
      expect(runtime.env_auth).toBe(true);
      // Lifecycle fields survive the read-modify-write.
      expect(runtime.session_state).toBe('idle');
      expect(fs.readFileSync(runtimePath(wd.dir), 'utf-8')).not.toContain(API_KEY);
    } finally {
      wd.cleanup();
    }
  });

  it('no config dir in the environment → the CLI default is recorded', async () => {
    const wd = setupWorkdir();
    try {
      seedRuntime(wd.dir);
      const res = await run(wd.dir, {
        HERMIT_MANAGED: '1',
        HOME: wd.dir,
        CLAUDE_CONFIG_DIR: '',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
      });
      expect(res.exitCode).toBe(0);
      const runtime = readRuntime(wd.dir);
      expect(runtime.config_dir).toBe(path.join(wd.dir, '.claude'));
      expect(runtime.env_auth).toBe(false);
    } finally {
      wd.cleanup();
    }
  });

  // A compaction fires SessionStart too. Re-stamping identical values would move
  // updated_at, and doctor reads that as proof the session is doing work — so a
  // wedged hermit that keeps auto-compacting would stop looking stale.
  it('unchanged values → the record is left alone, updated_at does not move', async () => {
    const wd = setupWorkdir();
    try {
      seedRuntime(wd.dir);
      const env = { HERMIT_MANAGED: '1', CLAUDE_CONFIG_DIR: path.join(wd.dir, 'session-config') };
      expect((await run(wd.dir, env)).exitCode).toBe(0);
      const first = readRuntime(wd.dir);
      expect(first.updated_at).toBeTruthy();

      fs.writeFileSync(runtimePath(wd.dir), JSON.stringify({ ...first, updated_at: 'sentinel' }));
      expect((await run(wd.dir, env)).exitCode).toBe(0);
      expect(readRuntime(wd.dir).updated_at).toBe('sentinel');
    } finally {
      wd.cleanup();
    }
  });

  // A hand-launched session in the same folder must not overwrite the record
  // describing the managed one — the watchdog only ever diagnoses the latter.
  it('unmanaged session stamps nothing', async () => {
    const wd = setupWorkdir();
    try {
      seedRuntime(wd.dir);
      const res = await run(wd.dir, {
        CLAUDE_CONFIG_DIR: path.join(wd.dir, 'guest-config'),
        ANTHROPIC_API_KEY: API_KEY,
      });
      expect(res.exitCode).toBe(0);
      const runtime = readRuntime(wd.dir);
      expect(runtime.config_dir).toBeUndefined();
      expect(runtime.env_auth).toBeUndefined();
    } finally {
      wd.cleanup();
    }
  });

  // runtime.json is hermit-start's to create; a hook must never conjure a
  // lifecycle record that would make a never-booted project look live.
  it('no runtime.json → none is created', async () => {
    const wd = setupWorkdir();
    try {
      const res = await run(wd.dir, { HERMIT_MANAGED: '1', CLAUDE_CONFIG_DIR: wd.dir });
      expect(res.exitCode).toBe(0);
      expect(fs.existsSync(runtimePath(wd.dir))).toBe(false);
    } finally {
      wd.cleanup();
    }
  });
});
