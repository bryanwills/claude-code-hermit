// Contract tests for scripts/permission-denied-notify.ts, the PermissionDenied
// hook that records maintainer-tier diagnostics on a managed unattended session.
// Exercised as a subprocess (stdin in, exit code + stub requests out), the same
// boundary Claude Code sees. This hook cannot block and never emits
// hookSpecificOutput.retry; every case exits 0.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { startHttpStub } from './helpers/http-stub';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);
// The technical assembly (tool + reason) lands maintainer-tier and routes by
// the general tiered-disclosure policy: maintainer chat when configured,
// primary chat on a `technical` profile without one, SHELL.md Findings on a
// `non-technical` profile or whenever no channel is reachable (setupWorkdir
// seeds a `## Findings` section).
const readFindings = (dir: string) => fs.readFileSync(hermit(dir, 'sessions', 'SHELL.md'), 'utf8');
const findingsLines = (dir: string) => readFindings(dir).match(/^- \[maintainer alert suppressed\].*$/gm) ?? [];

function setupChannelWorkdir(telegramExtra: object = {}, configExtra: object = {}): Workdir {
  const wd = setupWorkdir();
  const stateDir = path.join(wd.dir, '.claude.local', 'channels', 'telegram');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
  write(hermit(wd.dir, 'config.json'), JSON.stringify({
    always_on: true,
    ...configExtra,
    channels: {
      primary: 'telegram',
      telegram: { enabled: true, dm_channel_id: '12345', allowed_users: ['u1'], state_dir: '.claude.local/channels/telegram', ...telegramExtra },
    },
  }));
  return wd;
}

// A client-facing install: the technical leg must never reach the client chat.
const setupClientWorkdir = (telegramExtra: object = {}) =>
  setupChannelWorkdir(telegramExtra, { operator_profile: 'non-technical' });

// Age the dedup state so the next denial of the same tool opens a fresh window.
function expireDedupWindow(dir: string): void {
  const p = hermit(dir, 'state', 'permission-denied-alerts.json');
  const alerts = JSON.parse(fs.readFileSync(p, 'utf8'));
  const past = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  for (const k of Object.keys(alerts)) alerts[k].at = past;
  write(p, JSON.stringify(alerts));
}

// Mirrors Claude Code's PermissionDenied stdin payload. The fixed classifier
// reason is normally present, while synthetic and older payloads may omit it.
const DENIAL_PAYLOAD = {
  hook_event_name: 'PermissionDenied',
  permission_mode: 'auto',
  tool_name: 'Bash',
  tool_input: { command: 'bun scripts/apply-settings.ts .claude/settings.local.json artifact-allow' },
  reason: 'Blocked by classifier',
};

const run = (payload: object, dir: string, stubUrl: string, env: Record<string, string> = {}) =>
  runScript('permission-denied-notify.ts', {
    stdin: JSON.stringify(payload),
    cwd: dir,
    env: { HERMIT_MANAGED: '1', HERMIT_TELEGRAM_API_URL: stubUrl, ...env },
  });

describe('permission-denied-notify', () => {
  // The stock install: one technical operator, one chat, no maintainer chat.
  // This is the only tier the routing change moves, and it is the tier the
  // hook exists for — a client leg would be wrong here, silence equally so.
  test('technical profile without a maintainer chat reaches the primary chat', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].body.chat_id).toBe('12345');
      expect(stub.requests[0].body.text).toContain('Auto-mode denied: Bash');
      expect(stub.requests[0].body.text).toContain('Blocked by classifier');
      expect(stub.requests[0].body.text).not.toContain('apply-settings.ts');
      expect(findingsLines(wd.dir)).toHaveLength(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('non-technical profile without a maintainer chat stays fail-closed to Findings', async () => {
    const stub = startHttpStub();
    const wd = setupClientWorkdir();
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
      const findings = readFindings(wd.dir);
      expect(findings).toContain('Auto-mode denied: Bash');
      expect(findings).toContain('Blocked by classifier');
      expect(findings).not.toContain('apply-settings.ts');
      expect(findingsLines(wd.dir)).toHaveLength(1);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('configured maintainer receives one diagnostic and the client receives none', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].body.chat_id).toBe('99999');
      expect(stub.requests[0].body.text).toContain('Auto-mode denied: Bash');
      expect(stub.requests[0].body.text).toContain('Blocked by classifier');
      expect(stub.requests[0].body.text).not.toContain('apply-settings.ts');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('includes the classifier reason when the payload carries one', async () => {
    const stub = startHttpStub();
    const wd = setupClientWorkdir();
    try {
      const r = await run({ ...DENIAL_PAYLOAD, reason: '[Self-Modification] blocked' }, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(readFindings(wd.dir)).toContain('Self-Modification');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // A long reason must not eat the trailing "what to do about it" guidance.
  test('an overlong reason is capped before the tail', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run({ ...DENIAL_PAYLOAD, reason: 'x'.repeat(400) }, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].body.text).toContain('/hermit-settings');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('payload without reason still records exactly one diagnostic', async () => {
    const stub = startHttpStub();
    const wd = setupClientWorkdir();
    try {
      const r = await run({ ...DENIAL_PAYLOAD, reason: undefined }, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
      expect(readFindings(wd.dir)).toContain('Auto-mode denied: Bash');
      expect(findingsLines(wd.dir)).toHaveLength(1);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('credential-shaped tool input reaches neither HTTP bodies nor Findings', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const command = 'curl -H "Authorization: Bearer test-secret-token" https://example.invalid';
      const r = await run({ ...DENIAL_PAYLOAD, tool_input: { command } }, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests).toHaveLength(1);
      expect(JSON.stringify(stub.requests)).not.toContain('test-secret-token');
      expect(readFindings(wd.dir)).not.toContain('test-secret-token');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('stdout is always empty (never emits hookSpecificOutput)', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.stdout.trim()).toBe('');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('HERMIT_MANAGED absent — attended session, no request', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url, { HERMIT_MANAGED: '' });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('HERMIT_DENY_NOTIFY=off — escape hatch, no request', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url, { HERMIT_DENY_NOTIFY: 'off' });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('always_on: false — no request', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      write(hermit(wd.dir, 'config.json'), JSON.stringify({
        always_on: false,
        channels: { primary: 'telegram', telegram: { enabled: true, dm_channel_id: '12345', state_dir: '.claude.local/channels/telegram' } },
      }));
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // Channel reachability gates the POST, never the record. A terminal-managed
  // hermit with no channel at all, and one whose bot token just got revoked,
  // both still leave a trail — startup-context.ts injects the last Findings
  // lines at the next session boot, which is the only way either operator
  // learns this happened.
  test('no eligible channel — recorded to Findings, no request', async () => {
    const stub = startHttpStub();
    const wd = setupWorkdir();
    try {
      write(hermit(wd.dir, 'config.json'), JSON.stringify({ always_on: true, channels: {} }));
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
      expect(readFindings(wd.dir)).toContain('Auto-mode denied: Bash');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('channel likely down — recorded to Findings, no request into a dead channel', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      fs.mkdirSync(hermit(wd.dir, 'state'), { recursive: true });
      write(hermit(wd.dir, 'state', 'channel-health.json'), JSON.stringify({ telegram: { last_success_at: null, consecutive_failures: 3 } }));
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
      expect(readFindings(wd.dir)).toContain('Auto-mode denied: Bash');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // Maintainer-eligible but not client-eligible: `resolve()` returns null while
  // `resolveMaintainerTarget()` succeeds. Eligibility must follow the tier the
  // diagnostic actually targets, or this install gets nothing.
  test('maintainer configured with no proactive client target still sends', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999', dm_channel_id: undefined });
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].body.chat_id).toBe('99999');
      expect(stub.requests[0].body.text).toContain('Auto-mode denied: Bash');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // The motivating incident: four denials of the same tool in nine minutes. The
  // old tool+input key made those four separate keys, so the window collapsed
  // nothing and the operator got four messages.
  test('dedup: a burst of distinct commands on one tool sends once', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      for (const command of ['a', 'b', 'c', 'd']) {
        const r = await run({ ...DENIAL_PAYLOAD, tool_input: { command } }, wd.dir, stub.url);
        expect(r.exitCode).toBe(0);
      }
      expect(stub.requests).toHaveLength(1);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // What the burst cost the operator has to survive the collapse, or "one wall"
  // and "twelve walls" become the same message. It can only ride out on the
  // next window — a burst's size isn't known when the window opens.
  test('dedup: the next window reports how many denials were suppressed', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      for (const command of ['a', 'b', 'c', 'd']) {
        await run({ ...DENIAL_PAYLOAD, tool_input: { command } }, wd.dir, stub.url);
      }
      expect(stub.requests[0].body.text).not.toContain('more in the previous');
      expireDedupWindow(wd.dir);
      await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[1].body.text).toContain('(+3 more in the previous 30 min)');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('dedup: a different tool opens its own window', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      await run({ tool_name: 'Edit', tool_input: { file_path: '/tmp/x' }, reason: 'different' }, wd.dir, stub.url);
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[0].body.text).toContain('Auto-mode denied: Bash');
      expect(stub.requests[1].body.text).toContain('Auto-mode denied: Edit');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // Long MCP tool names share the `mcp__<server>__` prefix, so a plain
  // truncation would collapse two distinct tools into one dedup window.
  test('dedup: two long tool names sharing a prefix do not share a window', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const prefix = `mcp__${'server'.repeat(9)}__`;
      await run({ ...DENIAL_PAYLOAD, tool_name: `${prefix}read` }, wd.dir, stub.url);
      await run({ ...DENIAL_PAYLOAD, tool_name: `${prefix}write` }, wd.dir, stub.url);
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[0].body.text).not.toBe(stub.requests[1].body.text);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('malformed stdin — exit 0, no request', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runScript('permission-denied-notify.ts', {
        stdin: '{broken',
        cwd: wd.dir,
        env: { HERMIT_MANAGED: '1', HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('empty stdin — exit 0, no request', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runScript('permission-denied-notify.ts', {
        stdin: '',
        cwd: wd.dir,
        env: { HERMIT_MANAGED: '1', HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('missing config.json — fail-open, no request, exit 0', async () => {
    const stub = startHttpStub();
    const wd = setupWorkdir();
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });
});
