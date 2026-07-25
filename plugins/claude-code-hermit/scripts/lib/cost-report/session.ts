// `cost-report.ts session <session_id> [--opened-at <iso>] [--closed-at <iso>]`
// Sums cost-log.jsonl entries for the current logical session and prints the result.
// Output: JSON {"cost_usd": <number>, "tokens": <number>}
//
// Primary mode: window-delta. cost-log.jsonl rows are tagged with the transcript's
// process session_id (a UUID), never the logical S-NNN id (assigned only at close),
// and one long-lived transcript holds many logical sessions — so an exact session_id
// match against S-NNN always misses. Instead, sum every row whose timestamp falls in
// the arc window [opened_at, closed_at]. Both bounds are read from state/runtime.json
// (maintained by cost-tracker.ts: opened_at re-stamped per arc keyed on the transcript
// id, closed_at stamped on the idle transition) unless overridden via --opened-at /
// --closed-at. A live arc has no closed_at yet, so the window ends at now.
//
// Fallback mode: when no opened_at is available (older runtime.json, or none yet),
// fail open to the legacy exact session_id sum — same zeros-for-unknown-id behavior
// as before.
// Fails open throughout: missing log or unreadable state prints {"cost_usd": 0, "tokens": 0}.

import fs from 'node:fs';
import path from 'node:path';
import { costLogPath, hermitDir } from '../cc-compat';
import { readRuntimeJson } from '../runtime';
import { computeSessionCost } from '../session-cost';

// Arc-window rationale is in the file header above; this just applies the
// --opened-at / --closed-at overrides on top of runtime.json's values.
function readWindow(root: string, openedAtOverride?: string, closedAtOverride?: string): { openedAt?: string; closedAt?: string } {
  const rt = readRuntimeJson(path.join(root, 'state')) || {};
  return {
    openedAt: openedAtOverride ?? (typeof rt.opened_at === 'string' ? rt.opened_at : undefined),
    closedAt: closedAtOverride ?? (typeof rt.closed_at === 'string' ? rt.closed_at : undefined),
  };
}

function sumMatching(costLog: string, predicate: (e: any) => boolean): { cost: number; tokens: number } {
  let cost = 0;
  let tokens = 0;
  try {
    for (const line of fs.readFileSync(costLog, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (predicate(e)) {
          cost += e.estimated_cost_usd || 0;
          tokens += e.total_tokens || 0;
        }
      } catch {}
    }
  } catch {}
  return { cost, tokens };
}

// root/costLog are resolved here, not at module scope: cost-report.ts imports
// every verb module unconditionally, and hermitDir() is an fs.existsSync walk up
// to 8 levels — at module scope it would run on every invocation, including the
// verbs that never touch it. reflect.ts already resolves inside its own entry.
export function run(argv: string[]): void {
  const root = hermitDir();
  const costLog = costLogPath(root);

  let sessionId = '';
  let openedAtOverride: string | undefined;
  let closedAtOverride: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--opened-at') { openedAtOverride = argv[++i]; continue; }
    if (a === '--closed-at') { closedAtOverride = argv[++i]; continue; }
    if (!sessionId) sessionId = a;
  }

  const { openedAt, closedAt } = readWindow(root, openedAtOverride, closedAtOverride);
  const measured = computeSessionCost({ logPath: costLog, openedAt, closedAt });

  // Window mode unavailable (no opened_at) — fall back to the legacy exact-match sum.
  const result = measured.available
    ? { cost: measured.cost_usd, tokens: measured.tokens }
    : sumMatching(costLog, e => e.session_id === sessionId);

  process.stdout.write(JSON.stringify({ cost_usd: Math.round(result.cost * 10000) / 10000, tokens: result.tokens }) + '\n');
}
