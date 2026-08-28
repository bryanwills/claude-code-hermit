import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { checkClassifierDenials, resolvePaths } from '../scripts/doctor-check';
import { freshDirFactory } from './helpers/workdir';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const { freshDir, cleanup } = freshDirFactory('hermit-classifier-denials-');
afterAll(cleanup);

const nowIso = () => new Date().toISOString();
const daysAgoIso = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

type Ledger = Record<string, unknown>;

function scenario(ledger: Ledger | null | 'missing' | 'malformed') {
  const projectRoot = freshDir();
  const hermitDir = path.join(projectRoot, '.claude-code-hermit');
  const stateDir = path.join(hermitDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'permission-denied-alerts.json');
  if (ledger === 'malformed') {
    fs.writeFileSync(file, '{not json');
  } else if (ledger !== 'missing' && ledger !== null) {
    fs.writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n');
  }
  return checkClassifierDenials(resolvePaths(hermitDir, PLUGIN_ROOT));
}

describe('doctor classifier-denials check', () => {
  test('absent file is ok', () => {
    const result = scenario('missing');
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('no classifier denials recorded in 7d');
  });

  test('burst_max 2 warns with tools by count desc and program breakdown', () => {
    const since = nowIso();
    const result = scenario({
      Bash: {
        at: since,
        suppressed: 0,
        history: { since, total: 7, burst_max: 2, programs: { bun: 5, python3: 2 } },
      },
      mcp__discord__reply: {
        at: since,
        suppressed: 0,
        history: { since, total: 2, burst_max: 1, programs: {} },
      },
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toBe(
      '9 denials in 7d — Bash: bun ×5, python3 ×2; mcp__discord__reply ×2; max burst 2',
    );
  });

  test('burst_max 3 fails and names the auto-mode fallback', () => {
    const since = nowIso();
    const result = scenario({
      Bash: {
        at: since,
        suppressed: 0,
        history: { since, total: 3, burst_max: 3, programs: { bun: 3 } },
      },
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('3 denials in 7d — Bash: bun ×3; max burst 3');
    expect(result.detail).toContain('a burst of 3+ drops auto mode to prompting (session may have stalled)');
  });

  test('malformed JSON warns check failed', () => {
    const result = scenario('malformed');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('check failed');
  });

  test('history.since 8 days old is ignored', () => {
    const result = scenario({
      Bash: {
        at: daysAgoIso(8),
        suppressed: 0,
        history: { since: daysAgoIso(8), total: 9, burst_max: 4, programs: { bun: 9 } },
      },
    });
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('no classifier denials recorded in 7d');
  });
});
