// Drive-by test (deterministic channel voice work): writeStatusJson (cost-tracker.ts)
// must populate sessions/.status.json's `status`/`task` fields from real
// runtime.json/SHELL.md state, not fall back to "unknown"/"" — the channel
// status responder reads exactly these fields, and a hatched install with no
// runtime.json or no `## Task` section previously read as blank.
//
// Subprocess test (via runScript), same rationale as cost-tracker-budget.test.ts:
// cost-tracker.ts resolves HERMIT_DIR from cwd at module load.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { fixturesDir, freshDirFactory, writeConfig } from './helpers/workdir';
import { triggerPrompt, assistantEntryFor as assistantEntry } from './helpers/transcript';

describe('cost-tracker: writeStatusJson populates status/task from real state', () => {
  let dir: string;
  let statusPath: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-status-'));
    const cchDir = path.join(dir, '.claude-code-hermit');
    fs.mkdirSync(path.join(cchDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(cchDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });

    fs.writeFileSync(
      path.join(cchDir, 'state', 'runtime.json'),
      JSON.stringify({ session_id: 'test-session', session_state: 'in_progress' })
    );
    writeConfig(dir, { timezone: null });
    fs.copyFileSync(
      path.join(fixturesDir, 'shell-session.md'),
      path.join(cchDir, 'sessions', 'SHELL.md')
    );

    const transcriptLines = [
      triggerPrompt('[hermit-routine:demo] start'),
      assistantEntry('claude-sonnet-4-6', 1000, 500),
    ];
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');
    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });

    statusPath = path.join(cchDir, 'sessions', '.status.json');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true });
  });

  test('status reflects runtime.json session_state, not "unknown"', () => {
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    expect(status.status).toBe('in_progress');
  });

  test('task reflects SHELL.md\'s ## Task section, not ""', () => {
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    expect(status.task).toBe('Test task for hook validation');
  });
});

// Regression: the section reads went through an unanchored `/## Blockers\n/`,
// and a `### Blockers` sub-heading in a Progress Log entry matches that substring.
// The status responder then reported a stale sub-heading's body as the live blocker.
describe('cost-tracker: a ### sub-heading does not hijack the section read', () => {
  let dir: string;
  let statusPath: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-decoy-'));
    const cchDir = path.join(dir, '.claude-code-hermit');
    fs.mkdirSync(path.join(cchDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(cchDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });

    fs.writeFileSync(
      path.join(cchDir, 'state', 'runtime.json'),
      JSON.stringify({ session_id: 'test-session', session_state: 'in_progress' })
    );
    writeConfig(dir, { timezone: null });
    fs.writeFileSync(path.join(cchDir, 'sessions', 'SHELL.md'), [
      '# Active Session',
      '',
      '## Session Info',
      '- **ID:** S-001',
      '',
      '## Task',
      'Real task',
      '',
      '## Progress Log',
      '[09:00] Wrote up findings under a sub-heading:',
      '### Blockers',
      'decoy blocker from a sub-heading',
      '',
      '## Blockers',
      'the real blocker',
      '',
      '## Session Summary',
      '',
    ].join('\n'));

    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      triggerPrompt('[hermit-routine:demo] start'),
      assistantEntry('claude-sonnet-4-6', 1000, 500),
    ].join('\n') + '\n');
    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });

    statusPath = path.join(cchDir, 'sessions', '.status.json');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true });
  });

  test('blockers reads the real ## Blockers section, not the ### decoy', () => {
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    expect(status.blockers).toBe('the real blocker');
  });
});

// GH #828: the `blockers` field must drop `~`/`[resolved]` entries like every other
// blocker surface: `bin/hermit-status` prints it verbatim as "BLOCKED: …".
describe('cost-tracker: blockers drops resolved entries', () => {
  const { freshDir, cleanup } = freshDirFactory('hermit-cost-resolved-');

  async function statusFor(blockerLines: string[]): Promise<{ blockers: string | null }> {
    const dir = freshDir();
    const cchDir = path.join(dir, '.claude-code-hermit');
    fs.mkdirSync(path.join(cchDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(cchDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(cchDir, 'state', 'runtime.json'),
      JSON.stringify({ session_id: 'test-session', session_state: 'in_progress' })
    );
    writeConfig(dir, { timezone: null });
    fs.writeFileSync(path.join(cchDir, 'sessions', 'SHELL.md'), [
      '# Active Session',
      '',
      '## Task',
      'Real task',
      '',
      '## Blockers',
      ...blockerLines,
      '',
      '## Session Summary',
      '',
    ].join('\n'));
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      triggerPrompt('[hermit-routine:demo] start'),
      assistantEntry('claude-sonnet-4-6', 1000, 500),
    ].join('\n') + '\n');
    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
    return JSON.parse(fs.readFileSync(path.join(cchDir, 'sessions', '.status.json'), 'utf-8'));
  }

  afterAll(cleanup);

  test('a resolved line ahead of an open one yields the open one', async () => {
    const status = await statusFor(['~ cleared blocker', 'real blocker']);
    expect(status.blockers).toBe('real blocker');
  });

  test('only resolved lines yields null', async () => {
    const status = await statusFor(['[resolved] cleared blocker']);
    expect(status.blockers).toBeNull();
  });
});
