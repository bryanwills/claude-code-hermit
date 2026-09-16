import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { taskFixture } from './helpers/tasks';

describe('cost-report.ts session: per-task attribution', () => {
  test('reports one task share from the index and ignores frozen sessions', async () => {
    const f = taskFixture();
    try {
      const record = await f.open();
      f.put('state/cost-index.json', { version: 4, by_task: { [record.id]: { '2026-09-16': { cost: 1.25, tokens: 500 } }, other: { '2026-09-16': { cost: 9, tokens: 9000 } } } });
      const r = await runScript('cost-report.ts', { args: ['session', record.id], cwd: f.dir, env: { AGENT_DIR: f.dir, CLAUDE_PROJECT_DIR: f.dir } });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ cost_usd: 1.25, tokens: 500 });
    } finally { f.cleanup(); }
  });

  test('rebuild fallback splits rows across tasks and excludes conversation spend', async () => {
    const f = taskFixture();
    try {
      const record = await f.open();
      const timestamp = new Date().toISOString();
      fs.mkdirSync(path.join(f.dir, '..', '.claude'), { recursive: true });
      fs.writeFileSync(path.join(f.dir, '..', '.claude', 'cost-log.jsonl'), [
        { timestamp, bucket: 'tasks', task_ids: [record.id, 'T-other'], estimated_cost_usd: 2, total_tokens: 1000 },
        { timestamp, bucket: 'conversation', estimated_cost_usd: 9, total_tokens: 9000 },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      const r = await runScript('cost-report.ts', { args: ['session', record.id], cwd: f.dir, env: { AGENT_DIR: f.dir, CLAUDE_PROJECT_DIR: path.dirname(f.dir) } });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ cost_usd: 1, tokens: 500 });
    } finally { f.cleanup(); }
  });

  test('unknown records return zeros even if an index entry exists', async () => {
    const f = taskFixture();
    try {
      f.put('state/cost-index.json', { version: 4, by_task: { unknown: { '2026-09-16': { cost: 9, tokens: 9000 } } } });
      const r = await runScript('cost-report.ts', { args: ['session', 'unknown'], cwd: f.dir, env: { AGENT_DIR: f.dir } });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ cost_usd: 0, tokens: 0 });
    } finally { f.cleanup(); }
  });
});
