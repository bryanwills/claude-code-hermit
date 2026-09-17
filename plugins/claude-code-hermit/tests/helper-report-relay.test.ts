import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { bind } from '../scripts/lib/conversations';
import { MAX_HOOK_STDIN } from '../scripts/lib/hook-input';
import { runScript } from './helpers/run';
import { withDir } from './helpers/workdir';

function seed(dir: string, key = 'discord:123') {
  const worktree = path.join(dir, key.replace(':', '-'));
  const reports = path.join(worktree, '.claude-code-hermit', 'helper-reports');
  fs.mkdirSync(reports, { recursive: true });
  bind(path.join(dir, '.claude-code-hermit'), key, { worktree, session_name: 'helper', session_id: 'helper-id' });
  fs.writeFileSync(path.join(reports, 'abc123.md'), 'first report');
  return { worktree, reports };
}

const payload = (text = '[[helper-report abc123]]', tool = 'mcp__discord__reply', event = 'PreToolUse') => ({
  hook_event_name: event, tool_name: tool, tool_input: { chat_id: '123', text, files: ['/tmp/deliverable'], reply_to: '456' },
});
const run = (dir: string, input: object) => runScript('helper-report-relay.ts', {
  cwd: dir, env: { AGENT_DIR: path.join(dir, '.claude-code-hermit') }, stdin: JSON.stringify(input),
});

test('ordinary replies and non-placeholder shapes remain untouched', withDir(async dir => {
  for (const text of ['hello', '[[helper-report ABC123]]', '[[helper-report abc123]] extra']) {
    expect(await run(dir, payload(text))).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  }
}));

test('substitutes only the named report byte-exactly and preserves other input', withDir(async dir => {
  const { reports } = seed(dir);
  const body = '```ts\nconst café = "世界";  \n```\n'.repeat(100) + 'end  \n';
  fs.writeFileSync(path.join(reports, 'second12.md'), body);
  for (const [id, expected] of [['abc123', 'first report'], ['second12', body]]) {
    const input = payload(`[[helper-report ${id}]]`);
    const result = await run(dir, input);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, text: expected },
    } });
    expect(Buffer.from(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.text)).toEqual(Buffer.from(expected));
  }
}));

test('same chat on distinct sources resolves the matching tool, including plugin prefix', withDir(async dir => {
  seed(dir);
  const { reports } = seed(dir, 'telegram:123');
  fs.writeFileSync(path.join(reports, 'abc123.md'), 'telegram report');
  for (const tool of ['mcp__telegram__reply', 'mcp__plugin_channel_telegram__reply']) {
    const result = await run(dir, payload(undefined, tool));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.text).toBe('telegram report');
  }
  expect(JSON.parse((await run(dir, payload())).stdout).hookSpecificOutput.updatedInput.text).toBe('first report');
}));

for (const failure of ['missing chat', 'no binding', 'several bindings', 'wrong source', 'unknown id', 'empty', 'too long', 'escape', 'directory escape', 'gone worktree', 'store error']) {
  test(`refuses ${failure}`, withDir(async dir => {
    const { worktree, reports } = seed(dir);
    const input: any = payload();
    const file = path.join(reports, 'abc123.md');
    if (failure === 'missing chat') delete input.tool_input.chat_id;
    if (failure === 'no binding') input.tool_input.chat_id = 'unknown';
    if (failure === 'several bindings') {
      seed(dir, 'channel_discord:123');
      input.tool_name = 'mcp__channel_discord__reply';
    }
    if (failure === 'wrong source') input.tool_name = 'mcp__other__reply';
    if (failure === 'unknown id') input.tool_input.text = '[[helper-report absent12]]';
    if (failure === 'empty') fs.writeFileSync(file, '');
    if (failure === 'too long') fs.writeFileSync(file, 'x'.repeat(8193));
    if (failure === 'escape') {
      fs.writeFileSync(path.join(dir, 'outside.md'), 'outside');
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(dir, 'outside.md'), file);
    }
    if (failure === 'directory escape') {
      fs.renameSync(reports, `${reports}-outside`);
      fs.symlinkSync(`${reports}-outside`, reports);
    }
    if (failure === 'gone worktree') fs.rmSync(worktree, { recursive: true });
    if (failure === 'store error') fs.writeFileSync(path.join(dir, '.claude-code-hermit/state/conversations.json'), '{bad');
    const result = await run(dir, input);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr.trim().length).toBeGreaterThan(0);
  }));
}

test('oversize stdin fails open', withDir(async dir => {
  seed(dir);
  const input: any = payload();
  input.padding = 'x'.repeat(MAX_HOOK_STDIN);
  expect(await run(dir, input)).toEqual({ exitCode: 0, stdout: '', stderr: '' });
}));

test('PostToolUse alarms only on an unsubstituted placeholder', withDir(async dir => {
  const result = await run(dir, payload(undefined, undefined, 'PostToolUse'));
  expect(result).toEqual({ exitCode: 2, stdout: '', stderr: 'helper report was not substituted; delivery failed\n' });
  expect(await run(dir, payload('actual report', undefined, 'PostToolUse'))).toEqual({ exitCode: 0, stdout: '', stderr: '' });
}));
