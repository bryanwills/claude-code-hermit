import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promptHash } from '../scripts/lib/routines/registry';
import { runScript } from './helpers/run';

const pluginRoot = path.resolve(import.meta.dir, '..');
const tmpdirs: string[] = [];
const now = Date.now();
const iso = (ms = now) => new Date(ms).toISOString();

afterAll(() => {
  for (const dir of tmpdirs) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { scheduled?: boolean; heartbeat?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'routine-arm-')));
  tmpdirs.push(root);
  const hermit = path.join(root, '.claude-code-hermit');
  const state = path.join(hermit, 'state');
  fs.mkdirSync(state, { recursive: true });
  const anchor = {
    id: 'heartbeat-restart', schedule: '0 4 * * *',
    skill: 'claude-code-hermit:hermit-routines load', enabled: true,
  };
  const routines = [anchor];
  if (options.scheduled !== false) {
    routines.push({ id: 'reflect', schedule: '0 9 * * *', skill: 'claude-code-hermit:reflect', enabled: true } as typeof anchor);
  }
  const config = {
    timezone: null,
    routines,
    heartbeat: { enabled: options.heartbeat !== false, every: '30m' },
  };
  fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(state, '.boot-id'), 'boot-a\n');
  fs.writeFileSync(path.join(state, 'cron-registry.json'), JSON.stringify({
    boot_id: 'boot-a',
    routines: {
      'heartbeat-restart': {
        prompt_hash: promptHash(anchor, anchor.schedule, pluginRoot),
        registered_at: now,
      },
    },
  }));
  const routineCommand = `bash ${path.join(pluginRoot, 'scripts', 'routine-monitor.sh')} 60 ${hermit}`;
  const heartbeatCommand = `bash ${path.join(pluginRoot, 'scripts', 'heartbeat-monitor.sh')} 1800 ${hermit}`;
  if (options.scheduled !== false) {
    fs.writeFileSync(path.join(state, 'routine-monitor.runtime.json'), JSON.stringify({
      description: 'routine-monitor', task_id: 'task-old', command: routineCommand,
      interval: 60, started_at: iso(now - 60_000), mode: 'monitor', boot_id: 'boot-a',
    }));
    fs.writeFileSync(path.join(state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso() }));
  } else {
    fs.writeFileSync(path.join(state, 'routine-monitor.runtime.json'), JSON.stringify({
      description: 'routine-monitor', command: routineCommand, interval: 60,
      started_at: iso(now - 60_000), mode: 'monitor', boot_id: 'boot-a', routines: 0,
    }));
  }
  if (options.heartbeat !== false) {
    fs.writeFileSync(path.join(state, 'heartbeat-monitor.runtime.json'), JSON.stringify({
      command: heartbeatCommand, interval: 1800, started_at: iso(now - 60_000), boot_id: 'boot-a',
    }));
    fs.writeFileSync(path.join(state, 'heartbeat-liveness.json'), JSON.stringify({ last_peek_at: iso() }));
  }
  return { root, hermit, state };
}

async function arm(hermit: string, args: string[], env: Record<string, string> = {}) {
  const [subverb, ...flags] = args;
  return runScript('routines.ts', { args: ['arm', subverb, hermit, pluginRoot, ...flags], env });
}

test('anchor HEALTHY stamps started and fired', async () => {
  const f = fixture();
  const result = await arm(f.hermit, ['anchor']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/^HEALTHY\|routines=monitor:1\|anchor_age=0\.0d\|heartbeat=ok$/m);
  const events = fs.readFileSync(path.join(f.state, 'routine-metrics.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line).event);
  expect(events).toEqual(['started', 'fired']);
});

test('anchor arms only the stale leg and stamps started without fired', async () => {
  const f = fixture();
  const runtimePath = path.join(f.state, 'routine-monitor.runtime.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  runtime.started_at = iso(now - 1_000_000);
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso(now - 700_000) }));
  const result = await arm(f.hermit, ['anchor']);
  expect(result.stdout).toContain('ARM|routines|routines:liveness-stale');
  const events = fs.readFileSync(path.join(f.state, 'routine-metrics.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line).event);
  expect(events).toEqual(['started']);
});

test('anchor pause short-circuits and stamps skipped-paused', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.state, 'operator-pause.json'), JSON.stringify({
    paused: true, paused_until: null, reason: 'operator', by: 'test', ts: iso(),
  }));
  const result = await arm(f.hermit, ['anchor']);
  expect(result.stdout).toBe('SKIP|paused\n');
  expect(fs.readFileSync(path.join(f.state, 'routine-metrics.jsonl'), 'utf8')).toContain('skipped-paused');
});

test('begin reset always plans, removes cursor, and renders the anchor prompt', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.state, 'routine-schedule.json'), '{}');
  const result = await arm(f.hermit, ['begin', '--reset']);
  expect(result.stdout).toContain('ARM|routines,heartbeat|reset');
  expect(result.stdout).toContain('OLD_TASK:task-old');
  expect(result.stdout).toContain('MONITOR_CMD:bash ');
  expect(result.stdout).toContain('ANCHOR_PROMPT_BEGIN\n[hermit-routine:heartbeat-restart]');
  expect(result.stdout).toContain('arm anchor');
  expect(result.stdout).toContain('finish heartbeat-restart cron-create');
  expect(fs.existsSync(path.join(f.state, 'routine-schedule.json'))).toBe(false);
});

test('begin reports OLD_TASK only for the current boot', async () => {
  const f = fixture();
  const runtimePath = path.join(f.state, 'routine-monitor.runtime.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  runtime.boot_id = 'old-boot';
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  const result = await arm(f.hermit, ['begin', '--reset']);
  expect(result.stdout).not.toContain('OLD_TASK:');
});

test('commit none writes monitor runtime and commits the anchor mirror', async () => {
  const f = fixture({ scheduled: false, heartbeat: false });
  fs.writeFileSync(path.join(f.state, 'cron-registry.json'), JSON.stringify({ boot_id: null, routines: {} }));
  const result = await arm(f.hermit, ['commit', 'none', '--created', 'heartbeat-restart']);
  expect(result.stdout).toBe('OK|monitor|0 scheduled|anchor created\n');
  const runtime = JSON.parse(fs.readFileSync(path.join(f.state, 'routine-monitor.runtime.json'), 'utf8'));
  expect(runtime).toMatchObject({ mode: 'monitor', routines: 0, boot_id: 'boot-a' });
  const mirror = JSON.parse(fs.readFileSync(path.join(f.state, 'cron-registry.json'), 'utf8'));
  expect(Object.keys(mirror.routines)).toEqual(['heartbeat-restart']);
});

test('daily HEALTHY verdicts cannot carry registration past the 5-day planner cliff', async () => {
  const f = fixture();
  let sawArm = false;
  for (let day = 1; day <= 6; day++) {
    const dayNow = now + day * 86400000;
    fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso(dayNow) }));
    fs.writeFileSync(path.join(f.state, 'heartbeat-liveness.json'), JSON.stringify({ last_peek_at: iso(dayNow) }));
    fs.writeFileSync(path.join(f.state, 'routine-metrics.jsonl'), JSON.stringify({
      ts: iso(dayNow - 86400000), routine_id: 'heartbeat-restart', event: 'fired', delivery: 'cron-create',
    }) + '\n');
    const result = await arm(f.hermit, ['anchor'], { HERMIT_NOW: iso(dayNow) });
    if (result.stdout.startsWith('ARM|')) {
      sawArm = true;
      expect(day).toBeLessThanOrEqual(6);
      break;
    }
    expect(result.stdout).toStartWith('HEALTHY|');
  }
  expect(sawArm).toBe(true);
});
