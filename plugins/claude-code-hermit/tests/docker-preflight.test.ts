import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-dpf-');
afterAll(cleanup);

async function run(projectRoot: string) {
  const r = await runScript('docker-preflight.ts', { args: [projectRoot] });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout);
}

describe('docker-preflight.ts', () => {
  test('clean project: stable shape, fail-open fields', async () => {
    const dir = freshDir();
    const out = await run(dir);

    // dockerVersion is host-dependent — string or null, never throws.
    expect(out.dockerVersion === null || typeof out.dockerVersion === 'string').toBe(true);
    expect(out.configExists).toBe(false);
    expect(out.existing).toEqual({ dockerfile: false, entrypoint: false, compose: false });
    expect(typeof out.gitconfigExists).toBe('boolean');
    // path key is derived from the project root passed in (mirrors `pwd | sed 's|/|-|g'`,
    // leading dash retained) — keyed off the supplied logical path, not a resolved one.
    expect(out.memory.pathKey).toBe(dir.replace(/\//g, '-'));
    expect(typeof out.memory.seedExists).toBe('boolean');
  });

  test('detects config.json and existing docker files', async () => {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '.claude-code-hermit'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-code-hermit', 'config.json'), '{}');
    fs.writeFileSync(path.join(dir, 'Dockerfile.hermit'), 'FROM ubuntu\n');
    fs.writeFileSync(path.join(dir, 'docker-compose.hermit.yml'), 'services: {}\n');

    const out = await run(dir);
    expect(out.configExists).toBe(true);
    expect(out.existing.dockerfile).toBe(true);
    expect(out.existing.compose).toBe(true);
    expect(out.existing.entrypoint).toBe(false);
  });
  // liveOwner mirrors the entrypoint's split-brain guard and hermit-start's
  // shouldRefuseBoot: a non-docker runtime_mode that is neither idle nor cleanly
  // shut down, backed by a liveness file inside the 600s freshness window.
  function seedOwner(dir: string, runtime: object, ageSecs = 0) {
    const stateDir = path.join(dir, '.claude-code-hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify(runtime));
    const liveness = path.join(stateDir, 'routine-monitor-liveness.json');
    fs.writeFileSync(liveness, '{}');
    if (ageSecs) {
      const when = new Date(Date.now() - ageSecs * 1000);
      fs.utimesSync(liveness, when, when);
    }
  }

  test('no runtime.json: no live owner', async () => {
    const out = await run(freshDir());
    expect(out.liveOwner).toBe(null);
  });

  test('live tmux owner: reported with mode and liveness age', async () => {
    const dir = freshDir();
    seedOwner(dir, { runtime_mode: 'tmux', session_state: 'active' });

    const out = await run(dir);
    expect(out.liveOwner.mode).toBe('tmux');
    expect(out.liveOwner.ageSecs).toBeGreaterThanOrEqual(0);
    expect(out.liveOwner.ageSecs).toBeLessThan(600);
  });

  // The reason liveOwner is not a call into shouldRefuseBoot: a running Docker
  // hermit is the supported case for re-running /docker-setup over an existing
  // container, so it must never gate the wizard.
  test('a live docker owner never gates the wizard', async () => {
    const dir = freshDir();
    seedOwner(dir, { runtime_mode: 'docker', session_state: 'active' });

    expect((await run(dir)).liveOwner).toBe(null);
  });

  test('cleanly-stopped owner is definitively dead, not live', async () => {
    const dir = freshDir();
    seedOwner(dir, { runtime_mode: 'tmux', session_state: 'idle' });

    expect((await run(dir)).liveOwner).toBe(null);
  });

  test('stale liveness proves nothing: no live owner', async () => {
    const dir = freshDir();
    seedOwner(dir, { runtime_mode: 'tmux', session_state: 'active' }, 660);

    expect((await run(dir)).liveOwner).toBe(null);
  });
});
