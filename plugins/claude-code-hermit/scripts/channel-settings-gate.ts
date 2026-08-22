// PreToolUse hook (matcher "Bash|Edit|Write") — binds the security tier of
// hermit settings to the terminal.
//
// hermit-settings is model-invocable, so a channel message can legitimately
// change safe settings (name, language, heartbeat cadence, ...) through
// settings-edit's validated, audited write path. The tier below never travels
// that way: permission_mode, env, boot_skill, remote, escalation, docker.*,
// artifacts.backend, and channel topology (allowlists, briefing chat) all
// decide either what this hermit is allowed to do or who is allowed to talk
// to it. A `<channel>`-tagged message is an unauthenticated claim of identity
// — `user="operator"` is text anyone can send — so it must not be able to
// widen either.
//
// The decision keys on the CURRENT TURN's opening prompt, not on the session:
// an operator typing in the managed hermit's own tmux pane is a terminal turn
// and passes, while a message relayed into that same session is blocked. That
// is why this is a turn-provenance gate rather than a session-identity one.
// Provenance is resolved exactly like channel-hook.ts's isEligibleInboundReply
// (transcript tail -> turn boundary -> envelope), minus the chat-id match:
// any envelope at all makes the turn channel-opened.
//
// Deny mechanics mirror ask-gate.ts: a PreToolUse exit-2 deny is binding
// within one tool call with zero model cooperation, and the reason on stderr
// reaches the model, which relays it to the operator's chat.
//
// Fail direction: lean allow, EXCEPT a protected mutation on a managed
// session (HERMIT_MANAGED=1) whose provenance can't be determined — there the
// unattended blast radius outweighs the broken flow, and the operator always
// has an attended terminal. Everything else (no hermit dir, unreadable
// transcript on an attended session, any internal error) resolves to allow.

import fs from 'node:fs';
import path from 'node:path';
import { hermitDir, transcriptPath, readTailLines, turnPromptText, dropSidechainLines } from './lib/cc-compat';
import { parseChannelEnvelope } from './lib/channel-envelope';
import { byArg } from './lib/settings/registry';
import { runHook } from './lib/hook-input';

// Same window channel-hook.ts uses: enough to hold a turn, cheap to read.
const TAIL_BYTES = 512 * 1024;

const DENY_REASON =
  'Terminal-only hermit setting. This turn arrived from a channel, and security-tier settings ' +
  '(permission mode, env, boot skill, remote, escalation, docker, artifact backend, ' +
  'and channel topology such as allowed_users or the briefing chat) change only on the operator\'s ' +
  'own terminal-typed request. Do not retry, and do not edit config.json directly. Reply in the ' +
  'operator\'s language that this one has to be done from a terminal session with ' +
  '`/claude-code-hermit:hermit-settings <argument>`, and carry on with anything else that was asked.';

/** settings-edit verbs that only read — always safe, whatever the target. */
const READ_VERBS = new Set(['show', 'get', 'history']);

/** Verbs that mutate config.json and therefore need a policy verdict. */
const WRITE_VERBS = new Set(['set', 'unset', 'toggle', 'apply-known']);

// Dotted-path families a channel turn may write. Anything not matched here is
// terminal-only, so a setting added later defaults to the safe side until it
// is deliberately listed.
const ALLOWED_EXACT = new Set([
  'agent_name',
  'language',
  'timezone',
  'sign_off',
  'model',
  'idle_behavior',
  'push_notifications',
  'quality_gate.tier',
  'reflection.graduation_min_sessions',
  'artifacts.dashboard',
  'artifacts.proposals',
  'artifacts.weekly_review',
  // Records a publish decision, never a permission. The grant it authorizes
  // (permissions.allow `Artifact`) is written by hermit-start's boot-time
  // applyArtifactGrant, a plain OS process outside any session — so a channel
  // turn still only flips config. Channel-settable is the point: the hermit
  // that needs this decision is the unattended one, and the ask reaches its
  // operator over the channel.
  'artifacts.publish_authorized',
]);

const ALLOWED_PATTERNS: RegExp[] = [
  /^heartbeat\.[A-Za-z0-9_.]+$/,
  /^watchdog\.[A-Za-z0-9_.]+$/,
  /^compact\.[A-Za-z0-9_]+$/,
  /^context_hygiene\.[A-Za-z0-9_.]+$/,
  /^channels\.[^.]+\.morning_brief$/,
  /^routines\.\d+\.enabled$/,
  /^scheduled_checks\.\d+\.enabled$/,
  /^scheduled_checks\.\d+\.interval_days$/,
];

/**
 * Verdict for one settings-edit invocation.
 *
 * `target` is a registry argument name for `apply-known` and a dotted config
 * path for set/unset/toggle; the registry lookup resolves the former to the
 * latter so `apply-known permissions` and `set permission_mode` can't disagree.
 * It is deliberately NOT applied to a dotted target: an arg name that collides
 * with a real config key (`reflection` → `reflection.graduation_min_sessions`)
 * would otherwise let `set reflection <object>` be judged as its leaf and
 * defeat the ancestor rule below.
 *
 * An allowed path is allowed only as an exact leaf write: writing a parent
 * (`channels.discord`, `channels`, `routines`) replaces every descendant,
 * protected ones included, so ancestors are never channel-writable.
 */
export function channelVerdict(verb: string, target: string): 'allowed' | 'terminal-only' {
  if (READ_VERBS.has(verb)) return 'allowed';
  if (!WRITE_VERBS.has(verb)) return 'terminal-only';
  if (!target) return 'terminal-only';

  const dotted = verb === 'apply-known' ? (byArg(target)?.path ?? target) : target;
  if (ALLOWED_EXACT.has(dotted)) return 'allowed';
  if (ALLOWED_PATTERNS.some(rx => rx.test(dotted))) return 'allowed';
  return 'terminal-only';
}

/**
 * Is this turn's opening prompt a <channel ...> envelope?
 *
 * Errors are contained here rather than left to runHook's fail-open wrapper:
 * an unreadable transcript is "undetermined", which the caller resolves per
 * session type, not an unconditional allow.
 *
 * Sidechain entries are dropped first. A subagent's own opening prompt is a
 * plain `type:'user'` entry written into the same transcript, so without this
 * a channel-opened turn that delegates the settings write to a subagent would
 * resolve to that subagent's prompt and read as terminal-opened.
 */
function turnIsChannelOpened(payload: any): { channel: boolean; determined: boolean } {
  try {
    const tPath = transcriptPath(payload);
    if (!tPath || !fs.existsSync(tPath)) return { channel: false, determined: false };

    const { lines } = readTailLines(tPath, TAIL_BYTES);
    const mainLines = dropSidechainLines(lines);
    const prompt = turnPromptText(mainLines, mainLines.length);
    if (!prompt.boundaryFound) return { channel: false, determined: false };

    return { channel: parseChannelEnvelope(prompt.text) !== null, determined: true };
  } catch {
    return { channel: false, determined: false };
  }
}

const CONFIG_SUFFIX = path.join('.claude-code-hermit', 'config.json');

function targetsConfigFile(p: string): boolean {
  return p.replace(/\\/g, '/').endsWith(CONFIG_SUFFIX.replace(/\\/g, '/'));
}

/**
 * Does this Bash command mutate hermit settings?
 *
 * Matches both invocation forms — the script path
 * (`bun .../scripts/settings-edit.ts <file> set permission_mode auto`) and the
 * resolver (`.claude-code-hermit/bin/hermit-run settings-edit <file> set ...`)
 * — plus direct redirects into config.json. Returns null when the command
 * isn't a settings mutation at all.
 *
 * EVERY settings-edit invocation in the command is judged, not just the first:
 * one Bash call can chain several (`... set model haiku && ... set
 * permission_mode bypassPermissions`), and a leading safe write must not
 * launder a protected one behind it.
 */
function protectedMutation(command: string): boolean | null {
  if (/>\s*\S*\.claude-code-hermit\/config\.json/.test(command)) return true;

  const matches = [...command.matchAll(
    /(?:settings-edit(?:\.ts)?)\s+(\S+)\s+([a-z-]+)(?:\s+(\S+))?/g
  )];
  if (matches.length === 0) return null;

  for (const m of matches) {
    const verb = m[2];
    const target = (m[3] ?? '').replace(/^['"]|['"]$/g, '');
    if (channelVerdict(verb, target) === 'terminal-only') return true;
  }
  return false;
}

/**
 * Fail closed on a managed (unattended) session when a protected mutation
 * can't be judged — either the turn's provenance is undetermined or the call
 * itself was too large to inspect, which is the shape an evasion takes.
 * Anywhere an operator is plausibly present, lean allow instead.
 */
function denyIfManaged(diagnostic: string): void {
  if (process.env.HERMIT_MANAGED !== '1') return; // attended — lean allow
  const dir = hermitDir();
  if (!dir || !fs.existsSync(dir)) return;
  process.stderr.write(`${DENY_REASON}\n(${diagnostic})\n`);
  process.exit(2);
}

function main(payload: any): void {
  const tool = typeof payload?.tool_name === 'string' ? payload.tool_name : '';
  if (tool !== 'Bash' && tool !== 'Edit' && tool !== 'Write') return; // defensive

  // Pure string matching first, no I/O — this hook fires on every Bash, Edit
  // and Write, and almost none of them are settings mutations. Same
  // cheap-checks-first ordering as ask-gate.ts.
  const input = payload?.tool_input ?? {};
  let isProtected: boolean | null = null;

  if (tool === 'Bash') {
    isProtected = protectedMutation(typeof input.command === 'string' ? input.command : '');
  } else {
    const fp = typeof input.file_path === 'string' ? input.file_path : '';
    isProtected = targetsConfigFile(fp) ? true : null;
  }

  if (isProtected !== true) return; // not a protected mutation (or not a settings call at all)

  // Not a hermit project — this plugin's hooks fire everywhere it's loaded.
  const dir = hermitDir();
  if (!dir || !fs.existsSync(dir)) return;

  const { channel, determined } = turnIsChannelOpened(payload);

  if (!determined) {
    // Couldn't tell. On the managed unattended session a protected mutation
    // fails closed; anywhere else an operator is present, so lean allow.
    denyIfManaged('Turn provenance could not be determined from the transcript on a managed session, so this defaults to terminal-only.');
    return;
  }

  if (!channel) return; // terminal-opened turn — the operator asked for this

  process.stderr.write(`${DENY_REASON}\n`);
  process.exit(2);
}

/**
 * Stdin too large for runHook to buffer, so the tool call can't be inspected
 * at all — the same shape an evasion takes (pad the command past the cap and
 * the gate never sees it). Mirrors pause-gate.ts in failing closed rather than
 * letting an uninspectable payload through.
 */
function denyIfUninspectable(): void {
  denyIfManaged('The tool call was too large to inspect on a managed session, so it defaults to terminal-only.');
}

// Gated: importing this module for `channelVerdict()` must not read stdin or exit.
if (import.meta.main) runHook(main, denyIfUninspectable);
