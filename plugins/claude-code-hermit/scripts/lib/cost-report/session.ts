// `cost-report.ts session <task_id>` reports cost attributed to one task record.
import path from 'node:path';
import { costLogPath, hermitDir } from '../cc-compat';
import { readTaskReports } from '../task-report';
import { readConfigRaw } from '../config-read';
import { costIndexPath, readCostIndex, computeIndex } from '../cost-log';

export function run(argv: string[]): void {
  const root = hermitDir();
  const id = argv[0];
  const report = readTaskReports(root).find(row => path.basename(row.source_path, '.md') === id);
  const index = readCostIndex(costIndexPath(root)) ?? computeIndex(costLogPath(root), readConfigRaw(root)?.timezone ?? 'UTC');
  const buckets: Record<string, { tokens: number }> = report ? (index.by_task?.[id] ?? {}) : {};
  const tokens = Object.values(buckets).reduce((sum, bucket) => sum + bucket.tokens, 0);
  process.stdout.write(JSON.stringify({ cost_usd: Math.round((report?.cost ?? 0) * 10000) / 10000, tokens }) + '\n');
}
