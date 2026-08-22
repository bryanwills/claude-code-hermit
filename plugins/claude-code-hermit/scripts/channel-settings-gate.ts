// PreToolUse hook (matcher "Bash|Edit|Write") — tiers the security-relevant
// hermit settings by where the request came from.
//
// hermit-settings is model-invocable, so a channel message can legitimately
// change safe settings (name, language, heartbeat cadence, ...) through
// settings-edit's validated, audited write path. The rest is tiered, because a
// `<channel>`-tagged message is an unauthenticated claim of identity —
// `user="operator"` is text anyone can send:
//
//   allowed        the operator's own chat (isTrustedController — the same
//                  anchor pause/resume/status use). Reads are open wider: any
//                  chat that may reach the hermit can `show`/`get`/`history`.
//   maintainer     the settings chat, allowlist-checked (isSettingsController):
//                  the configured maintainer chat, or the home chat itself on
//                  an operator-run install that never configured one
//                  (boot_skill, remote, escalation, docker.*,
//                  artifacts.backend, and everything not named below)
//   nonce          settings chat AND an echoed token: permission_mode, env.*,
//                  monitors (each entry carries a shell command)
//   terminal-only  the enrollment root, the two authority keys, and any
//                  ancestor write that would replace them — never reachable
//                  from a channel, on any tier
//
// The maintainer tier exists because the hermit that most needs these decisions
// is the unattended one, and its operator is reachable on a channel, not at a
// shell. Its anchor is a platform-supplied chat id (lib/channel-auth.ts
// isSettingsController), not message text. `maintainer_channel_id` alone was
// too narrow an anchor to carry it: that field is outbound routing for
// client-facing installs, so the ordinary operator-run hermit never sets one
// and the whole tier was unreachable exactly where it was meant to be used.
// The fallback is gated on `operator_profile` — on a client-facing install the
// home chat belongs to the client, so only a `technical` install extends it.
//
// The enrollment root (allowed_users, default_chat_id, dm_channel_id,
// maintainer_channel_id) is the deliberate hole in that: a settings chat that
// could add an allowed user or re-point itself would turn one compromise into
// a permanent, self-extending one, instead of something an operator with
// terminal access can revoke. `operator_profile` and `settings_from_chat` join
// it for the same reason — both decide who holds the tier, so a chat that could
// write them could grant itself authority or re-arm an opt-out the operator set.
//
// `settings_from_chat: false` is that opt-out: it collapses everything above
// the safe tier to terminal-only on every chat, the configured maintainer one
// included. Absent or true, the tiers above apply.
//
// The decision keys on the CURRENT TURN's opening prompt, not on the session:
// an operator typing in the managed hermit's own tmux pane is a terminal turn
// and passes, while a message relayed into that same session is tiered. That
// is why this is a turn-provenance gate rather than a session-identity one.
// Provenance is resolved exactly like channel-hook.ts's isEligibleInboundReply
// (transcript tail -> turn boundary -> envelope), and now keeps the parsed
// envelope so the chat id can be matched rather than discarded.
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
import { parseChannelEnvelope, type ChannelEnvelope } from './lib/channel-envelope';
import { isSettingsController, isTrustedController } from './lib/channel-auth';
import { readConfigRaw } from './lib/config-read';
import { byArg } from './lib/settings/registry';
import { runHook } from './lib/hook-input';
import { readPending, writePending, clearPending, newToken, bodyEchoesToken } from './lib/settings-confirm';

// Same window channel-hook.ts uses: enough to hold a turn, cheap to read.
const TAIL_BYTES = 512 * 1024;

const DENY_TERMINAL_ONLY =
  'Terminal-only hermit setting. Channel enrollment (allowed_users, default_chat_id, ' +
  'dm_channel_id, maintainer_channel_id) decides who is allowed to talk to this hermit, so it ' +
  'changes only on the operator\'s own terminal-typed request — the maintainer chat cannot grant ' +
  'itself more reach. Writing a parent object counts, and so does editing config.json directly. ' +
  'Do not retry. Reply in the operator\'s language that this one has to be done from a terminal ' +
  'session with `/claude-code-hermit:hermit-settings <argument>`, and carry on with anything else ' +
  'that was asked.';

const DENY_NEEDS_MAINTAINER =
  'Security-tier hermit setting. Settings like permission mode, boot skill, remote, escalation, ' +
  'docker and the artifact backend change only from the chat that holds settings authority — the ' +
  'configured maintainer chat, or the hermit\'s own home chat when none is configured and the ' +
  'install is operator-run — or from the operator\'s terminal. This turn arrived from neither. Do ' +
  'not retry, and do not edit config.json directly. Reply in the operator\'s language explaining ' +
  'where this has to be asked from, and carry on with anything else that was asked.';

const DENY_NEEDS_TRUSTED =
  'Hermit setting. This turn arrived from a chat that is not the operator\'s own, and settings ' +
  'change only from there or from a terminal — the same rule that governs pause, resume and ' +
  'status. Reading a setting is still fine from any chat. Do not retry, and do not edit ' +
  'config.json directly. Reply in the operator\'s language saying the change has to come from ' +
  'their own chat with the hermit, and carry on with anything else that was asked.';

const DENY_SETTINGS_FROM_CHAT_OFF =
  'Settings changes from chat are switched off for this hermit (`settings_from_chat` is false), so ' +
  'anything beyond the everyday settings changes only from a terminal session — from every chat, ' +
  'including the maintainer one. Do not retry, and do not edit config.json directly. Reply in the ' +
  'operator\'s language that this hermit is set to terminal-only for settings of this kind, name ' +
  '`/claude-code-hermit:hermit-settings <argument>` as the terminal command, and carry on with ' +
  'anything else that was asked.';

function denyNeedsNonce(target: string, token: string): string {
  return (
    `Second factor required for \`${target}\`. This setting reaches what the session may execute, ` +
    'so the maintainer chat alone does not authorize it. Send exactly this confirmation code to ' +
    `the maintainer chat now — \`.claude-code-hermit/bin/hermit-run channel-send ` +
    `.claude-code-hermit --notice\` with {"maintainer": "...${token}..."} on stdin — then stop and ` +
    'wait. Do not retry the setting in this turn: it applies only after the operator echoes the ' +
    `code back in a maintainer-chat message. The code expires in 10 minutes.`
  );
}

/** settings-edit verbs that only read — always safe, whatever the target. */
const READ_VERBS = new Set(['show', 'get', 'history']);

/** Verbs that mutate config.json and therefore need a policy verdict. */
const WRITE_VERBS = new Set(['set', 'unset', 'toggle', 'apply-known']);

/** Write verbs that take a value after the target — see settings-edit.ts's dispatch. */
const TAKES_VALUE = new Set(['set', 'apply-known']);

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
 * The enrollment root: who may talk to this hermit, and which chat holds the
 * maintainer tier. Terminal-only on every turn, maintainer chat included —
 * these four keys are what the maintainer tier is *anchored on*, so letting
 * that chat write them would make a single compromise self-extending and
 * unrevokable. Everything else in the security tier is recoverable by an
 * operator who can still reach a terminal; this is the part that would not be.
 *
 * Matches the leaf AND anything beneath it. `settings-edit`'s setPath treats a
 * dotted path as a plain traversal and arrays are objects, so
 * `channels.discord.allowed_users.0` writes one allowlist entry — an
 * exact-leaf-only match would let that land on `maintainer` and hand the
 * maintainer chat the self-extending compromise this tier exists to block.
 * Indexed paths are a real spelling here, not a hypothetical: ALLOWED_PATTERNS
 * above depends on them for `routines.<n>.enabled`.
 */
const ENROLLMENT_ROOT = /^channels\.[^.]+\.(allowed_users|default_chat_id|dm_channel_id|maintainer_channel_id)(\..+)?$/;

/**
 * `channels` and `channels.<platform>` — writing either replaces the enrollment
 * root wholesale, so the ancestor rule has to hold at every tier, not just for
 * a channel turn. (Ancestors of merely maintainer-tier keys are maintainer-tier
 * themselves: nothing protected hides beneath them.)
 */
const ENROLLMENT_ANCESTOR = /^channels(\.[^.]+)?$/;

/**
 * The two keys that decide who holds settings authority at all, rather than
 * what one may change. `operator_profile` gates the home-chat fallback
 * (lib/channel-auth.ts isSettingsController) and `settings_from_chat` switches
 * every tier above `allowed` off — so a chat able to write either could grant
 * itself the tier or re-arm an opt-out the operator deliberately set. Same
 * unrevocability argument as the enrollment root, so the same answer.
 */
const AUTHORITY_KEYS = /^(operator_profile|settings_from_chat)(\..+)?$/;

/**
 * Execution-adjacent: `permission_mode` can be flipped to bypassPermissions,
 * `env` is a free-form dict that reaches the session's environment, and every
 * `monitors[]` entry carries a `command` string the `watch` skill registers as
 * a Monitor subprocess at session start (validate-config.ts requires it) — a
 * config-declared shell command is at least as execution-adjacent as either of
 * the other two, so it cannot sit a tier below them. All three stay behind the
 * confirmation nonce even from the maintainer chat — see lib/settings-confirm.ts
 * for what that second factor is worth. Each matches as both the whole
 * container and any leaf, because replacing the container is the broader write.
 */
const NONCE_REQUIRED = /^(permission_mode|env|monitors)(\..+)?$/;

/** Increasing strictness — a chained command takes the strongest verdict. */
export type Verdict = 'allowed' | 'maintainer' | 'nonce' | 'terminal-only';
const STRICTNESS: Record<Verdict, number> = { allowed: 0, maintainer: 1, nonce: 2, 'terminal-only': 3 };

/**
 * `apply-known`'s registry arg name resolved to its dotted config path; every
 * other verb's target is already dotted and passes through. One helper so the
 * verdict and the nonce's target binding can't resolve it differently — a token
 * bound to `permissions` would never match a retry spelled `permission_mode`,
 * and the operator would be asked to confirm the same change twice forever.
 */
function resolveTarget(verb: string, target: string): string {
  return verb === 'apply-known' ? (byArg(target)?.path ?? target) : target;
}

/**
 * Verdict for one settings-edit invocation.
 *
 * `target` is a registry argument name for `apply-known` and a dotted config
 * path for set/unset/toggle; the registry lookup resolves the former to the
 * latter so `apply-known permissions` and `set permission_mode` can't disagree.
 * It is deliberately NOT applied to a dotted target: an arg name that collides
 * with a real config key (`reflection` → `reflection.graduation_min_sessions`)
 * would otherwise let `set reflection <object>` be judged as its leaf and
 * defeat the ancestor rule.
 *
 * An `allowed` path is allowed only as an exact leaf write; a parent write
 * falls through to the tier of whatever it would replace. Unknown and
 * future keys land on `maintainer` — the operator's own chat, allowlist-checked
 * and audited — rather than on the terminal, so adding a setting doesn't
 * silently lock the unattended operator out of it. Only the enrollment root and
 * the two authority keys are enumerated as unreachable, because only they are
 * unrecoverable.
 *
 * The verdict is a tier, not an answer: `allowed` still requires the trusted
 * chat for a write (main() applies that), and every tier above it is void when
 * `settings_from_chat` is false.
 */
export function channelVerdict(verb: string, target: string): Verdict {
  if (READ_VERBS.has(verb)) return 'allowed';
  if (!WRITE_VERBS.has(verb)) return 'terminal-only';
  if (!target) return 'terminal-only';

  const dotted = resolveTarget(verb, target);
  if (ALLOWED_EXACT.has(dotted)) return 'allowed';
  if (ALLOWED_PATTERNS.some(rx => rx.test(dotted))) return 'allowed';
  if (ENROLLMENT_ROOT.test(dotted) || ENROLLMENT_ANCESTOR.test(dotted)) return 'terminal-only';
  if (AUTHORITY_KEYS.test(dotted)) return 'terminal-only';
  if (NONCE_REQUIRED.test(dotted)) return 'nonce';
  return 'maintainer';
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
function turnEnvelope(payload: any): { envelope: ChannelEnvelope | null; determined: boolean } {
  try {
    const tPath = transcriptPath(payload);
    if (!tPath || !fs.existsSync(tPath)) return { envelope: null, determined: false };

    const { lines } = readTailLines(tPath, TAIL_BYTES);
    const mainLines = dropSidechainLines(lines);
    const prompt = turnPromptText(mainLines, mainLines.length);
    if (!prompt.boundaryFound) return { envelope: null, determined: false };

    // Attributes come from the opening tag only (parseChannelEnvelope is
    // start-anchored and truncates the body at the first `</channel>`), so a
    // second `<channel chat_id="...">` pasted into a message body is inert and
    // cannot shift which chat this turn appears to come from.
    return { envelope: parseChannelEnvelope(prompt.text), determined: true };
  } catch {
    return { envelope: null, determined: false };
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
function protectedMutation(command: string): { verdict: Verdict; target: string } | null {
  // An opaque write of the whole file can replace the enrollment root, so it
  // takes the strictest tier regardless of what it happens to contain.
  if (/>\s*\S*\.claude-code-hermit\/config\.json/.test(command)) {
    return { verdict: 'terminal-only', target: 'config.json' };
  }

  const matches = [...command.matchAll(
    /(?:settings-edit(?:\.ts)?)\s+(\S+)\s+([a-z-]+)(?:\s+(\S+))?(?:\s+(\S+))?/g
  )];
  if (matches.length === 0) return null;

  // Every distinct target tied at the worst tier survives into `target`, not
  // just the first. At the nonce tier this string is what the confirmation
  // token binds to, and one command can carry two nonce-tier writes
  // (`set permission_mode ... && set env ...`) — binding to only the first
  // would let the operator's confirmation of that one wave the other through
  // unnamed and unconfirmed.
  //
  // The VALUE is part of the binding, not just the key: the deny reason is what
  // the operator sees before echoing the code, so a token issued for
  // `permission_mode=default` must not also apply `permission_mode=bypassPermissions`.
  // Targets are sorted so a reordered retry of the same pair matches the
  // outstanding token instead of superseding it.
  const strip = (s: string | undefined) => (s ?? '').replace(/^['"]|['"]$/g, '');

  let worst: Verdict = 'allowed';
  let targets: string[] = [];
  let sawWrite = false;
  for (const m of matches) {
    const verb = m[2];
    // Reads are open on every tier and to every chat that may reach the hermit,
    // so they contribute neither a verdict nor a label. A command that is only
    // reads returns null below and never reaches an authority check at all.
    if (READ_VERBS.has(verb)) continue;
    sawWrite = true;
    const t = strip(m[3]);
    // `unset` and `toggle` take a path and nothing else, so the token after
    // theirs belongs to the shell (a `&&`, a redirect), not to the setting.
    const value = TAKES_VALUE.has(verb) ? strip(m[4]) : '';
    const v = channelVerdict(verb, t);
    const label = value ? `${resolveTarget(verb, t)}=${value}` : resolveTarget(verb, t);
    if (STRICTNESS[v] > STRICTNESS[worst]) {
      worst = v;
      targets = [label];
    } else if (v === worst && !targets.includes(label)) {
      targets.push(label);
    }
  }
  // Safe-tier writes are returned too, not swallowed: `allowed` means "any
  // setting", never "any sender", and main() still binds them to the operator's
  // own chat. Only a command with no write at all is none of the gate's
  // business.
  if (!sawWrite) return null;
  return { verdict: worst, target: targets.sort().join(', ') };
}

/**
 * Fail closed on a managed (unattended) session when a protected mutation
 * can't be judged — either the turn's provenance is undetermined or the call
 * itself was too large to inspect, which is the shape an evasion takes.
 * Anywhere an operator is plausibly present, lean allow instead.
 */
function deny(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function denyIfManaged(diagnostic: string): void {
  if (process.env.HERMIT_MANAGED !== '1') return; // attended — lean allow
  const dir = hermitDir();
  if (!dir || !fs.existsSync(dir)) return;
  deny(`${DENY_TERMINAL_ONLY}\n(${diagnostic})`);
}

function main(payload: any): void {
  const tool = typeof payload?.tool_name === 'string' ? payload.tool_name : '';
  if (tool !== 'Bash' && tool !== 'Edit' && tool !== 'Write') return; // defensive

  // Pure string matching first, no I/O — this hook fires on every Bash, Edit
  // and Write, and almost none of them are settings mutations. Same
  // cheap-checks-first ordering as ask-gate.ts.
  const input = payload?.tool_input ?? {};
  let mutation: { verdict: Verdict; target: string } | null = null;

  if (tool === 'Bash') {
    mutation = protectedMutation(typeof input.command === 'string' ? input.command : '');
  } else {
    const fp = typeof input.file_path === 'string' ? input.file_path : '';
    // Edit/Write of config.json is opaque here — it can rewrite the enrollment
    // root, so it takes the strictest tier.
    mutation = targetsConfigFile(fp) ? { verdict: 'terminal-only', target: 'config.json' } : null;
  }

  if (!mutation) return; // not a protected mutation (or not a settings call at all)

  // Not a hermit project — this plugin's hooks fire everywhere it's loaded.
  const dir = hermitDir();
  if (!dir || !fs.existsSync(dir)) return;

  const { envelope, determined } = turnEnvelope(payload);

  if (!determined) {
    // Couldn't tell. On the managed unattended session a protected mutation
    // fails closed; anywhere else an operator is present, so lean allow. A
    // safe-tier write is exempt: the fail-closed rule buys its broken flows
    // back in blast radius, and a safe setting has none to speak of.
    if (mutation.verdict !== 'allowed') {
      denyIfManaged('Turn provenance could not be determined from the transcript on a managed session, so this defaults to terminal-only.');
    }
    return;
  }

  if (!envelope) return; // terminal-opened turn — the operator asked for this

  // Cheapest check first: terminal-only never needs config content, so decide
  // it before paying for the read — same cheap-checks-first ordering as the
  // pure string matching above.
  if (mutation.verdict === 'terminal-only') deny(DENY_TERMINAL_ONLY);

  const config = readConfigRaw(dir);

  // Safe tier: any setting, but only from the operator's own chat — the same
  // anchor pause/resume/status bind to. Without this a stranger in a shared
  // home chat could set the model or switch the watchdog off while being
  // refused a status read.
  if (mutation.verdict === 'allowed') {
    if (!isTrustedController(config, envelope.source, envelope.userId, envelope.chatId)) {
      deny(DENY_NEEDS_TRUSTED);
    }
    return;
  }

  // The operator's opt-out, checked before authority: with settings_from_chat
  // false there is no chat that holds these tiers, so naming one in the deny
  // would send the operator somewhere that cannot help either.
  if (config?.settings_from_chat === false) deny(DENY_SETTINGS_FROM_CHAT_OFF);

  if (!isSettingsController(config, envelope.source, envelope.userId, envelope.chatId)) {
    deny(DENY_NEEDS_MAINTAINER);
  }

  if (mutation.verdict === 'maintainer') return; // the settings chat carries this tier

  // Nonce tier: the maintainer chat asks, the operator confirms. A token is
  // bound to one target and one chat, single-use, and matched only against the
  // harness-written envelope body — never the model's own tool call.
  const pending = readPending(dir);
  const sameAsk =
    pending?.target === mutation.target &&
    pending?.sourceKey === envelope.sourceKey &&
    pending?.chatId === envelope.chatId;

  if (pending && sameAsk && bodyEchoesToken(envelope.body, pending.token)) {
    clearPending(dir);
    return; // confirmed
  }

  // Reuse an outstanding token for the same ask: a model retry must not
  // invalidate the code the operator has already been sent. `created` is
  // carried over rather than refreshed — the TTL is measured from the moment
  // the code was first posted to the chat, so a model that retries every few
  // minutes cannot keep a code the operator never echoed alive indefinitely.
  const reused = pending && sameAsk ? pending : null;
  const token = reused ? reused.token : newToken();
  writePending(dir, {
    token,
    target: mutation.target,
    sourceKey: envelope.sourceKey,
    chatId: envelope.chatId,
    userId: envelope.userId,
    created: reused ? reused.created : Date.now(),
  });
  deny(denyNeedsNonce(mutation.target, token));
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
