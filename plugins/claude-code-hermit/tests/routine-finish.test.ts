// Contract tests for `routines.ts finish` — the terminal gate that decides
// whether a routine fire is recorded as `fired`. Exercised as a subprocess, the
// same shape as tests/routine-precheck.test.ts (both resolve the hermit root via
// lib/cc-compat's hermitDir()).
//
// The regression this file exists for: a routine's success used to be logged
// from the dispatched subagent's self-report, so a skill that wrote nothing (or
// wrote to the wrong path) still produced a clean `fired` row.
//
// Usage: bun test tests/routine-finish.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);

const readMetricsRows = (dir: string) => {
  try {
    return fs.readFileSync(hermit(dir, 'state', 'routine-metrics.jsonl'), 'utf-8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const events = (dir: string, id: string) =>
  readMetricsRows(dir).filter((r) => r.routine_id === id).map((r) => r.event);

const writeConfig = (dir: string, routines: unknown[], timezone: string | null = 'UTC') =>
  fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify({ timezone, routines }));

const writeArtifact = (dir: string, rel: string, body: string) => {
  const abs = hermit(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
};

const precheck = (dir: string, id: string) =>
  runScript('routines.ts', { args: ['precheck', id, 'true'], cwd: dir });
const finish = (dir: string, id: string) =>
  runScript('routines.ts', { args: ['finish', id], cwd: dir });

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

/** Today's YYYY-MM-DD in UTC — matches what resolveArtifactPath freezes for a UTC config. */
const todayUTC = () => new Date().toISOString().slice(0, 10);

describe('routines.ts finish — routines with no artifact contract', () => {
  test('logs fired unconditionally (legacy behavior preserved)', withDir(async (dir) => {
    writeConfig(dir, [{ id: 'plain', schedule: '0 9 * * *', skill: 'x', enabled: true }]);
    await precheck(dir, 'plain');
    const r = await finish(dir, 'plain');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('fired');
    expect(events(dir, 'plain')).toEqual(['started', 'fired']);
  }));

  test('logs fired even with no run record and no config at all', withDir(async (dir) => {
    const r = await finish(dir, 'orphan');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('fired');
    expect(events(dir, 'orphan')).toEqual(['fired']);
  }));
});

describe('routines.ts finish — declared artifact contract', () => {
  const CONTRACT = 'raw/snapshot-calendar-{date}.md';
  const declared = (extra: Record<string, unknown> = {}) => [
    { id: 'cal', schedule: '0 6 * * *', skill: 'calendar-fetch-light', enabled: true, expect_artifact: CONTRACT, ...extra },
  ];

  test('absent before, written during the run → fired', withDir(async (dir) => {
    writeConfig(dir, declared());
    await precheck(dir, 'cal');
    writeArtifact(dir, `raw/snapshot-calendar-${todayUTC()}.md`, 'fresh events\n');
    const r = await finish(dir, 'cal');
    expect(r.stdout.trim()).toBe('fired');
    expect(events(dir, 'cal')).toEqual(['started', 'fired']);
  }));

  test('never written → failed-artifact-missing, not fired', withDir(async (dir) => {
    writeConfig(dir, declared());
    await precheck(dir, 'cal');
    const r = await finish(dir, 'cal');
    expect(r.stdout.trim()).toBe(`failed|artifact-missing|raw/snapshot-calendar-${todayUTC()}.md`);
    expect(events(dir, 'cal')).toEqual(['started', 'failed-artifact-missing']);
    expect(events(dir, 'cal')).not.toContain('fired');
  }));

  // The 2026-08-06 incident: an older file from an earlier same-day dispatch was
  // still on disk, so a plain existence check would have passed.
  test('stale file left untouched by the run → failed-artifact-unchanged', withDir(async (dir) => {
    writeConfig(dir, declared());
    writeArtifact(dir, `raw/snapshot-calendar-${todayUTC()}.md`, 'yesterday-ish content\n');
    await precheck(dir, 'cal');
    const r = await finish(dir, 'cal');
    expect(r.stdout.trim()).toBe(`failed|artifact-unchanged|raw/snapshot-calendar-${todayUTC()}.md`);
    expect(events(dir, 'cal')).toEqual(['started', 'failed-artifact-unchanged']);
  }));

  test('pre-existing file rewritten during the run → fired', withDir(async (dir) => {
    writeConfig(dir, declared());
    const rel = `raw/snapshot-calendar-${todayUTC()}.md`;
    writeArtifact(dir, rel, 'old\n');
    await precheck(dir, 'cal');
    writeArtifact(dir, rel, 'new content, different size\n');
    const r = await finish(dir, 'cal');
    expect(r.stdout.trim()).toBe('fired');
    expect(events(dir, 'cal')).toEqual(['started', 'fired']);
  }));

  test('a symlink at the target path never counts as the artifact', withDir(async (dir) => {
    writeConfig(dir, declared());
    await precheck(dir, 'cal');
    const real = writeArtifact(dir, 'raw/elsewhere.md', 'content\n');
    fs.symlinkSync(real, hermit(dir, `raw/snapshot-calendar-${todayUTC()}.md`));
    const r = await finish(dir, 'cal');
    expect(r.stdout.trim()).toContain('failed|artifact-missing');
  }));

  test('missing run record for a declared contract → verification-error, never fired', withDir(async (dir) => {
    writeConfig(dir, declared());
    // No precheck: nothing froze a baseline. The artifact even exists — that must
    // not be enough, because nothing proves this run produced it.
    writeArtifact(dir, `raw/snapshot-calendar-${todayUTC()}.md`, 'unattributable\n');
    const r = await finish(dir, 'cal');
    expect(r.stdout.trim()).toContain('failed|verification-error|');
    expect(events(dir, 'cal')).toEqual(['failed-verification-error']);
  }));

  test('finalize is idempotent — a replayed finish writes no second terminal row', withDir(async (dir) => {
    writeConfig(dir, declared());
    await precheck(dir, 'cal');
    writeArtifact(dir, `raw/snapshot-calendar-${todayUTC()}.md`, 'written\n');
    const first = await finish(dir, 'cal');
    const second = await finish(dir, 'cal');
    expect(first.stdout.trim()).toBe('fired');
    expect(second.stdout.trim()).toBe('fired');
    expect(events(dir, 'cal')).toEqual(['started', 'fired']);
  }));

  test('a replayed failure re-reports the failure, and still writes one row', withDir(async (dir) => {
    writeConfig(dir, declared());
    await precheck(dir, 'cal');
    await finish(dir, 'cal');
    const second = await finish(dir, 'cal');
    expect(second.stdout.trim()).toContain('failed|artifact-missing');
    expect(events(dir, 'cal')).toEqual(['started', 'failed-artifact-missing']);
  }));

  test('the next fire re-arms: a new precheck clears the previous outcome', withDir(async (dir) => {
    writeConfig(dir, declared());
    const rel = `raw/snapshot-calendar-${todayUTC()}.md`;
    await precheck(dir, 'cal');
    await finish(dir, 'cal'); // fails — nothing written
    await precheck(dir, 'cal');
    writeArtifact(dir, rel, 'this time it wrote\n');
    const r = await finish(dir, 'cal');
    expect(r.stdout.trim()).toBe('fired');
    expect(events(dir, 'cal')).toEqual(['started', 'failed-artifact-missing', 'started', 'fired']);
  }));
});

describe('routines.ts finish — run record', () => {
  test('precheck freezes the resolved path and baseline; the ledger row shape is untouched', withDir(async (dir) => {
    writeConfig(dir, [
      { id: 'cal', schedule: '0 6 * * *', skill: 'x', enabled: true, expect_artifact: 'compiled/digest-{date}.md' },
    ]);
    writeArtifact(dir, `compiled/digest-${todayUTC()}.md`, 'baseline\n');
    await precheck(dir, 'cal');

    const record = JSON.parse(fs.readFileSync(hermit(dir, 'state', 'routine-run.json'), 'utf-8')).cal;
    expect(record.resolved_path).toBe(`compiled/digest-${todayUTC()}.md`);
    expect(record.baseline).toMatchObject({ size: 'baseline\n'.length });
    expect(typeof record.started_ts).toBe('string');

    // The pinned 4-key ledger schema must survive the sidecar's introduction.
    const rows = readMetricsRows(dir);
    expect(Object.keys(rows[0]).sort()).toEqual(['delivery', 'event', 'routine_id', 'ts']);
  }));

  test('no run record is written for a routine without a contract', withDir(async (dir) => {
    writeConfig(dir, [{ id: 'plain', schedule: '0 9 * * *', skill: 'x', enabled: true }]);
    await precheck(dir, 'plain');
    expect(fs.existsSync(hermit(dir, 'state', 'routine-run.json'))).toBe(false);
  }));

  test('a fire the gate skipped writes no run record', withDir(async (dir) => {
    writeConfig(dir, [
      { id: 'cal', schedule: '0 6 * * *', skill: 'x', enabled: true, expect_artifact: 'raw/s-{date}.md' },
    ]);
    fs.writeFileSync(hermit(dir, 'state', 'runtime.json'), JSON.stringify({ session_state: 'waiting' }));
    const r = await runScript('routines.ts', { args: ['precheck', 'cal', 'false'], cwd: dir });
    expect(r.stdout.trim()).toBe('SKIP');
    expect(fs.existsSync(hermit(dir, 'state', 'routine-run.json'))).toBe(false);
  }));
});
