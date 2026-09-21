import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { fixturesDir, withDir } from './helpers/workdir';
import { markGuest } from '../scripts/lib/guest-marker';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const PIPE_ENV = { AGENT_HOOK_PROFILE: 'standard', CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT };
const SESSION_ID = 'test-session-001'; // as carried by the stop-hook fixture

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);

function stopHookInput(dir: string): string {
  const transcript = path.join(dir, '.claude', 'transcript.jsonl');
  fs.copyFileSync(path.join(fixturesDir, 'transcript.jsonl'), transcript);
  return fs
    .readFileSync(path.join(fixturesDir, 'stop-hook-input.json'), 'utf-8')
    .replace('__TRANSCRIPT_PATH__', transcript);
}

function writeTurn(dir: string, at = '2020-01-01T00:00:00.000Z'): void {
  fs.writeFileSync(hermit(dir, 'state', 'operator-turn-open.json'), JSON.stringify({ at }) + '\n');
}

function writeAck(dir: string, patch: Record<string, unknown> = {}): void {
  fs.writeFileSync(hermit(dir, 'state', 'intake-ack.json'), JSON.stringify({
    at: '2020-01-01T00:00:01.000Z',
    channel: 'discord',
    chat_id: 'home',
    session_id: SESSION_ID,
    ...patch,
  }) + '\n');
}

function writeChats(dir: string, chatId: string, type: number): void {
  fs.writeFileSync(hermit(dir, 'state', 'channel-chats.json'), JSON.stringify({
    discord: { chats: { [chatId]: { type, parent_id: type === 11 ? 'home' : null, guild_id: 'guild', fetched_at: '2020-01-01T00:00:00.000Z' } } },
  }) + '\n');
}

async function openResident(dir: string, conversation: string): Promise<void> {
  const r = await runScript('task.ts', {
    cwd: dir,
    env: { AGENT_DIR: hermit(dir) },
    args: ['open', hermit(dir), '--owner', 'resident', '--requester', 'discord:u1', '--conversation', conversation, '--title', 'Work', '--done', 'Verified'],
  });
  expect(r.exitCode).toBe(0);
}

async function runStop(dir: string, stdin?: string) {
  return runScript('stop-pipeline.ts', {
    stdin: stdin ?? stopHookInput(dir),
    cwd: dir,
    env: { ...PIPE_ENV, AGENT_DIR: hermit(dir) },
  });
}

function turnExists(dir: string): boolean {
  return fs.existsSync(hermit(dir, 'state', 'operator-turn-open.json'));
}

describe('stop-pipeline — channel intake checkpoint', () => {
  test('no ack: stdout empty, turn marker removed', withDir(async (dir) => {
    writeTurn(dir);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(turnExists(dir)).toBe(false);
  }));

  test('ack plus a record opened this turn on a cached thread: stdout empty, turn marker removed', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir, { chat_id: 'thread' });
    writeChats(dir, 'thread', 11);
    await openResident(dir, 'discord:thread');
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(turnExists(dir)).toBe(false);
  }));

  test('ack with no record: block JSON, reason contains task.ts open, turn marker kept', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.decision).toBe('block');
    expect(body.reason).toContain('task.ts open');
    expect(body.reason).toContain('task skill');
    expect(turnExists(dir)).toBe(true);
  }));

  test('ack with a resident record keyed to a cached type 0 chat: block JSON, Resident guild thread, turn marker kept', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir);
    writeChats(dir, 'home', 0);
    await openResident(dir, 'discord:home');
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.decision).toBe('block');
    expect(body.reason).toContain('resident guild thread');
    expect(body.reason).toContain('task skill');
    expect(turnExists(dir)).toBe(true);
  }));

  test('ack in a conversation that already has an open record: stdout empty, turn marker removed', withDir(async (dir) => {
    writeChats(dir, 'thread', 11);
    await openResident(dir, 'discord:thread');
    writeTurn(dir, new Date(Date.now() + 1000).toISOString());
    writeAck(dir, { chat_id: 'thread', at: new Date(Date.now() + 2000).toISOString() });
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(turnExists(dir)).toBe(false);
  }));

  test('missing record with stop_hook_active true: stdout empty, turn marker removed', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir);
    const r = await runStop(dir, stopHookInput(dir).replace('"stop_hook_active": false', '"stop_hook_active": true'));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(turnExists(dir)).toBe(false);
  }));

  test('missing record in a guest session: stdout empty', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir);
    markGuest(hermit(dir, 'state'), SESSION_ID);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));

  test('foreign ack session is ignored: stdout empty, turn marker removed, ack deleted', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir, { session_id: 'other-session' });
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(turnExists(dir)).toBe(false);
    expect(fs.existsSync(hermit(dir, 'state', 'intake-ack.json'))).toBe(false);
  }));
});
