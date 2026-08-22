// bun test port of tests/test-watchdog.sh — black-box tests of
// scripts/hermit-watchdog.ts, the single-shot watchdog decision flow.
// The watchdog stays a spawned subprocess (it is a standalone script);
// fake tmux/pgrep live as executable stubs in a temp bin dir prepended to PATH
// in the spawn env, driving each branch without live sessions.
//
// Usage: bun test tests/watchdog.test.ts   (from the plugin root)

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, SCRIPTS_DIR } from './helpers/run';
import {
  inActiveHours, isNearDailyAutoClose, composeRestartMessage, composeWedgeMessage, composeStallQuestionMessage, composeSessionWedgedMessage, composePauseMessage, hasPendingQuestion, classifyQueueTail, composeCompactSteeringMessage,
  rearmDamperOpen, passesLifecycleGuards, setHygieneEval, stampHygieneEval,
  maybeContextClear, maybeContextCompact, MONITOR_REARM_DAMPER_SECS, type World,
} from '../scripts/hermit-watchdog';
import { startHttpStub, type Stub } from './helpers/http-stub';

// The one line to flip when hermit-watchdog is ported to TypeScript.
// (Absolute bun path via process.execPath: Bun.spawn resolves the executable
// against the child env PATH, which the no-systemctl cases restrict to the
// fake bin dir.)
const WATCHDOG_CMD = [process.execPath, path.join(SCRIPTS_DIR, 'hermit-watchdog.ts')];

// ---------- fixture scaffolding ----------

interface Hermit {
  dir: string;
  fakeBin: string;
  cleanup(): void;
}

const state = (h: Hermit, ...p: string[]) => path.join(h.dir, '.claude-code-hermit', 'state', ...p);
const eventsFile = (h: Hermit) => state(h, 'watchdog-events.jsonl');
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

/** Standard hermit project fixture: in_progress always-on tmux session. */
function setupHermit(): Hermit {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-watchdog-'));
  fs.mkdirSync(path.join(dir, '.claude-code-hermit', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude-code-hermit', 'bin'), { recursive: true });

  fs.writeFileSync(path.join(dir, '.claude-code-hermit', 'state', 'runtime.json'), JSON.stringify({
    version: 1,
    session_state: 'in_progress',
    runtime_mode: 'tmux',
    tmux_session: 'hermit-test',
    shutdown_requested_at: null,
    shutdown_completed_at: null,
    last_error: null,
    updated_at: '2026-01-01T00:00:00+0000',
  }, null, 2) + '\n');

  // Stub hermit-start: writes a marker so we can detect invocation
  const start = path.join(dir, '.claude-code-hermit', 'bin', 'hermit-start');
  fs.writeFileSync(start, `#!/usr/bin/env bash\necho "hermit-start called" > "${dir}/hermit-start-called"\n`);
  fs.chmodSync(start, 0o755);

  // Stub bin dir on PATH for fake tmux + pgrep
  const fakeBin = path.join(dir, 'fake-bin');
  fs.mkdirSync(fakeBin);

  return {
    dir, fakeBin,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function writeConfig(h: Hermit, every = '2h', watchdogExtra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'), JSON.stringify({
    watchdog: { enabled: true, stale_factor: 2, escalate_after: 3, operator_grace: '15m', ...watchdogExtra },
    heartbeat: {
      enabled: true, every,
      active_hours: { start: '00:00', end: '23:59' },
      stale_threshold: '2h',
    },
  }, null, 2) + '\n');
}

function patchRuntime(h: Hermit, patch: Record<string, unknown>): void {
  const p = state(h, 'runtime.json');
  fs.writeFileSync(p, JSON.stringify({ ...readJson(p), ...patch }) + '\n');
}

/** Fake tmux: sessionAlive 0 = alive, 1 = dead. send-keys/kill-session log to tmux-calls.log.
 *  runtimeSnapshotPath: if set, the stub copies runtime.json to this path when it sees send-keys .../clear,
 *  proving the context_cleared marker was written before the /clear keystroke.
 *  shellSnapshotPath: if set, the stub copies sessions/SHELL.md to this path at the same instant,
 *  proving the pre-clear breadcrumb was written before the /clear keystroke. */
function writeFakeTmux(h: Hermit, sessionAlive: 0 | 1, paneContent = 'tmux pane content', runtimeSnapshotPath?: string, shellSnapshotPath?: string): void {
  const log = path.join(h.dir, 'tmux-calls.log');
  const stub = path.join(h.fakeBin, 'tmux');
  const runtimePath = state(h, 'runtime.json');
  const shellPath = path.join(h.dir, '.claude-code-hermit', 'sessions', 'SHELL.md');
  const sendKeysExtra = [
    runtimeSnapshotPath ? `[[ "$*" == *"/clear"* || "$*" == *"/compact"* ]] && cat "${runtimePath}" > "${runtimeSnapshotPath}"` : '',
    shellSnapshotPath ? `[[ "$*" == *"/clear"* || "$*" == *"/compact"* ]] && cat "${shellPath}" > "${shellSnapshotPath}"` : '',
  ].filter(Boolean).join(' ; ') || 'true';
  fs.writeFileSync(stub, `#!/usr/bin/env bash
case "$1" in
  has-session) exit ${sessionAlive} ;;
  capture-pane) echo "${paneContent}" ;;
  send-keys) echo "send-keys $@" >> "${log}" ; ${sendKeysExtra} ;;
  kill-session) echo "kill-session $@" >> "${log}" ;;
esac
`);
  fs.chmodSync(stub, 0o755);
}

/** Fake pgrep: found 0 = found, 1 = not found. */
function writeFakePgrep(h: Hermit, found: 0 | 1): void {
  const stub = path.join(h.fakeBin, 'pgrep');
  fs.writeFileSync(stub, `#!/usr/bin/env bash\nexit ${found}\n`);
  fs.chmodSync(stub, 0o755);
}

/** Backdate a file's mtime by `seconds` (creating it empty if absent). */
function touchAgo(p: string, seconds: number): void {
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  const t = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(p, t, t);
}

const isoAgo = (hours: number) =>
  new Date(Date.now() - hours * 3600_000).toISOString();
const isoAgoSeconds = (hours: number) =>
  new Date(Date.now() - hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Spawn the watchdog. restrictPath limits PATH to the fake bin dir (no systemctl). */
async function watchdog(h: Hermit, sub: string, opts: { restrictPath?: boolean; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn({
    cmd: [...WATCHDOG_CMD, sub],
    cwd: h.dir,
    env: {
      ...process.env,
      PATH: opts.restrictPath ? h.fakeBin : `${h.fakeBin}:${process.env.PATH}`,
      ...opts.env,
    },
    stdin: Buffer.from(''),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Run a test body against a throwaway hermit fixture, always cleaning up. */
function withHermit(fn: (h: Hermit) => Promise<void> | void) {
  return async () => {
    const h = setupHermit();
    try { await fn(h); } finally { h.cleanup(); }
  };
}

// -------------------------------------------------------
// 1. Config gate: watchdog.enabled false → no-op
// -------------------------------------------------------

test('watchdog disabled → exit 0, no events', withHermit(async (h) => {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'),
    '{"watchdog": {"enabled": false}}\n');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h))).toBe(false);
}));

// -------------------------------------------------------
// 2. Shutdown gate: session_state idle → no-op
// -------------------------------------------------------

test('idle session → exit 0, no events', withHermit(async (h) => {
  writeConfig(h);
  patchRuntime(h, { session_state: 'idle' });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h))).toBe(false);
}));

// -------------------------------------------------------
// 3. Shutdown gate: shutdown_completed_at set → no-op
// -------------------------------------------------------

test('shutdown_completed_at set → exit 0, no events', withHermit(async (h) => {
  writeConfig(h);
  patchRuntime(h, { shutdown_completed_at: '2026-06-10T04:00:00Z' });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h))).toBe(false);
}));

// -------------------------------------------------------
// 4. Interactive mode → skip
// -------------------------------------------------------

test('interactive mode → exit 0, no events', withHermit(async (h) => {
  writeConfig(h);
  patchRuntime(h, { runtime_mode: 'interactive' });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h))).toBe(false);
}));

// -------------------------------------------------------
// 5. Dead session → restart
// -------------------------------------------------------

describe('dead session', () => {
  let h: Hermit;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    // tmux has-session returns 1 (dead)
    writeFakeTmux(h, 1);
    writeFakePgrep(h, 1);
    ({ exitCode } = await watchdog(h, 'run'));
  });

  afterAll(() => h.cleanup());

  test('dead session → restart event written', () => {
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('restart');
  });

  test('dead session → restart reason dead-process', () => {
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('dead-process');
  });

  test('dead session → runtime.json last_error set', () => {
    const d = readJson(state(h, 'runtime.json'));
    expect(d.last_error).toBe('unclean_shutdown');
    expect(d.watchdog_restart_reason).toBe('dead-process');
  });
});

// -------------------------------------------------------
// 5d. Dead session + FRESH shared liveness → orphan, abort restart
// -------------------------------------------------------

describe('dead session with fresh liveness (orphan guard)', () => {
  test('fresh liveness + no tmux → restart aborted, no hermit-start spawned', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 1); // dead
    writeFakePgrep(h, 1);
    // A fresh monitor-liveness file = an instance is still writing state.
    fs.writeFileSync(state(h, 'routine-monitor-liveness.json'), '{}');
    const { exitCode } = await watchdog(h, 'run');
    expect(exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('restart-aborted');
    expect(events).toContain('liveness-fresh-no-tmux');
    // No replacement spawned, and the restart reason is never stamped.
    expect(fs.existsSync(path.join(h.dir, 'hermit-start-called'))).toBe(false);
    expect(readJson(state(h, 'runtime.json')).watchdog_restart_reason ?? null).toBeNull();
    expect(readJson(state(h, 'watchdog-state.json')).orphan_notified).toBe(true);
  }));

  test('stale liveness + no tmux → normal restart (stale proves nothing)', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 1);
    writeFakePgrep(h, 1);
    touchAgo(state(h, 'routine-monitor-liveness.json'), 3600); // 1h old ≫ 600s
    const { exitCode } = await watchdog(h, 'run');
    expect(exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('dead-process');
    expect(events).not.toContain('restart-aborted');
    expect(fs.existsSync(path.join(h.dir, 'hermit-start-called'))).toBe(true);
  }));
});

// -------------------------------------------------------
// 5a. Re-auth relay (setup-token expiry)
// -------------------------------------------------------

/** Put the fixture in setup-token mode with a record expiring `days` from now. */
function writeSetupToken(h: Hermit, days: number, opts: { installFile?: boolean } = {}): string {
  const configDir = path.join(h.dir, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });
  if (opts.installFile !== false) {
    fs.writeFileSync(path.join(configDir, '.hermit-setup-token'), 'sk-ant-oat01-testtesttesttesttest\n', { mode: 0o600 });
  }
  fs.writeFileSync(state(h, 'setup-token.json'), JSON.stringify({
    minted_at: isoAgo(24),
    expires_at: new Date(Date.now() + days * 86400_000).toISOString(),
  }));
  return configDir;
}

const relayMarker = (h: Hermit) => state(h, 'reauth-relay.json');

describe('re-auth relay', () => {
  test('expired setup-token → relay spawned, wedge tiers suppressed', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const configDir = writeSetupToken(h, -1);
    // Heartbeat old enough that a nudge would normally fire — proving the relay
    // suppresses it rather than merely running before it.
    touchAgo(state(h, '.heartbeat'), 6 * 3600);

    const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir } });
    expect(r.exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('reauth-relay');
    expect(events).not.toContain('nudge');
  }));

  test('valid setup-token → no relay', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const configDir = writeSetupToken(h, 200);
    const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir } });
    expect(r.exitCode).toBe(0);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('reauth-relay');
  }));

  // A leftover record on a hermit that no longer uses token auth must not
  // trigger a renewal for a credential it isn't using.
  test('expired record but no token installed → no relay', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const configDir = writeSetupToken(h, -1, { installFile: false });
    const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '' } });
    expect(r.exitCode).toBe(0);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('reauth-relay');
  }));

  // The operator can legitimately take hours to reach a browser, so an in-flight
  // relay is identified by a live PID, not by marker age.
  test('live relay marker → no second relay spawned', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const configDir = writeSetupToken(h, -1);
    fs.writeFileSync(relayMarker(h), JSON.stringify({
      pid: process.pid, mode: 'relay', stage: 'awaiting-ack',
      started_at: isoAgo(5), updated_at: isoAgo(5),
    }));

    const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir } });
    expect(r.exitCode).toBe(0);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('relay spawned');
    expect(fs.existsSync(relayMarker(h))).toBe(true);
  }));

  // A crashed relay must not permanently disable recovery.
  test('dead relay marker → cleared and a fresh relay spawned', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const configDir = writeSetupToken(h, -1);
    // PID 2^22 is above the default pid_max — reliably not a running process.
    fs.writeFileSync(relayMarker(h), JSON.stringify({
      pid: 4194304, mode: 'relay', stage: 'awaiting-ack',
      started_at: isoAgo(1), updated_at: isoAgo(1),
    }));

    const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir } });
    expect(r.exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('cleared stale marker');
    expect(events).toContain('relay spawned');
  }));
});

// -------------------------------------------------------
// 5c. restart subcommand — the shared post-renewal bounce
// -------------------------------------------------------

describe('restart subcommand', () => {
  test('restart <reason> → doRestart path runs with that reason', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'restart', { env: {} });
    expect(r.exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('restart');
    expect(fs.existsSync(path.join(h.dir, 'hermit-start-called'))).toBe(true);
  }));
});

// -------------------------------------------------------
// 5b. Dead session + channel configured → restart push actually reaches it
//     (deterministic channel voice: the watchdog reaches channel-send via
//     spawnSync with no cwd override, so this also proves HERMIT_ROOT — a
//     relative path — resolves correctly through that child process boundary)
// -------------------------------------------------------

function configureChannel(h: Hermit): void {
  const p = path.join(h.dir, '.claude-code-hermit', 'config.json');
  const cfg = readJson(p);
  cfg.timezone = 'UTC';
  cfg.channels = { telegram: { enabled: true, dm_channel_id: '12345', state_dir: '.claude.local/channels/telegram' } };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  const stateDir = path.join(h.dir, '.claude.local', 'channels', 'telegram');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
}

describe('dead session with channel configured', () => {
  let h: Hermit;
  let stub: Stub;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    configureChannel(h);
    writeFakeTmux(h, 1);
    writeFakePgrep(h, 1);
    stub = startHttpStub();
    ({ exitCode } = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } }));
  });

  afterAll(() => { stub.stop(); h.cleanup(); });

  test('restart still fires', () => {
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('restart');
  });

  test('the restart push reaches the configured channel', () => {
    expect(stub.requests.length).toBe(1);
    expect(stub.requests[0].body.text).toContain("wasn't running");
  });
});

// -------------------------------------------------------
// 5c. Stall-question detection (un-redirectable, PROP-024) — catches the
//     remainder ask-gate.ts's PreToolUse deny can't reach: native permission
//     dialogs, harness-rendered prompts. Fixtures from a real capture
//     (compiled/spike-ask-gate-probe-2026-07-05.md): a pointer-marked
//     numbered option plus an "Esc to cancel" footer.
// -------------------------------------------------------

const PENDING_QUESTION_PANE =
  ' Which color do you prefer?\n\n❯ 1. Red\n  2. Green\n  3. Blue\n\nEnter to select · Esc to cancel';

// CC 2.1.233's first-run wizard, captured verbatim. The selector is "❯ Continue" — no digit,
// which is precisely what the old numbered-option regex could not see.
const AUTO_MODE_WIZARD_PANE = [
  '   Set up auto mode for your environment?',
  '',
  '   Claude Code reads this project, your recent Claude sessions, and optionally your shell history and other repositories.',
  '',
  '     How you use Claude here    ◀ Mixed ▶',
  '     Also scan shell history    [✔]',
  '     Also scan your other repos [ ]',
  '',
  '   ❯ Continue',
  '',
  '   ←/→ to change usage · Enter to continue · Esc to cancel',
].join('\n');

describe('hasPendingQuestion tail-scan (#8 false-positive guard)', () => {
  test('a genuine modal at the bottom of the pane matches', () => {
    expect(hasPendingQuestion(PENDING_QUESTION_PANE)).toBe(true);
  });

  test('the CC 2.1.233 auto-mode setup wizard matches (live wedge regression)', () => {
    expect(hasPendingQuestion(AUTO_MODE_WIZARD_PANE)).toBe(true);
  });

  test('the wizard still matches with blank terminal rows below it', () => {
    expect(hasPendingQuestion(`${AUTO_MODE_WIZARD_PANE}${'\n'.repeat(20)}`)).toBe(true);
  });

  test('a dialog whose only footer is "Enter to continue" matches', () => {
    // A wizard step that cannot be cancelled omits the Esc affordance entirely.
    expect(hasPendingQuestion('   Set up something?\n\n   ❯ Continue\n\n   Enter to continue')).toBe(true);
  });

  test('an idle composer prompt does NOT match', () => {
    // The pointer glyph also opens the composer; the status bar, not a dialog footer,
    // terminates the pane there.
    const idle = 'Boot summary\n  - Session: idle\n\n❯ Try "how does <filepath> work?"\n\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents';
    expect(hasPendingQuestion(idle)).toBe(false);
  });

  test('a genuine modal still matches with blank terminal rows below it', () => {
    // Claude 2.1.220 leaves the unused rows of a 50-line pane blank below a
    // short native permission dialog. capture-pane includes those rows.
    expect(hasPendingQuestion(`${PENDING_QUESTION_PANE}\n${'\n'.repeat(20)}`)).toBe(true);
  });

  test('the same tokens in scrollback, followed by clean output, do NOT match', () => {
    // A menu / quoted output that scrolled up, then 20 lines of ordinary activity.
    const scrollback = '❯ 1. Red\nEsc to cancel\n' + Array.from({ length: 20 }, (_, i) => `running step ${i}...`).join('\n');
    expect(hasPendingQuestion(scrollback)).toBe(false);
  });

  test('stale modal followed by short progress and blank terminal rows does NOT match', () => {
    const progress = Array.from({ length: 6 }, (_, i) => `running step ${i}...`).join('\n');
    expect(hasPendingQuestion(`${PENDING_QUESTION_PANE}\n${progress}${'\n'.repeat(20)}`)).toBe(false);
  });

  test('ordinary output that merely quotes one token does not match', () => {
    expect(hasPendingQuestion('the docs say to press Esc to cancel a running task\nall done')).toBe(false);
  });
});

// -------------------------------------------------------
// 3c. Queue-liveness wedge detection — the shape-independent net behind 3b.
//     Fixture shape is the live 2026-08-17 incident: monitor notifications
//     enqueued and never dequeued while the session sat behind a dialog.
// -------------------------------------------------------

const NOW = Date.parse('2026-08-17T14:00:00Z');
const queueRec = (operation: string, iso: string) =>
  JSON.stringify({ type: 'queue-operation', operation, timestamp: iso, sessionId: 'sess-1' });

describe('classifyQueueTail', () => {
  test('enqueue older than the threshold with no dequeue → wedged', () => {
    const tail = [
      queueRec('enqueue', '2026-08-17T07:30:00Z'),
      queueRec('enqueue', '2026-08-17T08:00:00Z'),
    ].join('\n');
    expect(classifyQueueTail(tail, NOW)).toBe('wedged');
  });

  test('a dequeue after the last enqueue → draining', () => {
    const tail = [
      queueRec('enqueue', '2026-08-17T07:30:00Z'),
      queueRec('dequeue', '2026-08-17T07:30:01Z'),
    ].join('\n');
    expect(classifyQueueTail(tail, NOW)).toBe('draining');
  });

  test('a recent enqueue still within the threshold → draining (not yet a wedge)', () => {
    expect(classifyQueueTail(queueRec('enqueue', '2026-08-17T13:50:00Z'), NOW)).toBe('draining');
  });

  test('a transcript with no queue records → unknown (fail-open)', () => {
    const tail = '{"type":"assistant","timestamp":"2026-08-17T13:00:00Z"}\n{"type":"mode","mode":"normal"}';
    expect(classifyQueueTail(tail, NOW)).toBe('unknown');
  });

  test('a truncated leading line (byte-offset tail read) is skipped, not fatal', () => {
    const tail = `p":"2026-08-17T06:00:00Z"}\n${queueRec('enqueue', '2026-08-17T08:00:00Z')}`;
    expect(classifyQueueTail(tail, NOW)).toBe('wedged');
  });
});

/** Seed a transcript for CC transcript id `transcriptId` under a sandboxed HOME, and point
 *  runtime.json's `opened_transcript` at it. That field — not `session_id`, which holds the
 *  logical S-NNN arc id — is what names the `<uuid>.jsonl` file CC writes. */
function seedTranscript(h: Hermit, transcriptId: string, lines: string[]): Record<string, string> {
  const home = path.join(h.dir, 'fake-home');
  const dir = path.join(home, '.claude', 'projects', h.dir.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${transcriptId}.jsonl`), lines.join('\n') + '\n');
  const runtimePath = state(h, 'runtime.json');
  fs.writeFileSync(runtimePath, JSON.stringify(
    { ...readJson(runtimePath), session_id: 'S-001', opened_transcript: transcriptId }, null, 2) + '\n');
  return { HOME: home };
}

describe('session-wedged detection (queued notifications not draining)', () => {
  let h: Hermit;
  let stub: Stub;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    configureChannel(h);
    writeFakeTmux(h, 0, 'ordinary pane output\nno dialog here');
    writeFakePgrep(h, 1);
    stub = startHttpStub();
    const env = seedTranscript(h, 'sess-wedged', [
      queueRec('enqueue', isoAgoSeconds(50)),
      queueRec('enqueue', isoAgoSeconds(2)),
    ]);
    ({ exitCode } = await watchdog(h, 'run', { env: { ...env, HERMIT_TELEGRAM_API_URL: stub.url } }));
  });

  afterAll(() => { stub.stop(); h.cleanup(); });

  test('stale enqueue tail → session-wedged event', () => {
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('session-wedged');
  });

  test('stale enqueue tail → watchdog-state flags session_wedged_notified', () => {
    expect(readJson(state(h, 'watchdog-state.json')).session_wedged_notified).toBe(true);
  });

  test('stale enqueue tail → exactly one operator push', () => {
    expect(stub.requests.length).toBe(1);
    expect(stub.requests[0].body.text).toContain('scheduled work');
  });

  test('alert-only: no keystrokes and no kill were sent to the pane', () => {
    const calls = fs.existsSync(path.join(h.dir, 'tmux-calls.log'))
      ? fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8')
      : '';
    expect(calls).not.toContain('send-keys');
    expect(calls).not.toContain('kill-session');
  });
});

test('draining transcript → no wedge event, sticky flag clears', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, 'ordinary pane output');
  writeFakePgrep(h, 1);
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({ session_wedged_notified: true }) + '\n');
  const stub = startHttpStub();
  try {
    const env = seedTranscript(h, 'sess-ok', [
      queueRec('enqueue', isoAgoSeconds(50)),
      queueRec('dequeue', isoAgoSeconds(49)),
    ]);
    await watchdog(h, 'run', { env: { ...env, HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(readJson(state(h, 'watchdog-state.json')).session_wedged_notified).toBe(false);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('session-wedged');
  } finally { stub.stop(); }
}));

test('unknown verdict (fresh transcript after restart) re-arms the sticky flag', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, 'ordinary pane output');
  writeFakePgrep(h, 1);
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({ session_wedged_notified: true }) + '\n');
  const stub = startHttpStub();
  try {
    // A brand-new session's transcript carries no queue records yet → 'unknown'.
    // Holding the flag through that would mute the NEXT real wedge.
    const env = seedTranscript(h, 'sess-fresh', ['{"type":"mode","mode":"normal"}']);
    await watchdog(h, 'run', { env: { ...env, HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(readJson(state(h, 'watchdog-state.json')).session_wedged_notified).toBe(false);
  } finally { stub.stop(); }
}));

test('missing transcript → no wedge event (fail-open)', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, 'ordinary pane output');
  writeFakePgrep(h, 1);
  const stub = startHttpStub();
  try {
    await watchdog(h, 'run', { env: { HOME: path.join(h.dir, 'empty-home'), HERMIT_TELEGRAM_API_URL: stub.url } });
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('session-wedged');
  } finally { stub.stop(); }
}));

describe('stall-question detection', () => {
  let h: Hermit;
  let stub: Stub;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    configureChannel(h);
    writeFakeTmux(h, 0, PENDING_QUESTION_PANE);
    writeFakePgrep(h, 1);
    stub = startHttpStub();
    ({ exitCode } = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } }));
  });

  afterAll(() => { stub.stop(); h.cleanup(); });

  test('pending dialog on pane → stall-question-detected event', () => {
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('stall-question-detected');
  });

  test('pending dialog → watchdog-state.json flags stall_question_notified', () => {
    expect(readJson(state(h, 'watchdog-state.json')).stall_question_notified).toBe(true);
  });

  test('pending dialog → operator push reaches the configured channel', () => {
    expect(stub.requests.length).toBe(1);
    expect(stub.requests[0].body.text).toContain("can't ask over chat");
  });
});

test('pending dialog, second tick → deduped, no second push', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, PENDING_QUESTION_PANE);
  writeFakePgrep(h, 1);
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({ stall_question_notified: true }) + '\n');
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(stub.requests.length).toBe(0);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('stall-question-detected');
  } finally {
    stub.stop();
  }
}));

test('pane clears after a flagged episode → re-arms (flag cleared, no new event)', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0, 'tmux pane content');
  writeFakePgrep(h, 1);
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({ stall_question_notified: true }) + '\n');
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(readJson(state(h, 'watchdog-state.json')).stall_question_notified).toBe(false);
  const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
  expect(events).not.toContain('stall-question-detected');
}));

test('ordinary busy pane content → no false-positive match', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0, 'tmux pane content');
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
  expect(events).not.toContain('stall-question-detected');
}));

// Regression: a pending pane whose in-session heartbeat has ALSO gone stale must
// NOT be nudged or restarted. Wedge detection (step 4) and the re-arm fallback
// (step 5) both send keystrokes into the pane; on a focused prompt that would
// auto-answer the operator's pending decision. The stall detector notifies and
// stops — never keystrokes.
test('pending dialog + stale heartbeat + operator silent → notify only, no send-keys, no restart', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, PENDING_QUESTION_PANE);
  writeFakePgrep(h, 1);              // monitor down — the escalation/restart signal
  touchAgo(state(h, '.heartbeat'), 6 * 3600); // stale (threshold 2h*2 = 4h)
  // No last-operator-action.json → operator silent (recency guard would not save it)
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('stall-question-detected'); // fail-loud fired
    expect(events).not.toContain('nudge');
    expect(events).not.toContain('restart');
    const tmuxCalls = fs.existsSync(path.join(h.dir, 'tmux-calls.log'))
      ? fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8')
      : '';
    expect(tmuxCalls).not.toContain('send-keys');   // never keystroke the pane
    expect(tmuxCalls).not.toContain('kill-session'); // never restart into it
  } finally {
    stub.stop();
  }
}));

test('stale dialog scrollback + stale heartbeat → normal nudge recovery continues', withHermit(async (h) => {
  writeConfig(h);
  const progress = Array.from({ length: 6 }, (_, i) => `running step ${i}...`).join('\n');
  writeFakeTmux(h, 0, `${PENDING_QUESTION_PANE}\n${progress}${'\n'.repeat(20)}`);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  const events = fs.readFileSync(eventsFile(h), 'utf-8');
  expect(events).not.toContain('stall-question-detected');
  expect(events).toContain('nudge');
  expect(fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8')).toContain('send-keys');
}));

// -------------------------------------------------------
// 4b. Wedge threshold floor (watchdog.wedge_floor / WEDGE_FLOOR_DEFAULT)
// -------------------------------------------------------

test('floor: every 30m + 1h-stale heartbeat → no nudge (threshold floored to 4h)', withHermit(async (h) => {
  writeConfig(h, '30m');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 3600); // 1h — past 30m*2, inside the 4h floor

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '').not.toContain('nudge');
}));

test('floor: every 30m + 3h59m-stale heartbeat → no nudge (just inside the floor)', withHermit(async (h) => {
  writeConfig(h, '30m');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 4 * 3600 - 60);

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '').not.toContain('nudge');
}));

test('floor: every 30m + 5h-stale heartbeat → nudge (past the 4h floor)', withHermit(async (h) => {
  writeConfig(h, '30m');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 5 * 3600);

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('nudge');
}));

// Floor is a lower bound, not a replacement: a long interval still widens the threshold.
test('floor inactive: every 4h + 5h-stale heartbeat → no nudge (8h product wins)', withHermit(async (h) => {
  writeConfig(h, '4h');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 5 * 3600);

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '').not.toContain('nudge');
}));

// The floor is operator policy, not a constant: an install that tightened heartbeat.every
// can tighten the wedge threshold back down with it. Without wedge_floor this config waits 4h.
test('wedge_floor override: every 15m + 1h-stale heartbeat → nudge (floor lowered to 30m)', withHermit(async (h) => {
  writeConfig(h, '15m', { wedge_floor: '30m' });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 3600);

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('nudge');
}));

// -------------------------------------------------------
// 5b. Supervision on an idle session arc
//
// The contract under test is about the GATE, not about any one dialog: whatever holds
// stdin — a permission prompt, an AskUserQuestion modal, a first-run wizard, a shape no
// released Claude Code has shown yet — an idle session arc must still raise exactly one
// alert. The tests below therefore cover a generic modal, a real captured wizard, and a
// dialog the pane scanner deliberately does NOT recognise (caught by the queue-liveness
// net instead). Nothing here keys off the wizard that exposed the bug.
//
// The failure this pins: both detectors return the correct verdict, but the step-2 shutdown
// gate exited on `session_state: 'idle'` before either could run — so a blocked session
// stayed blocked indefinitely with no alert.
//
// `idle` is not a stop signal: 'in_progress' is written only by the model-driven
// /session-start open path, and session-close returns it to 'idle', so every hermit rests
// there between arcs. Worse, the state is self-sealing — leaving `idle` needs the model to
// take a turn, which is exactly what a blocking dialog prevents.
//
// Every pre-existing test above runs at setupHermit's hardcoded 'in_progress', which no
// wedged hermit is ever in. That is why this shipped green. These tests pin the real state.
// -------------------------------------------------------

/** A wizard step whose pointer rests on a CHECKBOX row while "Continue" sits unmarked below
 *  it — unlike AUTO_MODE_WIZARD_PANE, where the pointer is on "❯ Continue" itself. The
 *  detector must match a pointer on any row, not only on the confirming one. */
const CHECKBOX_ROW_WIZARD_PANE = [
  '  Ran 1 shell command',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '   Set up auto mode for your environment?',
  '',
  '   Claude Code reads this project, your recent Claude sessions, and',
  '   optionally your shell history and other repositories.',
  '',
  '     How you use Claude here    ◀ Mixed ▶',
  '   ❯ Also scan shell history    [✔]',
  '     Also scan your other repos [ ]',
  '',
  '     Continue',
  '',
  '   ←/→ to change usage · Enter to continue · Esc to cancel',
].join('\n');

test('wizard pane with the pointer on a checkbox row matches', () => {
  expect(hasPendingQuestion(CHECKBOX_ROW_WIZARD_PANE)).toBe(true);
});

test('idle arc + pending dialog → stall-question-detected and one push', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  patchRuntime(h, { session_state: 'idle' });
  writeFakeTmux(h, 0, CHECKBOX_ROW_WIZARD_PANE);
  writeFakePgrep(h, 1);
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('stall-question-detected');
    expect(stub.requests.length).toBe(1);
  } finally { stub.stop(); }
}));

// Not wizard-specific: a plain AskUserQuestion/permission-shaped modal on an idle arc
// must alert identically. The gate never inspected the dialog, and neither does the fix.
test('idle arc + generic modal (not the wizard) → stall-question-detected and one push', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  patchRuntime(h, { session_state: 'idle' });
  writeFakeTmux(h, 0, PENDING_QUESTION_PANE);
  writeFakePgrep(h, 1);
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('stall-question-detected');
    expect(stub.requests.length).toBe(1);
  } finally { stub.stop(); }
}));

// The generic net, and the reason 3c exists at all: a blocker the pane scanner cannot
// recognise (no pointer glyph, no dialog footer) still gets caught, because a blocked
// session stops draining its notification queue whatever is holding stdin. This is the
// case that must keep working for dialog shapes no released Claude Code has shipped yet.
test('idle arc + UNRECOGNISED blocker shape → still alerts via queue liveness', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  patchRuntime(h, { session_state: 'idle' });
  const novelBlocker = 'Some future modal\n\n  [ Accept ]   [ Decline ]\n\npress a key';
  expect(hasPendingQuestion(novelBlocker)).toBe(false);   // 3b is blind to it, by design
  writeFakeTmux(h, 0, novelBlocker);
  writeFakePgrep(h, 1);
  const stub = startHttpStub();
  try {
    const env = seedTranscript(h, 'sess-novel', [
      queueRec('dequeue', isoAgoSeconds(9)),
      queueRec('enqueue', isoAgoSeconds(8)),
    ]);
    const r = await watchdog(h, 'run', { env: { ...env, HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('session-wedged');
    expect(stub.requests.length).toBe(1);
  } finally { stub.stop(); }
}));

test('idle arc + stale enqueue tail → session-wedged and one push', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  patchRuntime(h, { session_state: 'idle' });
  writeFakeTmux(h, 0, 'ordinary pane output\nno dialog here');
  writeFakePgrep(h, 1);
  const stub = startHttpStub();
  try {
    // The captured production shape: a drain that stopped, then enqueues that never drained.
    const env = seedTranscript(h, 'sess-idle-wedged', [
      queueRec('dequeue', isoAgoSeconds(14)),
      queueRec('enqueue', isoAgoSeconds(13)),
      queueRec('enqueue', isoAgoSeconds(1.3)),
    ]);
    const r = await watchdog(h, 'run', { env: { ...env, HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('session-wedged');
    expect(stub.requests.length).toBe(1);
  } finally { stub.stop(); }
}));

test('idle arc + clean pane + draining queue → still no events', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  patchRuntime(h, { session_state: 'idle' });
  writeFakeTmux(h, 0, 'ordinary pane output');
  writeFakePgrep(h, 1);
  const stub = startHttpStub();
  try {
    const env = seedTranscript(h, 'sess-idle-ok', [
      queueRec('enqueue', isoAgoSeconds(2)),
      queueRec('dequeue', isoAgoSeconds(1.9)),
    ]);
    const r = await watchdog(h, 'run', { env: { ...env, HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('session-wedged');
    expect(events).not.toContain('stall-question-detected');
    expect(stub.requests.length).toBe(0);
  } finally { stub.stop(); }
}));

// The guard 3c's own contract always claimed ("while tmux is alive") but never implemented
// — it relied on the idle gate that no longer exits here. Without it, a deliberately-stopped
// hermit whose last transcript record happens to be an enqueue would alert forever.
test('idle arc + DEAD tmux + stale enqueue tail → no wedge event', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  patchRuntime(h, { session_state: 'idle' });
  writeFakeTmux(h, 1, 'irrelevant');   // 1 = session gone
  writeFakePgrep(h, 1);
  const stub = startHttpStub();
  try {
    const env = seedTranscript(h, 'sess-stopped', [
      queueRec('enqueue', isoAgoSeconds(30)),
    ]);
    const r = await watchdog(h, 'run', { env: { ...env, HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('session-wedged');
    expect(stub.requests.length).toBe(0);
  } finally { stub.stop(); }
}));

// The other half of the contract: reaching the alert tiers must NOT hand an idle arc back
// to the keystroke tiers. "Never resurrect a deliberately-stopped hermit" still holds.
test('idle arc + stale heartbeat + monitor down → no nudge, no restart, no keystrokes', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  patchRuntime(h, { session_state: 'idle' });
  writeFakeTmux(h, 0, 'ordinary pane output');
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('nudge');
    expect(events).not.toContain('restart');
    const tmuxCalls = fs.existsSync(path.join(h.dir, 'tmux-calls.log'))
      ? fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8')
      : '';
    expect(tmuxCalls).not.toContain('send-keys');
    expect(tmuxCalls).not.toContain('kill-session');
  } finally { stub.stop(); }
}));

// -------------------------------------------------------
// 6. Alive + operator recent → back off (no events)
// -------------------------------------------------------

describe('alive + operator recent', () => {
  let h: Hermit;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    // .heartbeat mtime 6h ago (stale — threshold is 2h*2=4h)
    touchAgo(state(h, '.heartbeat'), 6 * 3600);
    // operator action 5 minutes ago (within 15m grace)
    fs.writeFileSync(state(h, 'last-operator-action.json'),
      JSON.stringify({ at: isoAgo(5 / 60) }) + '\n');
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    ({ exitCode } = await watchdog(h, 'run'));
  });

  afterAll(() => h.cleanup());

  test('stale + operator recent → no events', () => {
    expect(exitCode).toBe(0);
    expect(fs.existsSync(eventsFile(h))).toBe(false);
  });

  test('stale + operator recent → consecutive reset to 0', () => {
    expect(readJson(state(h, 'watchdog-state.json')).consecutive_stale).toBe(0);
  });
});

// -------------------------------------------------------
// 7. Alive + stale + operator silent → nudge on cycle 1
// -------------------------------------------------------

describe('alive + stale + operator silent', () => {
  let h: Hermit;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    touchAgo(state(h, '.heartbeat'), 6 * 3600);
    // No last-operator-action.json (operator silent)
    writeFakeTmux(h, 0, 'some pane content');
    // pgrep returns 1 = monitor not running (wedge signal)
    writeFakePgrep(h, 1);
    ({ exitCode } = await watchdog(h, 'run'));
  });

  afterAll(() => h.cleanup());

  test('stale + operator silent → nudge event written', () => {
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('nudge');
  });

  test('nudge cycle 1 → consecutive_stale = 1', () => {
    expect(readJson(state(h, 'watchdog-state.json')).consecutive_stale).toBe(1);
  });

  test('nudge cycle 1 → send-keys called', () => {
    expect(fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8')).toContain('send-keys');
  });
});

// -------------------------------------------------------
// 8. Escalation after escalate_after cycles (pane frozen + monitor dead)
// -------------------------------------------------------

describe('escalation', () => {
  let h: Hermit;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    touchAgo(state(h, '.heartbeat'), 6 * 3600);
    // Fake tmux pane content — the stub's echo adds a trailing newline, so the
    // stored hash must include it for the pane to read as frozen.
    const paneContent = 'frozen pane';
    const frozenHash = crypto.createHash('sha256').update(`${paneContent}\n`).digest('hex');
    fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
      consecutive_stale: 2, last_pane_hash: frozenHash, last_nudge_at: '2026-01-01T00:00:00Z',
    }) + '\n');
    // Fake tmux: session alive, pane returns same content → same hash
    writeFakeTmux(h, 0, paneContent);
    // pgrep returns 1 = monitor not running
    writeFakePgrep(h, 1);
    ({ exitCode } = await watchdog(h, 'run'));
  });

  afterAll(() => h.cleanup());

  test('escalation at cycle 3 (pane frozen + monitor dead) → restart', () => {
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('restart');
  });

  test('escalation reason is pane-frozen', () => {
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('pane-frozen');
  });
});

// -------------------------------------------------------
// 9. Alive + pane changed → nudge (not restart), even at escalate_after cycles
// -------------------------------------------------------

test('pane changed at cycle 3 → nudge (not restart)', withHermit(async (h) => {
  writeConfig(h);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  // State shows 2 prior stale cycles with old hash
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
    consecutive_stale: 2, last_pane_hash: 'old-hash-abc', last_nudge_at: '2026-01-01T00:00:00Z',
  }) + '\n');
  // Fake tmux returns DIFFERENT pane content → different hash
  writeFakeTmux(h, 0, 'new pane content different from old');
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  const events = fs.readFileSync(eventsFile(h), 'utf-8');
  expect(events).toContain('nudge');
  expect(events).not.toContain('restart');
}));

// -------------------------------------------------------
// 10. Re-arm fallback: heartbeat-restart not fired in > 26h
// -------------------------------------------------------

test('heartbeat-restart missed > 26h → re-arm-fallback event', withHermit(async (h) => {
  writeConfig(h);
  // Recent .heartbeat (30 minutes ago) so wedge detection is skipped
  touchAgo(state(h, '.heartbeat'), 1800);
  // routine-metrics.jsonl: heartbeat-restart fired 28h ago
  fs.writeFileSync(state(h, 'routine-metrics.jsonl'), JSON.stringify({
    ts: isoAgoSeconds(28), routine_id: 'heartbeat-restart', event: 'fired', delivery: 'cron-create',
  }) + '\n');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 0);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('re-arm-fallback');
}));

// The re-arm fallback used to send `/heartbeat start` unconditionally — the second
// ungated heartbeat-start path (the routine anchor was the first). An automated
// re-arm is not an operator override, so it honours heartbeat.enabled; the routine
// reload stays unconditional because it is what keeps the scheduler itself alive.
test('heartbeat-restart missed > 26h + heartbeat disabled → routines reloaded, heartbeat NOT started', withHermit(async (h) => {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'), JSON.stringify({
    watchdog: { enabled: true, stale_factor: 2, escalate_after: 3, operator_grace: '15m' },
    heartbeat: { enabled: false, every: '2h', active_hours: { start: '00:00', end: '23:59' }, stale_threshold: '2h' },
  }, null, 2) + '\n');
  touchAgo(state(h, '.heartbeat'), 1800);
  fs.writeFileSync(state(h, 'routine-metrics.jsonl'), JSON.stringify({
    ts: isoAgoSeconds(28), routine_id: 'heartbeat-restart', event: 'fired', delivery: 'cron-create',
  }) + '\n');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 0);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  const calls = tmuxCalls(h);
  expect(calls).toContain('/claude-code-hermit:hermit-routines load');
  expect(calls).not.toContain('/claude-code-hermit:heartbeat start');
}));

// -------------------------------------------------------
// 11. Re-arm suppressed: heartbeat-restart fired < 26h ago
// -------------------------------------------------------

test('heartbeat-restart fired < 26h → no re-arm', withHermit(async (h) => {
  writeConfig(h);
  touchAgo(state(h, '.heartbeat'), 1800);
  // fired 2h ago — within the 26h window
  fs.writeFileSync(state(h, 'routine-metrics.jsonl'), JSON.stringify({
    ts: isoAgoSeconds(2), routine_id: 'heartbeat-restart', event: 'fired', delivery: 'cron-create',
  }) + '\n');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 0);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h))).toBe(false);
}));

// -------------------------------------------------------
// 11b. started event is not treated as fired by re-arm check
// -------------------------------------------------------

test('started event does not count as fired for re-arm check', withHermit(async (h) => {
  writeConfig(h);
  touchAgo(state(h, '.heartbeat'), 1800);
  // started 1h ago (recent) + fired 28h ago. If started were counted as fired, re-arm
  // would be suppressed. With correct behavior (only event==="fired" counts), re-arm fires.
  fs.writeFileSync(state(h, 'routine-metrics.jsonl'), [
    JSON.stringify({ ts: isoAgoSeconds(28), routine_id: 'heartbeat-restart', event: 'fired', delivery: 'cron-create' }),
    JSON.stringify({ ts: isoAgoSeconds(1), routine_id: 'heartbeat-restart', event: 'started', delivery: 'cron-create' }),
  ].join('\n') + '\n');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 0);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('re-arm-fallback');
}));

// -------------------------------------------------------
// 11d/e. Step-5 re-arm damper: the fired metric only advances at the routine's
//        next real fire, so an undamped >26h check re-injects every tick. One
//        attempt per 6h window, mirroring step 6.
// -------------------------------------------------------

// Shared setup: heartbeat-restart fired 28h ago (> 26h), .heartbeat fresh so wedge
// detection stays out of the way, live session.
const armStep5 = (h: Hermit) => {
  writeConfig(h);
  touchAgo(state(h, '.heartbeat'), 1800);
  fs.writeFileSync(state(h, 'routine-metrics.jsonl'), JSON.stringify({
    ts: isoAgoSeconds(28), routine_id: 'heartbeat-restart', event: 'fired', delivery: 'cron-create',
  }) + '\n');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 0);
};

test('re-arm fallback within damper window → no second re-arm', withHermit(async (h) => {
  armStep5(h);
  // Fallback re-armed 1h ago: inside the 6h damper.
  writeState(h, 'watchdog-state.json', { last_rearm_fallback: isoAgo(1) });
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).not.toContain('re-arm-fallback');
}));

test('re-arm fallback past damper window → fires and refreshes damper stamp', withHermit(async (h) => {
  armStep5(h);
  const stale = isoAgo(7); // last fallback 7h ago, past the 6h damper
  writeState(h, 'watchdog-state.json', { last_rearm_fallback: stale });
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toContain('re-arm-fallback');
  const stamp = readWatchdogStateFile(h).last_rearm_fallback;
  expect(typeof stamp).toBe('string');
  expect(stamp).not.toBe(stale);
}));

test('re-arm fallback suppressed while paused', withHermit(async (h) => {
  armStep5(h);
  writePauseFlag(h);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).not.toContain('re-arm-fallback');
}));

// -------------------------------------------------------
// 11c. Monitor-liveness re-arm (step 6): recover a Monitor that died mid-session,
//      detected via its stale liveness file rather than step 5's fired-age heuristic.
//      No .heartbeat file → wedge (step 4) skipped; no routine-metrics.jsonl →
//      step-5 fired-age fallback skipped; so only step 6 is under test here.
// -------------------------------------------------------

const tmuxCalls = (h: Hermit) => {
  const p = path.join(h.dir, 'tmux-calls.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
};
const events = (h: Hermit) => (fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '');
const writeState = (h: Hermit, name: string, obj: unknown) =>
  fs.writeFileSync(state(h, name), JSON.stringify(obj) + '\n');
const writeRoutineMonitorConfig = (h: Hermit) =>
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'), JSON.stringify({
    watchdog: { enabled: true, stale_factor: 2, escalate_after: 3, operator_grace: '15m' },
    heartbeat: { enabled: true, every: '2h', active_hours: { start: '00:00', end: '23:59' } },
    routines: [{ id: 'scheduled-checks', enabled: true, schedule: '*/30 * * * *' }],
  }, null, 2) + '\n');

test('stale heartbeat liveness → monitor-rearm event, only heartbeat start injected', withHermit(async (h) => {
  writeConfig(h); // heartbeat every 2h → threshold 6h; no routines
  // Trusted but stale: last tick 8h ago, monitor registered 9h ago.
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(8) });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toContain('monitor-rearm');
  expect(events(h)).toContain('heartbeat');
  const calls = tmuxCalls(h);
  expect(calls).toContain('/claude-code-hermit:heartbeat start');
  expect(calls).not.toContain('hermit-routines load');
  // Damper stamp persisted for the heartbeat monitor.
  expect(typeof readWatchdogStateFile(h).last_monitor_rearm?.heartbeat).toBe('string');
}));

test('fresh heartbeat liveness → no monitor-rearm', withHermit(async (h) => {
  writeConfig(h);
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(5 / 60) }); // 5 min ago
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(1 / 60) });       // 1 min ago
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).not.toContain('monitor-rearm');
}));

test('stale liveness but within damper window → no second re-arm', withHermit(async (h) => {
  writeConfig(h);
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(8) });
  // Already re-armed 1h ago — inside the 6h per-monitor damper.
  writeState(h, 'watchdog-state.json', { last_monitor_rearm: { heartbeat: isoAgo(1) } });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).not.toContain('monitor-rearm');
}));

test('stale liveness but dead session → restart path owns it, no monitor-rearm', withHermit(async (h) => {
  writeConfig(h);
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(8) });
  writeFakeTmux(h, 1); // dead
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toContain('restart');
  expect(events(h)).not.toContain('monitor-rearm');
}));

test('stale liveness but operator active < grace → no re-arm', withHermit(async (h) => {
  writeConfig(h); // operator_grace 15m
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(8) });
  writeState(h, 'last-operator-action.json', { at: isoAgo(2 / 60) }); // 2 min ago
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).not.toContain('monitor-rearm');
}));

test('liveness tick predating started_at + past startup grace → re-arm', withHermit(async (h) => {
  writeConfig(h);
  // Monitor registered 10 min ago (past the 2-min grace); only tick is 20 min ago,
  // which predates started_at → untrusted → falls to the startup-grace branch.
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(10 / 60) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(20 / 60) });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toContain('monitor-rearm');
}));

test('stale liveness but hermit paused → no re-arm', withHermit(async (h) => {
  writeConfig(h);
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(8) });
  writeState(h, 'operator-pause.json', { paused: true, paused_until: null, reason: 'operator' });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).not.toContain('monitor-rearm');
}));

test('stale routine-monitor liveness → monitor-rearm, only hermit-routines load injected', withHermit(async (h) => {
  // Routine monitor enabled (a non-anchor routine), interval 60s → threshold 10m.
  writeRoutineMonitorConfig(h);
  writeState(h, 'routine-monitor.runtime.json', { started_at: isoAgo(25 / 60), interval: 60, mode: 'monitor' });
  writeState(h, 'routine-monitor-liveness.json', { last_peek_at: isoAgo(20 / 60) }); // 20 min ago > 10m
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toContain('monitor-rearm');
  expect(events(h)).toContain('routine-monitor');
  const calls = tmuxCalls(h);
  expect(calls).toContain('/claude-code-hermit:hermit-routines load');
  expect(calls).not.toContain('heartbeat start');
}));

test('routine monitor in croncreate-fallback mode → no re-arm', withHermit(async (h) => {
  writeRoutineMonitorConfig(h);
  writeState(h, 'routine-monitor.runtime.json', { started_at: isoAgo(25 / 60), interval: 60, mode: 'croncreate-fallback' });
  writeState(h, 'routine-monitor-liveness.json', { last_peek_at: isoAgo(20 / 60) });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).not.toContain('monitor-rearm');
}));

// -------------------------------------------------------
// 12. checkWatchdog in doctor-check.ts: disabled → ok
// -------------------------------------------------------

const DOCTOR_BASE = {
  agent_name: null, language: null, timezone: null, escalation: 'balanced',
  channels: {}, env: {}, heartbeat: { enabled: true, every: '2h' },
  routines: [], quality_gate: { tier: 'budget' },
};

async function doctorWatchdogCheck(h: Hermit) {
  const r = await runScript('doctor-check.ts', { cwd: h.dir });
  const checks = JSON.parse(r.stdout).checks.filter((c: any) => c.id === 'watchdog');
  expect(checks.length).toBeGreaterThan(0); // watchdog check missing otherwise
  return checks[0];
}

const readWatchdogStateFile = (h: Hermit) => readJson(state(h, 'watchdog-state.json'));

/** Seed watchdog-state.json with a given last_run (null ⇒ omit the field). */
function setLastRun(h: Hermit, iso: string | null): void {
  const p = state(h, 'watchdog-state.json');
  const cur = fs.existsSync(p) ? readJson(p) : { consecutive_stale: 0 };
  if (iso === null) delete cur.last_run; else cur.last_run = iso;
  fs.writeFileSync(p, JSON.stringify(cur) + '\n');
}

function writeDoctorConfig(h: Hermit, enabled = true): void {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'),
    JSON.stringify({
      watchdog: enabled
        ? { enabled: true, stale_factor: 2, escalate_after: 3, operator_grace: '15m' }
        : { enabled: false },
      ...DOCTOR_BASE,
    }, null, 2) + '\n');
}

test('doctor checkWatchdog: disabled → ok', withHermit(async (h) => {
  // post_close_clear and context_hygiene are explicitly off: absent keys now
  // settle to template defaults (on), which would mean the tick is needed.
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'),
    JSON.stringify({
      watchdog: { enabled: false, context_clear_tokens: null }, post_close_clear: false,
      context_hygiene: { compact: { enabled: false } }, ...DOCTOR_BASE,
    }, null, 2) + '\n');
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('ok');
  expect(w.detail).toContain('disabled');
}));

// -------------------------------------------------------
// 13. checkWatchdog: enabled + recent restart → warn
// -------------------------------------------------------

test('doctor checkWatchdog: restart in last 7d → warn', withHermit(async (h) => {
  writeDoctorConfig(h);
  fs.writeFileSync(eventsFile(h), JSON.stringify({
    ts: isoAgoSeconds(0), action: 'restart', reason: 'dead-process',
  }) + '\n');
  setLastRun(h, new Date().toISOString()); // fresh liveness → exercise the restart-summary path, not the liveness warn
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
  expect(w.detail).toContain('restarts: 1');
}));

// -------------------------------------------------------
// liveness: last_run stamp (script) + doctor liveness branches
// -------------------------------------------------------

test('run stamps last_run before the enabled gate (enabled:false)', withHermit(async (h) => {
  // Hygiene tiers explicitly off: absent keys now settle to template defaults
  // (on), which would send this minimal fixture down tmux-dependent paths.
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'),
    '{"watchdog": {"enabled": false, "context_clear_tokens": null}, "post_close_clear": false, "context_hygiene": {"compact": {"enabled": false}}}\n');
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  const ws = readWatchdogStateFile(h);
  expect(typeof ws.last_run).toBe('string');
  expect(Date.now() - Date.parse(ws.last_run)).toBeLessThan(60_000);
}));

test('doctor checkWatchdog: enabled + fresh last_run + quiet → ok, shows last tick', withHermit(async (h) => {
  writeDoctorConfig(h);
  setLastRun(h, new Date().toISOString());
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('ok');
  expect(w.detail).toContain('last tick');
}));

test('doctor checkWatchdog: enabled + stale last_run + tmux → warn, install hint', withHermit(async (h) => {
  writeDoctorConfig(h);          // setupHermit runtime_mode = tmux
  setLastRun(h, isoAgo(1));      // 1h ago → stale
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
  expect(w.detail).toContain('not firing');
  expect(w.detail).toContain('hermit-watchdog install');
}));

test('doctor checkWatchdog: enabled + missing last_run + docker → warn, recreate hint', withHermit(async (h) => {
  writeDoctorConfig(h);
  patchRuntime(h, { runtime_mode: 'docker' });
  // no watchdog-state.json → last_run missing
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
  expect(w.detail).toContain('not firing');
  expect(w.detail).toContain('force-recreate');
}));

test('doctor checkWatchdog: enabled + stale last_run + unknown runtime → warn, both hints', withHermit(async (h) => {
  writeDoctorConfig(h);
  fs.rmSync(state(h, 'runtime.json')); // runtime_mode unknown
  setLastRun(h, isoAgo(1));
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
  expect(w.detail).toContain('hermit-watchdog install');
  expect(w.detail).toContain('force-recreate');
}));

test('doctor checkWatchdog: stale last_run + recent restart → not-firing wins, summary suppressed', withHermit(async (h) => {
  writeDoctorConfig(h);
  fs.writeFileSync(eventsFile(h), JSON.stringify({
    ts: isoAgoSeconds(0), action: 'restart', reason: 'dead-process',
  }) + '\n');
  setLastRun(h, isoAgo(1)); // stale → liveness takes precedence
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
  expect(w.detail).toContain('not firing');
  expect(w.detail).not.toContain('restarts:');
}));

test('doctor checkWatchdog: restart tier disabled but post_close_clear active → liveness still checked',
  withHermit(async (h) => {
    fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'),
      JSON.stringify({ watchdog: { enabled: false }, post_close_clear: true, ...DOCTOR_BASE }, null, 2) + '\n');
    setLastRun(h, isoAgo(1)); // stale — the hygiene tier still needs a live scheduler tick
    const w = await doctorWatchdogCheck(h);
    expect(w.status).toBe('warn');
    expect(w.detail).toContain('not firing');
  }));

test('doctor checkWatchdog: restart tier disabled + hygiene active + fresh tick → ok, labels the tier split',
  withHermit(async (h) => {
    fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'),
      JSON.stringify({
        watchdog: { enabled: false },
        context_hygiene: { compact: { enabled: true, min_context_tokens: 150000, min_interval: '4h' } },
        ...DOCTOR_BASE,
      }, null, 2) + '\n');
    setLastRun(h, new Date().toISOString());
    const w = await doctorWatchdogCheck(h);
    expect(w.status).toBe('ok');
    expect(w.detail).toContain('restart tier disabled, hygiene tier active');
  }));

test('doctor checkWatchdog: alive session with a shutdown stamp → warn, names the pathology',
  withHermit(async (h) => {
    writeDoctorConfig(h);
    patchRuntime(h, { session_state: 'in_progress', shutdown_completed_at: isoAgo(72) });
    setLastRun(h, new Date().toISOString());
    const w = await doctorWatchdogCheck(h);
    expect(w.status).toBe('warn');
    expect(w.detail).toContain('shutdown stamp');
  }));

test('doctor checkWatchdog: last_hygiene_eval surfaces in the ok detail', withHermit(async (h) => {
  writeDoctorConfig(h);
  const p = state(h, 'watchdog-state.json');
  fs.writeFileSync(p, JSON.stringify({
    last_run: new Date().toISOString(),
    last_hygiene_eval: { compact: { ts: new Date().toISOString(), outcome: 'fired', prompt_tokens: 250000 } },
  }) + '\n');
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('ok');
  expect(w.detail).toContain('compact/fired');
}));

test('doctor checkWatchdog: per-mechanism last_hygiene_eval surfaces the most-recent tier',
  withHermit(async (h) => {
    writeDoctorConfig(h);
    const older = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const newer = new Date().toISOString();
    fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
      last_run: new Date().toISOString(),
      last_hygiene_eval: {
        clear: { ts: older, outcome: 'skip:under-threshold', prompt_tokens: 300000 },
        compact: { ts: newer, outcome: 'fired', prompt_tokens: 300000 },
      },
    }) + '\n');
    const w = await doctorWatchdogCheck(h);
    expect(w.detail).toContain('compact/fired'); // newer of the two wins
  }));

test('doctor checkWatchdog: stale scheduler + stuck shutdown stamp → not-firing wins',
  withHermit(async (h) => {
    writeDoctorConfig(h);
    patchRuntime(h, { session_state: 'in_progress', shutdown_completed_at: isoAgo(72) });
    setLastRun(h, isoAgo(1)); // scheduler dead — the higher-severity signal
    const w = await doctorWatchdogCheck(h);
    expect(w.status).toBe('warn');
    expect(w.detail).toContain('not firing'); // liveness remediation, not the stamp warning
  }));

test('doctor checkWatchdog: fresh shutdown stamp on an alive session → no false positive',
  withHermit(async (h) => {
    writeDoctorConfig(h);
    // A real in-flight hermit-stop stamps shutdown_requested_at seconds before
    // /session-close flips session_state to idle — a fresh stamp is that window.
    patchRuntime(h, { session_state: 'in_progress', shutdown_requested_at: new Date().toISOString() });
    setLastRun(h, new Date().toISOString());
    const w = await doctorWatchdogCheck(h);
    expect(w.detail).not.toContain('shutdown stamp');
  }));

// -------------------------------------------------------
// install / uninstall without systemctl (Linux-only path)
// -------------------------------------------------------

const isLinux = process.platform === 'linux';

test.if(isLinux)('install without systemctl → exit 0, prints crontab, no traceback', withHermit(async (h) => {
  writeConfig(h);
  // fake-bin has tmux/pgrep stubs but no systemctl — simulates systemd-less host
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'install', { restrictPath: true });
  const out = r.stdout + r.stderr;
  expect(r.exitCode).toBe(0);
  expect(out).toContain('crontab'); // expected crontab guidance
  expect(out).not.toContain('Traceback');
}));

test.if(isLinux)('uninstall without systemctl → exit 0, no traceback', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'uninstall', { restrictPath: true });
  expect(r.exitCode).toBe(0);
  expect(r.stdout + r.stderr).not.toContain('Traceback');
}));

// -------------------------------------------------------
// Unit PATH baking. A generated unit runs without ~/.bun/bin on PATH, so the
// shim's bare `bun` exits 127 on every tick — silently, forever. These assert on
// the PATH the unit actually ends up running with, not on the text of the line
// that sets it: a substring match on `PATH=` passes happily for a cron line whose
// assignment never reaches the command.
// -------------------------------------------------------

/** Fake systemctl: succeeds at everything, so install can render real units. */
function writeFakeSystemctl(h: Hermit): void {
  const stub = path.join(h.fakeBin, 'systemctl');
  fs.writeFileSync(stub, '#!/usr/bin/env bash\nexit 0\n');
  fs.chmodSync(stub, 0o755);
}

// The five-minute schedule line install prints for the cron fallback.
function cronLineFrom(output: string): string | undefined {
  return output.split('\n').map((s) => s.trim()).find((s) => s.startsWith('*/5 * * * *'));
}

test.if(isLinux)('cron fallback line applies its PATH to the watchdog, not just to cd', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  // Stand in for the binary cron would invoke; it reports the PATH it received.
  // Absolute interpreter on purpose: the baked PATH under restrictPath holds only
  // bun's dir and the fake bin, so a `/usr/bin/env bash` shebang could not resolve.
  const wd = path.join(h.dir, '.claude-code-hermit', 'bin', 'hermit-watchdog');
  fs.writeFileSync(wd, '#!/bin/sh\necho "$PATH"\n');
  fs.chmodSync(wd, 0o755);

  const r = await watchdog(h, 'install', { restrictPath: true });
  expect(r.exitCode).toBe(0);
  const line = cronLineFrom(r.stdout + r.stderr);
  expect(line).toBeDefined();

  // Run exactly what cron hands to /bin/sh: the line minus its five schedule
  // fields. The ambient PATH deliberately lacks bun's dir, so anything the
  // command sees must have come from the baked assignment.
  const command = line!.split(/\s+/).slice(5).join(' ');
  const proc = Bun.spawn({
    cmd: ['sh', '-c', command],
    cwd: h.dir,
    env: { PATH: '/usr/bin:/bin' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const seenPath = await new Response(proc.stdout).text();
  await proc.exited;
  expect(seenPath.trim().split(':')).toContain(path.dirname(process.execPath));
}));

test.if(isLinux)('systemd unit keeps every inherited PATH entry and adds bun\'s dir', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  writeFakeSystemctl(h);
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-fakehome-'));
  try {
    const r = await watchdog(h, 'install', { env: { HOME: fakeHome } });
    expect(r.exitCode).toBe(0);

    const unitDir = path.join(fakeHome, '.config', 'systemd', 'user');
    const serviceFile = fs.readdirSync(unitDir).find((f) => f.endsWith('.service'));
    expect(serviceFile).toBeDefined();
    const unit = fs.readFileSync(path.join(unitDir, serviceFile!), 'utf-8');

    const baked = unit.match(/^Environment="PATH=(.*)"$/m)?.[1];
    expect(baked).toBeDefined();
    expect(unit).not.toContain('{{UNIT_PATH}}');

    // bun resolves — the 127 this fixes.
    expect(baked!.split(':')).toContain(path.dirname(process.execPath));
    // And nothing already working was dropped: Environment= replaces the unit's
    // PATH rather than extending it, and the restart path needs claude and tmux,
    // which live on the inherited PATH and not in any hardcodable list.
    // Relative entries are dropped on purpose — they would resolve against the
    // unit's WorkingDirectory rather than against the installer's shell.
    for (const entry of `${h.fakeBin}:${process.env.PATH}`.split(':').filter((e) => e && path.isAbsolute(e))) {
      expect(baked!.split(':')).toContain(entry);
    }
    // systemd applies Environment= to the ExecStart that follows it.
    expect(unit.indexOf('Environment=')).toBeLessThan(unit.indexOf('ExecStart='));
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
}));

test.if(isLinux)('a PATH entry with % survives per-target escaping', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const oddEntry = '/opt/we%ird dir';

  // cron: an unescaped % ends the command and sends the rest to stdin (crontab(5)).
  const cron = await watchdog(h, 'install', { env: { PATH: `${oddEntry}:${h.fakeBin}` } });
  expect(cronLineFrom(cron.stdout + cron.stderr)).toContain('/opt/we\\%ird dir');

  // systemd: % introduces a specifier, so a literal one is %% (systemd.unit(5)).
  writeFakeSystemctl(h);
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-fakehome-'));
  try {
    await watchdog(h, 'install', { env: { PATH: `${oddEntry}:${h.fakeBin}`, HOME: fakeHome } });
    const unitDir = path.join(fakeHome, '.config', 'systemd', 'user');
    const serviceFile = fs.readdirSync(unitDir).find((f) => f.endsWith('.service'))!;
    const unit = fs.readFileSync(path.join(unitDir, serviceFile), 'utf-8');
    expect(unit).toContain('/opt/we%%ird dir');
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
}));

// A source-level assertion, not a behavioral one: cmdInstall's darwin branch is
// selected by process.platform inside a spawned subprocess, and this suite has no
// darwin-gated coverage at all — there is no way to reach it from a Linux CI host.
// The ordering is what matters (load is a no-op on an already-loaded label, so
// re-running install would silently keep the stale plist).
test('cmdInstall unloads the launchd label before loading it', () => {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'hermit-watchdog.ts'), 'utf-8');
  const install = src.slice(src.indexOf('function cmdInstall'), src.indexOf('function cmdUninstall'));
  const unloadIdx = install.indexOf("'unload'");
  const loadIdx = install.indexOf("'load'");
  expect(unloadIdx).toBeGreaterThan(-1);
  expect(loadIdx).toBeGreaterThan(-1);
  expect(unloadIdx).toBeLessThan(loadIdx);
});

// -------------------------------------------------------
// post-close clear tests
// -------------------------------------------------------

function writeClearMarker(h: Hermit): void {
  fs.writeFileSync(state(h, 'clear-requested.json'),
    JSON.stringify({ requested_at: new Date().toISOString(), reason: 'daily-auto-close' }) + '\n');
}

// watchdog.enabled: false verifies clear fires independently of the watchdog restart path
function writePostCloseClearConfig(h: Hermit): void {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'), JSON.stringify({
    post_close_clear: true,
    watchdog: { enabled: false },
    heartbeat: { enabled: true, every: '2h', active_hours: { start: '00:00', end: '23:59' } },
  }, null, 2) + '\n');
}

test('post_close_clear: marker + idle + tmux alive + operator silent → /clear sent, marker deleted',
  withHermit(async (h) => {
    writePostCloseClearConfig(h);
    // runtime: idle (as set by session-archive.ts after auto-close)
    patchRuntime(h, { session_state: 'idle' });
    writeClearMarker(h);
    // operator idle 30 min ago
    fs.writeFileSync(state(h, 'last-operator-action.json'),
      JSON.stringify({ at: isoAgo(0.5) }) + '\n');
    const snapshotPath = path.join(h.dir, 'runtime-at-clear.json');
    writeFakeTmux(h, 0, 'tmux pane content', snapshotPath); // tmux session alive
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/clear');
    expect(fs.existsSync(state(h, 'clear-requested.json'))).toBe(false);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('post-close-clear');
    const runtimeAtClear = readJson(snapshotPath);
    expect(runtimeAtClear.context_cleared).toBe(true);
    // last_run stamp precedes the maybePostCloseClear process.exit(0) (finding 2)
    const ws = readWatchdogStateFile(h);
    expect(typeof ws.last_run).toBe('string');
    expect(Date.now() - Date.parse(ws.last_run)).toBeLessThan(60_000);
  }));

test('post_close_clear: operator active < 10 min → no send, marker kept',
  withHermit(async (h) => {
    writePostCloseClearConfig(h);
    patchRuntime(h, { session_state: 'idle' });
    writeClearMarker(h);
    // operator active 3 min ago — within the 10-min grace
    fs.writeFileSync(state(h, 'last-operator-action.json'),
      JSON.stringify({ at: isoAgo(3 / 60) }) + '\n');
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(fs.existsSync(state(h, 'clear-requested.json'))).toBe(true);
  }));

test('post_close_clear: session not idle → no send, marker kept',
  withHermit(async (h) => {
    writePostCloseClearConfig(h);
    // setupHermit() defaults to session_state: in_progress — no patchRuntime needed
    writeClearMarker(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(fs.existsSync(state(h, 'clear-requested.json'))).toBe(true);
  }));

test('post_close_clear: tmux session dead → no send, marker kept',
  withHermit(async (h) => {
    writePostCloseClearConfig(h);
    patchRuntime(h, { session_state: 'idle' });
    writeClearMarker(h);
    writeFakeTmux(h, 1); // tmux session dead (hermit-stop ran)
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(fs.existsSync(state(h, 'clear-requested.json'))).toBe(true);
  }));

test('post_close_clear: shutdown requested → no send, marker kept',
  withHermit(async (h) => {
    writePostCloseClearConfig(h);
    patchRuntime(h, { session_state: 'idle', shutdown_requested_at: isoAgo(0.5) });
    writeClearMarker(h);
    writeFakeTmux(h, 0); // tmux still briefly alive mid-shutdown
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(fs.existsSync(state(h, 'clear-requested.json'))).toBe(true);
  }));

test('post_close_clear: no marker → no send',
  withHermit(async (h) => {
    writePostCloseClearConfig(h);
    patchRuntime(h, { session_state: 'idle' });
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
  }));

test('post_close_clear: flag false → no send even with marker',
  withHermit(async (h) => {
    writeConfig(h);
    // Explicit false: an absent post_close_clear now settles to the template
    // default (true), so the fixture must actually carry the flag.
    const cfgPath = path.join(h.dir, '.claude-code-hermit', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    cfg.post_close_clear = false;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    patchRuntime(h, { session_state: 'idle' });
    writeClearMarker(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(fs.existsSync(state(h, 'clear-requested.json'))).toBe(true);
  }));

test('post_close_clear: invalidates sessions/.status.json so a stale pre-clear cost entry cannot trigger a spurious compact',
  withHermit(async (h) => {
    fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'), JSON.stringify({
      post_close_clear: true,
      watchdog: { enabled: false },
      context_hygiene: { compact: { enabled: true, min_context_tokens: 150000, min_interval: '4h' } },
      heartbeat: { enabled: true, every: '2h', active_hours: { start: '00:00', end: '23:59' } },
    }, null, 2) + '\n');
    // Mirrors session-archive.ts's post-auto-close state: idle, no open arc —
    // resolveHygieneSessionId falls back to sessions/.status.json.
    patchRuntime(h, { session_state: 'idle', session_id: null });
    fs.mkdirSync(path.join(h.dir, '.claude-code-hermit', 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(h.dir, '.claude-code-hermit', 'sessions', '.status.json'),
      JSON.stringify({ session_id: SESSION_ID }) + '\n',
    );
    // Bloated pre-clear entry — the dead context's final turn.
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 }]);
    writeClearMarker(h);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(0.5) }) + '\n');
    // Pre-prime the compact tracker's pane hash so quiescence is already satisfied —
    // absent the fix, tick 2 alone would be enough for the compactor to misfire.
    primeCompactHash(h, STATIC_HASH);
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    // Tick 1: post-close /clear fires and (with the fix) deletes .status.json.
    const r1 = await watchdog(h, 'run');
    expect(r1.exitCode).toBe(0);
    const tmuxLog1 = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog1).toContain('/clear');
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('post-close-clear');
    expect(fs.existsSync(path.join(h.dir, '.claude-code-hermit', 'sessions', '.status.json'))).toBe(false);

    // Tick 2: runtime.session_id is still null (no real turn has run yet) — the
    // compactor must fail to resolve a session id now that the cache is gone.
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    const tmuxLog2 = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog2).not.toContain('/compact');
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).not.toContain('context-compact');
    const ws = readJson(state(h, 'watchdog-state.json'));
    expect(ws.last_hygiene_eval?.compact?.outcome).toBe('skip:no-session-id');
  }));

// -------------------------------------------------------
// context-clear tests
// -------------------------------------------------------

const SESSION_ID = 'S-001';

/** Write a cost-log entry under <hermit.dir>/.claude/cost-log.jsonl. */
function writeCostLog(h: Hermit, entries: {
  session_id: string; input_tokens: number; cache_write_tokens: number; cache_read_tokens: number;
  timestamp?: string; api_calls?: number; max_prompt_tokens?: number; subagent?: boolean;
  observed_at?: string; last_call_prompt_tokens?: number;
}[]): void {
  const dir = path.join(h.dir, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const lines = entries.map(e => JSON.stringify({
    timestamp: e.timestamp ?? new Date().toISOString(),
    session_id: e.session_id,
    input_tokens: e.input_tokens,
    cache_write_tokens: e.cache_write_tokens,
    cache_read_tokens: e.cache_read_tokens,
    output_tokens: 500,
    total_tokens: e.input_tokens + e.cache_write_tokens + e.cache_read_tokens + 500,
    estimated_cost_usd: 1.0,
    ...(e.api_calls !== undefined ? { api_calls: e.api_calls } : {}),
    ...(e.max_prompt_tokens !== undefined ? { max_prompt_tokens: e.max_prompt_tokens } : {}),
    ...(e.observed_at !== undefined ? { observed_at: e.observed_at } : {}),
    ...(e.last_call_prompt_tokens !== undefined ? { last_call_prompt_tokens: e.last_call_prompt_tokens } : {}),
    ...(e.subagent !== undefined ? { subagent: e.subagent } : {}),
  })).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'cost-log.jsonl'), lines);
}

/** Write config with context_clear_tokens enabled and watchdog.enabled: false (pre-enabled gate). */
function writeContextClearConfig(h: Hermit, threshold = 700000): void {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'), JSON.stringify({
    watchdog: { enabled: false, context_clear_tokens: threshold },
    heartbeat: { enabled: true, every: '2h', active_hours: { start: '00:00', end: '23:59' } },
  }, null, 2) + '\n');
}

/** Write runtime.json for an always-on hermit with given session_state. */
function writeAlwaysOnRuntime(h: Hermit, session_state = 'idle'): void {
  patchRuntime(h, { session_state, runtime_mode: 'tmux', session_id: SESSION_ID });
}

/** Write watchdog-state with a specific last_pane_hash_ctx (simulates second tick). */
function primeContextHash(h: Hermit, hash: string): void {
  const p = state(h, 'watchdog-state.json');
  const existing = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  fs.writeFileSync(p, JSON.stringify({ ...existing, last_pane_hash_ctx: hash }) + '\n');
}

test('context_clear: bloated idle + quiescent + operator silent → /clear sent on 2nd tick',
  withHermit(async (h) => {
    writeContextClearConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    // Bloated: 850K prompt-side tokens
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    const snapshotPath = path.join(h.dir, 'runtime-at-clear.json');
    // Fake tmux returns deterministic pane content so hash matches across both ticks
    writeFakeTmux(h, 0, 'static pane content', snapshotPath);
    writeFakePgrep(h, 1);

    // Tick 1: hash recorded, no /clear yet
    const r1 = await watchdog(h, 'run');
    expect(r1.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);

    // Tick 2: same hash → /clear fires
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/clear');
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('context-clear');
    const runtimeAtClear = readJson(snapshotPath);
    expect(runtimeAtClear.context_cleared).toBe(true);
  }));

test('context_clear: SHELL.md breadcrumb is written before the /clear keystroke',
  withHermit(async (h) => {
    writeContextClearConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');

    const sessionsDir = path.join(h.dir, '.claude-code-hermit', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'SHELL.md'), '## Progress Log\n', 'utf-8');

    const shellSnapshotPath = path.join(h.dir, 'shell-at-clear.md');
    writeFakeTmux(h, 0, 'static pane content', undefined, shellSnapshotPath);
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1: hash recorded
    await watchdog(h, 'run'); // tick 2: /clear fires

    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/clear');

    // The snapshot was taken by the stub at the instant it saw the /clear keystroke —
    // asserting the breadcrumb is already there proves the flush ran before sendKeys.
    const shellAtClear = fs.readFileSync(shellSnapshotPath, 'utf-8');
    expect(shellAtClear).toContain('context cleared (watchdog-700k)');
    expect(shellAtClear).toContain('arc may have unfinished work');

    // Not appended to observations.jsonl — a breadcrumb is Progress-Log only (see
    // scripts/lib/progress-log.ts header comment for why observations.jsonl was dropped).
    const obsPath = state(h, 'observations.jsonl');
    const obsContent = fs.existsSync(obsPath) ? fs.readFileSync(obsPath, 'utf-8') : '';
    expect(obsContent).not.toContain('watchdog-700k');
  }));

test('context_clear: fail-open — missing sessions/SHELL.md does not block the safety /clear',
  withHermit(async (h) => {
    writeContextClearConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    // Deliberately do NOT create sessions/SHELL.md — the flush helper's read will throw,
    // and it must fail open rather than suppress the destructive /clear below it.

    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1
    const r2 = await watchdog(h, 'run'); // tick 2: /clear should still fire

    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/clear');
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('context-clear');
  }));

test('context_clear: fires with watchdog.enabled: false (independent of restart path)',
  withHermit(async (h) => {
    // config has enabled: false — verifies context-clear runs before the enabled gate
    writeContextClearConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1
    const r2 = await watchdog(h, 'run'); // tick 2
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/clear');
  }));

// -------------------------------------------------------
// context-compact tests (PROP-011 commit 3: maybeContextCompact)
// -------------------------------------------------------

/** Write config with context_hygiene.compact enabled and watchdog.enabled: false (pre-enabled gate). */
function writeContextCompactConfig(h: Hermit, opts: {
  minContextTokens?: number; minInterval?: string; clearTokens?: number;
  routines?: unknown[]; timezone?: string;
} = {}): void {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'), JSON.stringify({
    // Explicit null when unconfigured: an absent context_clear_tokens now
    // settles to the template default (700000).
    watchdog: { enabled: false, context_clear_tokens: opts.clearTokens ?? null },
    context_hygiene: {
      compact: {
        enabled: true,
        min_context_tokens: opts.minContextTokens ?? 150000,
        min_interval: opts.minInterval ?? '4h',
      },
    },
    heartbeat: { enabled: true, every: '2h', active_hours: { start: '00:00', end: '23:59' } },
    routines: opts.routines ?? [],
    timezone: opts.timezone ?? 'UTC',
  }, null, 2) + '\n');
}

function writeCompactMarker(h: Hermit, ageSeconds = 0): void {
  fs.writeFileSync(state(h, 'compact-requested.json'), JSON.stringify({
    requested_at: new Date(Date.now() - ageSeconds * 1000).toISOString(), reason: 'test',
  }) + '\n');
}

/** Write watchdog-state with a specific last_pane_hash_compact (simulates second tick for the compact tracker). */
function primeCompactHash(h: Hermit, hash: string): void {
  const p = state(h, 'watchdog-state.json');
  const existing = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  fs.writeFileSync(p, JSON.stringify({ ...existing, last_pane_hash_compact: hash }) + '\n');
}

const STATIC_HASH = crypto.createHash('sha256').update('static pane content\n').digest('hex');

test('context_compact: bloated idle + quiescent + operator silent → /compact sent on 2nd tick, context_cleared never set',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    const snapshotPath = path.join(h.dir, 'runtime-at-compact.json');
    writeFakeTmux(h, 0, 'static pane content', snapshotPath);
    writeFakePgrep(h, 1);

    const r1 = await watchdog(h, 'run'); // tick 1: hash recorded, no compact yet
    expect(r1.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);

    const r2 = await watchdog(h, 'run'); // tick 2: same hash → /compact fires
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    // 'idle' with no boundary marker is only half the conjunction → mid-arc. An
    // always-on hermit sits at 'idle' indefinitely, so idle alone never licenses the
    // "complete and archived" claim.
    expect(tmuxLog).toContain(composeCompactSteeringMessage('mid-arc'));
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('context-compact');
    // context_cleared is context_clear's marker only — compact must never touch it.
    const runtimeAtCompact = readJson(snapshotPath);
    expect(runtimeAtCompact.context_cleared).not.toBe(true);
  }));

/**
 * Shared tail for the flavor-conjunction cases below: bloat the context, go
 * operator-silent, hold the pane still, then tick twice so quiescence clears and the
 * compact fires. Each caller sets only the two predicate inputs (session_state and the
 * marker) above this, so the row under test is the visible difference.
 */
async function fireCompactFlavorCase(h: Hermit): Promise<{ tmuxLog: string; events: string }> {
  writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 }]);
  fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
  writeFakeTmux(h, 0, 'static pane content');
  writeFakePgrep(h, 1);

  await watchdog(h, 'run'); // tick 1: hash recorded
  const r2 = await watchdog(h, 'run'); // tick 2: same hash → /compact fires
  expect(r2.exitCode).toBe(0);
  return {
    tmuxLog: fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8'),
    events: fs.readFileSync(eventsFile(h), 'utf-8'),
  };
}

/**
 * Flavor is a conjunction: session_state === 'idle' AND a fresh compact-requested
 * marker. Each case below breaks exactly one half (or neither) so a regression that
 * drops either condition from the predicate turns a row red.
 */
test('context_compact: idle + fresh boundary marker → drop-completed-arc message',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    writeCompactMarker(h); // both halves satisfied — the only boundary-flavor case

    const { tmuxLog, events } = await fireCompactFlavorCase(h);
    expect(tmuxLog).toContain(composeCompactSteeringMessage('boundary'));
    expect(events).toContain('flavor boundary');
  }));

test('context_compact: idle + stale boundary marker → demoted to mid-arc',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    writeCompactMarker(h, 2 * 3600); // past COMPACT_MARKER_TTL_SECS — consumed on read, no waiver

    const { tmuxLog, events } = await fireCompactFlavorCase(h);
    expect(tmuxLog).toContain(composeCompactSteeringMessage('mid-arc'));
    expect(events).toContain('flavor mid-arc');
  }));

test('context_compact: in_progress + fresh boundary marker → still mid-arc',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    writeAlwaysOnRuntime(h, 'in_progress');
    writeCompactMarker(h); // marker fresh, but a session is open — arc is not done

    const { tmuxLog, events } = await fireCompactFlavorCase(h);
    expect(tmuxLog).toContain(composeCompactSteeringMessage('mid-arc'));
    expect(events).toContain('flavor mid-arc');
  }));

test('context_compact: absent session_state + fresh marker → conservative mid-arc',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    // Seed 'idle' then remove the key: with the marker fresh, a failed key removal
    // would satisfy both halves and produce the boundary literal, so this assertion
    // genuinely exercises the absent-state path rather than passing by fixture luck.
    writeAlwaysOnRuntime(h, 'idle');
    patchRuntime(h, { session_state: undefined });
    writeCompactMarker(h);

    const { tmuxLog } = await fireCompactFlavorCase(h);
    expect(tmuxLog).toContain(composeCompactSteeringMessage('mid-arc'));
  }));

test('context_clear takes precedence over compact on the same tick (both thresholds crossed)',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 150000, clearTokens: 700000 });
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1: both trackers prime their hashes
    const r2 = await watchdog(h, 'run'); // tick 2: clear fires first and exits before compact runs
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/clear');
    expect(tmuxLog).not.toContain('/compact');
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('context-clear');
    expect(events).not.toContain('context-compact');
  }));

test('context_clear (mid-arc emergency clear) cross-stamps compact idempotence so the destroyed entry cannot re-trigger a spurious compact',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 150000, minInterval: '4h', clearTokens: 700000 });
    writeAlwaysOnRuntime(h, 'idle'); // arc open: runtime.session_id = SESSION_ID — resolveHygieneSessionId short-circuits, cache deletion alone can't help
    const entryTimestamp = '2026-01-01T00:00:00.000Z';
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000, timestamp: entryTimestamp }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1: both trackers prime their hashes
    const r2 = await watchdog(h, 'run'); // tick 2: /clear fires and exits before compact runs
    expect(r2.exitCode).toBe(0);
    const tmuxLog2 = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog2).toContain('/clear');
    expect(tmuxLog2).not.toContain('/compact');

    // Cross-stamp: the emergency clear must mark this cost entry as already
    // compacted too — deleting sessions/.status.json alone cannot protect this
    // path, since runtime.session_id (arc still open) short-circuits the fallback.
    const wsAfterClear = readJson(state(h, 'watchdog-state.json'));
    expect(wsAfterClear.last_compacted_cost_ts).toBe(entryTimestamp);

    const r3 = await watchdog(h, 'run'); // tick 3: clear is idempotent; compact must see the cross-stamp
    expect(r3.exitCode).toBe(0);
    const tmuxLog3 = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog3).not.toContain('/compact');
    const events3 = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events3).not.toContain('context-compact');
    // Two independent guards now cover this entry: the clear stamped last_context_reset_at,
    // so the poisoned-entry check rejects it as stale before the idempotence cross-stamp is
    // even consulted. Both are kept — the cross-stamp above still protects an entry the
    // reset stamp can't date (no timestamp at all).
    const wsAfterTick3 = readJson(state(h, 'watchdog-state.json'));
    expect(wsAfterTick3.last_hygiene_eval?.compact?.outcome).toBe('skip:stale-entry');
  }));

test('context_compact: boundary marker waives min_interval but not the 60k floor',
  withHermit(async (h) => {
    // Threshold low enough that 40K tokens clears it, but the absolute 60K floor still blocks.
    writeContextCompactConfig(h, { minContextTokens: 10000 });
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 20000, cache_write_tokens: 0, cache_read_tokens: 20000 }]); // 40K total
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);
    primeCompactHash(h, STATIC_HASH);
    writeCompactMarker(h); // fresh marker — would waive min_interval, but floor is absolute

    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    // A fresh marker is preserved (not wasted) when the floor blocks the compact —
    // it keeps its interval-cooldown waiver until the compact it enables actually
    // fires or it goes stale. Consuming it here would drop the waiver a tick early.
    expect(fs.existsSync(state(h, 'compact-requested.json'))).toBe(true);
  }));

test('context_compact: fresh boundary marker waives min_interval and fires again',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 150000, minInterval: '4h' });
    writeAlwaysOnRuntime(h, 'idle');
    const ts1 = new Date(Date.now() - 3600_000).toISOString();
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000, timestamp: ts1 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1: prime hash
    await watchdog(h, 'run'); // tick 2: fires — sets last_compacted_at to now

    const ts2 = new Date().toISOString();
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 100000, cache_write_tokens: 0, cache_read_tokens: 200000, timestamp: ts2 }]);
    await watchdog(h, 'run'); // tick 3: re-primes hash after reset

    writeCompactMarker(h); // fresh boundary marker — waives the still-open min_interval
    await watchdog(h, 'run'); // tick 4: hash matches, marker waives interval → fires again

    const events = fs.readFileSync(eventsFile(h), 'utf-8').split('\n').filter(l => l.includes('context-compact'));
    expect(events.length).toBe(2);
    expect(fs.existsSync(state(h, 'compact-requested.json'))).toBe(false); // consumed
  }));

test('context_compact: fresh boundary marker survives the two-tick quiescence wait under an active interval cooldown',
  withHermit(async (h) => {
    // Regression: the marker used to be consumed on read (tick 1), a full tick before
    // the quiescence gate confirms the pane is stable (tick 2) — so under an active
    // interval cooldown the waiver was gone by the time the compact could fire, and
    // the compact the boundary requested never happened. The hash is deliberately NOT
    // pre-primed here, mirroring a real boundary where work just churned the pane.
    writeContextCompactConfig(h, { minContextTokens: 150000, minInterval: '4h' });
    writeAlwaysOnRuntime(h, 'idle');
    // Interval cooldown active: compacted 1h ago, on a *different* cost entry so
    // idempotence isn't the blocker — this isolates min_interval as the thing the
    // marker must waive.
    fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
      last_compacted_at: new Date(Date.now() - 3600_000).toISOString(),
      last_compacted_cost_ts: 'earlier-entry',
    }) + '\n');
    const ts = new Date().toISOString();
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000, timestamp: ts }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);
    writeCompactMarker(h); // fresh marker, hash not pre-primed

    const r1 = await watchdog(h, 'run'); // tick 1: records hash, not yet stable → no compact, marker preserved
    expect(r1.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(fs.existsSync(state(h, 'compact-requested.json'))).toBe(true); // waiver survives to the next tick

    const r2 = await watchdog(h, 'run'); // tick 2: pane stable, marker still waives the cooldown → fires
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/compact');
    expect(fs.existsSync(state(h, 'compact-requested.json'))).toBe(false); // consumed on fire
  }));

// -------------------------------------------------------
// context-hygiene starvation fixes: subagent-tail skip, idle session-id
// fallback, real-context metric, negative telemetry (last_hygiene_eval)
// -------------------------------------------------------

test('context_compact: subagent tail entry is ignored — bloated main line still triggers',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [
      { session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 }, // main turn line, 250k
      { session_id: SESSION_ID, input_tokens: 500, cache_write_tokens: 0, cache_read_tokens: 500, subagent: true }, // dispatched-subagent tail, tiny
    ]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1: hash recorded
    const r2 = await watchdog(h, 'run'); // tick 2: same hash → fires
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/compact');
  }));

test('context_compact: idle-phase session-id fallback via sessions/.status.json',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    // No open S-NNN arc — runtime.session_id is null, as it is for most of an
    // always-on hermit's life between sessions.
    patchRuntime(h, { session_state: 'idle', runtime_mode: 'tmux', session_id: null });
    const harnessSid = 'harness-uuid-1234';
    fs.mkdirSync(path.join(h.dir, '.claude-code-hermit', 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(h.dir, '.claude-code-hermit', 'sessions', '.status.json'),
      JSON.stringify({ session_id: harnessSid }) + '\n',
    );
    writeCostLog(h, [{ session_id: harnessSid, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/compact');
  }));

test('context_clear: legacy multi-call entry averages down — no destructive misfire; still compact-eligible',
  withHermit(async (h) => {
    // Old semantics summed every API call in the turn: a 5-call turn at a real ~300k
    // context logged 1.5M "prompt tokens" and blew straight through the 700k emergency
    // clear threshold. The average (still the pre-max_prompt_tokens fallback, since
    // this entry predates that field) keeps it out of the destructive tier while
    // correctly landing above the 150k compact threshold.
    writeContextCompactConfig(h, { minContextTokens: 150000, clearTokens: 700000 });
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 1500000, cache_write_tokens: 0, cache_read_tokens: 0, api_calls: 5 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1: both trackers prime their hashes
    const r2 = await watchdog(h, 'run'); // tick 2
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).not.toContain('/clear');
    expect(tmuxLog).toContain('/compact');
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).not.toContain('context-clear');
    expect(events).toContain('context-compact');
    // The destructive /clear declines the multi-call legacy estimate outright rather
    // than acting on the per-call mean; the compact tier still uses it.
    const ws = readJson(state(h, 'watchdog-state.json'));
    expect(ws.last_hygiene_eval?.clear?.outcome).toBe('skip:estimate-only');
  }));

test('context_clear: max_prompt_tokens field takes precedence over the per-turn sum',
  withHermit(async (h) => {
    writeContextClearConfig(h, 700000);
    writeAlwaysOnRuntime(h, 'idle');
    // Small literal input/cache fields (100k sum) but max_prompt_tokens says the
    // real single-call context was 900k — the field must win.
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 50000, max_prompt_tokens: 900000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/clear');
  }));

test('context_compact: last_hygiene_eval records the fire outcome and prompt token count',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    const ws = readJson(state(h, 'watchdog-state.json'));
    expect(ws.last_hygiene_eval?.compact).toMatchObject({ outcome: 'fired', prompt_tokens: 250000 });
  }));

// -------------------------------------------------------
// poisoned cost-entry guards (both hygiene tiers)
//
// The proxy both tiers act on ("last cost entry for this session") lies in two ways:
// the entry was observed before the context was reset, or the number is impossible.
// Measured live: a re-billed pre-compaction entry drove a compaction of a context 47k
// UNDER the threshold.
// -------------------------------------------------------

test('context_compact: entry observed after the last context reset still fires',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    patchRuntime(h, { last_context_reset_at: isoAgo(2) });
    writeCostLog(h, [{
      session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000,
      observed_at: isoAgo(1),
    }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    const ws = readJson(state(h, 'watchdog-state.json'));
    expect(ws.last_hygiene_eval?.compact?.outcome).toBe('fired');
  }));

test('context_compact: last_call_prompt_tokens wins over the turn-peak max_prompt_tokens',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    // A turn that compacted mid-flight: peak 250k (dead), newest call 30k (real) — under
    // the 60k floor, so the tier must skip rather than compact a freshly-compacted context.
    writeCostLog(h, [{
      session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000,
      max_prompt_tokens: 250000, last_call_prompt_tokens: 30000,
    }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    const ws = readJson(state(h, 'watchdog-state.json'));
    expect(ws.last_hygiene_eval?.compact).toMatchObject({ outcome: 'skip:below-floor', prompt_tokens: 30000 });
  }));

// -------------------------------------------------------
// pause enforcement tests (PROP-015)
// -------------------------------------------------------

function writePauseFlag(h: Hermit, opts: { until?: string | null; ts?: string } = {}): void {
  fs.writeFileSync(state(h, 'pause.json'), JSON.stringify({
    paused: true,
    paused_until: opts.until ?? null,
    reason: 'operator',
    by: 'test',
    ts: opts.ts ?? '2026-01-01T00:00:00.000Z',
  }) + '\n');
}

describe('pause enforcement', () => {
  test('dead session still restarts while paused (channel plugin lives inside the session)',
    withHermit(async (h) => {
      writeConfig(h);
      writeFakeTmux(h, 1); // dead
      writeFakePgrep(h, 1);
      writePauseFlag(h);
      const r = await watchdog(h, 'run');
      expect(r.exitCode).toBe(0);
      expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('restart');
    }));

  test('nudge suppressed while paused (Escape enforcement supersedes it on the same tick)',
    withHermit(async (h) => {
      writeConfig(h);
      touchAgo(state(h, '.heartbeat'), 6 * 3600);
      writeFakeTmux(h, 0, 'some pane content');
      writeFakePgrep(h, 1);
      writePauseFlag(h);
      const r = await watchdog(h, 'run');
      expect(r.exitCode).toBe(0);
      const events = fs.readFileSync(eventsFile(h), 'utf-8');
      expect(events).not.toContain('nudge');
      expect(events).toContain('pause-enforced');
      const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
      expect(tmuxLog).not.toContain('heartbeat run');
    }));

  test('context_clear suppressed while paused (shared passesLifecycleGuards gate)',
    withHermit(async (h) => {
      writeContextClearConfig(h);
      writeAlwaysOnRuntime(h, 'idle');
      writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
      fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
      writeFakeTmux(h, 0, 'static pane content');
      writeFakePgrep(h, 1);
      writePauseFlag(h);
      await watchdog(h, 'run'); // tick 1
      const r2 = await watchdog(h, 'run'); // tick 2 — would normally fire /clear
      expect(r2.exitCode).toBe(0);
      expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    }));

  test('post_close_clear suppressed while paused, marker kept', withHermit(async (h) => {
    writePostCloseClearConfig(h);
    patchRuntime(h, { session_state: 'idle' });
    writeClearMarker(h);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(0.5) }) + '\n');
    writeFakeTmux(h, 0, 'tmux pane content');
    writeFakePgrep(h, 1);
    writePauseFlag(h);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(fs.existsSync(state(h, 'clear-requested.json'))).toBe(true);
  }));

  test('Escape sent once when paused mid-turn (session in_progress, live tmux)', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0, 'busy pane');
    writeFakePgrep(h, 1);
    writePauseFlag(h, { ts: '2026-02-02T00:00:00.000Z' });
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('Escape');
    expect(readJson(state(h, 'watchdog-state.json')).last_escaped_pause_ts).toBe('2026-02-02T00:00:00.000Z');
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('pause-enforced');
  }));

  test('Escape still fires exactly once for a ts-less flag (sentinel dedup)', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0, 'busy pane');
    writeFakePgrep(h, 1);
    // Hand-crafted/partial flag with no `ts` — a bare `=== status.ts` compare
    // would read undefined === undefined and skip the interrupt entirely.
    fs.writeFileSync(state(h, 'pause.json'),
      JSON.stringify({ paused: true, paused_until: null, reason: 'operator', by: 'test' }) + '\n');
    await watchdog(h, 'run');
    await watchdog(h, 'run');
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    const escapeCount = tmuxLog.split('\n').filter(l => l.includes('Escape')).length;
    expect(escapeCount).toBe(1);
    expect(readJson(state(h, 'watchdog-state.json')).last_escaped_pause_ts).toBe('no-ts');
  }));

  test('Escape not repeated on a second tick (same pause episode)', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0, 'busy pane');
    writeFakePgrep(h, 1);
    writePauseFlag(h, { ts: '2026-02-02T00:00:00.000Z' });
    await watchdog(h, 'run');
    await watchdog(h, 'run');
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    const escapeCount = tmuxLog.split('\n').filter(l => l.includes('Escape')).length;
    expect(escapeCount).toBe(1);
  }));

  test('Escape sent again for a new pause episode (fresh ts) after a resume', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0, 'busy pane');
    writeFakePgrep(h, 1);
    writePauseFlag(h, { ts: '2026-02-02T00:00:00.000Z' });
    await watchdog(h, 'run');
    fs.rmSync(state(h, 'pause.json')); // resume
    writePauseFlag(h, { ts: '2026-03-03T00:00:00.000Z' }); // new episode
    await watchdog(h, 'run');
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    const escapeCount = tmuxLog.split('\n').filter(l => l.includes('Escape')).length;
    expect(escapeCount).toBe(2);
  }));

  test('Escape not sent when session is idle (nothing plausibly in flight)', withHermit(async (h) => {
    writeConfig(h);
    patchRuntime(h, { session_state: 'idle' });
    writeFakeTmux(h, 0, 'idle pane');
    writeFakePgrep(h, 1);
    writePauseFlag(h);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
  }));

  test('Escape not sent for an interactive session (never auto-managed)', withHermit(async (h) => {
    writeConfig(h);
    patchRuntime(h, { runtime_mode: 'interactive' });
    writeFakeTmux(h, 0, 'interactive pane');
    writeFakePgrep(h, 1);
    writePauseFlag(h);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
  }));

  test('no pause.json — normal nudge flow unaffected', withHermit(async (h) => {
    writeConfig(h);
    touchAgo(state(h, '.heartbeat'), 6 * 3600);
    writeFakeTmux(h, 0, 'some pane content');
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('nudge');
  }));
});

describe('isNearDailyAutoClose (midnight-adjacency, unit)', () => {
  const REF_2359 = new Date('2026-06-11T23:59:00Z'); // 1 min before UTC midnight
  const REF_NOON = new Date('2026-06-11T12:00:00Z');
  const routines = [{ id: 'daily-auto-close', schedule: '0 0 * * *', enabled: true }];

  test('within window before midnight → suppresses', () => {
    expect(isNearDailyAutoClose({ routines, timezone: 'UTC' }, 2 * 3600, REF_2359)).toBe(true);
  });

  test('far from the routine → does not suppress', () => {
    expect(isNearDailyAutoClose({ routines, timezone: 'UTC' }, 2 * 3600, REF_NOON)).toBe(false);
  });

  test('routine disabled → does not suppress (fail-open)', () => {
    const disabled = [{ id: 'daily-auto-close', schedule: '0 0 * * *', enabled: false }];
    expect(isNearDailyAutoClose({ routines: disabled, timezone: 'UTC' }, 2 * 3600, REF_2359)).toBe(false);
  });

  test('no daily-auto-close routine configured → does not suppress', () => {
    expect(isNearDailyAutoClose({ routines: [], timezone: 'UTC' }, 2 * 3600, REF_2359)).toBe(false);
  });
});

// ---------- inActiveHours unit tests ----------
// 2026-06-11T03:00:00Z → 12:00 Asia/Tokyo (inside 09:00-17:00), 23:00 America/New_York (outside)
const ACTIVE_WINDOW = { start: '09:00', end: '17:00' };
const REF = new Date('2026-06-11T03:00:00Z');

describe('inActiveHours (timezone)', () => {
  test('honours config.timezone, not the machine clock', () => {
    expect(inActiveHours(ACTIVE_WINDOW, 'Asia/Tokyo', REF)).toBe(true);
    expect(inActiveHours(ACTIVE_WINDOW, 'America/New_York', REF)).toBe(false);
  });

  test('end boundary is exclusive, matching heartbeat-precheck', () => {
    // Pacific/Honolulu reads exactly 17:00 at REF (the window end).
    expect(inActiveHours(ACTIVE_WINDOW, 'Pacific/Honolulu', REF)).toBe(false);
  });

  test('fail-open on unparseable timezone', () => {
    expect(inActiveHours(ACTIVE_WINDOW, 'Not/AZone', REF)).toBe(true);
  });
});

// ---------- deterministic channel voice: operator-language message composers ----------

describe('composeRestartMessage / composeWedgeMessage / composePauseMessage', () => {
  test('restart message distinguishes dead-process from pane-frozen', () => {
    expect(composeRestartMessage('dead-process', 'UTC')).toContain("wasn't running");
    expect(composeRestartMessage('pane-frozen', 'UTC')).toContain('had frozen');
  });

  test('wedge message names the check-in time', () => {
    expect(composeWedgeMessage('UTC')).toContain('checking on it now');
  });

  test('pause message: indefinite pause has no boundary time', () => {
    expect(composePauseMessage('operator', null, 'UTC')).toBe('Your hermit is paused (your request) until you resume it.');
  });

  test('pause message: budget/watchdog reasons render in operator language', () => {
    expect(composePauseMessage('budget', null, 'UTC')).toContain('a budget cap');
    expect(composePauseMessage('watchdog', null, 'UTC')).toContain('the watchdog');
  });

  test('pause message: a future boundary is rendered dated (YYYY-MM-DD HH:MM), not bare HH:MM', () => {
    // A monthly/weekly auto-resume can be days or weeks out; bare HH:MM would read
    // as minutes away, so the message carries the date.
    const until = new Date(Date.now() + 3600_000).toISOString();
    const msg = composePauseMessage('budget', until, 'UTC');
    expect(msg).toMatch(/until \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.$/);
  });
});

// -------------------------------------------------------
// telemetry export (step 0d: independent of watchdog.enabled, like 0a-0c)
// -------------------------------------------------------

/** Minimal config: watchdog disabled (so the process exits right after step 0d, with
 *  no tmux dependency) plus an enabled telemetry_export block pointed at a mock webhook. */
function writeTelemetryConfig(h: Hermit, url: string): void {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'), JSON.stringify({
    watchdog: { enabled: false },
    telemetry_export: {
      enabled: true,
      destination: { type: 'webhook', url },
      interval_hours: 24,
      redact_operator_text: true,
    },
  }, null, 2) + '\n');
}

describe('telemetry export (step 0d)', () => {
  test('fires with watchdog.enabled: false — one POST, state stamped, event logged', withHermit(async (h) => {
    let calls = 0;
    const server = Bun.serve({ port: 0, fetch: () => { calls++; return new Response('ok', { status: 200 }); } });
    try {
      writeTelemetryConfig(h, `http://127.0.0.1:${server.port}`);
      const r = await watchdog(h, 'run');
      expect(r.exitCode).toBe(0);
      expect(calls).toBe(1);
      const exportState = readJson(state(h, 'telemetry', 'last-export.json'));
      expect(typeof exportState.last_success_at).toBe('string');
      expect(exportState.consecutive_failures).toBe(0);
      expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('telemetry-export');
    } finally {
      server.stop(true);
    }
  }));

  test('interval not yet due → no POST', withHermit(async (h) => {
    let calls = 0;
    const server = Bun.serve({ port: 0, fetch: () => { calls++; return new Response('ok', { status: 200 }); } });
    try {
      writeTelemetryConfig(h, `http://127.0.0.1:${server.port}`);
      fs.mkdirSync(state(h, 'telemetry'), { recursive: true });
      fs.writeFileSync(state(h, 'telemetry', 'last-export.json'), JSON.stringify({
        version: 1,
        last_success_at: new Date().toISOString(),
        last_attempt_at: new Date().toISOString(),
        consecutive_failures: 0,
      }));
      const r = await watchdog(h, 'run');
      expect(r.exitCode).toBe(0);
      expect(calls).toBe(0);
    } finally {
      server.stop(true);
    }
  }));

  test('no telemetry_export block → nothing leaves the box', withHermit(async (h) => {
    let calls = 0;
    const server = Bun.serve({ port: 0, fetch: () => { calls++; return new Response('ok', { status: 200 }); } });
    try {
      fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'), JSON.stringify({
        watchdog: { enabled: false },
      }, null, 2) + '\n');
      const r = await watchdog(h, 'run');
      expect(r.exitCode).toBe(0);
      expect(calls).toBe(0);
      expect(fs.existsSync(state(h, 'telemetry'))).toBe(false);
    } finally {
      server.stop(true);
    }
  }));
});

// -------------------------------------------------------
// 14. Compose-function localization (PROP-059): the four watchdog message
//     families compose through WatchdogMessages. `en` stays byte-identical to
//     the pre-refactor literals (frame asserted around the live HH:MM clock);
//     `pt-PT` is exercised with an explicit locale arg.
// -------------------------------------------------------

describe('watchdog message localization', () => {
  test('composeRestartMessage en byte-identity (both causes)', () => {
    expect(composeRestartMessage('dead-process', 'UTC', 'en')).toMatch(
      /^I restarted your hermit at \d{2}:\d{2} — it wasn't running\.$/);
    expect(composeRestartMessage('pane-frozen', 'UTC', 'en')).toMatch(
      /^I restarted your hermit at \d{2}:\d{2} — it had frozen\.$/);
  });

  test('composeRestartMessage pt-PT', () => {
    expect(composeRestartMessage('dead-process', 'UTC', 'pt-PT')).toMatch(
      /^Reiniciei o seu hermit às \d{2}:\d{2} — não estava a correr\.$/);
    expect(composeRestartMessage('pane-frozen', 'UTC', 'pt-PT')).toMatch(
      /^Reiniciei o seu hermit às \d{2}:\d{2} — tinha bloqueado\.$/);
  });

  test('composeWedgeMessage en / pt-PT', () => {
    expect(composeWedgeMessage('UTC', 'en')).toMatch(
      /^Your hermit hasn't responded in a while — checking on it now \(\d{2}:\d{2}\)\.$/);
    expect(composeWedgeMessage('UTC', 'pt-PT')).toMatch(
      /^O seu hermit não responde há algum tempo — estou a verificá-lo agora \(\d{2}:\d{2}\)\.$/);
  });

  test('composeStallQuestionMessage en / pt-PT', () => {
    expect(composeStallQuestionMessage('UTC', 'en')).toMatch(
      /^Your hermit is waiting on a question it can't ask over chat — open the terminal or Claude app to answer \(\d{2}:\d{2}\)\.$/);
    expect(composeStallQuestionMessage('UTC', 'pt-PT')).toMatch(
      /^O seu hermit está à espera de uma pergunta que não pode fazer pelo chat — abra o terminal ou a app Claude para responder \(\d{2}:\d{2}\)\.$/);
  });

  test('composeSessionWedgedMessage en / pt-PT', () => {
    expect(composeSessionWedgedMessage('UTC', 'en')).toMatch(
      /^Your hermit has stopped picking up its scheduled work — something on screen is holding it\. Open the terminal or Claude app and clear whatever is waiting there \(\d{2}:\d{2}\)\.$/);
    expect(composeSessionWedgedMessage('UTC', 'pt-PT')).toMatch(
      /^O seu hermit deixou de executar o trabalho agendado — algo no ecrã está a bloqueá-lo\. Abra o terminal ou a app Claude e resolva o que está à espera \(\d{2}:\d{2}\)\.$/);
  });

  test('composePauseMessage indefinite form is deterministic and localized', () => {
    expect(composePauseMessage('operator', null, 'UTC', 'en')).toBe(
      'Your hermit is paused (your request) until you resume it.');
    expect(composePauseMessage('operator', null, 'UTC', 'pt-PT')).toBe(
      'O seu hermit está em pausa (o seu pedido) até que a retome.');
    expect(composePauseMessage('budget', null, 'UTC', 'pt-PT')).toBe(
      'O seu hermit está em pausa (um limite de orçamento) até que a retome.');
  });

  test('composePauseMessage dated form carries the localized frame and reason label', () => {
    const until = '2026-07-05T12:00:00Z';
    const en = composePauseMessage('budget', until, 'UTC', 'en');
    expect(en).toContain('Your hermit is paused (a budget cap) until ');
    const pt = composePauseMessage('watchdog', until, 'UTC', 'pt-PT');
    expect(pt).toContain('O seu hermit está em pausa (o watchdog) até ');
  });
});

// -------------------------------------------------------
// conversation gate + hygiene first-blocker counters
// -------------------------------------------------------

function writeSurfaceFile(h: Hermit, tokens: number): void {
  fs.writeFileSync(state(h, 'context-surface.json'), JSON.stringify({
    surface_upper_bound_tokens: tokens, post_tokens: 30000,
    boundary_at: isoAgo(24), observed_at: isoAgo(24), prev: null,
  }) + '\n');
}

function readWdState(h: Hermit): any {
  return JSON.parse(fs.readFileSync(state(h, 'watchdog-state.json'), 'utf-8'));
}

test('context_compact: recorded surface subtracted — under-threshold skip carries compactible_tokens',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 100000 });
    writeAlwaysOnRuntime(h, 'idle');
    writeSurfaceFile(h, 65000);
    // 160k total − 65k surface = 95k compactible ≤ 100k threshold → skip
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 160000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    const ws = readWdState(h);
    expect(ws.last_hygiene_eval.compact.outcome).toBe('skip:under-threshold');
    expect(ws.last_hygiene_eval.compact.prompt_tokens).toBe(160000);
    expect(ws.last_hygiene_eval.compact.compactible_tokens).toBe(95000);
  }));

test('context_compact: recorded surface subtracted — fires once compactible crosses the threshold',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 100000 });
    writeAlwaysOnRuntime(h, 'idle');
    writeSurfaceFile(h, 65000);
    // 170k total − 65k surface = 105k compactible > 100k threshold → fires on tick 2
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 170000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1: quiescence pending
    const r2 = await watchdog(h, 'run'); // tick 2: fires
    expect(r2.exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('prompt tokens 170000 (compactible ~105000) over threshold 100000');
    const ws = readWdState(h);
    expect(ws.last_hygiene_eval.compact.outcome).toBe('fired');
    expect(ws.last_hygiene_eval.compact.compactible_tokens).toBe(105000);
  }));

test('context_compact: no surface file → 50k assumed surface gives cold-start parity with the old 150k total default',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 100000 });
    writeAlwaysOnRuntime(h, 'idle');
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    // 150k total − 50k assumed = 100k compactible, NOT > threshold → never fires
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 150000 }]);
    await watchdog(h, 'run');
    await watchdog(h, 'run');
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(readWdState(h).last_hygiene_eval.compact.outcome).toBe('skip:under-threshold');

    // 151k total − 50k assumed = 101k compactible > threshold → fires
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 1000, cache_write_tokens: 0, cache_read_tokens: 150000 }]);
    await watchdog(h, 'run');
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('context-compact');
  }));

test('context_compact: malformed context-surface.json degrades to the assumed-surface fallback, never throws',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 100000 });
    writeAlwaysOnRuntime(h, 'idle');
    fs.writeFileSync(state(h, 'context-surface.json'), '{ truncated');
    // 250k total − 50k fallback = 200k compactible → fires on tick 2
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('context-compact');
  }));

test('context_compact: floor applies to the subtracted value (compactible below 60k floor → skip:below-floor)',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 1000 });
    writeAlwaysOnRuntime(h, 'idle');
    // No surface file: 100k total − 50k assumed = 50k compactible < 60k floor
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 100000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    await watchdog(h, 'run');
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(readWdState(h).last_hygiene_eval.compact.outcome).toBe('skip:below-floor');
  }));

test('hygiene_eval_counts: monotonic first-blocker counters keyed per mechanism with a stable since',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 100000 });
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 30000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    const ws1 = readWdState(h);
    // compactible −20k → below floor is the first blocker on every tick
    expect(ws1.hygiene_eval_counts.compact['skip:below-floor']).toBe(1);
    expect(typeof ws1.hygiene_eval_counts.since).toBe('string');

    await watchdog(h, 'run');
    const ws2 = readWdState(h);
    expect(ws2.hygiene_eval_counts.compact['skip:below-floor']).toBe(2);
    expect(ws2.hygiene_eval_counts.since).toBe(ws1.hygiene_eval_counts.since);
    // clear tier is unconfigured (no context_clear_tokens) → silent, never counted
    expect(Object.keys(ws2.hygiene_eval_counts.clear ?? {}).length).toBe(0);
  }));

test('hygiene_eval_counts: a clear-tier fire exits the tick before compact ever stamps (first-blocker semantics)',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 100000, clearTokens: 700000 });
    writeAlwaysOnRuntime(h, 'idle');
    // 800k total: over the 700k clear threshold AND the compact threshold
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 800000, max_prompt_tokens: 800000, api_calls: 1 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1: clear quiescence-pending, then compact also stamps
    const ws1 = readWdState(h);
    expect(ws1.hygiene_eval_counts.clear['skip:quiescence-pending']).toBe(1);
    const compactTick1 = Object.values(ws1.hygiene_eval_counts.compact as Record<string, number>).reduce((a: number, b: any) => a + b, 0);
    expect(compactTick1).toBe(1);

    const r2 = await watchdog(h, 'run'); // tick 2: clear FIRES and process.exit(0)s the tick
    expect(r2.exitCode).toBe(0);
    const ws2 = readWdState(h);
    expect(ws2.hygiene_eval_counts.clear.fired).toBe(1);
    // compact never ran on the firing tick — its counters are untouched since tick 1
    const compactTick2 = Object.values(ws2.hygiene_eval_counts.compact as Record<string, number>).reduce((a: number, b: any) => a + b, 0);
    expect(compactTick2).toBe(compactTick1);
  }));

// ============================================================================
// In-process cascade tests (fake world)
// ============================================================================
//
// The gates above are driven through a spawned subprocess with fake tmux/pgrep on
// PATH — the only way to reach them while they read the clock and shell out
// directly (Bun's spawnSync snapshots PATH at process start, so a stub binary
// only works across a spawn boundary).
//
// These drive the same gates in-process by handing them a World: fake clock, fake
// tmux, real fs against a temp state dir. That buys two things a spawn test can't
// give: the gate's decision is the assertion (the returned HygieneOutcome, not a
// side effect inferred afterwards), and time is a value, so a damper or cooldown
// can be watched flipping as the clock advances.

const NOW_MS = Date.parse('2026-08-14T12:00:00Z');
const agoISO = (secs: number) => new Date(NOW_MS - secs * 1000).toISOString();

interface Cascade {
  dir: string;
  world: World;
  sent: Array<{ session: string; text: string }>;
  setPane(v: string | null): void;
  setAlive(v: boolean): void;
  setNow(ms: number): void;
  runtime(): any;
  wdState(): any;
  cleanup(): void;
}

/** Temp hermit whose World the cascade gates can be handed directly. Defaults to a
 *  live always-on tmux session that passes every lifecycle guard. */
function setupCascade(): Cascade {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cascade-'));
  const hermitRoot = path.join(dir, '.claude-code-hermit');
  const stateDir = path.join(hermitRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(hermitRoot, 'sessions'), { recursive: true });

  let pane: string | null = 'stable-pane';
  let alive = true;
  let nowMs = NOW_MS;
  const sent: Array<{ session: string; text: string }> = [];

  const world: World = {
    clock: { nowMs: () => nowMs },
    tmux: {
      alive: () => alive,
      capture: () => pane,
      send: (session, text) => { sent.push({ session, text }); },
    },
    files: {
      readJson: (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } },
      readText: (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
      writeJson: (p, v) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
      },
      rm: (p) => { try { fs.rmSync(p); } catch {} },
    },
    paths: { stateDir, hermitRoot, costLog: path.join(dir, 'cost-log.jsonl') },
    memo: {},
  };

  const runtimePath = path.join(stateDir, 'runtime.json');
  fs.writeFileSync(runtimePath, JSON.stringify({
    version: 1,
    session_state: 'in_progress',
    runtime_mode: 'tmux',
    tmux_session: 'hermit-test',
    session_id: 'S-001',
    shutdown_requested_at: null,
    shutdown_completed_at: null,
  }, null, 2) + '\n');

  return {
    dir, world, sent,
    setPane: (v) => { pane = v; },
    setAlive: (v) => { alive = v; },
    setNow: (ms) => { nowMs = ms; },
    runtime: () => JSON.parse(fs.readFileSync(runtimePath, 'utf-8')),
    wdState: () => {
      try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'watchdog-state.json'), 'utf-8')); }
      catch { return {}; }
    },
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

/** Wraps a cascade body so the temp dir is always cleaned up. */
const withCascade = (fn: (c: Cascade) => void) => () => {
  const c = setupCascade();
  try { fn(c); } finally { c.cleanup(); }
};

function patchCascadeRuntime(c: Cascade, patch: Record<string, unknown>): void {
  const p = path.join(c.world.paths.stateDir, 'runtime.json');
  fs.writeFileSync(p, JSON.stringify({ ...c.runtime(), ...patch }) + '\n');
}

/** One cost-log entry for the fixture session. Defaults to a real (non-estimate)
 *  900k reading, which is over the clear threshold and well over the compact one. */
function writeCostEntry(c: Cascade, over: Record<string, unknown> = {}): void {
  const entry = {
    session_id: 'S-001',
    timestamp: agoISO(60),
    observed_at: agoISO(60),
    last_call_prompt_tokens: 900_000,
    max_prompt_tokens: 900_000,
    api_calls: 1,
    ...over,
  };
  fs.writeFileSync(c.world.paths.costLog, JSON.stringify(entry) + '\n');
}

const CLEAR_CONFIG = { watchdog: { context_clear_tokens: 700_000 } };
const COMPACT_CONFIG = {
  timezone: 'UTC',
  context_hygiene: { compact: { enabled: true, min_context_tokens: 100_000, min_interval: '4h' } },
};

describe('rearmDamperOpen (in-process, fake clock)', () => {
  test('a missing or non-string stamp opens the damper', withCascade((c) => {
    expect(rearmDamperOpen(undefined, c.world)).toBe(true);
    expect(rearmDamperOpen(null, c.world)).toBe(true);
    expect(rearmDamperOpen(1234, c.world)).toBe(true);
  }));

  test('an unparseable stamp opens the damper', withCascade((c) => {
    expect(rearmDamperOpen('not-a-timestamp', c.world)).toBe(true);
  }));

  test('a stamp inside the window keeps it closed', withCascade((c) => {
    expect(rearmDamperOpen(agoISO(3600), c.world)).toBe(false);
    expect(rearmDamperOpen(agoISO(MONITOR_REARM_DAMPER_SECS - 60), c.world)).toBe(false);
  }));

  test('a stamp at or past the window opens it', withCascade((c) => {
    expect(rearmDamperOpen(agoISO(MONITOR_REARM_DAMPER_SECS), c.world)).toBe(true);
    expect(rearmDamperOpen(agoISO(MONITOR_REARM_DAMPER_SECS + 600), c.world)).toBe(true);
  }));

  // The case the spawn suite cannot express: one stamp, two instants.
  test('the same stamp flips from closed to open as the clock advances', withCascade((c) => {
    const stamp = agoISO(3600);
    expect(rearmDamperOpen(stamp, c.world)).toBe(false);
    c.setNow(NOW_MS + MONITOR_REARM_DAMPER_SECS * 1000);
    expect(rearmDamperOpen(stamp, c.world)).toBe(true);
  }));
});

describe('passesLifecycleGuards (in-process) — every reason reachable', () => {
  test('passes and returns the live session name', withCascade((c) => {
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: true, sessionName: 'hermit-test' });
  }));

  test('paused', withCascade((c) => {
    fs.writeFileSync(path.join(c.world.paths.stateDir, 'pause.json'),
      JSON.stringify({ paused: true, reason: 'operator' }));
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'paused' });
  }));

  test('interactive', withCascade((c) => {
    patchCascadeRuntime(c, { runtime_mode: 'interactive' });
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'interactive' });
  }));

  test('transition', withCascade((c) => {
    patchCascadeRuntime(c, { transition: 'archiving' });
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'transition' });
  }));

  test('suspect-process', withCascade((c) => {
    patchCascadeRuntime(c, { session_state: 'suspect_process' });
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'suspect-process' });
  }));

  test('shutdown-stamp', withCascade((c) => {
    patchCascadeRuntime(c, { shutdown_requested_at: agoISO(30) });
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'shutdown-stamp' });
  }));

  test('no-tmux when the session name is empty', withCascade((c) => {
    patchCascadeRuntime(c, { tmux_session: '' });
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'no-tmux' });
  }));

  test('no-tmux when the named session is dead', withCascade((c) => {
    c.setAlive(false);
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'no-tmux' });
  }));

  test('operator-recent inside the 10-minute backoff, clear once past it', withCascade((c) => {
    fs.writeFileSync(path.join(c.world.paths.stateDir, 'last-operator-action.json'),
      JSON.stringify({ at: agoISO(60) }));
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'operator-recent' });
    c.setNow(NOW_MS + 11 * 60 * 1000);
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: true, sessionName: 'hermit-test' });
  }));

  // Gate ORDER, not just gate membership: a runtime that trips several gates at once
  // must report the first one, since that reason is what lands in last_hygiene_eval.
  test('reports the first blocking gate when several would block', withCascade((c) => {
    fs.writeFileSync(path.join(c.world.paths.stateDir, 'pause.json'),
      JSON.stringify({ paused: true, reason: 'operator' }));
    patchCascadeRuntime(c, { runtime_mode: 'interactive', transition: 'archiving', tmux_session: '' });
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'paused' });
  }));
});

describe('hygiene stamping (in-process)', () => {
  test('first stamp initialises both records off the world clock', withCascade((c) => {
    const ws: any = {};
    setHygieneEval(c.world, ws, 'clear', 'skip:under-threshold', 123);
    expect(ws.last_hygiene_eval.clear).toEqual({
      ts: '2026-08-14T12:00:00Z', outcome: 'skip:under-threshold', prompt_tokens: 123,
    });
    expect(ws.hygiene_eval_counts.since).toBe('2026-08-14T12:00:00Z');
    expect(ws.hygiene_eval_counts.clear['skip:under-threshold']).toBe(1);
    expect(ws.hygiene_eval_counts.compact).toEqual({});
  }));

  test('repeat outcomes increment rather than overwrite', withCascade((c) => {
    const ws: any = {};
    setHygieneEval(c.world, ws, 'compact', 'skip:below-floor', 90_000, 40_000);
    setHygieneEval(c.world, ws, 'compact', 'skip:below-floor', 91_000, 41_000);
    setHygieneEval(c.world, ws, 'compact', 'fired', 92_000, 42_000);
    expect(ws.hygiene_eval_counts.compact).toEqual({ 'skip:below-floor': 2, fired: 1 });
    // last_hygiene_eval holds only the most recent evaluation for the mechanism
    expect(ws.last_hygiene_eval.compact.outcome).toBe('fired');
    expect(ws.last_hygiene_eval.compact.compactible_tokens).toBe(42_000);
  }));

  test('token fields are omitted when not supplied', withCascade((c) => {
    const ws: any = {};
    setHygieneEval(c.world, ws, 'clear', 'skip:no-cost-entry');
    expect(ws.last_hygiene_eval.clear).toEqual({ ts: '2026-08-14T12:00:00Z', outcome: 'skip:no-cost-entry' });
  }));

  test('the two mechanisms keep separate slots', withCascade((c) => {
    const ws: any = {};
    setHygieneEval(c.world, ws, 'clear', 'skip:estimate-only');
    setHygieneEval(c.world, ws, 'compact', 'skip:under-threshold', 5);
    expect(ws.last_hygiene_eval.clear.outcome).toBe('skip:estimate-only');
    expect(ws.last_hygiene_eval.compact.outcome).toBe('skip:under-threshold');
  }));

  test('stampHygieneEval round-trips through the state file', withCascade((c) => {
    stampHygieneEval(c.world, 'clear', 'skip:lock-held', 700);
    stampHygieneEval(c.world, 'clear', 'skip:lock-held', 701);
    const ws = c.wdState();
    expect(ws.last_hygiene_eval.clear.outcome).toBe('skip:lock-held');
    expect(ws.hygiene_eval_counts.clear['skip:lock-held']).toBe(2);
    expect(ws.last_check_at).toBe('2026-08-14T12:00:00Z');
  }));
});

describe('maybeContextClear (in-process) — outcome per gate', () => {
  test('no outcome at all when the tier is unconfigured', withCascade((c) => {
    expect(maybeContextClear({}, c.world)).toBeNull();
    expect(maybeContextClear({ watchdog: { context_clear_tokens: 0 } }, c.world)).toBeNull();
    expect(c.wdState().last_hygiene_eval).toBeUndefined();
  }));

  test('no outcome when runtime.json is missing', withCascade((c) => {
    fs.rmSync(path.join(c.world.paths.stateDir, 'runtime.json'));
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBeNull();
  }));

  test('lifecycle reason travels into the outcome', withCascade((c) => {
    c.setAlive(false);
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('skip:lifecycle:no-tmux');
    expect(c.wdState().last_hygiene_eval.clear.outcome).toBe('skip:lifecycle:no-tmux');
  }));

  test('no-session-id', withCascade((c) => {
    patchCascadeRuntime(c, { session_id: '' });
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('skip:no-session-id');
  }));

  test('no-cost-entry when the log has nothing for this session', withCascade((c) => {
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('skip:no-cost-entry');
    writeCostEntry(c, { session_id: 'S-OTHER' });
    c.world.memo.costLogEntry = undefined; // new tick
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('skip:no-cost-entry');
  }));

  test('stale-entry when the reading predates the last context reset', withCascade((c) => {
    writeCostEntry(c, { observed_at: agoISO(600) });
    patchCascadeRuntime(c, { last_context_reset_at: agoISO(300) });
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('skip:stale-entry');
  }));

  test('aberrant-reading above the plausible ceiling', withCascade((c) => {
    writeCostEntry(c, { last_call_prompt_tokens: 6_500_000, max_prompt_tokens: 6_500_000 });
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('skip:aberrant-reading');
  }));

  test('estimate-only never drives the destructive tier', withCascade((c) => {
    writeCostEntry(c, { max_prompt_tokens: undefined, api_calls: 4 });
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('skip:estimate-only');
  }));

  test('under-threshold', withCascade((c) => {
    writeCostEntry(c, { last_call_prompt_tokens: 500_000, max_prompt_tokens: 500_000 });
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('skip:under-threshold');
    expect(c.wdState().last_hygiene_eval.clear.prompt_tokens).toBe(500_000);
  }));

  test('already-processed once the entry has been cleared', withCascade((c) => {
    writeCostEntry(c);
    c.world.files.writeJson(path.join(c.world.paths.stateDir, 'watchdog-state.json'),
      { last_cleared_cost_ts: agoISO(60) });
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('skip:already-processed');
    expect(c.sent).toEqual([]);
  }));

  test('quiescence-pending on the first qualifying tick', withCascade((c) => {
    writeCostEntry(c);
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('skip:quiescence-pending');
    expect(c.sent).toEqual([]);
    expect(c.wdState().last_pane_hash_ctx).toBeTruthy();
  }));

  test('quiescence re-arms when the pane moves between ticks', withCascade((c) => {
    writeCostEntry(c);
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('skip:quiescence-pending');
    c.setPane('operator typed something');
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('skip:quiescence-pending');
    expect(c.sent).toEqual([]);
  }));

  test('lock-held defers the fire without touching the pane', withCascade((c) => {
    writeCostEntry(c);
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('skip:quiescence-pending');
    // A bare, live, foreign PID — acquireLock treats own-PID or unparseable
    // content as a stale lock it may claim.
    fs.writeFileSync(path.join(c.world.paths.stateDir, '.lifecycle.lock'), String(process.ppid));
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('skip:lock-held');
    expect(c.sent).toEqual([]);
  }));

  test('fires on the second stable tick and marks the entry consumed', withCascade((c) => {
    writeCostEntry(c);
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('skip:quiescence-pending');
    expect(maybeContextClear(CLEAR_CONFIG, c.world)).toBe('fired');

    expect(c.sent).toEqual([{ session: 'hermit-test', text: '/clear' }]);
    const ws = c.wdState();
    expect(ws.last_hygiene_eval.clear).toEqual({
      ts: '2026-08-14T12:00:00Z', outcome: 'fired', prompt_tokens: 900_000,
    });
    expect(ws.last_cleared_cost_ts).toBe(agoISO(60));
    // cross-stamped so the compact tier can't act on the same destroyed context
    expect(ws.last_compacted_cost_ts).toBe(agoISO(60));
    expect(ws.last_pane_hash_ctx).toBeNull();
    // the reset breadcrumb lands before the keystroke, on the same hermit root
    expect(c.runtime().context_cleared).toBe(true);
    const events = fs.readFileSync(path.join(c.world.paths.stateDir, 'watchdog-events.jsonl'), 'utf-8');
    expect(events).toContain('context-clear');
  }));
});

describe('maybeContextCompact (in-process) — outcome per gate', () => {
  test('no outcome when the tier is disabled or unconfigured', withCascade((c) => {
    expect(maybeContextCompact({}, c.world)).toBeNull();
    expect(maybeContextCompact({ context_hygiene: { compact: { enabled: false, min_context_tokens: 100 } } }, c.world)).toBeNull();
    expect(maybeContextCompact({ context_hygiene: { compact: { enabled: true, min_context_tokens: 0 } } }, c.world)).toBeNull();
  }));

  test('midnight-adjacent suppression beats the token gates', withCascade((c) => {
    writeCostEntry(c);
    const config = { ...COMPACT_CONFIG, routines: [{ id: 'daily-auto-close', schedule: '0 13 * * *', enabled: true }] };
    expect(maybeContextCompact(config, c.world)).toBe('skip:midnight-adjacent');
    expect(c.sent).toEqual([]);
  }));

  test('below-floor: a small compactible conversation is never worth summarising', withCascade((c) => {
    // 100k prompt minus the 50k assumed fixed surface = 50k compactible, under the 60k floor
    writeCostEntry(c, { last_call_prompt_tokens: 100_000, max_prompt_tokens: 100_000 });
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:below-floor');
    const evalRow = c.wdState().last_hygiene_eval.compact;
    expect(evalRow.prompt_tokens).toBe(100_000);
    expect(evalRow.compactible_tokens).toBe(50_000);
  }));

  test('under-threshold is measured in compactible tokens, not total prompt', withCascade((c) => {
    // 180k total prompt = 130k compactible... but with a recorded 100k surface it is only 80k
    writeCostEntry(c, { last_call_prompt_tokens: 180_000, max_prompt_tokens: 180_000 });
    fs.writeFileSync(path.join(c.world.paths.stateDir, 'context-surface.json'),
      JSON.stringify({ surface_upper_bound_tokens: 100_000 }));
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:under-threshold');
    expect(c.wdState().last_hygiene_eval.compact.compactible_tokens).toBe(80_000);
  }));

  test('interval-cooldown blocks before quiescence has a say', withCascade((c) => {
    writeCostEntry(c);
    c.world.files.writeJson(path.join(c.world.paths.stateDir, 'watchdog-state.json'),
      { last_compacted_at: agoISO(3600) }); // 1h ago, inside the 4h min_interval
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:interval-cooldown');
  }));

  // The cooldown-blocked tick still banks the pane hash, so when the interval
  // reopens the compact fires immediately instead of spending another tick
  // re-observing a pane that never moved.
  test('the cooldown lapses as the clock advances, and quiescence banked meanwhile still counts', withCascade((c) => {
    writeCostEntry(c);
    c.world.files.writeJson(path.join(c.world.paths.stateDir, 'watchdog-state.json'),
      { last_compacted_at: agoISO(3600) });
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:interval-cooldown');
    expect(c.wdState().last_pane_hash_compact).toBeTruthy();
    c.setNow(NOW_MS + 4 * 3600 * 1000); // stamp is now >4h old
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('fired');
  }));

  test('a fresh boundary marker waives the cooldown but not the floor', withCascade((c) => {
    const markerPath = path.join(c.world.paths.stateDir, 'compact-requested.json');
    fs.writeFileSync(markerPath, JSON.stringify({ requested_at: agoISO(60) }));
    writeCostEntry(c, { last_call_prompt_tokens: 100_000, max_prompt_tokens: 100_000 });
    c.world.files.writeJson(path.join(c.world.paths.stateDir, 'watchdog-state.json'),
      { last_compacted_at: agoISO(3600) });
    // cooldown waived, floor still refuses — and the fresh marker survives for a later tick
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:below-floor');
    expect(fs.existsSync(markerPath)).toBe(true);
  }));

  test('a stale boundary marker is consumed on read and waives nothing', withCascade((c) => {
    const markerPath = path.join(c.world.paths.stateDir, 'compact-requested.json');
    fs.writeFileSync(markerPath, JSON.stringify({ requested_at: agoISO(2 * 3600) })); // past the 1h TTL
    writeCostEntry(c);
    c.world.files.writeJson(path.join(c.world.paths.stateDir, 'watchdog-state.json'),
      { last_compacted_at: agoISO(3600) });
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:interval-cooldown');
    expect(fs.existsSync(markerPath)).toBe(false);
  }));

  test('already-processed', withCascade((c) => {
    writeCostEntry(c);
    c.world.files.writeJson(path.join(c.world.paths.stateDir, 'watchdog-state.json'),
      { last_compacted_cost_ts: agoISO(60) });
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:already-processed');
    expect(c.sent).toEqual([]);
  }));

  test('lock-held', withCascade((c) => {
    writeCostEntry(c);
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:quiescence-pending');
    // A bare, live, foreign PID — acquireLock treats own-PID or unparseable
    // content as a stale lock it may claim.
    fs.writeFileSync(path.join(c.world.paths.stateDir, '.lifecycle.lock'), String(process.ppid));
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:lock-held');
    expect(c.sent).toEqual([]);
  }));

  test('fires mid-arc on the second stable tick', withCascade((c) => {
    writeCostEntry(c);
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:quiescence-pending');
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('fired');

    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].session).toBe('hermit-test');
    expect(c.sent[0].text).toBe(composeCompactSteeringMessage('mid-arc'));
    const ws = c.wdState();
    expect(ws.last_hygiene_eval.compact).toEqual({
      ts: '2026-08-14T12:00:00Z', outcome: 'fired', prompt_tokens: 900_000, compactible_tokens: 850_000,
    });
    expect(ws.last_compacted_at).toBe('2026-08-14T12:00:00Z');
    expect(ws.last_pane_hash_compact).toBeNull();
  }));

  test('an idle session with a fresh marker fires the boundary flavor and consumes it', withCascade((c) => {
    const markerPath = path.join(c.world.paths.stateDir, 'compact-requested.json');
    patchCascadeRuntime(c, { session_state: 'idle' });
    writeCostEntry(c);
    fs.writeFileSync(markerPath, JSON.stringify({ requested_at: agoISO(60) }));
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:quiescence-pending');
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('fired');
    expect(c.sent[0].text).toBe(composeCompactSteeringMessage('boundary'));
    expect(fs.existsSync(markerPath)).toBe(false);
  }));
});
