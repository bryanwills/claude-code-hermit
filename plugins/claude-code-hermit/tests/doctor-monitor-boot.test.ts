import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { checkHeartbeat, checkRoutineMonitor, resolvePaths } from '../scripts/doctor-check';
import { freshDirFactory } from './helpers/workdir';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const { freshDir, cleanup } = freshDirFactory('doctor-monitor-boot-');
afterAll(cleanup);

type FixtureOpts = {
  bootId?: string | null;
  heartbeatBootId?: string | null;
  routineBootId?: string | null;
  routineMode?: string;
};

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value));
}

/** Per-monitor override wins; explicit null omits boot_id entirely; undefined falls back to the shared id. */
function resolveBootId(specific: string | null | undefined, fallback: string | null | undefined): string | undefined {
  if (specific !== null && specific !== undefined) return specific;
  if (specific === undefined && fallback) return fallback;
  return undefined;
}

function fixture(opts: FixtureOpts = {}) {
  const dir = freshDir();
  const hermitDir = path.join(dir, '.claude-code-hermit');
  const stateDir = path.join(hermitDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  writeJson(path.join(hermitDir, 'config.json'), {
    heartbeat: { enabled: true, every: '30m' },
    routines: [
      { id: 'doctor', enabled: true, schedule: '10 9 * * 1', skill: 'claude-code-hermit:hermit-doctor' },
    ],
  });
  writeJson(path.join(stateDir, 'runtime.json'), {
    version: 1,
    session_state: 'in_progress',
    runtime_mode: 'interactive',
  });

  const now = new Date().toISOString();
  const heartbeatRuntime: Record<string, unknown> = {
    description: 'heartbeat-monitor',
    started_at: now,
    interval: 1800,
  };
  const heartbeatBootId = resolveBootId(opts.heartbeatBootId, opts.bootId);
  if (heartbeatBootId !== undefined) heartbeatRuntime.boot_id = heartbeatBootId;
  writeJson(path.join(stateDir, 'heartbeat-monitor.runtime.json'), heartbeatRuntime);
  writeJson(path.join(stateDir, 'heartbeat-liveness.json'), { last_peek_at: now });

  const routineRuntime: Record<string, unknown> = {
    description: 'routine-monitor',
    mode: opts.routineMode ?? 'monitor',
    started_at: now,
    interval: 60,
  };
  const routineBootId = resolveBootId(opts.routineBootId, opts.bootId);
  if (routineBootId !== undefined) routineRuntime.boot_id = routineBootId;
  writeJson(path.join(stateDir, 'routine-monitor.runtime.json'), routineRuntime);
  writeJson(path.join(stateDir, 'routine-monitor-liveness.json'), { last_peek_at: now });

  if (opts.bootId) {
    fs.writeFileSync(path.join(stateDir, '.boot-id'), opts.bootId + '\n');
  }

  return resolvePaths(hermitDir, PLUGIN_ROOT);
}

describe('doctor monitor boot gate', () => {
  test('a runtime boot_id from a previous boot fails both checks', () => {
    const p = fixture({
      bootId: 'boot-current',
      heartbeatBootId: 'boot-old',
      routineBootId: 'boot-old',
    });

    const heartbeat = checkHeartbeat(p);
    expect(heartbeat.status).toBe('fail');
    expect(heartbeat.detail).toContain('previous boot');
    expect(heartbeat.detail).toContain('/claude-code-hermit:heartbeat start');

    const routine = checkRoutineMonitor(p);
    expect(routine.status).toBe('fail');
    expect(routine.detail).toContain('previous boot');
    expect(routine.detail).toContain('/claude-code-hermit:hermit-routines load');
  });

  test('a matching boot_id leaves both checks ok', () => {
    const p = fixture({ bootId: 'boot-now' });

    const heartbeat = checkHeartbeat(p);
    expect(heartbeat.status).toBe('ok');
    expect(heartbeat.detail).toContain('ticking');

    const routine = checkRoutineMonitor(p);
    expect(routine.status).toBe('ok');
    expect(routine.detail).toContain('ticking');
  });

  test('a pre-upgrade runtime without boot_id falls through to freshness', () => {
    const p = fixture({ bootId: 'boot-now', heartbeatBootId: null, routineBootId: null });

    const heartbeat = checkHeartbeat(p);
    expect(heartbeat.status).toBe('ok');
    expect(heartbeat.detail).toContain('ticking');

    const routine = checkRoutineMonitor(p);
    expect(routine.status).toBe('ok');
    expect(routine.detail).toContain('ticking');
  });

  // A hermit that has never booted through hermit-start has no marker to compare
  // against, so the gate must stay silent rather than condemn every registration.
  test('a hermit with no .boot-id never trips the gate', () => {
    const p = fixture({ heartbeatBootId: 'boot-old', routineBootId: 'boot-old' });

    expect(checkHeartbeat(p).status).toBe('ok');
    expect(checkRoutineMonitor(p).status).toBe('ok');
  });

  // croncreate-fallback writes no liveness file, so the boot id is the only
  // evidence its durable:false crons died with the process that registered them.
  test('croncreate-fallback is gated on boot id, not reported ok unconditionally', () => {
    const stale = checkRoutineMonitor(
      fixture({ bootId: 'boot-current', routineBootId: 'boot-old', routineMode: 'croncreate-fallback' }),
    );
    expect(stale.status).toBe('fail');
    expect(stale.detail).toContain('previous boot');

    const current = checkRoutineMonitor(
      fixture({ bootId: 'boot-now', routineMode: 'croncreate-fallback' }),
    );
    expect(current.status).toBe('ok');
    expect(current.detail).toContain('croncreate-fallback');
  });
});

// The heartbeat monitor writes its first tick before `start-commit` records started_at,
// so that tick reads untrusted until the next poll — a whole interval away. The two
// untrusted cases get different graces, because they mean different things.
describe('doctor heartbeat startup graces', () => {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  function seed(p: ReturnType<typeof fixture>, startedMinsAgo: number, tickMinsAgo: number | null, interval = 1800) {
    writeJson(path.join(p.stateDir, 'heartbeat-monitor.runtime.json'), {
      description: 'heartbeat-monitor', started_at: minsAgo(startedMinsAgo), interval,
    });
    const liveness = path.join(p.stateDir, 'heartbeat-liveness.json');
    if (tickMinsAgo === null) fs.rmSync(liveness, { force: true });
    else writeJson(liveness, { last_peek_at: minsAgo(tickMinsAgo) });
  }

  // interval 1800 → predates-grace 1860s (31 min).
  test('a tick predating started_at is tolerated for one interval', () => {
    const p = fixture();
    seed(p, 10, 20);
    expect(checkHeartbeat(p).status).toBe('ok');
  });

  test('and faults once that interval is up', () => {
    const p = fixture();
    seed(p, 35, 40);
    const r = checkHeartbeat(p);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('belongs to another registration');
  });

  // The split: no tick at all is a subprocess that never spawned, and nothing will
  // supersede it, so it keeps the 2-minute spawn grace instead of the interval.
  test('no tick at all still faults on the 2m spawn grace', () => {
    const p = fixture();
    seed(p, 5, null);
    const r = checkHeartbeat(p);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('spawn likely blocked');
  });

  // `every` can be edited without re-running `start`; the live loop keeps the cadence it
  // was registered with, so the grace has to follow the registration. Config says 30m
  // here (grace 31 min), the registration says 2h (grace 121 min) — at 60 min the
  // registration wins and it is still warming up.
  test('the grace follows runtime.interval, not config.every', () => {
    const p = fixture();
    seed(p, 60, 70, 7200);
    expect(checkHeartbeat(p).status).toBe('ok');
  });
});
