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
//                  anchor pause/resume/status use), or the settings chat, which
//                  holds strictly more. Reads are open wider: any chat that may
//                  reach the hermit can `show`/`get`/`history`.
//   maintainer     the settings chat, allowlist-checked (isSettingsController):
//                  the configured maintainer chat, or the home chat itself on
//                  an operator-run install that never configured one
//                  (boot_skill, remote, escalation, docker.*,
//                  artifacts.backend, and everything not named below)
//   nonce          settings chat AND an echoed token: permission_mode, env.*,
//                  monitors (each entry carries a shell command), and
//                  routines.<n>.precheck (an executable the routine monitor runs
//                  unattended) — plus a routines container write (the whole array
//                  or one indexed entry) that arms or changes one. The token is
//                  asked for only when the channel's settings_policy is `ask`;
//                  on `allow` the tier applies on the first message
//   terminal-only  the enrollment root (settings_policy included),
//                  operator_profile, settings_permissions, and any ancestor
//                  write that would replace them — never reachable from a
//                  channel, on any tier
//
// Which path sits on which tier is the default, not the law: `settings_permissions`
// in config.json re-tiers any other path with Claude Code's own allow/ask/deny
// rule shape (see SettingsRules below). It cannot reach the terminal-only set
// above, itself included — channelVerdict answers those before reading a rule.
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
// maintainer_channel_id, settings_policy) is the deliberate hole in that: a
// settings chat that could add an allowed user, re-point itself, or raise its
// own policy would turn one compromise into a permanent, self-extending one,
// instead of something an operator with terminal access can revoke.
// `operator_profile` joins it for the same reason — it decides who holds the
// tier, so a chat that could write it could grant itself authority.
//
// `channels.<name>.settings_policy` (lib/channel-auth.ts settingsPolicy) is how
// far the tiers above reach on that channel: `allow` applies them on the first
// message, `ask` keeps the echoed token, `deny` collapses everything above the
// safe tier to terminal-only for that channel, the configured maintainer chat
// included. Absent or unrecognised reads as `ask`, so only a deliberate value
// relaxes anything — except that a retired `settings_from_chat: false` still
// floors an unmigrated channel at `deny`, so an upgrade never reopens an
// opt-out the operator set. It replaces that retired global key.
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
import { isSettingsController, isTrustedController, settingsPolicy } from './lib/channel-auth';
import { readConfigRaw } from './lib/config-read';
import { byArg } from './lib/settings/registry';
import { runHook } from './lib/hook-input';
import { readPending, writePending, clearPending, newToken, bodyEchoesToken, bindingFor } from './lib/settings-confirm';
import { isSecretPath } from './lib/config-audit';
// The path-classification half of this gate: which paths no operator rule may
// re-tier, which reach what a session executes, and the operator's own
// `settings_permissions` rules. Shared with validate-config.ts, which reports a
// rule that can never take effect and must classify a path exactly as this hook
// does — so the regexes have one home rather than a copy in each.
import {
  type Verdict, type SettingsRules, STRICTNESS,
  isImmutablePath, isExecutionAdjacentPath, parseSettingsRules, ruleVerdict,
} from './lib/settings/permissions';

export type { Verdict, SettingsRules };

// Same window channel-hook.ts uses: enough to hold a turn, cheap to read.
const TAIL_BYTES = 512 * 1024;

type Json = any;

const DENY_TERMINAL_ONLY =
  'Terminal-only hermit setting. Channel enrollment (allowed_users, default_chat_id, ' +
  'dm_channel_id, maintainer_channel_id, settings_policy), operator_profile, and ' +
  'settings_permissions decide who is allowed to talk to this ' +
  'hermit and how much a chat there may change, so they change only on the operator\'s own ' +
  'terminal-typed request — the maintainer chat cannot grant itself more reach, and no ' +
  'settings_permissions rule can lift this tier. Writing a parent ' +
  'object counts, and so does editing config.json directly. ' +
  'Do not retry. Reply in the operator\'s language that this one has to be done from a terminal ' +
  'session with `/claude-code-hermit:hermit-settings <argument>`, and carry on with anything else ' +
  'that was asked.';

// Deliberately spells the recovery path out in parts rather than as one runnable
// command line: protectedMutation() matches `settings-edit <word> <word>` anywhere
// in a Bash command string, so a verbatim invocation here would re-trigger this
// gate the moment the model quotes the deny text inside a command (a heredoc
// `--notice` payload, a Findings append). Backticking the verb with no trailing
// space keeps the token out of that match while still naming it.
const DENY_DIRECT_CONFIG_EDIT =
  'Direct config.json edits are blocked from chat on every tier — a file write is opaque here, so ' +
  'it is treated as if it could replace the enrollment root. The change itself may still be ' +
  'possible: re-issue it through the audited script path — `.claude-code-hermit/bin/hermit-run` ' +
  'with the `settings-edit` verb, the hermit config path, then `set <dotted.path> <value>`. ' +
  'Settings are tiered per-field there, and many (routines included) are writable from the chat ' +
  'holding settings authority. Only if that path is also denied does this need a terminal, via ' +
  '`/claude-code-hermit:hermit-settings <argument>`. Reply in the operator\'s language saying what ' +
  'is happening to the change, and carry on with anything else that was asked.';

const DENY_NEEDS_MAINTAINER =
  'Security-tier hermit setting. Settings like permission mode, boot skill, remote, escalation, ' +
  'docker and the artifact backend change only from the chat that holds settings authority — the ' +
  'configured maintainer chat, or the hermit\'s own home chat when none is configured and the ' +
  'install is operator-run — or from the operator\'s terminal. This turn arrived from neither. Do ' +
  'not retry, and do not edit config.json directly. Reply in the operator\'s language explaining ' +
  'where this has to be asked from, and carry on with anything else that was asked.';

const DENY_NEEDS_TRUSTED =
  'Hermit setting. This turn arrived from a chat that is neither the operator\'s own nor the ' +
  'settings chat, and settings change only from one of those or from a terminal — the same rule ' +
  'that governs pause, resume and status. Reading a setting is still fine from any chat. Do not ' +
  'retry, and do not edit config.json directly. Reply in the operator\'s language saying the ' +
  'change has to come from their own chat with the hermit, and carry on with anything else that ' +
  'was asked.';

const DENY_POLICY_DENY =
  'Settings changes from this channel are switched off (its `settings_policy` is `deny`), so ' +
  'anything beyond the everyday settings changes only from a terminal session — from every chat ' +
  'on it, the maintainer one included. Do not retry, and do not edit config.json directly. Reply ' +
  'in the operator\'s language that this hermit is set to terminal-only for settings of this kind, ' +
  'name `/claude-code-hermit:hermit-settings <argument>` as the terminal command, and carry on ' +
  'with anything else that was asked.';

// The operator-facing notice must carry the CHANGE as well as the code. The
// token is bound to the exact mutation on disk, so a mismatched retry is
// rejected either way — but the operator only ever sees what this turn chooses
// to send them, and a bare code asks them to authorize something they cannot
// name. Spelling the target into the notice is what makes the echo an informed
// second factor rather than a reflex.
//
// `target` is already the redacted display (protectedMutation), so quoting it
// verbatim can never move a credential into the chat.
function denyNeedsNonce(target: string, token: string): string {
  return (
    `Second factor required for \`${target}\`. This setting reaches what the session may execute, ` +
    'so on a channel whose `settings_policy` is `ask` the maintainer chat alone does not ' +
    'authorize it. Send a confirmation request to the ' +
    `maintainer chat now — \`.claude-code-hermit/bin/hermit-run channel-send ` +
    `.claude-code-hermit --notice\` with {"maintainer": "..."} on stdin — then stop and wait. That ` +
    `message MUST name the exact change \`${target}\` in the operator's language AND carry the ` +
    `code \`${token}\` verbatim, so the operator can see what they are authorizing before echoing ` +
    'it; a code with no change named is not a valid ask. Quote the change exactly as shown here — ' +
    'a value rendered as [set] or [cleared] is withheld deliberately and must stay that way. ' +
    'Do not retry the setting ' +
    'in this turn: it applies only after the operator echoes the code back in a maintainer-chat ' +
    'message. The code expires in 10 minutes.'
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
  // Which of three sealed values renders into outputStyle. `default` and `Concise`
  // are Claude Code's own styles and `custom` merely points at voice.prose, which
  // is gated a tier up — so this leaf carries no text of its own. Operators run
  // these hermits from a chat; how it talks to them is the first thing they want
  // to change, and holding the whole voice at the terminal made that unreachable.
  'voice.style',
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

// The tiers this table does NOT decide live in lib/settings/permissions.ts: the
// enrollment root and authority keys (terminal-only on every turn, and beyond the
// reach of any operator rule) and the execution-adjacent set behind the
// confirmation code. channelVerdict() below is where the two halves meet.

/**
 * The container spellings judged by value: the whole array, and one indexed entry.
 * `setPath` splits on `.` and indexes arrays, so `set routines.0 '<object>'`
 * replaces a whole routine, precheck included, without ever naming the field, which
 * a leaf-only rule would wave through at the maintainer tier.
 */
const ROUTINES_CONTAINER = /^routines(\.\d+)?$/;

/**
 * Does this `set routines[.<n>] <json>` add or change any `precheck`?
 *
 * The add/edit flow in hermit-settings writes the entire array back, so a
 * field-level rule alone would be bypassed by every legitimate-looking array
 * write. Compared by id: a reordered array with the same gates is not a change.
 * Unparseable input counts as changed — an opaque write must not buy a weaker
 * tier than a legible one.
 */
export function precheckSetChanged(value: string, current: Json[]): boolean {
  const gateOf = (r: Json) => (r && r.precheck != null ? `${String(r.precheck)}\u0000${r.precheck_timeout_s ?? ''}` : null);
  const before = new Map<string, string | null>();
  for (const r of Array.isArray(current) ? current : []) {
    if (r && r.id) before.set(String(r.id), gateOf(r));
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(value);
  } catch {
    return true;
  }
  // A lone routine object (the `routines.<n>` spelling) is judged as an array of
  // one. It has to carry an `id` to be read that way: anything else is not a
  // routine write this can reason about, so it takes the strict answer.
  const next: Json[] | null = Array.isArray(parsed) ? parsed
    : (parsed && typeof parsed === 'object' && parsed.id) ? [parsed]
    : null;
  if (!next) return true;
  for (const r of next) {
    const gate = gateOf(r);
    if (gate === null) continue; // dropping a gate is a de-escalation, not an arming
    if (!r || !r.id || before.get(String(r.id)) !== gate) return true;
  }
  return false;
}


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
 * the channel's `settings_policy` is `deny`.
 *
 * `rules` is the operator's `settings_permissions` map, consulted after the
 * unreachable keys and before every built-in rule — so an operator can re-tier
 * anything the defaults decide, in either direction, and nothing at all of what
 * makes a chat compromise revocable. The immutable checks moved above the
 * `allowed` ones to make that ordering explicit; the two sets are disjoint
 * (nothing in ALLOWED_EXACT/ALLOWED_PATTERNS is an enrollment or authority key),
 * so the built-in verdicts are unchanged by the move.
 */
export function channelVerdict(verb: string, target: string, rules?: SettingsRules | null): Verdict {
  if (READ_VERBS.has(verb)) return 'allowed';
  if (!WRITE_VERBS.has(verb)) return 'terminal-only';
  if (!target) return 'terminal-only';

  const dotted = resolveTarget(verb, target);
  if (isImmutablePath(dotted)) return 'terminal-only';

  const ruled = ruleVerdict(rules ?? null, dotted);
  if (ruled) return ruled;

  if (ALLOWED_EXACT.has(dotted)) return 'allowed';
  if (ALLOWED_PATTERNS.some(rx => rx.test(dotted))) return 'allowed';
  if (isExecutionAdjacentPath(dotted)) return 'nonce';
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
 * The routines array as it stands on disk, for the value-aware precheck rule.
 * An unreadable config yields an empty baseline, which makes every declared gate
 * in the incoming write look new — the strict direction.
 */
/**
 * The config as it stands on disk, read at most once per hook process. Both
 * readers below want the same file, and a routines write that arms a gate asks
 * for both — without the memo that is two directory walk-ups and two parses for
 * one answer. Safe because the file cannot change inside one invocation.
 */
let configCache: Json | null | undefined;
function currentConfig(): Json | null {
  if (configCache !== undefined) return configCache;
  try {
    const dir = hermitDir();
    configCache = dir ? readConfigRaw(dir) : null;
  } catch {
    configCache = null;
  }
  return configCache;
}

function currentRoutines(): Json[] {
  const routines = currentConfig()?.routines;
  return Array.isArray(routines) ? routines : [];
}

/**
 * The operator's `settings_permissions` map as it stands on disk. Unreadable
 * config yields no rules, which leaves every built-in tier in force — the strict
 * direction, and the same one an install that never wrote the key gets.
 */
function currentRules(): SettingsRules | null {
  return parseSettingsRules(currentConfig()?.settings_permissions);
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
/**
 * Display stand-in for a credential value — what it became, never what it was.
 *
 * Uses the same two words as the audit ledger's own marker (`presence` in
 * lib/config-audit.ts) so a settings-history line and a confirmation ask read
 * alike, but deliberately does not import it: that helper is ledger formatting,
 * keyed on null/undefined/empty, and reaching it from here would mean mapping
 * `'none'`/`'clear'` — settings-edit's spellings for a null write — onto an
 * empty string first, which hides the decision this function exists to make.
 * Two literals are a cheaper coupling than that indirection; if they ever need
 * to be one, the shared thing is a marker constant, not this function.
 */
function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function presenceOf(value: string): string {
  const v = stripQuotes(value);
  return v === '' || v === 'none' || v === 'clear' ? '[cleared]' : '[set]';
}

/**
 * A bare integer is not a credential, and the env knobs this plugin ships and
 * documents (`MAX_THINKING_TOKENS`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) are all
 * integers. Withholding those would cost the operator the only thing the ask is
 * for — `=[set]` reads identically for `20000` and `200` — and buy nothing, since
 * the redaction exists to keep secrets out of the chat, not numbers.
 */
const BARE_INTEGER = /^\d+$/;

/**
 * What the operator is shown for one write, with any value config-audit refuses
 * to log withheld.
 *
 * A container write (`set env '{"A":"x"}'`) is expanded to one marker per key it
 * sets: redacting it whole yields a bare `env=[set]`, which names no key at all
 * and is therefore the very "code with no change named" the notice calls invalid.
 */
function displayFor(dotted: string, value: string): string {
  if (!isSecretPath(dotted)) return `${dotted}=${value}`;
  const bare = stripQuotes(value);
  if (BARE_INTEGER.test(bare)) return `${dotted}=${bare}`;
  let parsed: Json;
  try {
    parsed = JSON.parse(bare);
  } catch {
    return `${dotted}=${presenceOf(value)}`;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return `${dotted}=${presenceOf(value)}`;
  }
  const keys = Object.keys(parsed);
  if (keys.length === 0) return `${dotted}=[cleared]`;
  return keys.map((k) => `${dotted}.${k}=${presenceOf(String(parsed[k] ?? ''))}`).join(', ');
}

function protectedMutation(
  command: string,
): { verdict: Verdict; target: string; binding: string } | null {
  // An opaque write of the whole file can replace the enrollment root, so it
  // takes the strictest tier regardless of what it happens to contain.
  if (/>\s*\S*\.claude-code-hermit\/config\.json/.test(command)) {
    return { verdict: 'terminal-only', target: 'config.json', binding: bindingFor('config.json') };
  }

  // The value alternation accepts a quoted argument before the bare-word form: a
  // routines write carries a JSON array, which has spaces in it, and a bare `\S+`
  // would capture only up to the first one. That truncation is not merely a cosmetic
  // problem for the label the operator confirms — precheckSetChanged() would then be
  // parsing a fragment, fail, and escalate every routine add to the nonce tier.
  const matches = [...command.matchAll(
    /(?:settings-edit(?:\.ts)?)\s+(\S+)\s+([a-z-]+)(?:\s+(\S+))?(?:\s+('[^']*'|"[^"]*"|\S+))?/g
  )];
  if (matches.length === 0) return null;

  // Read only once a settings write is actually in hand — a command that never
  // touches settings must not pay for a config read.
  const rules = currentRules();

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
  let rawTargets: string[] = [];
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
    let v = channelVerdict(verb, t, rules);
    // Routines container write (whole array or one indexed entry): escalate only
    // when it arms or changes a gate. Keeps the everyday add/edit/enable path on
    // its existing tier while closing the bypass a container write would otherwise be.
    //
    // The escalation target is whatever tier a precheck leaf itself carries, not a
    // fixed `nonce`: the add/edit flow writes the whole array back, so an operator
    // who re-tiered `routines.*.precheck` would otherwise see their rule apply to
    // the leaf spelling nobody uses and never to the write that actually arms a
    // gate. Resolved through the same channelVerdict, so the two spellings cannot
    // disagree, and applied only when it is stricter — a container write is never
    // made weaker than the container's own verdict.
    if (v !== 'terminal-only' && ROUTINES_CONTAINER.test(resolveTarget(verb, t)) && value
        && precheckSetChanged(value, currentRoutines())) {
      const precheckTier = channelVerdict('set', 'routines.0.precheck', rules);
      if (STRICTNESS[precheckTier] > STRICTNESS[v]) v = precheckTier;
    }
    const dotted = resolveTarget(verb, t);
    // Two labels, deliberately: `raw` carries the exact value and is only ever
    // hashed into the token binding; `shown` is what reaches the operator, the
    // model's context and the on-disk record. They diverge on the paths
    // config-audit already refuses to log a value for — every `env.*` leaf plus
    // anything named like a credential — so a chat-set API key is confirmable
    // without being repeated back anywhere. See displayFor() for what survives
    // that redaction and why.
    const raw = value ? `${dotted}=${value}` : dotted;
    const shown = value ? displayFor(dotted, value) : dotted;
    if (STRICTNESS[v] > STRICTNESS[worst]) {
      worst = v;
      targets = [shown];
      rawTargets = [raw];
    } else if (v === worst) {
      if (!targets.includes(shown)) targets.push(shown);
      // Tracked separately from `targets`: two different secrets under one path
      // collapse to the same `shown` string, and deduping the binding on the
      // display would let a token issued for one apply to the other.
      if (!rawTargets.includes(raw)) rawTargets.push(raw);
    }
  }
  // Safe-tier writes are returned too, not swallowed: `allowed` means "any
  // setting", never "any sender", and main() still binds them to the operator's
  // own chat. Only a command with no write at all is none of the gate's
  // business.
  if (!sawWrite) return null;
  return {
    verdict: worst,
    target: targets.sort().join(', '),
    binding: bindingFor(rawTargets.sort().join(', ')),
  };
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

function denyIfManaged(diagnostic: string, target?: string): void {
  if (process.env.HERMIT_MANAGED !== '1') return; // attended — lean allow
  const dir = hermitDir();
  if (!dir || !fs.existsSync(dir)) return;
  // A direct config.json edit gets the recovery-path message here too: safe-tier
  // settings-edit writes are exempt from this fail-closed rule, so the script
  // path it points at can still succeed where the opaque edit cannot.
  const message = target === 'config.json' ? DENY_DIRECT_CONFIG_EDIT : DENY_TERMINAL_ONLY;
  deny(`${message}\n(${diagnostic})`);
}

function main(payload: any): void {
  const tool = typeof payload?.tool_name === 'string' ? payload.tool_name : '';
  if (tool !== 'Bash' && tool !== 'Edit' && tool !== 'Write') return; // defensive

  // Pure string matching first, no I/O — this hook fires on every Bash, Edit
  // and Write, and almost none of them are settings mutations. Same
  // cheap-checks-first ordering as ask-gate.ts.
  const input = payload?.tool_input ?? {};
  let mutation: { verdict: Verdict; target: string; binding: string } | null = null;

  if (tool === 'Bash') {
    mutation = protectedMutation(typeof input.command === 'string' ? input.command : '');
  } else {
    const fp = typeof input.file_path === 'string' ? input.file_path : '';
    // Edit/Write of config.json is opaque here — it can rewrite the enrollment
    // root, so it takes the strictest tier. The binding is carried for the type
    // only: terminal-only denies before any token is ever issued.
    mutation = targetsConfigFile(fp)
      ? { verdict: 'terminal-only', target: 'config.json', binding: bindingFor('config.json') }
      : null;
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
      denyIfManaged('Turn provenance could not be determined from the transcript on a managed session, so this defaults to the strictest tier.', mutation.target);
    }
    return;
  }

  if (!envelope) return; // terminal-opened turn — the operator asked for this

  // Cheapest check first: terminal-only never needs config content, so decide
  // it before paying for the read — same cheap-checks-first ordering as the
  // pure string matching above. An opaque whole-file write (Edit/Write on
  // config.json, or a shell redirect into it) gets its own message: the *edit*
  // is terminal-only because it can't be inspected, but the change behind it
  // may be a lower tier through settings-edit — the deny must teach that
  // recovery path, not send the model to a terminal it doesn't have.
  if (mutation.verdict === 'terminal-only') {
    deny(mutation.target === 'config.json' ? DENY_DIRECT_CONFIG_EDIT : DENY_TERMINAL_ONLY);
  }

  const config = readConfigRaw(dir);

  // Safe tier: any setting, but only from a chat that holds authority — the
  // operator's own chat (the same anchor pause/resume/status bind to) or the
  // settings chat, which holds strictly more than it. Without the first arm a
  // stranger messaging from some other chat could set the model or switch the
  // watchdog off while being refused a plain status read; without the second,
  // a configured maintainer chat could flip `permission_mode` but not the
  // model, and the tier ladder would invert at its own top.
  if (mutation.verdict === 'allowed') {
    const holdsAuthority =
      isTrustedController(config, envelope.source, envelope.userId, envelope.chatId) ||
      isSettingsController(config, envelope.source, envelope.userId, envelope.chatId);
    if (!holdsAuthority) deny(DENY_NEEDS_TRUSTED);
    return;
  }

  // How far the tiers reach on THIS channel. Read once: `deny` and `allow` are
  // the two ends of the same dial, and reading it twice would let a rewrite of
  // config.json mid-turn answer the two questions differently.
  const policy = settingsPolicy(config, envelope.source);

  // The operator's opt-out, checked before authority: with `deny` there is no
  // chat on this channel that holds these tiers, so naming one in the deny would
  // send the operator somewhere that cannot help either.
  if (policy === 'deny') deny(DENY_POLICY_DENY);

  if (!isSettingsController(config, envelope.source, envelope.userId, envelope.chatId)) {
    deny(DENY_NEEDS_MAINTAINER);
  }

  if (mutation.verdict === 'maintainer') return; // the settings chat carries this tier

  // `allow`: the settings chat on this channel has a single poster, so the code
  // would only ever be echoed by the person who just asked for the change. The
  // tier still required the settings chat to get here — this drops the second
  // factor, never the first.
  if (policy === 'allow') return;

  // Nonce tier: the maintainer chat asks, the operator confirms. A token is
  // bound to one target and one chat, single-use, and matched only against the
  // harness-written envelope body — never the model's own tool call.
  const pending = readPending(dir);
  // Identity is the BINDING, never the display: a redacted `env.X=[set]` is the
  // same string for every value of X, so comparing displays would let a code
  // issued for one credential apply a different one.
  const sameAsk =
    pending?.binding === mutation.binding &&
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
    binding: mutation.binding,
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
