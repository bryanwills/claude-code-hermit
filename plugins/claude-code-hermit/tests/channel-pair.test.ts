// channel-pair.ts + the lib/tmux docker transport.
//
// The argv assertions are the real coverage here: a host-tmux probe exercises
// Claude Code's bracketed-paste behavior but says nothing about whether the
// docker adapter builds the right command, so both adapters are checked against
// a fake `docker`/`tmux` on PATH that records what it was called with.

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { tmuxArgv, HOST } from '../scripts/lib/tmux';
import { buildPairMessage, buildPolicyMessage, buildGroupAddMessage } from '../scripts/channel-pair';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-chanpair-');
afterAll(cleanup);

/** A PATH containing fake `tmux` and `docker` that log their argv and succeed. */
function fakeBinDir(opts: { tmuxExit?: number; dockerExit?: number } = {}): { bin: string; log: string } {
  const bin = freshDir();
  const log = path.join(bin, 'calls.log');
  for (const [name, code] of [['tmux', opts.tmuxExit ?? 0], ['docker', opts.dockerExit ?? 0]] as const) {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/sh\nprintf '%s' "${name}" >> "${log}"\nfor a in "$@"; do printf ' %s' "$a" >> "${log}"; done\nprintf '\\n' >> "${log}"\nexit ${code}\n`);
    fs.chmodSync(p, 0o755);
  }
  return { bin, log };
}

describe('tmuxArgv', () => {
  test('host transport calls tmux directly', () => {
    expect(tmuxArgv(HOST, ['has-session', '-t', 'hermit-x'])).toEqual({
      cmd: 'tmux', argv: ['has-session', '-t', 'hermit-x'],
    });
  });

  test('docker transport prefixes compose exec -T and keeps the tmux argv intact', () => {
    const t = { kind: 'docker' as const, composeFile: 'docker-compose.hermit.yml', service: 'hermit' };
    expect(tmuxArgv(t, ['send-keys', '-t', 'hermit-x', '-l', '--', 'hello'])).toEqual({
      cmd: 'docker',
      argv: ['compose', '-f', 'docker-compose.hermit.yml', 'exec', '-T', 'hermit',
             'tmux', 'send-keys', '-t', 'hermit-x', '-l', '--', 'hello'],
    });
  });

  test('argv is an array, so a message is never re-parsed as shell syntax', () => {
    const { argv } = tmuxArgv(HOST, ['send-keys', '-t', 's', '-l', '--', 'a; rm -rf /; echo $(x)']);
    expect(argv[argv.length - 1]).toBe('a; rm -rf /; echo $(x)');
  });
});

describe('message grammar', () => {
  test('pair carries the state-dir hint when given one', () => {
    expect(buildPairMessage('discord', 'AB12CD', '/p/.claude.local/channels/discord'))
      .toBe('/discord:access pair AB12CD — save access.json to /p/.claude.local/channels/discord not ~/.claude');
  });

  test('pair omits the hint when no state dir is supplied', () => {
    expect(buildPairMessage('telegram', 'AB12CD')).toBe('/telegram:access pair AB12CD');
  });

  test('policy is the allowlist form the skill used to type by hand', () => {
    expect(buildPolicyMessage('discord')).toBe('/discord:access policy allowlist');
  });

  test('group-add places --no-mention before the state-dir hint', () => {
    expect(buildGroupAddMessage('discord', '-1001234567890', true, '/p/dir'))
      .toBe('/discord:access group add -1001234567890 --no-mention — save access.json to /p/dir not ~/.claude');
  });

  test('group-add without --no-mention keeps mention required', () => {
    expect(buildGroupAddMessage('discord', '123', false)).toBe('/discord:access group add 123');
  });
});

describe('CLI validation', () => {
  const base = ['--channel', 'discord', '--session', 'hermit-p'];

  const bad: Array<[string, string[]]> = [
    ['a 5-char code', ['pair', 'AB12C', ...base]],
    ['a code with punctuation', ['pair', 'AB-2CD', ...base]],
    ['a non-numeric group id', ['group-add', 'abc', ...base]],
    ['an unknown verb', ['wat', ...base]],
    ['a channel slug with a slash', ['policy', '--channel', 'a/b', '--session', 'hermit-p']],
    ['an uppercase channel slug', ['policy', '--channel', 'Discord', '--session', 'hermit-p']],
    ['a session name with a space', ['policy', '--channel', 'discord', '--session', 'a b']],
    ['a state dir with a newline', ['pair', 'AB12CD', ...base, '--state-dir', 'a\nb']],
    ['a docker transport missing --service', ['policy', ...base, '--compose-file', 'x.yml']],
  ];

  for (const [label, args] of bad) {
    test(`rejects ${label}`, async () => {
      const r = await runScript('channel-pair.ts', { args });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('ERROR|');
    });
  }

  test('accepts a custom marketplace plugin slug, not just the built-in channels', async () => {
    // hermit-start.ts resolves channels.<name>.marketplace for third-party channel
    // plugins; a fixed known-set here would close that seam.
    const { bin } = fakeBinDir();
    const r = await runScript('channel-pair.ts', {
      args: ['policy', '--channel', 'my-own-channel', '--session', 'hermit-p'],
      env: { PATH: bin },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('/my-own-channel:access policy allowlist');
  });
});

describe('delivery', () => {
  test('host transport: has-session, then text, then Enter', async () => {
    const { bin, log } = fakeBinDir();
    const r = await runScript('channel-pair.ts', {
      args: ['pair', 'AB12CD', '--channel', 'discord', '--session', 'hermit-p'],
      env: { PATH: bin },
    });
    expect(r.exitCode).toBe(0);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(calls[0]).toBe('tmux has-session -t hermit-p');
    expect(calls[1]).toBe('tmux send-keys -t hermit-p -l -- /discord:access pair AB12CD');
    expect(calls[2]).toBe('tmux send-keys -t hermit-p Enter');
  });

  test('docker transport: every call goes through compose exec -T', async () => {
    const { bin, log } = fakeBinDir();
    const r = await runScript('channel-pair.ts', {
      args: ['group-add', '-100123', '--channel', 'telegram', '--session', 'hermit-p',
             '--compose-file', 'docker-compose.hermit.yml', '--service', 'hermit', '--no-mention'],
      env: { PATH: bin },
    });
    expect(r.exitCode).toBe(0);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.startsWith('docker compose -f docker-compose.hermit.yml exec -T hermit tmux')).toBe(true);
    }
    expect(calls[1]).toContain('/telegram:access group add -100123 --no-mention');
  });

  test('a missing tmux session is named, not reported as a generic send failure', async () => {
    const { bin } = fakeBinDir({ tmuxExit: 1 });
    const r = await runScript('channel-pair.ts', {
      args: ['policy', '--channel', 'discord', '--session', 'hermit-gone'],
      env: { PATH: bin },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('not found');
  });

  test('OK reports what was delivered, so the caller can verify it landed', async () => {
    const { bin } = fakeBinDir();
    const r = await runScript('channel-pair.ts', {
      args: ['pair', 'AB12CD', '--channel', 'discord', '--session', 'hermit-p', '--state-dir', '/p/chan'],
      env: { PATH: bin },
    });
    expect(r.stdout.trim()).toBe('OK|/discord:access pair AB12CD — save access.json to /p/chan not ~/.claude');
  });
});
