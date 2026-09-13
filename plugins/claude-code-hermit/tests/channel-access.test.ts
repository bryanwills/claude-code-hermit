import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { mergeGroupEntry } from '../scripts/channel-access';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-channel-access-');
afterAll(cleanup);

const entry = { requireMention: true, allowFrom: [] };
const access = {
  dmPolicy: 'allowlist', allowFrom: ['1'], pending: { code: '2' },
  mentionPatterns: ['hello'], unknown: { keep: true },
  groups: { '123': entry, '456': entry },
};

test('mergeGroupEntry creates a group without mutating its inputs', () => {
  const original = { dmPolicy: 'pairing' };
  const result = mergeGroupEntry(original, '123', entry);
  expect(result).toEqual({ ...original, groups: { '123': entry } });
  result.groups!['123'].allowFrom.push('7');
  expect(original).toEqual({ dmPolicy: 'pairing' });
  expect(entry.allowFrom).toEqual([]);
});

test('mergeGroupEntry replaces an entry and preserves siblings and other groups', () => {
  const replacement = { requireMention: false, allowFrom: ['9'] };
  expect(mergeGroupEntry(access, '123', replacement)).toEqual({
    ...access, groups: { '123': replacement, '456': entry },
  });
  expect(access.groups['123']).toEqual(entry);
});

function fixture(permissionMode = 'default', policy = 'allowlist', createAccess = true) {
  const dir = freshDir();
  const channelDir = path.join(dir, 'channel');
  fs.mkdirSync(channelDir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    permission_mode: permissionMode,
    channels: { discord: { state_dir: channelDir }, telegram: { state_dir: channelDir } },
  }));
  const file = path.join(channelDir, 'access.json');
  if (createAccess) fs.writeFileSync(file, JSON.stringify({ ...access, dmPolicy: policy }), { mode: 0o644 });
  return { dir, file };
}

function rows(dir: string): any[] {
  const file = path.join(dir, 'state/settings-audit.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

for (const channel of ['discord', 'telegram']) {
  test(`CLI writes ${channel} group policy with private mode and one audit row`, async () => {
    const { dir, file } = fixture();
    const result = await runScript('channel-access.ts', {
      args: [dir, 'group-add', channel, '-123', '--no-mention', '--allow', '1,-2'],
      env: { AGENT_DIR: dir, DISCORD_STATE_DIR: '', TELEGRAM_STATE_DIR: '' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`OK|${channel}:-123\n`);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      ...access, groups: { ...access.groups, '-123': { requireMention: false, allowFrom: ['1', '-2'] } },
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(rows(dir)).toHaveLength(1);
    expect(rows(dir)[0]).toMatchObject({ actor: 'channel-access', path: 'groups.-123', target: `${channel}/access.json` });
  });
}

const failures = [
  { token: 'unsupported-channel', args: ['slack', '123'] },
  { token: 'invalid-id', args: ['discord', 'abc'] },
  { token: 'invalid-id', args: ['discord', '123', '--allow', '1,bad'] },
  { token: 'needs-terminal', args: ['discord', '123'], mode: 'bypassPermissions' },
  { token: 'no-access-file', args: ['discord', '123'], missing: true },
  { token: 'policy-disabled', args: ['discord', '123'], policy: 'disabled' },
  { token: 'no-config', args: ['discord', '123'], noConfig: true },
];
for (const outcome of failures) {
  test(`CLI refuses ${outcome.token}: ${outcome.args.join(' ')}`, async () => {
    const { dir, file } = fixture(outcome.mode, outcome.policy, !outcome.missing);
    if (outcome.noConfig) fs.unlinkSync(path.join(dir, 'config.json'));
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const result = await runScript('channel-access.ts', {
      args: [dir, 'group-add', ...outcome.args],
      env: { AGENT_DIR: dir, DISCORD_STATE_DIR: '', TELEGRAM_STATE_DIR: '' },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(`ERROR|${outcome.token}\n`);
    expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null).toBe(before);
    expect(rows(dir)).toEqual([]);
  });
}
