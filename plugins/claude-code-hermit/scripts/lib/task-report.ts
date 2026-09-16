import path from 'node:path';
import { readTasks, type Task } from './tasks';
import { readCostIndex, costIndexPath, computeIndex } from './cost-log';
import { costLogPath } from './cc-compat';
import { readConfigRaw } from './config-read';
import { extractSection } from './md-write';

export interface TaskReport {
  source_path: string;
  outcome: 'done' | 'cancelled' | 'unconfirmed' | 'open';
  title: string;
  opened_at: string;
  closed_at: string | null;
  requester: string;
  due: string | null;
  waiting_on: string | null;
  cost: number;
  lessons: string[];
}

export function taskReport(dir: string, record: Task, buckets: Record<string, { cost: number }> = {}): TaskReport {
  return {
    source_path: path.join(dir, 'tasks', `${record.id}.md`),
    outcome: record.status === 'closed' ? (['check', 'confirmed'].includes(record.closed_by ?? '') ? 'done' : 'cancelled') : record.result ? 'unconfirmed' : 'open',
    title: record.title, opened_at: record.opened_at, closed_at: record.closed_at,
    requester: record.requester, due: record.due, waiting_on: record.waiting_on,
    cost: Object.values(buckets).reduce((sum, bucket) => sum + bucket.cost, 0),
    lessons: (extractSection(record.body, 'Lessons') ?? '').split('\n').map(line => line.trim()).filter(line => line.startsWith('- ')).map(line => line.slice(2)),
  };
}

export function readTaskReports(dir: string): TaskReport[] {
  const index = readCostIndex(costIndexPath(dir)) ?? computeIndex(costLogPath(dir), readConfigRaw(dir)?.timezone ?? 'UTC');
  return readTasks(dir).map(record => taskReport(dir, record, index.by_task?.[record.id]));
}
