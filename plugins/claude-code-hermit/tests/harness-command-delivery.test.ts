import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  isModelSwitchConfirmation,
  writePendingCommand,
} from '../scripts/lib/harness-command';
import { runScript } from './helpers/run';
import { withDir } from './helpers/workdir';

const MODEL_SWITCH_PANE = `
Switch model?
Your next response will be slower and use more tokens

This conversation is cached for the current model. Switching to Opus 5 means the full history gets
re-read on your next message.

❯ 1. Yes, switch to Opus 5
  2. No, go back
`;

const hermit = (dir: string, ...parts: string[]) =>
  path.join(dir, '.claude-code-hermit', ...parts);

function seedPendingModel(dir: string): void {
  fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify({ timezone: 'UTC' }));
  fs.writeFileSync(hermit(dir, 'state', 'runtime.json'), JSON.stringify({
    version: 1,
    session_state: 'in_progress',
    runtime_mode: 'headless',
    tmux_session: 'hermit-test',
    shutdown_requested_at: null,
    shutdown_completed_at: null,
  }));
  writePendingCommand(hermit(dir), {
    command: '/model',
    arg: 'opus',
    by: 'operator',
    requested_at: new Date().toISOString(),
  });
}

function installFakeTmux(
  dir: string,
  pane: string,
  opts: { failLiteral?: boolean; failSecondEnter?: boolean } = {},
): { bin: string; log: string } {
  const bin = path.join(dir, 'fake-bin');
  const log = path.join(dir, 'tmux-calls.log');
  const paneFile = path.join(dir, 'pane.txt');
  const enterCount = path.join(dir, 'enter-count');
  fs.mkdirSync(bin);
  fs.writeFileSync(paneFile, pane);
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  has-session) exit 0 ;;
  capture-pane) cat "${paneFile}"; exit 0 ;;
  send-keys)
    if [[ "${opts.failLiteral ? '1' : '0'}" == "1" && "$*" == *" -l -- "* ]]; then exit 1; fi
    if [[ "$*" == *" Enter" ]]; then
      count=0
      [[ -f "${enterCount}" ]] && count=$(cat "${enterCount}")
      count=$((count + 1))
      printf '%s' "$count" > "${enterCount}"
      if [[ "${opts.failSecondEnter ? '1' : '0'}" == "1" && "$count" == "2" ]]; then exit 1; fi
    fi
    exit 0
    ;;
esac
exit 1
`);
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  return { bin, log };
}

async function drain(dir: string, bin: string) {
  return runScript('stop-pipeline.ts', {
    stdin: '{}',
    cwd: dir,
    env: {
      AGENT_HOOK_PROFILE: 'minimal',
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
}

describe('model-switch confirmation matcher', () => {
  test('accepts the wrapped cached-context model prompt', () => {
    expect(isModelSwitchConfirmation(MODEL_SWITCH_PANE)).toBe(true);
  });

  test('rejects unrelated or incomplete dialogs', () => {
    expect(isModelSwitchConfirmation(`
Permission required
❯ 1. Yes, allow once
  2. No, go back
`)).toBe(false);
    expect(isModelSwitchConfirmation(`
Switch model?
❯ 1. Yes, switch to Opus 5
  2. No, go back
`)).toBe(false);
  });

  test('looks only at the pane tail', () => {
    expect(isModelSwitchConfirmation(`${MODEL_SWITCH_PANE}\n${'\n'.repeat(20)}ready`)).toBe(false);
  });
});

describe('Stop hook model delivery', () => {
  test('active context submits /model and confirms the selected Yes', withDir(async (dir) => {
    seedPendingModel(dir);
    const { bin, log } = installFakeTmux(dir, MODEL_SWITCH_PANE);

    const result = await drain(dir, bin);

    expect(result.exitCode).toBe(0);
    const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
    expect(calls.filter((line) => line.includes('-l -- /model opus'))).toHaveLength(1);
    expect(calls.filter((line) => line.endsWith(' Enter'))).toHaveLength(2);
    expect(calls).toContain('capture-pane -p -t hermit-test');
    expect(result.stderr).toContain('confirmed cached-context switch');
    expect(fs.existsSync(hermit(dir, 'state', 'pending-harness-command.json'))).toBe(false);
  }));

  test('context-free switch does not receive an extra Enter', withDir(async (dir) => {
    seedPendingModel(dir);
    const { bin, log } = installFakeTmux(dir, 'Claude ready');

    const result = await drain(dir, bin);

    expect(result.exitCode).toBe(0);
    const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
    expect(calls.filter((line) => line.endsWith(' Enter'))).toHaveLength(1);
    expect(fs.existsSync(hermit(dir, 'state', 'pending-harness-command.json'))).toBe(false);
  }));

  test('unrelated dialog is never answered', withDir(async (dir) => {
    seedPendingModel(dir);
    const { bin, log } = installFakeTmux(dir, `
Permission required
❯ 1. Yes, allow once
  2. No, go back
`);

    const result = await drain(dir, bin);

    expect(result.exitCode).toBe(0);
    const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
    expect(calls.filter((line) => line.endsWith(' Enter'))).toHaveLength(1);
  }));

  test('failed /model submission retains the marker for retry', withDir(async (dir) => {
    seedPendingModel(dir);
    const { bin } = installFakeTmux(dir, MODEL_SWITCH_PANE, { failLiteral: true });

    const result = await drain(dir, bin);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('marker kept for retry');
    expect(fs.existsSync(hermit(dir, 'state', 'pending-harness-command.json'))).toBe(true);
  }));

  test('failed confirmation does not reissue /model', withDir(async (dir) => {
    seedPendingModel(dir);
    const { bin, log } = installFakeTmux(dir, MODEL_SWITCH_PANE, { failSecondEnter: true });

    const result = await drain(dir, bin);

    expect(result.exitCode).toBe(0);
    const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
    expect(calls.filter((line) => line.includes('-l -- /model opus'))).toHaveLength(1);
    expect(calls.filter((line) => line.endsWith(' Enter'))).toHaveLength(2);
    expect(result.stderr).toContain('refused model-switch confirmation');
    expect(fs.existsSync(hermit(dir, 'state', 'pending-harness-command.json'))).toBe(false);
  }));
});
