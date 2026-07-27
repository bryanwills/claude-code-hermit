import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  isHarnessSwitchConfirmation,
  writePendingCommand,
} from '../scripts/lib/harness-command';
import { pidAlive } from '../scripts/lib/lockfile';
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

const EFFORT_SWITCH_PANE = `
Change effort level?
Your next response will be slower and use more tokens

This conversation is cached for the current effort level. Switching to high means the full history gets
re-read on your next message.

❯ 1. Yes, switch to high
  2. No, go back
`;

const SWITCH_CASES = [
  { label: 'model', command: '/model', arg: 'opus', pane: MODEL_SWITCH_PANE },
  { label: 'effort', command: '/effort', arg: 'high', pane: EFFORT_SWITCH_PANE },
] as const;

const hermit = (dir: string, ...parts: string[]) =>
  path.join(dir, '.claude-code-hermit', ...parts);

function seedPendingSwitch(dir: string, command: string, arg: string): void {
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
    command,
    arg,
    by: 'operator',
    requested_at: new Date().toISOString(),
  });
}

function installFakeTmux(
  dir: string,
  pane: string,
  opts: { failLiteral?: boolean; failSecondEnter?: boolean; revealAfterCapture?: number } = {},
): { bin: string; log: string; helperPid: string } {
  const bin = path.join(dir, 'fake-bin');
  const log = path.join(dir, 'tmux-calls.log');
  const paneFile = path.join(dir, 'pane.txt');
  const enterCount = path.join(dir, 'enter-count');
  const captureCount = path.join(dir, 'capture-count');
  const helperPid = path.join(dir, 'helper-pid');
  fs.mkdirSync(bin);
  fs.writeFileSync(paneFile, pane);
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  has-session) exit 0 ;;
  capture-pane)
    printf '%s' "$PPID" > "${helperPid}"
    count=0
    [[ -f "${captureCount}" ]] && count=$(cat "${captureCount}")
    count=$((count + 1))
    printf '%s' "$count" > "${captureCount}"
    if (( count < ${opts.revealAfterCapture ?? 1} )); then printf 'Claude ready\\n'; else cat "${paneFile}"; fi
    exit 0
    ;;
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
  return { bin, log, helperPid };
}

async function drain(dir: string, bin: string) {
  return runScript('stop-pipeline.ts', {
    stdin: '{}',
    cwd: dir,
    env: {
      AGENT_HOOK_PROFILE: 'minimal',
      HERMIT_HARNESS_CONFIRM_TIMEOUT_MS: '250',
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
}

async function waitForVerifierExit(helperPid: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let pid: number | null = null;
  while (Date.now() < deadline) {
    if (pid === null && fs.existsSync(helperPid)) {
      const parsed = Number(fs.readFileSync(helperPid, 'utf-8'));
      if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
    }
    if (pid !== null && !pidAlive(pid)) return;
    await Bun.sleep(25);
  }
  throw new Error('detached harness-switch verifier did not exit before the test deadline');
}

describe('harness-switch confirmation matcher', () => {
  test('accepts wrapped cached-context model and effort prompts', () => {
    expect(isHarnessSwitchConfirmation('/model', MODEL_SWITCH_PANE)).toBe(true);
    expect(isHarnessSwitchConfirmation('/effort', EFFORT_SWITCH_PANE)).toBe(true);
  });

  test('accepts cached-context prompts above blank terminal rows', () => {
    for (const { command, pane } of SWITCH_CASES) {
      expect(isHarnessSwitchConfirmation(command, `${pane}${'\n'.repeat(20)}`)).toBe(true);
    }
  });

  test('rejects stale cached-context prompts above newer pane content and blank rows', () => {
    const progress = Array.from({ length: 6 }, (_, i) => `running step ${i}...`).join('\n');
    for (const { command, pane } of SWITCH_CASES) {
      expect(isHarnessSwitchConfirmation(command, `${pane}\n${progress}${'\n'.repeat(20)}`)).toBe(false);
    }
  });

  test('rejects unrelated or incomplete dialogs', () => {
    expect(isHarnessSwitchConfirmation('/model', `
Permission required
❯ 1. Yes, allow once
  2. No, go back
`)).toBe(false);
    expect(isHarnessSwitchConfirmation('/model', `
Switch model?
❯ 1. Yes, switch to Opus 5
  2. No, go back
`)).toBe(false);
  });

  test('requires anchors for the delivered command', () => {
    expect(isHarnessSwitchConfirmation('/model', EFFORT_SWITCH_PANE)).toBe(false);
    expect(isHarnessSwitchConfirmation('/effort', MODEL_SWITCH_PANE)).toBe(false);
    expect(isHarnessSwitchConfirmation('/clear', MODEL_SWITCH_PANE)).toBe(false);
  });

  test('looks only at the pane tail', () => {
    for (const { command, pane } of SWITCH_CASES) {
      expect(isHarnessSwitchConfirmation(command, `${pane}\n${'\n'.repeat(20)}ready`)).toBe(false);
    }
  });
});

describe('Stop hook harness-switch delivery', () => {
  for (const { label, command, arg, pane } of SWITCH_CASES) {
    const text = `${command} ${arg}`;

    test(`${label}: cached context submits once and confirms the selected Yes`, withDir(async (dir) => {
      seedPendingSwitch(dir, command, arg);
      // The real TUI cannot render this dialog until the Stop hook exits. Make the
      // first detached capture miss so a one-shot synchronous implementation fails.
      const { bin, log, helperPid } = installFakeTmux(dir, pane, { revealAfterCapture: 2 });

      const result = await drain(dir, bin);
      await waitForVerifierExit(helperPid);

      expect(result.exitCode).toBe(0);
      const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
      expect(calls.filter((line) => line.includes(`-l -- ${text}`))).toHaveLength(1);
      expect(calls.filter((line) => line.endsWith(' Enter'))).toHaveLength(2);
      expect(calls).toContain('capture-pane -p -t hermit-test');
      expect(fs.existsSync(hermit(dir, 'state', 'pending-harness-command.json'))).toBe(false);
    }));

    test(`${label}: direct switch does not receive an extra Enter`, withDir(async (dir) => {
      seedPendingSwitch(dir, command, arg);
      const { bin, log, helperPid } = installFakeTmux(dir, 'Claude ready');

      const result = await drain(dir, bin);
      await waitForVerifierExit(helperPid);

      expect(result.exitCode).toBe(0);
      const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
      expect(calls.filter((line) => line.endsWith(' Enter'))).toHaveLength(1);
      expect(fs.existsSync(hermit(dir, 'state', 'pending-harness-command.json'))).toBe(false);
    }));

    test(`${label}: stale matching confirmation does not receive an extra Enter`, withDir(async (dir) => {
      seedPendingSwitch(dir, command, arg);
      const stalePane = `${pane}\nClaude ready${'\n'.repeat(20)}`;
      const { bin, log, helperPid } = installFakeTmux(dir, stalePane);

      const result = await drain(dir, bin);
      await waitForVerifierExit(helperPid);

      expect(result.exitCode).toBe(0);
      const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
      expect(calls.filter((line) => line.includes(`-l -- ${text}`))).toHaveLength(1);
      expect(calls.filter((line) => line.endsWith(' Enter'))).toHaveLength(1);
    }));

    test(`${label}: unrelated dialog is never answered`, withDir(async (dir) => {
      seedPendingSwitch(dir, command, arg);
      const { bin, log, helperPid } = installFakeTmux(dir, `
Permission required
❯ 1. Yes, allow once
  2. No, go back
`);

      const result = await drain(dir, bin);
      await waitForVerifierExit(helperPid);

      expect(result.exitCode).toBe(0);
      const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
      expect(calls.filter((line) => line.endsWith(' Enter'))).toHaveLength(1);
    }));

    test(`${label}: failed submission retains the marker for retry`, withDir(async (dir) => {
      seedPendingSwitch(dir, command, arg);
      const { bin } = installFakeTmux(dir, pane, { failLiteral: true });

      const result = await drain(dir, bin);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('marker kept for retry');
      expect(fs.existsSync(hermit(dir, 'state', 'pending-harness-command.json'))).toBe(true);
    }));

    test(`${label}: failed confirmation does not reissue the command`, withDir(async (dir) => {
      seedPendingSwitch(dir, command, arg);
      const { bin, log, helperPid } = installFakeTmux(dir, pane, { failSecondEnter: true });

      const result = await drain(dir, bin);
      await waitForVerifierExit(helperPid);

      expect(result.exitCode).toBe(0);
      const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
      expect(calls.filter((line) => line.includes(`-l -- ${text}`))).toHaveLength(1);
      expect(calls.filter((line) => line.endsWith(' Enter'))).toHaveLength(2);
      expect(fs.existsSync(hermit(dir, 'state', 'pending-harness-command.json'))).toBe(false);
    }));
  }
});
