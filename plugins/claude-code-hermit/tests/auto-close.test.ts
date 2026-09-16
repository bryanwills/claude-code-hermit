// Covers operator-action hooks, the retained archive decision verb, and auto-idle.
// Exercise subprocess boundaries with their real arguments and project roots.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, runPinnedScript, PLUGIN_ROOT, SCRIPTS_DIR } from './helpers/run';
import { composeCompactSteeringMessage } from '../scripts/hermit-watchdog';
import { autoIdleDue, runAutoIdle } from '../scripts/lib/auto-close';
import { setPause } from '../scripts/lib/pause';
import { replaceSectionInPlace } from '../scripts/lib/md-write';
import { readFrontmatter } from '../scripts/lib/frontmatter';

// ---------- fixture scaffolding ----------

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);

interface Tmp { dir: string; cleanup(): void }

function makeDir(): Tmp {
  // realpath, not the raw mkdtemp value: reflectPrecheck() below sets AGENT_DIR
  // from this path while passing a relative state dir the child resolves against
  // process.cwd(), which is already symlink-resolved. On macOS os.tmpdir() is
  // /var/folders/... behind a symlink to /private/var/folders/..., so the two
  // sides would disagree and the pin would refuse a legitimate call.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-autoclose-')));
  fs.mkdirSync(hermit(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
  return {
    dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

/** Run a test body inside a throwaway workdir, always cleaning up. */
function withTmp(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const t = makeDir();
    try { await fn(t.dir); } finally { t.cleanup(); }
  };
}

const RUNTIME_IN_PROGRESS = '{"session_state":"in_progress","session_id":"S-001"}';
const writeState = (dir: string, name: string, content: string) =>
  fs.writeFileSync(hermit(dir, 'state', name), content);

// -------------------------------------------------------
// last-operator-action.json signal
// -------------------------------------------------------

describe('last-operator-action.json signal', () => {
  const lastOp = (dir: string) => hermit(dir, 'state', 'last-operator-action.json');
  const turnPath = (dir: string) => hermit(dir, 'state', 'operator-turn-open.json');
  const recordHook = (dir: string, stdin: string, args: string[] = []) =>
    runScript('record-operator-action.ts', { stdin, cwd: dir, args });

  // A well-formed inbound envelope — quoted attributes, so parseChannelEnvelope
  // actually resolves a sender to check against the allowlist.
  const channelPrompt = (userId: string) =>
    `<channel source="discord" chat_id="c1" user_id="${userId}">hi</channel>`;
  const writeAllowlist = (dir: string, allowed: string[]) =>
    fs.writeFileSync(hermit(dir, 'config.json'),
      JSON.stringify({ timezone: 'UTC', channels: { discord: { enabled: true, allowed_users: allowed } } }));

  // e. hook smoke: routine prompt → file NOT written
  test('hook smoke: [hermit-routine: prefix → file NOT written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"[hermit-routine:reflect] Invoke /claude-code-hermit:reflect."}');
    expect(fs.existsSync(lastOp(dir))).toBe(false);
  }));

  test('hook smoke: GUEST_REPORT: prefix → file NOT written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"GUEST_REPORT: merged #900, touched scripts/x.ts"}');
    expect(fs.existsSync(lastOp(dir))).toBe(false);
  }));

  test('hook smoke: prose mentioning GUEST_REPORT: mid-sentence → file IS written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"what does GUEST_REPORT: mean?"}');
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // f. hook smoke: plain operator prompt → file IS written
  test('hook smoke: plain operator prompt → file IS written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"hello"}');
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // g. hook smoke: exact hermit-injected commands (watchdog re-arm + shutdown) → file NOT written
  for (const injected of [
    '/claude-code-hermit:heartbeat run',
    '/claude-code-hermit:heartbeat start',
    '/claude-code-hermit:heartbeat stop',
    '/claude-code-hermit:hermit-routines load',
    '/claude-code-hermit:session-close --shutdown',
  ]) {
    test(`hook smoke: injected "${injected}" → file NOT written`, withTmp(async (dir) => {
      await recordHook(dir, JSON.stringify({ prompt: injected }));
      expect(fs.existsSync(lastOp(dir))).toBe(false);
    }));
  }

  // g3. hook smoke: injected command with trailing whitespace/newline still matches
  test('hook smoke: injected command with trailing whitespace → file NOT written', withTmp(async (dir) => {
    await recordHook(dir, JSON.stringify({ prompt: '/claude-code-hermit:heartbeat run\n' }));
    expect(fs.existsSync(lastOp(dir))).toBe(false);
  }));

  // g4. hook smoke: watchdog hygiene commands (/clear, /compact ...) → file NOT written
  test('hook smoke: bare /clear (watchdog hygiene) → file NOT written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"/clear"}');
    expect(fs.existsSync(lastOp(dir))).toBe(false);
  }));

  // Both watchdog-fired steering flavors (mid-arc, boundary) must be filtered — the
  // real filter is a startsWith('/compact') prefix match, so this is a regression
  // guard against either literal drifting off that prefix.
  for (const flavor of ['mid-arc', 'boundary'] as const) {
    const compactMessage = composeCompactSteeringMessage(flavor);
    test(`hook smoke: bare /compact ... (${flavor}) (watchdog hygiene) → file NOT written`, withTmp(async (dir) => {
      await recordHook(dir, JSON.stringify({ prompt: compactMessage }));
      expect(fs.existsSync(lastOp(dir))).toBe(false);
    }));
  }

  // g5. hook smoke: Monitor-delivered scheduler notifications → file NOT written
  for (const notification of [
    'HEARTBEAT_EVALUATE',
    'HEARTBEAT_ERROR: precheck failed',
    'ROUTINE_DUE [hermit-routine:morning-brief]',
    'ROUTINE_DUE [hermit-routine:reflect] [hermit-routine:doctor]',
    'ROUTINE_MONITOR_ERROR: routine-due failed (3 consecutive)',
  ]) {
    test(`hook smoke: monitor notification "${notification}" → file NOT written`, withTmp(async (dir) => {
      await recordHook(dir, JSON.stringify({ prompt: notification }));
      expect(fs.existsSync(lastOp(dir))).toBe(false);
    }));
  }

  // g6. hook smoke: prose merely containing/echoing a monitor token → file IS written
  // (tight grammar — a mid-sentence or near-miss token still counts as operator activity)
  test('hook smoke: prose mentioning HEARTBEAT_EVALUATE mid-sentence → file IS written', withTmp(async (dir) => {
    await recordHook(dir, JSON.stringify({ prompt: 'why did HEARTBEAT_EVALUATE fire twice?' }));
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  test('hook smoke: near-miss "HEARTBEAT_EVALUATE looks weird" → file IS written', withTmp(async (dir) => {
    await recordHook(dir, JSON.stringify({ prompt: 'HEARTBEAT_EVALUATE looks weird' }));
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // h. hook smoke: legacy wrapped shape (never actually reaches stdin per the
  // 2026-07-10 probe, but must not regress to dropped if some future CC version emits it)
  test('hook smoke: legacy <command-message> wrapped shape → file IS written', withTmp(async (dir) => {
    await recordHook(dir, JSON.stringify({
      prompt: '<command-message>heartbeat run</command-message>\n<command-name>/claude-code-hermit:heartbeat run</command-name>',
    }));
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // i. hook smoke: channel inbound. Issue #835 — a channel-only conversation used to
  // leave the clock frozen (the write was delegated to a skill step the model skipped),
  // so the midnight post-close /clear fired mid-exchange. The hook now applies the same
  // allowlist gate channel-responder does: allowlisted sender = operator activity,
  // anyone else still ignored so stranger/bot traffic can't suppress AUTO_CLOSE.
  test('hook smoke: <channel inbound, no allowlist configured → file IS written', withTmp(async (dir) => {
    await recordHook(dir, JSON.stringify({ prompt: channelPrompt('u1') }));
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  test('hook smoke: <channel inbound from allowlisted sender → file IS written', withTmp(async (dir) => {
    writeAllowlist(dir, ['u1']);
    await recordHook(dir, JSON.stringify({ prompt: channelPrompt('u1') }));
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  test('hook smoke: <channel inbound from non-allowlisted sender → file NOT written', withTmp(async (dir) => {
    writeAllowlist(dir, ['u1']);
    await recordHook(dir, JSON.stringify({ prompt: channelPrompt('stranger') }));
    expect(fs.existsSync(lastOp(dir))).toBe(false);
  }));

  test('hook smoke: <channel prefix with no parseable envelope → file NOT written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"<channel source=discord chat_id=x>hi</channel>"}');
    expect(fs.existsSync(lastOp(dir))).toBe(false);
  }));

  // j. hook smoke: operator-typed bare /brief → file IS written (#574 repro — this is the
  // shape a real operator slash-command turn actually arrives as; no <command-message>
  // wrapper reaches this hook's stdin)
  test('hook smoke: operator-typed bare /claude-code-hermit:brief → file IS written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"/claude-code-hermit:brief"}');
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // k. hook smoke: legacy wrapped /brief shape → still written
  test('hook smoke: legacy <command-message> wrapped /brief shape → file IS written', withTmp(async (dir) => {
    await recordHook(dir, JSON.stringify({
      prompt: '<command-message>claude-code-hermit:brief</command-message>\n<command-name>/claude-code-hermit:brief</command-name>',
    }));
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // l. hook smoke: bare arbitrary namespaced slash command → file IS written (not on the
  // hermit-injected drop-list, so it counts as operator activity — see #574)
  test('hook smoke: bare /some-future-plugin:some-cmd → file IS written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"/some-future-plugin:some-cmd --flag"}');
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // l2. hook smoke: un-namespaced operator command (e.g. a personal/project skill) → file IS written
  test('hook smoke: bare /tackle-issue 574 (un-namespaced) → file IS written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"/tackle-issue 574"}');
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // l3. hook smoke: single-step always-on boot skill (hermit-start.ts argv bootstrap) →
  // file IS written (accepted delta: this is indistinguishable from operator-typed /session)
  test('hook smoke: bare /claude-code-hermit:session (boot_skill) → file IS written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"/claude-code-hermit:session"}');
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // m. SessionStart (no payload) + absent file → file IS written (cold-start seed)
  test('SessionStart with absent state file → file IS written (cold-start seed)', withTmp(async (dir) => {
    await recordHook(dir, '');
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // n. SessionStart (no payload) + existing file → timestamp preserved (no mask on restart)
  test("SessionStart with existing state file → timestamp preserved (restart doesn't reset clock)", withTmp(async (dir) => {
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T09:00:00.000Z"}');
    await recordHook(dir, '');
    expect(fs.readFileSync(lastOp(dir), 'utf-8')).toContain('2026-05-20T09:00:00');
  }));

  // o. --force invocation (channel-responder post-auth path) → file IS written
  test('--force → file IS written (channel-responder post-auth)', withTmp(async (dir) => {
    await recordHook(dir, '', ['--force']);
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // p. --force overwrites existing file (channel inbound = fresh operator activity)
  test('--force overwrites existing file (channel inbound bumps clock)', withTmp(async (dir) => {
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T09:00:00.000Z"}');
    await recordHook(dir, '', ['--force']);
    expect(fs.readFileSync(lastOp(dir), 'utf-8')).not.toContain('2026-05-20T09:00:00');
  }));

  // q. operator-turn-open.json marker — issue #617's routine-due.ts defer signal.
  // Written alongside last-operator-action.json on the same kept-prompt/--force paths,
  // never on SessionStart (a restart seed is not an operator turn).
  test('marker: plain operator prompt → operator-turn-open.json written with parseable ISO at', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"hello"}');
    expect(fs.existsSync(turnPath(dir))).toBe(true);
    const at = JSON.parse(fs.readFileSync(turnPath(dir), 'utf-8')).at;
    expect(isNaN(new Date(at).getTime())).toBe(false);
  }));

  test('marker: [hermit-routine: prefix → NOT written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"[hermit-routine:reflect] Invoke /claude-code-hermit:reflect."}');
    expect(fs.existsSync(turnPath(dir))).toBe(false);
  }));

  test('marker: HEARTBEAT_EVALUATE notification → NOT written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"HEARTBEAT_EVALUATE"}');
    expect(fs.existsSync(turnPath(dir))).toBe(false);
  }));

  test('marker: <channel inbound, no allowlist configured → written', withTmp(async (dir) => {
    await recordHook(dir, JSON.stringify({ prompt: channelPrompt('u1') }));
    expect(fs.existsSync(turnPath(dir))).toBe(true);
  }));

  test('marker: <channel inbound from allowlisted sender → written', withTmp(async (dir) => {
    writeAllowlist(dir, ['u1']);
    await recordHook(dir, JSON.stringify({ prompt: channelPrompt('u1') }));
    expect(fs.existsSync(turnPath(dir))).toBe(true);
  }));

  test('marker: <channel inbound from non-allowlisted sender → NOT written', withTmp(async (dir) => {
    writeAllowlist(dir, ['u1']);
    await recordHook(dir, JSON.stringify({ prompt: channelPrompt('stranger') }));
    expect(fs.existsSync(turnPath(dir))).toBe(false);
  }));

  test('marker: hermit-injected exact command → NOT written', withTmp(async (dir) => {
    await recordHook(dir, JSON.stringify({ prompt: '/claude-code-hermit:heartbeat run' }));
    expect(fs.existsSync(turnPath(dir))).toBe(false);
  }));

  test('marker: watchdog hygiene injections (/clear, /compact) → NOT written', withTmp(async (dir) => {
    await recordHook(dir, JSON.stringify({ prompt: '/clear' }));
    expect(fs.existsSync(turnPath(dir))).toBe(false);
    await recordHook(dir, JSON.stringify({ prompt: '/compact focus on the migration' }));
    expect(fs.existsSync(turnPath(dir))).toBe(false);
  }));

  test('marker: --force (channel-responder post-auth) → written', withTmp(async (dir) => {
    await recordHook(dir, '', ['--force']);
    expect(fs.existsSync(turnPath(dir))).toBe(true);
  }));

  test('marker: SessionStart (no prompt), file absent → NOT written (not an operator turn)', withTmp(async (dir) => {
    await recordHook(dir, '');
    expect(fs.existsSync(turnPath(dir))).toBe(false);
  }));

  test('marker: SessionStart (no prompt), file already present → left untouched', withTmp(async (dir) => {
    writeState(dir, 'operator-turn-open.json', '{"at":"2026-05-20T09:00:00.000Z"}');
    await recordHook(dir, '');
    expect(fs.readFileSync(turnPath(dir), 'utf-8')).toContain('2026-05-20T09:00:00');
  }));
});

// -------------------------------------------------------
// injection-sync drift guard: every slash literal hermit-watchdog.ts /
// hermit-stop.ts inject via tmux send-keys must be dropped by
// record-operator-action.ts's isRoutinePrompt. Prevents a future injection
// from silently refreshing the operator clock it should not touch.
// -------------------------------------------------------

describe('record-operator-action: hermit-injected commands stay in sync', () => {
  function extractSendKeysLiterals(file: string): string[] {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', file), 'utf-8');
    const literals: string[] = [];
    for (const line of src.split('\n')) {
      if (!line.includes('sendKeys(') && !line.includes('send-keys')) continue;
      for (const m of line.matchAll(/(['"])(\/[^'"]*)\1/g)) literals.push(m[2]);
    }
    return literals;
  }

  const literals = [
    ...extractSendKeysLiterals('hermit-watchdog.ts'),
    ...extractSendKeysLiterals('hermit-stop.ts'),
  ];

  test('sweep finds a non-trivial number of injected slash literals', () => {
    expect(literals.length).toBeGreaterThanOrEqual(5);
  });

  for (const literal of [...new Set(literals)]) {
    test(`injected literal "${literal}" is dropped by record-operator-action.ts`, withTmp(async (dir) => {
      const r = await runScript('record-operator-action.ts', {
        stdin: JSON.stringify({ prompt: literal }),
        cwd: dir,
      });
      expect(r.exitCode).toBe(0);
      expect(fs.existsSync(hermit(dir, 'state', 'last-operator-action.json'))).toBe(false);
    }));
  }

  // HAND-WRITTEN on purpose. The sweep above only matches single/double-quoted literals
  // on a sendKeys line; the harness-command drain injects a template literal
  // (`/model ${arg}`), which that regex cannot see. Without these cases a dynamic
  // injection would register as operator presence and suppress auto-close, with no
  // failing test to warn anyone. Keep in sync with the prefix rules in
  // record-operator-action.ts.
  for (const literal of ['/model opus', '/model claude-opus-5[1m]', '/effort high', '/advisor opus', '/advisor off']) {
    test(`drained harness command "${literal}" is dropped by record-operator-action.ts`, withTmp(async (dir) => {
      const r = await runScript('record-operator-action.ts', {
        stdin: JSON.stringify({ prompt: literal }),
        cwd: dir,
      });
      expect(r.exitCode).toBe(0);
      expect(fs.existsSync(hermit(dir, 'state', 'last-operator-action.json'))).toBe(false);
    }));
  }
});

// -------------------------------------------------------
// auto-close-decision verb: the deterministic midnight branch table
// (session-close --scheduled). The verb reads runtime + the operator clock,
// mutates pending-close.json itself, and returns noop | queued | close-now.
// -------------------------------------------------------

describe('auto-close-decision verb', () => {
  const NOW = '2026-05-20T22:45:00+00:00';
  const pendingPath = (dir: string) => hermit(dir, 'state', 'pending-close.json');

  async function decide(dir: string, now: string = NOW) {
    const r = await runPinnedScript('session-archive.ts', hermit(dir), ['auto-close-decision', `--state-dir=${hermit(dir)}`], {
      env: { HERMIT_NOW: now, TZ: 'UTC' },
    });
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout.trim());
  }

  const lastOpAt = (dir: string, at: string) =>
    writeState(dir, 'last-operator-action.json', JSON.stringify({ at }));

  test('in_progress + 15min lull → close-now, no pending-close written', withTmp(async (dir) => {
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    lastOpAt(dir, '2026-05-20T22:30:00+00:00');
    const result = await decide(dir);
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('close-now');
    expect(fs.existsSync(pendingPath(dir))).toBe(false);
  }));

  test('in_progress + 5min lull → queued, pending-close stamped by daily-auto-close at HERMIT_NOW', withTmp(async (dir) => {
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    lastOpAt(dir, '2026-05-20T22:40:00+00:00');
    const result = await decide(dir);
    expect(result.decision).toBe('queued');
    const pending = JSON.parse(fs.readFileSync(pendingPath(dir), 'utf-8'));
    expect(pending.queued_by).toBe('daily-auto-close');
    // TZ pinned to UTC in decide() so the localISOStamp prefix is deterministic.
    expect(pending.queued_at.startsWith('2026-05-20T22:45:00')).toBe(true);
    expect(new Date(pending.queued_at).getTime()).toBe(Date.parse(NOW));
  }));

  test('queued overwrites an existing pending-close (singleton semantics)', withTmp(async (dir) => {
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    lastOpAt(dir, '2026-05-20T22:40:00+00:00');
    writeState(dir, 'pending-close.json', '{"queued_at":"2026-05-19T00:00:00+0000","queued_by":"daily-auto-close"}');
    const result = await decide(dir);
    expect(result.decision).toBe('queued');
    const pending = JSON.parse(fs.readFileSync(pendingPath(dir), 'utf-8'));
    expect(new Date(pending.queued_at).getTime()).toBe(Date.parse(NOW));
  }));

  test('idle, no active session → noop regardless of lull (nothing to close)', withTmp(async (dir) => {
    writeState(dir, 'runtime.json', '{"session_state":"idle"}');
    lastOpAt(dir, '2026-05-20T22:30:00+00:00');
    const result = await decide(dir);
    expect(result.decision).toBe('noop');
    expect(result.reason).toContain('no active session');
  }));

  // The idle-archive rollover path (closeFinalUpdates) stamps a fresh session_id on
  // idle, and nulls it only on a real close — so idle WITH a session_id is still a
  // session worth closing, not the "nothing to close" rest state above.
  test('idle + active session_id + 15min lull → close-now', withTmp(async (dir) => {
    writeState(dir, 'runtime.json', '{"session_state":"idle","session_id":"S-001"}');
    lastOpAt(dir, '2026-05-20T22:30:00+00:00');
    expect((await decide(dir)).decision).toBe('close-now');
  }));

  test('idle + active session_id + 5min lull → queued', withTmp(async (dir) => {
    writeState(dir, 'runtime.json', '{"session_state":"idle","session_id":"S-001"}');
    lastOpAt(dir, '2026-05-20T22:40:00+00:00');
    expect((await decide(dir)).decision).toBe('queued');
  }));

  test('exact 10-min boundary → queued (threshold is strictly greater-than)', withTmp(async (dir) => {
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    lastOpAt(dir, '2026-05-20T22:35:00+00:00');
    expect((await decide(dir)).decision).toBe('queued');
  }));

  test("session_state 'waiting' → noop, stale pending-close reaped", withTmp(async (dir) => {
    writeState(dir, 'runtime.json', '{"session_state":"waiting"}');
    writeState(dir, 'pending-close.json', '{"queued_at":"2026-05-19T00:00:00+0000","queued_by":"daily-auto-close"}');
    const result = await decide(dir);
    expect(result.decision).toBe('noop');
    expect(result.reason).toContain('waiting');
    expect(fs.existsSync(pendingPath(dir))).toBe(false);
  }));

  test('runtime.json absent → noop, seeded stale flag deleted', withTmp(async (dir) => {
    writeState(dir, 'pending-close.json', '{"queued_at":"2026-05-19T00:00:00+0000","queued_by":"daily-auto-close"}');
    const result = await decide(dir);
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('noop');
    expect(fs.existsSync(pendingPath(dir))).toBe(false);
  }));

  test('runtime.json corrupt → noop, corrupt file NOT quarantined (recover owns quarantine)', withTmp(async (dir) => {
    const garbage = '{not valid json at all';
    writeState(dir, 'runtime.json', garbage);
    const result = await decide(dir);
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('noop');
    expect(fs.readFileSync(hermit(dir, 'state', 'runtime.json'), 'utf-8')).toBe(garbage);
    const stateFiles = fs.readdirSync(hermit(dir, 'state'));
    expect(stateFiles.some(f => f.startsWith('runtime.json.corrupt'))).toBe(false);
  }));

  // A queued flag is only provably stale once we know there is no session worth
  // closing. An absent runtime.json proves that; a corrupt or unreadable one does
  // not — it may still front a live session whose close is legitimately queued,
  // and reaping there strands the session until the next midnight.
  test('runtime.json corrupt → queued pending-close SURVIVES (not provably stale)', withTmp(async (dir) => {
    writeState(dir, 'runtime.json', '{not valid json at all');
    writeState(dir, 'pending-close.json', '{"queued_at":"2026-05-20T00:00:00+0000","queued_by":"daily-auto-close"}');
    const result = await decide(dir);
    expect(result.decision).toBe('noop');
    expect(result.reason).toContain('corrupt');
    expect(fs.existsSync(pendingPath(dir))).toBe(true);
  }));

  test('runtime.json unreadable (ioerror) → queued pending-close SURVIVES', withTmp(async (dir) => {
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    writeState(dir, 'pending-close.json', '{"queued_at":"2026-05-20T00:00:00+0000","queued_by":"daily-auto-close"}');
    fs.chmodSync(hermit(dir, 'state', 'runtime.json'), 0o000);
    try {
      const result = await decide(dir);
      expect(result.decision).toBe('noop');
      expect(fs.existsSync(pendingPath(dir))).toBe(true);
    } finally {
      fs.chmodSync(hermit(dir, 'state', 'runtime.json'), 0o644);
    }
  }));

  test('last-operator-action in the future → close-now, anomaly named in reason', withTmp(async (dir) => {
    // A future stamp yields a negative lull that can never exceed the threshold.
    // Left unguarded it pins this verb to `queued` every midnight while the
    // heartbeat drain (same comparison) never fires — the session never closes.
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    lastOpAt(dir, '2026-05-21T22:45:00+00:00');
    const result = await decide(dir);
    expect(result.decision).toBe('close-now');
    expect(result.reason).toContain('clock skew');
    expect(fs.existsSync(pendingPath(dir))).toBe(false);
  }));

  test('last-operator-action absent → close-now (fail-open)', withTmp(async (dir) => {
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    expect((await decide(dir)).decision).toBe('close-now');
  }));

  test('last-operator-action with invalid at → close-now (fail-open)', withTmp(async (dir) => {
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    writeState(dir, 'last-operator-action.json', '{"at":"not-a-date"}');
    expect((await decide(dir)).decision).toBe('close-now');
  }));

  test('bare state dir (state/ subdir missing entirely) → ok:true noop, no crash', withTmp(async (dir) => {
    fs.rmSync(hermit(dir, 'state'), { recursive: true, force: true });
    const result = await decide(dir);
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('noop');
  }));

  // The retained archive decision and routine drain share one lull threshold.
  test('every auto-close consumer reaches lib/auto-close and none hardcodes the lull', () => {
    const autoCloseSrc = fs.readFileSync(path.join(SCRIPTS_DIR, 'lib', 'auto-close.ts'), 'utf-8');
    const archiveSrc = fs.readFileSync(path.join(SCRIPTS_DIR, 'session-archive.ts'), 'utf-8');
    const dueSrc = fs.readFileSync(path.join(SCRIPTS_DIR, 'lib', 'routines', 'due.ts'), 'utf-8');

    // The constant is defined exactly once, here.
    expect(autoCloseSrc).toContain('export const AUTO_CLOSE_LULL_MINUTES = 10');

    // Direct consumer of the threshold.
    expect(archiveSrc).toContain('AUTO_CLOSE_LULL_MINUTES');
    // The routine drain consumes the shared predicate.
    expect(dueSrc).toContain("from '../auto-close'");
    expect(dueSrc).toContain('pendingCloseDrainDue');

    // Nobody re-derives the boundary from a bare literal.
    expect(dueSrc).not.toContain('1000 * 60) > 10');
  });
});

// -------------------------------------------------------
// autoIdleDue: quiet-session predicate for script-owned idle
// -------------------------------------------------------

describe('autoIdleDue', () => {
  const STALE_MS = 2 * 3600_000;
  const NOW_ISO = '2026-05-20T22:00:00+00:00';
  const NOW_MS = Date.parse(NOW_ISO);
  const QUIET_AT = '2026-05-20T19:00:00+00:00';
  const FRESH_AT = '2026-05-20T21:30:00+00:00';

  function seedQuiet(dir: string, runtime: object = { session_state: 'in_progress' }): void {
    fs.writeFileSync(hermit(dir, 'config.json'), '{"timezone":"UTC"}');
    writeState(dir, 'runtime.json', JSON.stringify(runtime));
    writeState(dir, 'last-operator-action.json', JSON.stringify({ at: QUIET_AT }));
    fs.writeFileSync(hermit(dir, 'sessions', 'SHELL.md'),
      '# Active Session\n\n## Progress Log\n[19:00] Did some work\n\n## Monitoring\n');
  }

  function snapshotState(dir: string): Record<string, string> {
    const stateDir = hermit(dir, 'state');
    const out: Record<string, string> = {};
    for (const name of fs.readdirSync(stateDir)) {
      const p = path.join(stateDir, name);
      if (fs.statSync(p).isFile()) out[name] = fs.readFileSync(p, 'utf-8');
    }
    return out;
  }

  test('both axes quiet → due', withTmp((dir) => {
    seedQuiet(dir);
    const before = snapshotState(dir);
    expect(autoIdleDue(hermit(dir), NOW_MS, STALE_MS)).toEqual({ due: true, hours: 3 });
    expect(snapshotState(dir)).toEqual(before);
  }));

  test('operator fresh → not due', withTmp((dir) => {
    seedQuiet(dir);
    writeState(dir, 'last-operator-action.json', JSON.stringify({ at: FRESH_AT }));
    expect(autoIdleDue(hermit(dir), NOW_MS, STALE_MS)).toEqual({ due: false });
  }));

  test('progress fresh → not due', withTmp((dir) => {
    seedQuiet(dir);
    fs.writeFileSync(hermit(dir, 'sessions', 'SHELL.md'),
      '# Active Session\n\n## Progress Log\n[21:30] Did some work\n\n## Monitoring\n');
    expect(autoIdleDue(hermit(dir), NOW_MS, STALE_MS)).toEqual({ due: false });
  }));

  test('interactive → not due', withTmp((dir) => {
    seedQuiet(dir, { session_state: 'in_progress', runtime_mode: 'interactive' });
    expect(autoIdleDue(hermit(dir), NOW_MS, STALE_MS)).toEqual({ due: false });
  }));

  test('transition → not due', withTmp((dir) => {
    seedQuiet(dir, { session_state: 'in_progress', transition: 'archiving' });
    expect(autoIdleDue(hermit(dir), NOW_MS, STALE_MS)).toEqual({ due: false });
  }));

  test('shutdown stamp → not due', withTmp((dir) => {
    seedQuiet(dir, { session_state: 'in_progress', shutdown_requested_at: QUIET_AT });
    expect(autoIdleDue(hermit(dir), NOW_MS, STALE_MS)).toEqual({ due: false });
  }));

  test('paused → not due', withTmp((dir) => {
    seedQuiet(dir);
    setPause(hermit(dir), { reason: 'operator', by: 'test' });
    expect(autoIdleDue(hermit(dir), NOW_MS, STALE_MS)).toEqual({ due: false });
  }));

  test('waiting → not due', withTmp((dir) => {
    seedQuiet(dir, { session_state: 'waiting' });
    expect(autoIdleDue(hermit(dir), NOW_MS, STALE_MS)).toEqual({ due: false });
  }));

  test('no SHELL.md → not due', withTmp((dir) => {
    seedQuiet(dir);
    fs.unlinkSync(hermit(dir, 'sessions', 'SHELL.md'));
    expect(autoIdleDue(hermit(dir), NOW_MS, STALE_MS)).toEqual({ due: false });
  }));

  test('fresh attempt marker → not due', withTmp((dir) => {
    seedQuiet(dir);
    writeState(dir, 'auto-idle-attempt.json', JSON.stringify({ last_attempt_at: FRESH_AT }));
    expect(autoIdleDue(hermit(dir), NOW_MS, STALE_MS)).toEqual({ due: false });
  }));
});

describe('runAutoIdle', () => {
  const NOW_ISO = '2026-05-20T22:00:00.000Z';
  const NOW_MS = Date.parse(NOW_ISO);
  const QUIET_AT = '2026-05-20T19:00:00+00:00';
  const SHELL_TEMPLATE = fs.readFileSync(
    path.join(import.meta.dir, '..', 'state-templates', 'SHELL.md.template'), 'utf-8',
  );
  const UTC_CONFIG = { timezone: 'UTC' };

  function seedArchivable(dir: string): void {
    fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify(UTC_CONFIG));
    writeState(dir, 'runtime.json', JSON.stringify({
      session_state: 'in_progress',
      session_id: 'S-001',
      opened_at: QUIET_AT,
    }));
    writeState(dir, 'last-operator-action.json', JSON.stringify({ at: QUIET_AT }));
    const shell = replaceSectionInPlace(SHELL_TEMPLATE, 'Progress Log', '\n[19:00] Did some work\n\n');
    fs.writeFileSync(hermit(dir, 'sessions', 'SHELL.md'), shell);
  }

  function withPinned<T>(dir: string, fn: () => T): T {
    const prevAgent = process.env.AGENT_DIR;
    const prevNow = process.env.HERMIT_NOW;
    process.env.AGENT_DIR = hermit(dir);
    process.env.HERMIT_NOW = NOW_ISO;
    try { return fn(); }
    finally {
      if (prevAgent === undefined) delete process.env.AGENT_DIR;
      else process.env.AGENT_DIR = prevAgent;
      if (prevNow === undefined) delete process.env.HERMIT_NOW;
      else process.env.HERMIT_NOW = prevNow;
    }
  }

  function captureStdout<T>(fn: () => T): { result: T; stdout: string } {
    let stdout = '';
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: any, encoding?: any, cb?: any) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      if (typeof encoding === 'function') encoding();
      else if (typeof cb === 'function') cb();
      return true;
    }) as typeof process.stdout.write;
    try { return { result: fn(), stdout }; }
    finally { process.stdout.write = orig; }
  }

  test('success archives to idle with marker, report, monitoring line, empty stdout', withTmp((dir) => {
    seedArchivable(dir);
    const { result, stdout } = withPinned(dir, () => captureStdout(() => runAutoIdle(hermit(dir), NOW_MS, UTC_CONFIG)));
    expect(result).toBe('archived');
    expect(stdout).toBe('');

    const marker = JSON.parse(fs.readFileSync(hermit(dir, 'state', 'auto-idle-attempt.json'), 'utf-8'));
    expect(marker.last_attempt_at).toBe(new Date(NOW_MS).toISOString());

    const reportPath = hermit(dir, 'sessions', 'S-001-REPORT.md');
    expect(fs.existsSync(reportPath)).toBe(true);
    const fm = readFrontmatter(reportPath);
    expect(fm.closed_via).toBe('auto');
    expect(fm.status).toBe('partial');

    const shell = fs.readFileSync(hermit(dir, 'sessions', 'SHELL.md'), 'utf-8');
    expect(shell).toContain('[22:00] Heartbeat: auto-idled (quiet ~3h).');

    const rt = JSON.parse(fs.readFileSync(hermit(dir, 'state', 'runtime.json'), 'utf-8'));
    expect(rt.session_state).toBe('idle');
    expect(typeof rt.closed_at).toBe('string');
    expect(Number.isNaN(new Date(rt.closed_at).getTime())).toBe(false);
  }));

  test('a second run after a successful archive skips instead of re-archiving', withTmp((dir) => {
    seedArchivable(dir);
    expect(withPinned(dir, () => runAutoIdle(hermit(dir), NOW_MS, UTC_CONFIG))).toBe('archived');
    const reports = () => fs.readdirSync(hermit(dir, 'sessions')).filter(f => f.endsWith('-REPORT.md'));
    const before = reports();
    expect(withPinned(dir, () => runAutoIdle(hermit(dir), NOW_MS, UTC_CONFIG))).toBe('skipped');
    expect(reports()).toEqual(before);
  }));

  test('failure stamps the marker, logs the failure line, leaves runtime not idle, empty stdout', withTmp((dir) => {
    seedArchivable(dir);
    fs.mkdirSync(hermit(dir, 'sessions', 'S-001-REPORT.md'));
    const { result, stdout } = withPinned(dir, () => captureStdout(() => runAutoIdle(hermit(dir), NOW_MS, UTC_CONFIG)));
    expect(result).toBe('failed');
    expect(stdout).toBe('');

    const marker = JSON.parse(fs.readFileSync(hermit(dir, 'state', 'auto-idle-attempt.json'), 'utf-8'));
    expect(marker.last_attempt_at).toBe(new Date(NOW_MS).toISOString());

    const shell = fs.readFileSync(hermit(dir, 'sessions', 'SHELL.md'), 'utf-8');
    expect(shell).toContain('Heartbeat: auto-idle failed:');

    const rt = JSON.parse(fs.readFileSync(hermit(dir, 'state', 'runtime.json'), 'utf-8'));
    expect(rt.session_state).not.toBe('idle');
  }));
});
