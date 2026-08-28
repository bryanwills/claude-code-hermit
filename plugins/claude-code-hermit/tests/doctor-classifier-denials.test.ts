import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { checkClassifierDenials, resolvePaths } from '../scripts/doctor-check';
import { freshDirFactory } from './helpers/workdir';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const { freshDir, cleanup } = freshDirFactory('hermit-classifier-denials-');
afterAll(cleanup);

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

type Row = { ts: string; tool: string; prog?: string };

/** Seed the event log with `rows` ('missing' writes no file at all) and run the check. */
function scenario(rows: Row[] | 'missing' | 'unreadable' | string) {
  const projectRoot = freshDir();
  const hermitDir = path.join(projectRoot, '.claude-code-hermit');
  const stateDir = path.join(hermitDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'permission-denied-events.jsonl');
  if (rows === 'unreadable') {
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o000);
  } else if (typeof rows === 'string' && rows !== 'missing') {
    fs.writeFileSync(file, rows);
  } else if (Array.isArray(rows)) {
    fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  return checkClassifierDenials(resolvePaths(hermitDir, PLUGIN_ROOT));
}

/** n denials on one tool, `gapMin` apart, newest first at `startMin` ago. */
const spread = (n: number, gapMin: number, startMin = 1, tool = 'Bash', prog: string | null = 'bun'): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    ts: minutesAgo(startMin + i * gapMin),
    tool,
    ...(prog ? { prog } : {}),
  }));

describe('doctor classifier-denials check', () => {
  test('absent file is ok', () => {
    const result = scenario('missing');
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('no classifier denials recorded in 7d');
  });

  test('an unreadable file warns rather than reading as a clean all-ok', () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    const result = scenario('unreadable');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('check failed');
  });

  test('a malformed line is skipped, the good rows still count, and it is named', () => {
    const good = spread(3, 60);
    const result = scenario(good.map(r => JSON.stringify(r)).join('\n') + '\n{torn\n');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('3 denials in 7d');
    expect(result.detail).toContain('1 unreadable row(s)');
  });

  test('a window of only malformed lines warns instead of reporting a clean all-ok', () => {
    // The regression that matters: skipping torn lines silently would report
    // "no classifier denials" over a damaged log — a false all-clear on the one
    // check whose job is to not under-report.
    const result = scenario('{torn\nnot json at all\n{"ts":"nope","tool":"Bash"}\n');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('no readable classifier denials in 7d');
    expect(result.detail).toContain('3 unreadable row(s)');
  });

  test('a well-formed row that is merely out of window is not counted as unreadable', () => {
    const result = scenario([
      ...spread(3, 60),
      { ts: daysAgo(9), tool: 'Bash', prog: 'bun' },
    ]);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('3 denials in 7d');
    expect(result.detail).not.toContain('unreadable');
  });

  test('below the reporting floor stays ok but still renders the count', () => {
    const result = scenario(spread(2, 60));
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('2 denials in 7d — Bash: bun ×2; largest cluster 1 in 10 min');
  });

  test('the floor is reached by total alone, with every denial its own cluster', () => {
    const result = scenario(spread(3, 60));
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('largest cluster 1 in 10 min');
  });

  test('the floor is reached by a cluster alone', () => {
    const result = scenario(spread(2, 2));
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('largest cluster 2 in 10 min');
  });

  test('three inside ten minutes fails, correlating without asserting a stall', () => {
    const result = scenario(spread(3, 2));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('largest cluster 3 in 10 min');
    expect(result.detail).toContain('around where auto mode falls back to prompting');
    // A cluster is not the documented consecutive-denial count, so the row must
    // not claim this session actually stalled.
    expect(result.detail).not.toContain('session may have stalled');
  });

  test('a cluster spanning more than ten minutes warns rather than failing', () => {
    const result = scenario(spread(3, 6)); // 0, 6, 12 minutes — no 3 inside any 10
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('largest cluster 2 in 10 min');
  });

  test('a cluster is cross-tool, which the old per-tool count could not see', () => {
    const result = scenario([
      { ts: minutesAgo(1), tool: 'Bash', prog: 'bun' },
      { ts: minutesAgo(3), tool: 'Read' },
      { ts: minutesAgo(5), tool: 'Edit' },
    ]);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('largest cluster 3 in 10 min');
  });

  test('tools are listed by count desc with their program breakdown', () => {
    const result = scenario([
      ...spread(5, 60, 1, 'Bash', 'bun'),
      ...spread(2, 60, 400, 'Bash', 'python3'),
      ...spread(2, 60, 700, 'mcp__discord__reply', null),
    ]);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(
      '9 denials in 7d — Bash: bun ×5, python3 ×2; mcp__discord__reply ×2;',
    );
  });

  test('more tools than the display limit fold into +N more', () => {
    const result = scenario(
      ['A', 'B', 'C', 'D', 'E'].map((tool, i) => ({ ts: minutesAgo(60 * (i + 1)), tool })),
    );
    expect(result.detail).toContain('+2 more');
  });

  test('a long tool key is elided while the cluster count survives', () => {
    const long = 'mcp__' + 'x'.repeat(54);
    const result = scenario([
      ...spread(3, 60, 1, long, null),
      ...spread(3, 60, 400, long + 'y', null),
      ...spread(3, 60, 700, long + 'z', null),
    ]);
    expect(result.detail.length).toBeLessThanOrEqual(200);
    expect(result.detail).toContain('largest cluster 1 in 10 min');
  });

  test('rows older than 7 days are ignored', () => {
    const result = scenario([
      { ts: daysAgo(8), tool: 'Bash', prog: 'bun' },
      { ts: daysAgo(9), tool: 'Bash', prog: 'bun' },
    ]);
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('no classifier denials recorded in 7d');
  });
});
