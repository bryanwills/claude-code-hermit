// channel-pair.ts — issue the channel-plugin `access` commands into a hermit's
// REPL, on the host or inside its container.
//
// This replaces three prose copies of the same send-keys choreography in
// docker-setup/SKILL.md (the guided flow, the manual-deployment branch, and the
// group-add loop), each spelling out a two-call `send-keys` + `sleep 0.5` dance
// with the state-dir hint hand-substituted into the message. The split-with-a-
// pause exists because Claude Code's TUI reads text+Enter in one burst as a
// bracketed paste and turns the Enter into a literal newline; `lib/tmux.ts`
// owns that, and this script owns the message grammar.
//
// Usage:
//   channel-pair.ts pair <code>            --channel <slug> --session <name> [transport] [--state-dir <path>]
//   channel-pair.ts policy                 --channel <slug> --session <name> [transport]
//   channel-pair.ts group-add <id>         --channel <slug> --session <name> [transport] [--state-dir <path>] [--no-mention]
//
//   transport: --compose-file <file> --service <name>   (omit both for host tmux)
//
// Output: `OK|<the text that was delivered>` or `ERROR|<reason>`.
// Exit 0 on success, 1 on a validation failure or a tmux that refused the keys.
//
// `OK` means tmux accepted the keystrokes, NOT that the channel plugin acted on
// them — nothing here can observe the REPL's response. Callers verify by reading
// the resulting `access.json`, which is what docker-setup does.

import { sendKeys, tmuxSessionAlive, HOST, type Transport } from './lib/tmux';
import { flagValue } from './lib/cli';

// Validation is a grammar, not an allow-list of known channels: `hermit-start.ts`
// resolves `channels.<name>.marketplace` for third-party channel plugins (custom
// marketplaces, forks, operator-built channels), so pinning this to
// discord/telegram/imessage would close a seam the rest of the plugin keeps open.
const SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/;
const CODE_RE = /^[A-Za-z0-9]{6}$/;
const GROUP_ID_RE = /^-?\d{1,20}$/;
const SESSION_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// The state dir is interpolated into the message body, so it must not be able to
// introduce a newline (which would submit early) or quote characters. Spaces are
// allowed: the message travels as one argv element, never as shell text, and a
// project under `/Users/x/My Projects/…` must still be pairable.
const STATE_DIR_RE = /^[A-Za-z0-9_./ -]{1,256}$/;

function fail(reason: string): never {
  process.stdout.write(`ERROR|${reason}\n`);
  process.exit(1);
}

export function buildPairMessage(channel: string, code: string, stateDir?: string): string {
  const base = `/${channel}:access pair ${code}`;
  return stateDir ? `${base} — save access.json to ${stateDir} not ~/.claude` : base;
}

export function buildPolicyMessage(channel: string): string {
  return `/${channel}:access policy allowlist`;
}

export function buildGroupAddMessage(
  channel: string, groupId: string, noMention: boolean, stateDir?: string,
): string {
  const base = `/${channel}:access group add ${groupId}${noMention ? ' --no-mention' : ''}`;
  return stateDir ? `${base} — save access.json to ${stateDir} not ~/.claude` : base;
}

export function resolveTransport(argv: string[]): Transport {
  const composeFile = flagValue(argv, '--compose-file');
  const service = flagValue(argv, '--service');
  if (!composeFile && !service) return HOST;
  if (!composeFile || !service) fail('docker transport needs both --compose-file and --service');
  return { kind: 'docker', composeFile: composeFile!, service: service! };
}

function main(): void {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  const positional = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;

  const channel = flagValue(argv, '--channel');
  const session = flagValue(argv, '--session');
  const stateDir = flagValue(argv, '--state-dir');
  const noMention = argv.includes('--no-mention');

  if (!channel || !SLUG_RE.test(channel)) fail('--channel must be a lowercase plugin slug');
  if (!session || !SESSION_RE.test(session)) fail('--session must be a tmux session name');
  if (stateDir !== undefined && !STATE_DIR_RE.test(stateDir)) fail('--state-dir has characters that cannot go in a REPL message');

  const transport = resolveTransport(argv);

  let message: string;
  switch (verb) {
    case 'pair':
      if (!positional || !CODE_RE.test(positional)) fail('pair needs a 6-character alphanumeric code');
      message = buildPairMessage(channel!, positional!, stateDir);
      break;
    case 'policy':
      message = buildPolicyMessage(channel!);
      break;
    case 'group-add':
      if (!positional || !GROUP_ID_RE.test(positional)) fail('group-add needs a numeric channel/group id');
      message = buildGroupAddMessage(channel!, positional!, noMention, stateDir);
      break;
    default:
      fail(`unknown verb "${verb ?? ''}" — expected pair, policy, or group-add`);
  }

  // A missing session is the common real failure (the container is still
  // installing plugins, or the operator never accepted the trust prompt), and it
  // is worth naming rather than reporting as a generic send failure.
  if (!tmuxSessionAlive(session!, transport)) fail(`tmux session "${session}" not found`);

  if (!sendKeys(session!, message, transport)) fail('tmux refused the keystrokes');

  process.stdout.write(`OK|${message}\n`);
}

if (import.meta.main) main();
