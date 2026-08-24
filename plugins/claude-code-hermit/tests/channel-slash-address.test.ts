import { describe, test, expect } from 'bun:test';

import { resolveSlashCommand } from '../scripts/lib/channel-slash-address';

describe('resolveSlashCommand — slash gating', () => {
  test('resolves an unsuffixed command with an empty rest', () => {
    expect(resolveSlashCommand('/pause', 'ourbot')).toEqual({ command: '/pause', rest: '' });
    expect(resolveSlashCommand('/resume', null)).toEqual({ command: '/resume', rest: '' });
  });

  test('lowercases the command head', () => {
    expect(resolveSlashCommand('/PAUSE', null)).toEqual({ command: '/pause', rest: '' });
  });

  test('rejects a body that is not a slash command', () => {
    // The whole point of the change: a bare control word must not resolve.
    expect(resolveSlashCommand('pause', 'ourbot')).toBeNull();
    expect(resolveSlashCommand('stop', 'ourbot')).toBeNull();
    expect(resolveSlashCommand('status', 'ourbot')).toBeNull();
    expect(resolveSlashCommand('snooze 2h', 'ourbot')).toBeNull();
    expect(resolveSlashCommand('please /pause the build', 'ourbot')).toBeNull();
    expect(resolveSlashCommand('', 'ourbot')).toBeNull();
  });

  test('trims surrounding whitespace before matching', () => {
    expect(resolveSlashCommand('  /pause  ', null)).toEqual({ command: '/pause', rest: '' });
  });
});

describe('resolveSlashCommand — rest is byte-for-byte', () => {
  test('preserves multiple spaces before an argument', () => {
    // pause-keyword's own grammar accepts `\s+` before a snooze duration; a
    // shared tokenizer that split on a single space would silently narrow it.
    expect(resolveSlashCommand('/snooze  2h', null)).toEqual({ command: '/snooze', rest: '  2h' });
  });

  test('preserves argument case', () => {
    expect(resolveSlashCommand('/model Opus[1m]', null)).toEqual({
      command: '/model', rest: ' Opus[1m]',
    });
  });

  test('preserves a tab separator', () => {
    expect(resolveSlashCommand('/snooze\t2h', null)).toEqual({ command: '/snooze', rest: '\t2h' });
  });
});

describe('resolveSlashCommand — @botname addressing', () => {
  test('accepts a suffix naming this bot', () => {
    expect(resolveSlashCommand('/pause@ourbot', 'ourbot')).toEqual({ command: '/pause', rest: '' });
  });

  test('matches the handle case-insensitively', () => {
    expect(resolveSlashCommand('/pause@OurBot', 'ourbot')).toEqual({ command: '/pause', rest: '' });
    expect(resolveSlashCommand('/pause@ourbot', 'OurBot')).toEqual({ command: '/pause', rest: '' });
  });

  test('the stored handle is bare — no leading @ — matching channel-bot-id.ts', () => {
    // channel-reply-reminder.ts prepends the '@' itself when matching mentions,
    // so the config value carries no '@'. Comparing against a stored '@handle'
    // would never match and every suffixed command would silently no-op.
    expect(resolveSlashCommand('/pause@ourbot', 'ourbot')).not.toBeNull();
  });

  test('tolerates a hand-set @handle in config', () => {
    expect(resolveSlashCommand('/pause@ourbot', '@ourbot')).toEqual({ command: '/pause', rest: '' });
  });

  test('rejects a suffix naming a different bot', () => {
    expect(resolveSlashCommand('/pause@otherbot', 'ourbot')).toBeNull();
    expect(resolveSlashCommand('/clear@otherbot', 'ourbot')).toBeNull();
  });

  test('rejects any suffix when the handle is unknown', () => {
    expect(resolveSlashCommand('/pause@ourbot', null)).toBeNull();
    expect(resolveSlashCommand('/pause@ourbot', '')).toBeNull();
  });

  test('rejects an empty suffix', () => {
    expect(resolveSlashCommand('/pause@', 'ourbot')).toBeNull();
    expect(resolveSlashCommand('/pause@', null)).toBeNull();
  });

  test('keeps the argument when the command is addressed', () => {
    expect(resolveSlashCommand('/snooze@ourbot 2h', 'ourbot')).toEqual({
      command: '/snooze', rest: ' 2h',
    });
  });

  test('an @ in the argument is not an address', () => {
    expect(resolveSlashCommand('/model opus@1m', 'ourbot')).toEqual({
      command: '/model', rest: ' opus@1m',
    });
  });
});
