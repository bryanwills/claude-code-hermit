// Sums cost-log.jsonl entries for the current logical session and prints the result.
// Usage: bun session-cost.ts <session_id> [--opened-at <iso>] [--closed-at <iso>]
// Output: JSON {"cost_usd": <number>, "tokens": <number>}
//
// Primary mode: window-delta. cost-log.jsonl rows are tagged with the transcript's
// process session_id (a UUID), never the logical S-NNN id (assigned only at close),
// so an exact session_id match against S-NNN always misses. Instead, sum every row
// whose timestamp falls in [opened_at, closed_at] — one process/transcript per arc,
// so every in-window row belongs to this arc regardless of its session_id.
// `opened_at` is read from state/runtime.json (stamped by cost-tracker.ts on the
// first in_progress turn of the arc) unless overridden via --opened-at.
//
// Fallback mode: when no opened_at is available (older runtime.json, or none yet),
// fail open to the legacy exact session_id sum — same zeros-for-unknown-id behavior
// as before.
// Fails open throughout: missing log or unreadable state prints {"cost_usd": 0, "tokens": 0}.

import fs from 'node:fs';
import path from 'node:path';
import { costLogPath } from './lib/cc-compat';

const COST_LOG = costLogPath('.claude-code-hermit');
const RUNTIME_JSON = path.join('.claude-code-hermit', 'state', 'runtime.json');

const argv = process.argv.slice(2);
let sessionId = '';
let openedAtOverride: string | undefined;
let closedAtOverride: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--opened-at') { openedAtOverride = argv[++i]; continue; }
  if (a === '--closed-at') { closedAtOverride = argv[++i]; continue; }
  if (!sessionId) sessionId = a;
}

function readOpenedAt(): string | undefined {
  if (openedAtOverride) return openedAtOverride;
  try {
    const rt = JSON.parse(fs.readFileSync(RUNTIME_JSON, 'utf8'));
    return typeof rt.opened_at === 'string' ? rt.opened_at : undefined;
  } catch {
    return undefined;
  }
}

function sumMatching(predicate: (e: any) => boolean): { cost: number; tokens: number } {
  let cost = 0;
  let tokens = 0;
  try {
    for (const line of fs.readFileSync(COST_LOG, 'utf8').split('\n')) {
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

const openedAt = readOpenedAt();
const openedMs = openedAt ? Date.parse(openedAt) : NaN;
const closedMs = closedAtOverride ? Date.parse(closedAtOverride) : Date.now();

const result = Number.isFinite(openedMs)
  ? sumMatching(e => {
      const ts = Date.parse(e.timestamp);
      return Number.isFinite(ts) && ts >= openedMs && ts <= closedMs;
    })
  : sumMatching(e => e.session_id === sessionId);

process.stdout.write(JSON.stringify({ cost_usd: Math.round(result.cost * 10000) / 10000, tokens: result.tokens }) + '\n');
