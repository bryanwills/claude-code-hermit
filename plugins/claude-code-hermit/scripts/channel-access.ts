import fs from 'node:fs';
import path from 'node:path';
import { GROUP_ID_RE } from './channel-pair';
import { pinStateDirOrExit } from './lib/cc-compat';
import { channelStateDir } from './lib/channel-token';
import { auditConfigChange } from './lib/config-audit';
import { readConfigRaw } from './lib/config-read';
import { writeFileAtomic } from './lib/md-write';

interface GroupEntry {
  requireMention: boolean;
  allowFrom: string[];
}

interface Access {
  dmPolicy: string;
  groups?: Record<string, GroupEntry>;
  [key: string]: unknown;
}

export function mergeGroupEntry(access: Access, chatId: string, entry: GroupEntry): Access {
  return {
    ...access,
    groups: { ...access.groups, [chatId]: { ...entry, allowFrom: [...entry.allowFrom] } },
  };
}

function options(args: string[]): GroupEntry {
  let requireMention = true;
  let allowFrom: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error('invalid-options');
    seen.add(flag);
    if (flag === '--no-mention') requireMention = false;
    else if (flag === '--allow' && args[i + 1] !== undefined) allowFrom = args[++i].split(',');
    else throw new Error('invalid-options');
  }
  if (allowFrom.some(id => !GROUP_ID_RE.test(id))) throw new Error('invalid-id');
  return { requireMention, allowFrom };
}

function main(): void {
  const [argvDir, verb, channel, chatId, ...args] = process.argv.slice(2);
  if (!argvDir || !verb) throw new Error('usage');
  const dir = pinStateDirOrExit(argvDir, 'channel-access.ts');
  if (verb !== 'group-add') throw new Error('unknown-verb');
  if (channel !== 'discord' && channel !== 'telegram') throw new Error('unsupported-channel');
  if (!chatId || !GROUP_ID_RE.test(chatId)) throw new Error('invalid-id');
  const entry = options(args);
  const config = readConfigRaw(dir);
  if (config === null) throw new Error('no-config');
  if (config.permission_mode === 'bypassPermissions') throw new Error('needs-terminal');
  const file = path.join(channelStateDir(dir, channel, config.channels?.[channel]), 'access.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('no-access-file');
    throw error;
  }
  const access: Access = JSON.parse(raw);
  if (access.dmPolicy === 'disabled') throw new Error('policy-disabled');
  const next = mergeGroupEntry(access, chatId, entry);
  writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n', 0o600);
  // Treat the group policy as one audit leaf, including when replacing it.
  const dotted = `groups.${chatId}`;
  auditConfigChange(dir,
    { [dotted]: JSON.stringify(access.groups?.[chatId]) },
    { [dotted]: JSON.stringify(entry) },
    'channel-access', `${channel}/access.json`);
  console.log(`OK|${channel}:${chatId}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const token = error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : 'operation-failed';
    console.log(`ERROR|${token}`);
    process.exitCode = 1;
  }
}
