// SubagentStop hook — captures async-dispatched subagent token cost.
//
// Problem: async Agent dispatches complete via XML <task-notification> with no usage
// field in the main transcript. cost-tracker.ts (Stop hook) is structurally blind to them.
// This hook fires on SubagentStop (CC >= v2.1.143), reads the subagent transcript directly,
// and appends a subagent:true row to cost-log.jsonl — matching the shape cost-tracker.ts
// emits for sync subagent completions.
//
// Sync dispatch dedup: if the parent transcript shows a status:"completed"+usage result for
// this agentId, cost-tracker.ts already captured it — skip to avoid double-count.
process.stdout.on('error', () => {});

import fs from 'node:fs';
import path from 'node:path';

import { hermitDir, costLogPath, extractUsage } from './lib/cc-compat';
import { calculateCost } from './lib/pricing';
import { classifySource, scanTriggerMarkers, detectModel } from './cost-tracker';

const HERMIT_DIR = hermitDir();
const COST_LOG = costLogPath(HERMIT_DIR);
const RUNTIME_JSON = path.join(HERMIT_DIR, 'state', 'runtime.json');

function readRuntimeSessionId(): string {
  try {
    return JSON.parse(fs.readFileSync(RUNTIME_JSON, 'utf-8')).session_id || '';
  } catch { return ''; }
}

function sumSubagentTranscript(transcriptPath: string): {
  model: string; inputTokens: number; cacheWriteTokens: number;
  cacheReadTokens: number; outputTokens: number;
} | null {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return null; }
  let inputTokens = 0, cacheWriteTokens = 0, cacheReadTokens = 0, outputTokens = 0;
  let model = '';
  let found = false;
  for (const line of content.split('\n')) {
    try {
      const usage = extractUsage(JSON.parse(line));
      if (!usage) continue;
      inputTokens += usage.inputTokens;
      cacheWriteTokens += usage.cacheWriteTokens;
      cacheReadTokens += usage.cacheReadTokens;
      outputTokens += usage.outputTokens;
      if (!model) model = usage.model;
      found = true;
    } catch {}
  }
  return found ? { model, inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens } : null;
}

// Locate the dispatch entry in the parent transcript for this agentId.
// Returns lines + index for scanTriggerMarkers, plus whether the dispatch was synchronous
// (status:"completed" with usage → already captured by cost-tracker.ts → skip).
function findDispatch(parentPath: string, agentId: string): {
  lines: string[]; index: number; isSyncDispatch: boolean;
} | null {
  let content: string;
  try { content = fs.readFileSync(parentPath, 'utf-8'); } catch { return null; }
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      const r = e.toolUseResult;
      if (!r || typeof r !== 'object' || r.agentId !== agentId) continue;
      return { lines: lines.slice(0, i + 1), index: i, isSyncDispatch: r.status === 'completed' && r.usage != null };
    } catch {}
  }
  return null;
}

process.stdin.on('error', () => {});
const chunks: Buffer[] = [];
process.stdin.on('data', (c: Buffer) => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    const payload = raw ? JSON.parse(raw) : {};

    if (payload.stop_hook_active) { process.exit(0); return; }

    const transcriptPath: string | undefined = payload.transcript_path;
    if (!transcriptPath) { process.exit(0); return; }

    // Derive parent transcript from subagent path:
    // .../projects/<proj>/<parentUuid>/subagents/agent-<agentId>.jsonl
    const agentId = path.basename(transcriptPath).replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const subagentsDir = path.dirname(transcriptPath);
    const sessionDir   = path.dirname(subagentsDir);
    const parentUuid   = path.basename(sessionDir);
    const projectsDir  = path.dirname(sessionDir);
    const parentPath   = path.join(projectsDir, parentUuid + '.jsonl');

    const usage = sumSubagentTranscript(transcriptPath);
    if (!usage) { process.exit(0); return; }

    const { model: rawModel, inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens } = usage;
    const totalTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
    if (totalTokens === 0) { process.exit(0); return; }

    // Skip sync dispatches — cost-tracker.ts already logged them
    const dispatch = findDispatch(parentPath, agentId);
    if (dispatch?.isSyncDispatch) { process.exit(0); return; }

    // Source attribution from parent transcript (best-effort, falls back to 'other')
    let source = 'other';
    if (dispatch) {
      try { source = classifySource(scanTriggerMarkers(dispatch.lines, dispatch.index)); } catch {}
    }

    const model = detectModel(rawModel);
    const estimatedCost = Math.round(
      calculateCost(model, inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens) * 10000
    ) / 10000;

    const entry = {
      timestamp: new Date().toISOString(),
      session_id: payload.session_id || readRuntimeSessionId() || 'unknown',
      source,
      model,
      input_tokens:      inputTokens,
      cache_write_tokens: cacheWriteTokens,
      cache_read_tokens:  cacheReadTokens,
      output_tokens:      outputTokens,
      total_tokens:       totalTokens,
      api_calls:          0,
      subagent:           true,
      agent_type:         payload.agent_type || '',
      model_resolved:     !!rawModel,
      context_usage:      null,
      estimated_cost_usd: estimatedCost,
    };

    try { fs.appendFileSync(COST_LOG, JSON.stringify(entry) + '\n', 'utf-8'); } catch {}
  } catch {}
  process.exit(0);
});
