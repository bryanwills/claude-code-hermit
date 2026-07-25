// Contract tests for scripts/user-prompt-pipeline.ts — the single UserPromptSubmit
// process — covering the two things the seven-hook shape could not express.
//
// 1. Shutdown is terminal. While a shutdown is pending, no later stage runs: not
//    status (which used to send and block on its own after a FAILED shutdown send,
//    discarding the shutdown relay instruction), not pause/resume, not a harness
//    command. Each of those was reachable by construction before, because no hook
//    could see what another had already done.
// 2. One disposition per prompt. A block prints the decision JSON alone — mixed
//    context text alongside it does not parse as a decision and the block is lost.
//
// Driven as a subprocess against a local HTTP stub, mirroring shutdown-gate.test.ts
// and channel-status-responder.test.ts.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { startHttpStub } from './helpers/http-stub';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);

function envelope(body: string, user = 'u1', chatId = '12345'): string {
  return `<channel source="telegram" chat_id="${chatId}" user="${user}">${body}</channel>`;
}

function setupChannelWorkdir(): Workdir {
  const wd = setupWorkdir();
  const stateDir = path.join(wd.dir, '.claude.local', 'channels', 'telegram');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
  fs.writeFileSync(hermit(wd.dir, 'config.json'), JSON.stringify({
    timezone: 'UTC',
    channels: { telegram: { enabled: true, dm_channel_id: '12345', allowed_users: ['u1'], state_dir: '.claude.local/channels/telegram' } },
  }));
  return wd;
}

function writeRuntime(wd: Workdir, patch: Record<string, unknown>): void {
  const p = hermit(wd.dir, 'state', 'runtime.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, session_state: 'in_progress', ...patch }));
}

// A shutdown in flight, plus the pane facts a harness command needs — so the
// harness stage is refused for the shutdown, not for a missing tmux session.
const PENDING_SHUTDOWN = {
  shutdown_requested_at: '2026-07-24T09:00:00+0000',
  shutdown_completed_at: null,
  runtime_mode: 'headless',
  tmux_session: 'hermit-test',
};

async function run(wd: Workdir, body: string, stubUrl: string) {
  return runScript('user-prompt-pipeline.ts', {
    stdin: JSON.stringify({ prompt: envelope(body) }),
    cwd: wd.dir,
    env: { HERMIT_TELEGRAM_API_URL: stubUrl },
  });
}

describe('user-prompt-pipeline: shutdown is terminal', () => {
  test('status during a pending shutdown → one send, one block, status never answers', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, PENDING_SHUTDOWN);

      const r = await run(wd, 'status', stub.url);

      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ decision: 'block' });
      // Exactly one outbound message: the shutdown reply. Two would mean the
      // status stage answered the same prompt.
      expect(stub.requests.length).toBe(1);
      // And the block is the ONLY thing on stdout — no [Now:], no reply reminder.
      expect(r.stdout).not.toContain('[Now:');
      expect(r.stdout).not.toContain('[status]');
    } finally {
      stub.stop();
    }
  });

  test('status during a pending shutdown with a FAILED send → shutdown relay only, status never answers', async () => {
    const wd = setupChannelWorkdir();
    writeRuntime(wd, PENDING_SHUTDOWN);

    // Dead listener: the shutdown send fails. Previously the prompt then fell
    // through and the status stage composed its own relay, swallowing the
    // shutdown instruction the model was supposed to act on. No stub here on
    // purpose — both stages read the same HERMIT_TELEGRAM_API_URL, so a request
    // count could not tell the two senders apart; the discriminator is that the
    // `[status]` relay is absent while the `[shutdown]` one is present.
    const r = await run(wd, 'status', 'http://127.0.0.1:1');

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[shutdown]');
    expect(r.stdout).not.toContain('[status]');
    expect(r.stdout).not.toContain('"decision"'); // a failed send must not block
  });

  test('a harness command during a pending shutdown is refused, not acknowledged', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, PENDING_SHUTDOWN);

      const r = await run(wd, '/model opus', stub.url);

      expect(r.exitCode).toBe(0);
      // The Stop-stage drain refuses to deliver a command during shutdown, so
      // recording one here would acknowledge something that never lands.
      expect(fs.existsSync(hermit(wd.dir, 'state', 'pending-harness-command.json'))).toBe(false);
      expect(r.stdout).not.toContain('[harness-command]');
    } finally {
      stub.stop();
    }
  });

  test('resume during a pending shutdown does not clear an existing pause', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      const pausePath = hermit(wd.dir, 'state', 'pause.json');
      fs.mkdirSync(path.dirname(pausePath), { recursive: true });
      fs.writeFileSync(pausePath, JSON.stringify({ paused: true, reason: 'operator', by: 'u1' }));
      writeRuntime(wd, PENDING_SHUTDOWN);

      const r = await run(wd, 'resume', stub.url);

      expect(r.exitCode).toBe(0);
      expect(JSON.parse(fs.readFileSync(pausePath, 'utf-8')).paused).toBe(true);
      expect(r.stdout).not.toContain('[pause]');
    } finally {
      stub.stop();
    }
  });
});

describe('user-prompt-pipeline: fail-open contract', () => {
  test('malformed stdin exits 0 and emits nothing', async () => {
    const wd = setupWorkdir();
    const r = await runScript('user-prompt-pipeline.ts', { stdin: '{broken', cwd: wd.dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  test('an ordinary prompt still records the operator-action markers', async () => {
    const wd = setupWorkdir();
    fs.writeFileSync(hermit(wd.dir, 'config.json'), JSON.stringify({ timezone: 'UTC' }));

    const r = await runScript('user-prompt-pipeline.ts', {
      stdin: JSON.stringify({ prompt: 'do a thing' }),
      cwd: wd.dir,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[Now:');
    expect(fs.existsSync(hermit(wd.dir, 'state', 'last-operator-action.json'))).toBe(true);
    expect(fs.existsSync(hermit(wd.dir, 'state', 'operator-turn-open.json'))).toBe(true);
  });
});
