// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// UserPromptSubmit hook — deterministic harness-command recorder.
//
// Native Claude Code slash commands that control the HARNESS (/model, /effort,
// /compact, /clear) are unreachable from a channel: inbound channel prompts are
// enqueued with `skipSlashCommands:true` (probe-verified, see
// compiled/spike-channel-block-responder-probe-2026-07-04.md), so the text arrives as
// literal prose and the model can only look for a matching *skill*, which never exists.
//
// Harness state cannot be written to a file the way pause.json can — it has to be typed
// into the pane. So this hook does the deterministic half (authorize + record) and the
// Stop hook does the delivery, once the turn it arrived on has ended and the pane is
// idle. Splitting it this way keeps the authorization model identical to pause-keyword.ts
// and never types into a pane mid-turn.
//
// Probe-verified limit (inherited from pause-keyword.ts): a UserPromptSubmit hook only
// fires BETWEEN turns. A command sent while a turn is genuinely in flight arrives as
// steering text and lands when that turn ends, not during it. Background work still
// counts as idle.
//
// Gated by isTrustedController — the same stricter-than-a-plain-reply gate pause uses,
// because these commands mutate session state. An unauthorized sender is a silent no-op:
// no marker, no stdout, so the mechanism can't be probed by an unauthorized prompt.

import { safeForLLM } from './lib/sanitize';
import { hermitDir } from './lib/cc-compat';
import { loadConfig, isTrustedController } from './lib/channel-auth';
import { parseChannelEnvelope } from './lib/channel-envelope';
import { readRuntimeJson } from './lib/runtime';
import { parseHarnessCommand, writePendingCommand, renderCommand } from './lib/harness-command';

type Json = any;

function main(raw: string): void {
  let payload: Json;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const prompt = payload && typeof payload.prompt === 'string' ? payload.prompt : null;
  if (!prompt) return;

  const env = parseChannelEnvelope(prompt);
  if (!env) return;
  if (!env.body) return;

  const parsed = parseHarnessCommand(env.body);
  if (!parsed) return;

  const dir = hermitDir();
  const config = loadConfig(dir);
  if (!isTrustedController(config, env.source, env.userId, env.chatId)) return; // unauthorized — silent no-op

  // Interactive sessions store tmux_session: null (hermit-start.ts), so there is no pane
  // to deliver into. Refuse HERE rather than recording a marker the drain could never
  // consume — otherwise the operator gets an acknowledgement for a command that silently
  // never happens.
  const runtime = readRuntimeJson();
  if (!runtime || runtime.runtime_mode === 'interactive' || !runtime.tmux_session) return;

  const by = safeForLLM((env.userId ?? env.source ?? 'channel').slice(0, 64));
  const ok = writePendingCommand(dir, {
    command: parsed.command,
    arg: parsed.arg,
    by,
    requested_at: new Date().toISOString(),
  });
  if (!ok) return;

  const rendered = renderCommand(parsed);
  process.stdout.write(
    `[harness-command] "${rendered}" requested by ${by} — will be applied to this session when the current turn ends.\n`,
  );
}

try {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buf += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    try { main(buf); } catch { /* fail-open */ }
    process.exit(0);
  });
} catch {
  process.exit(0);
}
