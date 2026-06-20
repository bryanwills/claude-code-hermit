// Tests for scripts/subagent-cost.ts — SubagentStop hook that captures
// async-dispatched subagent token cost.
//
// Each test runs the hook as a subprocess (same pattern as cost-tracker.test.ts)
// with a synthetic SubagentStop payload and validates cost-log.jsonl output.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';

// ---------------------------------------------------------------------------
// Helpers — synthetic transcript builders
// ---------------------------------------------------------------------------

function assistantEntry(model: string, inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model,
      usage: { input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: outputTokens },
      content: [{ type: 'text', text: 'done' }],
    },
  });
}

function triggerPrompt(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: text } });
}

// Async-launch dispatch result (what appears in the main transcript on dispatch)
function asyncLaunchEntry(agentId: string, resolvedModel: string): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: '' }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId, resolvedModel },
  });
}

// Sync-completion dispatch result (status:"completed" with usage — already handled by cost-tracker.ts)
function syncCompleteEntry(agentId: string): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: '' }] },
    toolUseResult: {
      agentType: 'general-purpose', agentId,
      status: 'completed',
      usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 },
    },
  });
}

// Build a minimal hermit project layout that subagent-cost.ts can resolve:
//   <root>/.claude/cost-log.jsonl              (written by the hook)
//   <root>/.claude-code-hermit/state/runtime.json
//   <root>/.claude/projects/<proj>/<sessionUuid>.jsonl  (parent transcript)
//   <root>/.claude/projects/<proj>/<sessionUuid>/subagents/agent-<agentId>.jsonl
interface Layout {
  root: string;
  logPath: string;
  agentId: string;
  subagentTranscriptPath: string;
  parentTranscriptPath: string;
  sessionUuid: string;
}

function buildLayout(rootSuffix = 'hermit-subagent-cost-'): Layout {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), rootSuffix));

  // Cost-log dir
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const logPath = path.join(root, '.claude', 'cost-log.jsonl');

  // Hermit state dir
  const stateDir = path.join(root, '.claude-code-hermit', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ session_id: 'rt-session' }));

  // Project + session dirs
  const projDir = path.join(root, '.claude', 'projects', '-home-user-myproject');
  const sessionUuid = 'fa030166-cf2d-4f1b-90c9-93e889b9e412';
  const subagentsDir = path.join(projDir, sessionUuid, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });

  const agentId = 'ab1812c331e910424';
  const subagentTranscriptPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  const parentTranscriptPath   = path.join(projDir, `${sessionUuid}.jsonl`);

  return { root, logPath, agentId, subagentTranscriptPath, parentTranscriptPath, sessionUuid };
}

function makePayload(layout: Layout, agentType = 'claude-code-hermit:skill-eval-runner'): string {
  return JSON.stringify({
    session_id: 'hook-session',
    transcript_path: layout.subagentTranscriptPath,
    agent_type: agentType,
  });
}

// ---------------------------------------------------------------------------
// Helper: run the hook and read the resulting cost-log rows
// ---------------------------------------------------------------------------

async function runHook(stdin: string, cwd: string): Promise<{ exitCode: number; rows: any[] }> {
  const r = await runScript('subagent-cost.ts', { stdin, cwd, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
  return { exitCode: r.exitCode, rows: [] };
}

async function runHookAndReadLog(layout: Layout): Promise<any[]> {
  const r = await runScript('subagent-cost.ts', {
    stdin: makePayload(layout),
    cwd: layout.root,
    env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
  });
  if (!fs.existsSync(layout.logPath)) return [];
  return fs.readFileSync(layout.logPath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subagent-cost: happy path — async heartbeat dispatch', () => {
  let layout: Layout;
  let rows: any[];

  beforeAll(async () => {
    layout = buildLayout();
    // Subagent transcript: two haiku calls
    fs.writeFileSync(layout.subagentTranscriptPath, [
      assistantEntry('claude-haiku-4-5-20251001', 1000, 400),
      assistantEntry('claude-haiku-4-5-20251001', 200, 80),
    ].join('\n') + '\n');
    // Parent transcript: heartbeat trigger → async dispatch
    fs.writeFileSync(layout.parentTranscriptPath, [
      triggerPrompt('HEARTBEAT_EVALUATE'),
      assistantEntry('claude-sonnet-4-6', 500, 100),
      asyncLaunchEntry(layout.agentId, 'claude-haiku-4-5-20251001'),
      assistantEntry('claude-sonnet-4-6', 10, 5),
    ].join('\n') + '\n');
    rows = await runHookAndReadLog(layout);
  });

  afterAll(() => fs.rmSync(layout.root, { recursive: true }));

  test('emits exactly one row', () => expect(rows).toHaveLength(1));
  test('row has subagent:true', () => expect(rows[0].subagent).toBe(true));
  test('row model is haiku', () => expect(rows[0].model).toBe('haiku'));
  test('row model_resolved is true', () => expect(rows[0].model_resolved).toBe(true));
  test('row source is heartbeat', () => expect(rows[0].source).toBe('heartbeat'));
  test('row token counts are summed across both calls', () => {
    expect(rows[0].input_tokens).toBe(1200);
    expect(rows[0].output_tokens).toBe(480);
    expect(rows[0].total_tokens).toBe(1680);
  });
  test('row api_calls is 0', () => expect(rows[0].api_calls).toBe(0));
  test('row estimated_cost_usd is positive', () => expect(rows[0].estimated_cost_usd).toBeGreaterThan(0));
  test('row agent_type matches payload', () => expect(rows[0].agent_type).toBe('claude-code-hermit:skill-eval-runner'));
  test('row session_id comes from payload', () => expect(rows[0].session_id).toBe('hook-session'));
});

describe('subagent-cost: sync dispatch dedup — skip if cost-tracker already handled', () => {
  let layout: Layout;
  let rows: any[];

  beforeAll(async () => {
    layout = buildLayout();
    fs.writeFileSync(layout.subagentTranscriptPath, [
      assistantEntry('claude-haiku-4-5-20251001', 1000, 400),
    ].join('\n') + '\n');
    // Parent shows sync completion (status:"completed" + usage) — cost-tracker already logged
    fs.writeFileSync(layout.parentTranscriptPath, [
      triggerPrompt('HEARTBEAT_EVALUATE'),
      syncCompleteEntry(layout.agentId),
      assistantEntry('claude-sonnet-4-6', 10, 5),
    ].join('\n') + '\n');
    rows = await runHookAndReadLog(layout);
  });

  afterAll(() => fs.rmSync(layout.root, { recursive: true }));

  test('emits no rows (dedup: sync dispatch already captured by cost-tracker.ts)', () =>
    expect(rows).toHaveLength(0));
});

describe('subagent-cost: agentId not found in parent — source fallback to other', () => {
  let layout: Layout;
  let rows: any[];

  beforeAll(async () => {
    layout = buildLayout();
    fs.writeFileSync(layout.subagentTranscriptPath, [
      assistantEntry('claude-haiku-4-5-20251001', 500, 200),
    ].join('\n') + '\n');
    // Parent transcript does not mention this agentId
    fs.writeFileSync(layout.parentTranscriptPath, [
      triggerPrompt('some prompt'),
      asyncLaunchEntry('different-agent-id', 'claude-haiku-4-5-20251001'),
      assistantEntry('claude-sonnet-4-6', 10, 5),
    ].join('\n') + '\n');
    rows = await runHookAndReadLog(layout);
  });

  afterAll(() => fs.rmSync(layout.root, { recursive: true }));

  test('still emits one row', () => expect(rows).toHaveLength(1));
  test('source falls back to other', () => expect(rows[0].source).toBe('other'));
  test('model still haiku', () => expect(rows[0].model).toBe('haiku'));
});

describe('subagent-cost: unreadable subagent transcript — fail open, no row', () => {
  let layout: Layout;
  let rows: any[];

  beforeAll(async () => {
    layout = buildLayout();
    // Do NOT write the subagent transcript
    fs.writeFileSync(layout.parentTranscriptPath, [
      triggerPrompt('HEARTBEAT_EVALUATE'),
      asyncLaunchEntry(layout.agentId, 'claude-haiku-4-5-20251001'),
    ].join('\n') + '\n');
    rows = await runHookAndReadLog(layout);
  });

  afterAll(() => fs.rmSync(layout.root, { recursive: true }));

  test('emits no rows', () => expect(rows).toHaveLength(0));
});

describe('subagent-cost: empty payload — fail open, no row', () => {
  let layout: Layout;

  beforeAll(() => { layout = buildLayout(); });
  afterAll(() => fs.rmSync(layout.root, { recursive: true }));

  test('exits 0 on empty stdin', async () => {
    const r = await runScript('subagent-cost.ts', {
      stdin: '', cwd: layout.root, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
  });

  test('exits 0 on stop_hook_active guard', async () => {
    const r = await runScript('subagent-cost.ts', {
      stdin: JSON.stringify({ stop_hook_active: true, transcript_path: layout.subagentTranscriptPath }),
      cwd: layout.root,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(layout.logPath)).toBe(false);
  });
});

describe('subagent-cost: routine dispatch source attribution', () => {
  let layout: Layout;
  let rows: any[];

  beforeAll(async () => {
    layout = buildLayout();
    fs.writeFileSync(layout.subagentTranscriptPath, [
      assistantEntry('claude-haiku-4-5-20251001', 800, 300),
    ].join('\n') + '\n');
    fs.writeFileSync(layout.parentTranscriptPath, [
      triggerPrompt('[hermit-routine:daily-brief] run\nlog-routine-event.sh daily-brief fired'),
      assistantEntry('claude-sonnet-4-6', 200, 50),
      asyncLaunchEntry(layout.agentId, 'claude-haiku-4-5-20251001'),
      assistantEntry('claude-sonnet-4-6', 10, 5),
    ].join('\n') + '\n');
    rows = await runHookAndReadLog(layout);
  });

  afterAll(() => fs.rmSync(layout.root, { recursive: true }));

  test('source is routine:daily-brief', () => expect(rows[0].source).toBe('routine:daily-brief'));
});
