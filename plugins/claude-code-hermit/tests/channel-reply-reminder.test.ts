// Behavioral tests for scripts/lib/prompt-stages/channel-reply-reminder.ts —
// the stage that reminds the model which reply tool to use, and captures
// inbound messages into the episodic channel log. Driven through the single
// UserPromptSubmit process, scripts/user-prompt-pipeline.ts, as a subprocess
// (stdin in, stdout out) — the boundary Claude Code sees. Mirrors
// tests/pause-keyword.test.ts.
//
// tests/channel-responder-reply-rule.test.ts is a separate, static wiring
// check (skill text / hooks.json / script presence) — it does not run this
// script, so this file is the only behavioral coverage for it.
//
// Usage: bun test tests/channel-reply-reminder.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { unconsolidated } from '../scripts/lib/channel-log';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

function withDir(fn: (dir: string) => Promise<void> | void, config?: string) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    write(hermit(wd.dir, 'config.json'), config ?? '{"channels":{"discord":{"allowed_users":["U1"]}}}');
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

const ID_ALLOWLIST = '{"channels":{"discord":{"allowed_users":["123456789012345678"]}}}';

const run = (prompt: string, dir: string) =>
  runScript('user-prompt-pipeline.ts', { stdin: JSON.stringify({ prompt }), cwd: dir });

describe('channel-reply-reminder', () => {
  test('bare source — names the exact reply tool', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1">hi</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('mcp__plugin_discord_discord__reply');
    expect(r.stdout).toContain('`discord` channel');
  }));

  // #634 regression: the harness injects a plugin-qualified source
  // (`plugin:discord:discord`); REPLY_TOOLS must be looked up by the
  // normalized bare key, not the raw qualified one.
  test('plugin-qualified source — still names the exact reply tool', withDir(async (dir) => {
    const r = await run('<channel source="plugin:discord:discord" chat_id="1" user="U1">hi</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('mcp__plugin_discord_discord__reply');
    expect(r.stdout).toContain('`discord` channel');
  }));

  test('unrecognized custom channel plugin — generic fallback phrase, no crash', withDir(async (dir) => {
    const r = await run('<channel source="plugin:acme-crm:crm" chat_id="1" user="U1">hi</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("the channel's `reply` tool");
    expect(r.stdout).toContain('`crm` channel');
  }));

  test('plugin-qualified source — episodic capture logs the bare channel key', withDir(async (dir) => {
    const r = await run('<channel source="plugin:discord:discord" chat_id="1" user="U1">hello there</channel>', dir);
    expect(r.exitCode).toBe(0);
    const { rows } = unconsolidated(hermit(dir));
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe('discord');
    expect(rows[0].text).toBe('hello there');
  }));

  test('plugin-qualified source, sender not on the allowlist — reminder still fires, capture is skipped', withDir(async (dir) => {
    const r = await run('<channel source="plugin:discord:discord" chat_id="1" user="STRANGER">hello there</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('mcp__plugin_discord_discord__reply'); // reminder is not gated by allowlist
    const { rows } = unconsolidated(hermit(dir));
    expect(rows.length).toBe(0); // capture is gated by isAllowedSender
  }));

  // Discord puts the display name in `user` and the numeric id in `user_id`.
  // allowed_users holds ids (what every doc instructs), so matching `user`
  // rejected the operator on every inbound message and nothing was ever logged.
  test('id-based allowlist, real wire shape — captured, sender keeps the display name', withDir(async (dir) => {
    const r = await run(
      '<channel source="plugin:discord:discord" chat_id="1" user="display-name" user_id="123456789012345678">hello there</channel>',
      dir,
    );
    expect(r.exitCode).toBe(0);
    const { rows } = unconsolidated(hermit(dir));
    expect(rows.length).toBe(1);
    expect(rows[0].text).toBe('hello there');
    expect(rows[0].sender).toBe('display-name');
  }, ID_ALLOWLIST));

  test('display name mimicking an allowlisted id — not captured', withDir(async (dir) => {
    const r = await run(
      '<channel source="plugin:discord:discord" chat_id="1" user="123456789012345678" user_id="EVIL">hello there</channel>',
      dir,
    );
    expect(r.exitCode).toBe(0);
    const { rows } = unconsolidated(hermit(dir));
    expect(rows.length).toBe(0);
  }, ID_ALLOWLIST));
});
