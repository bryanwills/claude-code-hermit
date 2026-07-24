import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  parseHarnessCommand,
  writePendingCommand,
  readPendingCommand,
  clearPendingCommand,
  renderCommand,
  COMMAND_MARKER_TTL_SECS,
} from '../scripts/lib/harness-command';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cmd-'));
}

describe('parseHarnessCommand grammar', () => {
  test('accepts the four bare/arg forms', () => {
    expect(parseHarnessCommand('/clear')).toEqual({ command: '/clear', arg: null });
    expect(parseHarnessCommand('/compact')).toEqual({ command: '/compact', arg: null });
    expect(parseHarnessCommand('/model opus')).toEqual({ command: '/model', arg: 'opus' });
    expect(parseHarnessCommand('/effort high')).toEqual({ command: '/effort', arg: 'high' });
  });

  // The whole point of dropping the tier list: a new model must not need a code change.
  test('accepts arbitrary future model names and effort levels', () => {
    expect(parseHarnessCommand('/model fable')).toEqual({ command: '/model', arg: 'fable' });
    expect(parseHarnessCommand('/effort ultracode')).toEqual({ command: '/effort', arg: 'ultracode' });
  });

  // Bracketed aliases are real (this repo's own sessions run claude-opus-5[1m]).
  test('accepts bracketed model aliases', () => {
    expect(parseHarnessCommand('/model opus[1m]')).toEqual({ command: '/model', arg: 'opus[1m]' });
    expect(parseHarnessCommand('/model claude-opus-5[1m]')).toEqual({
      command: '/model',
      arg: 'claude-opus-5[1m]',
    });
  });

  test('rejects an arg-command with no arg, and a bare-command with one', () => {
    expect(parseHarnessCommand('/model')).toBeNull();
    expect(parseHarnessCommand('/effort')).toBeNull();
    expect(parseHarnessCommand('/clear now')).toBeNull();
    expect(parseHarnessCommand('/compact everything')).toBeNull();
  });

  test('rejects bare words — strict slash grammar', () => {
    expect(parseHarnessCommand('clear')).toBeNull();
    expect(parseHarnessCommand('compact')).toBeNull();
    expect(parseHarnessCommand('model opus')).toBeNull();
  });

  test('rejects prose that merely mentions a command', () => {
    expect(parseHarnessCommand('please /clear the context')).toBeNull();
    expect(parseHarnessCommand('can you /model opus for me')).toBeNull();
  });

  // These are the ones that would reach a live pane. A newline would submit early and
  // turn the remainder into its own prompt.
  test('rejects injection-shaped args', () => {
    expect(parseHarnessCommand('/model opus\n/clear')).toBeNull();
    expect(parseHarnessCommand('/model opus /clear')).toBeNull();
    expect(parseHarnessCommand('/model `whoami`')).toBeNull();
    expect(parseHarnessCommand('/model opus;ls')).toBeNull();
    expect(parseHarnessCommand('/model $(id)')).toBeNull();
    expect(parseHarnessCommand(`/model ${'a'.repeat(65)}`)).toBeNull();
  });

  test('rejects unknown slash commands', () => {
    expect(parseHarnessCommand('/exit')).toBeNull();
    expect(parseHarnessCommand('/login')).toBeNull();
    expect(parseHarnessCommand('/claude-code-hermit:brief')).toBeNull();
  });
});

describe('pending-command marker', () => {
  test('round-trips and renders', () => {
    const root = tmpRoot();
    const entry = { command: '/model', arg: 'opus', by: 'op', requested_at: new Date().toISOString() };
    expect(writePendingCommand(root, entry)).toBe(true);
    expect(readPendingCommand(root)).toEqual(entry);
    expect(renderCommand(entry)).toBe('/model opus');
    fs.rmSync(root, { recursive: true });
  });

  test('renders a bare command without a trailing space', () => {
    expect(renderCommand({ command: '/clear', arg: null, by: 'op', requested_at: 'x' })).toBe('/clear');
  });

  test('absent marker reads as null', () => {
    const root = tmpRoot();
    expect(readPendingCommand(root)).toBeNull();
    fs.rmSync(root, { recursive: true });
  });

  test('marker past its TTL is ignored — a request is a moment, not a standing order', () => {
    const root = tmpRoot();
    const stale = new Date(Date.now() - (COMMAND_MARKER_TTL_SECS + 60) * 1000).toISOString();
    writePendingCommand(root, { command: '/clear', arg: null, by: 'op', requested_at: stale });
    expect(readPendingCommand(root)).toBeNull();
    fs.rmSync(root, { recursive: true });
  });

  test('malformed marker reads as null rather than throwing', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, 'state', 'pending-harness-command.json'), '{not json');
    expect(readPendingCommand(root)).toBeNull();
    fs.rmSync(root, { recursive: true });
  });

  test('clear removes it', () => {
    const root = tmpRoot();
    writePendingCommand(root, { command: '/clear', arg: null, by: 'op', requested_at: new Date().toISOString() });
    clearPendingCommand(root);
    expect(readPendingCommand(root)).toBeNull();
    fs.rmSync(root, { recursive: true });
  });
});
