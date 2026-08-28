// Which config path a channel turn may write, as pure data and predicates.
//
// Two hooks need these answers: channel-settings-gate.ts (PreToolUse) to enforce
// a tier, and validate-config.ts (PostToolUse) to tell an operator when a rule
// they wrote can never take effect. Neither may restate the other's regexes —
// a drift between them is a security bug that reads as a typo — and a hook
// importing another hook to borrow three pure functions is the wrong shape, so
// the shared half lives here instead.
//
// It holds the two parts that are pure: the paths whose tier is fixed no matter
// what the operator declares, and the operator's own rules. Assembling a verdict
// stays in the gate, which needs the settings registry to resolve an argument
// name to a path. This module imports nothing, which is what lets the cheap hook
// stay cheap; keep it that way.

type Json = any;

/** Increasing strictness — a chained command takes the strongest verdict. */
export type Verdict = 'allowed' | 'maintainer' | 'nonce' | 'terminal-only';
export const STRICTNESS: Record<Verdict, number> = { allowed: 0, maintainer: 1, nonce: 2, 'terminal-only': 3 };

/**
 * The enrollment root: who may talk to this hermit, which chat holds the
 * maintainer tier, and how much authority a chat on that channel carries.
 * Terminal-only on every turn, maintainer chat included — these keys are what
 * the maintainer tier is *anchored on*, so letting that chat write them would
 * make a single compromise self-extending and unrevokable. Everything else in
 * the security tier is recoverable by an operator who can still reach a
 * terminal; this is the part that would not be.
 *
 * `settings_policy` (lib/channel-auth.ts settingsPolicy) sits here for exactly
 * that reason: a chat that could raise its own channel from `ask` to `allow`
 * would drop its own second factor, and one that could lift `deny` would undo
 * the operator's opt-out.
 *
 * Matches the leaf AND anything beneath it. `settings-edit`'s setPath treats a
 * dotted path as a plain traversal and arrays are objects, so
 * `channels.discord.allowed_users.0` writes one allowlist entry — an
 * exact-leaf-only match would let that land on `maintainer` and hand the
 * maintainer chat the self-extending compromise this tier exists to block.
 * Indexed paths are a real spelling here, not a hypothetical: the gate's
 * everyday patterns depend on them for `routines.<n>.enabled`.
 */
const ENROLLMENT_ROOT = /^channels\.[^.]+\.(allowed_users|default_chat_id|dm_channel_id|maintainer_channel_id|settings_policy)(\..+)?$/;

/**
 * `channels` and `channels.<platform>` — writing either replaces the enrollment
 * root wholesale, so the ancestor rule has to hold at every tier, not just for
 * a channel turn. (Ancestors of merely maintainer-tier keys are maintainer-tier
 * themselves: nothing protected hides beneath them.)
 */
const ENROLLMENT_ANCESTOR = /^channels(\.[^.]+)?$/;

/**
 * The keys that decide who holds settings authority at all, rather than what one
 * may change. `operator_profile` gates the home-chat fallback (lib/channel-auth.ts
 * isSettingsController), so a chat able to write it could flip a client install to
 * `technical` and grant itself the tier. `settings_permissions` is the same kind of
 * key one level up: it is the operator's re-tiering of every OTHER setting, so a
 * chat that could write it could `allow` itself anything the built-in rules hold
 * above its tier. Same unrevocability argument as the enrollment root, so the same
 * answer. The per-channel half of this rule is `settings_policy`, which lives in
 * ENROLLMENT_ROOT above because it is spelled under `channels.<name>`.
 */
const AUTHORITY_KEYS = /^(operator_profile|settings_permissions)(\..+)?$/;

/**
 * Execution-adjacent: `permission_mode` can be flipped to bypassPermissions,
 * `env` is a free-form dict that reaches the session's environment, and every
 * `monitors[]` entry carries a `command` string the `watch` skill registers as
 * a Monitor subprocess at session start (validate-config.ts requires it) — a
 * config-declared shell command is at least as execution-adjacent as either of
 * the other two, so it cannot sit a tier below them. Each matches as both the
 * whole container and any leaf, because replacing the container is the broader
 * write.
 *
 * `boot_skill` joins them on persistence rather than on reach. It is not shell
 * (hermit-start shlex-quotes it into an argv element), but it becomes the boot
 * *prompt* of every session the hermit starts — arbitrary standing instructions,
 * re-applied on every restart, unattended, at whatever permission_mode is set.
 * That outlives a single `env` write, so it cannot sit a tier below one. Domain
 * hermits set it from the terminal at hatch, so the everyday path is untouched;
 * only a chat-originated change pays the second factor. `shutdown_skill` is the
 * same reach in the other direction — session-close invokes it as a skill
 * command on every full close, the `--auto` one included — so it is pinned
 * alongside its counterpart rather than left on the maintainer tier.
 *
 * `voice` joins them on the same persistence argument as `boot_skill`: its `prose`
 * is free text rendered verbatim into `.claude/output-styles/hermit-voice.md`, which
 * Claude Code builds into the SYSTEM PROMPT of every future session. That is the
 * longest-lived instruction surface a chat can reach, and content the hermit merely
 * *read* (a fetched page, an issue body) must not be able to write it. The container
 * is listed rather than the leaf so `set voice '<object>'` cannot smuggle prose past
 * a leaf-only rule; the gate catches `voice.style` on the everyday tier first, which
 * is the whole point — the three sealed style values carry no text.
 */
const NONCE_REQUIRED = /^(permission_mode|env|monitors|boot_skill|shutdown_skill|voice)(\..+)?$/;

/**
 * A routine's `precheck` is an executable the routine monitor runs unattended at
 * fire time — the same trust class as a `monitors[]` command, and so the same tier.
 * Only the precheck leaves are pinned here: `routines` is the container an operator
 * edits from chat every day (add a routine, flip `enabled`), and putting the whole
 * array behind a nonce would tax that daily work to protect one field. The
 * container write is judged by value instead — see the gate's precheckSetChanged().
 */
const NONCE_ROUTINE_PRECHECK = /^routines\.\d+\.precheck(_timeout_s)?(\..+)?$/;

/**
 * Paths no `settings_permissions` rule may re-tier, and the one question both the
 * gate and validate-config.ts ask about them — the regexes above have exactly one
 * reader each so the hook that enforces the set and the validator that reports an
 * ineffective rule cannot drift apart on what belongs to it.
 */
export function isImmutablePath(dotted: string): boolean {
  return ENROLLMENT_ROOT.test(dotted) || ENROLLMENT_ANCESTOR.test(dotted) || AUTHORITY_KEYS.test(dotted);
}

/** Does this path reach what a session executes, absent any operator rule? */
export function isExecutionAdjacentPath(dotted: string): boolean {
  return NONCE_REQUIRED.test(dotted) || NONCE_ROUTINE_PRECHECK.test(dotted);
}

/**
 * `config.json`'s `settings_permissions` — the operator's own re-tiering of the
 * built-in rules, in Claude Code's permission-rule shape and vocabulary
 * (`permissions.allow|ask|deny`), because it answers the same question about the
 * same kind of subject. `settings_policy` already borrows that vocabulary for how
 * far a channel reaches; this borrows it for which settings the tiers apply to.
 *
 *   allow  everyday tier — the operator's own chat, first message (`allowed`).
 *   ask    the settings chat plus the echoed confirmation code (`nonce`). As with
 *          the built-in ask-class paths, a channel whose `settings_policy` is
 *          `allow` drops the code; the policy dial still governs that, so there is
 *          no fourth word here for the maintainer tier — an unlisted path keeps
 *          landing there.
 *   deny   terminal-only.
 *
 * Entries are dotted config paths; `*` matches exactly one segment, the same
 * single-token wildcard Claude Code's own rules use (`Bash(npm run test *)`), so
 * `routines.*.precheck` covers every routine's gate without naming indices.
 *
 * A rule matches the path it names and nothing beneath it, where the built-in
 * regexes above match a whole subtree. Raising a container therefore means naming
 * its leaves too — `deny: ['env', 'env.*']`, not `deny: ['env']` alone, which would
 * leave `env.API_KEY` on its built-in tier rather than the operator's.
 *
 * The map cannot reach the enrollment root, the authority keys, or itself: the
 * gate's channelVerdict() answers isImmutablePath() before it consults any rule.
 * That ordering is the invariant — an operator relaxing their own gate is a
 * decision they are entitled to make, but handing a chat the ability to relax it
 * further is the unrevocable one, and no rule may express it. Mirrors Claude
 * Code's own "a security key keeps its strict value" carve-out.
 */
export type SettingsRules = { allow: string[]; ask: string[]; deny: string[] };

/** The rule lists, strictest first — a path named twice takes its strictest mention. */
const RULE_TIER: Array<[keyof SettingsRules, Verdict]> = [
  ['deny', 'terminal-only'],
  ['ask', 'nonce'],
  ['allow', 'allowed'],
];

/**
 * Reads the three lists out of raw config, keeping only string entries. A
 * malformed map degrades to whatever it declares legibly rather than voiding the
 * operator's whole intent — validate-config.ts is where a bad shape gets said
 * out loud; here it must never throw, because this runs inside a hook.
 */
export function parseSettingsRules(raw: Json): SettingsRules | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const list = (k: keyof SettingsRules) =>
    (Array.isArray(raw[k]) ? raw[k] : []).filter((e: Json) => typeof e === 'string' && e.length > 0);
  const rules = { allow: list('allow'), ask: list('ask'), deny: list('deny') };
  return rules.allow.length || rules.ask.length || rules.deny.length ? rules : null;
}

/** `*` matches exactly one dotted segment; everything else is literal. */
function ruleMatches(pattern: string, dotted: string): boolean {
  const rx = new RegExp(
    `^${pattern.split('.').map(seg => (seg === '*' ? '[^.]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('\\.')}$`,
  );
  return rx.test(dotted);
}

/**
 * The operator's tier for this path, or null when no rule names it.
 *
 * `deny` outranks `ask` outranks `allow`, the same order Claude Code resolves a
 * path matched by more than one permission rule — the strict reading wins, so a
 * path an operator listed twice can never come out weaker than its strictest
 * mention.
 */
export function ruleVerdict(rules: SettingsRules | null, dotted: string): Verdict | null {
  if (!rules) return null;
  for (const [key, verdict] of RULE_TIER) {
    if (rules[key].some(pattern => ruleMatches(pattern, dotted))) return verdict;
  }
  return null;
}

/**
 * A rule pattern rendered as a concrete path, so the predicates above can answer
 * for it. `0` satisfies both the `[^.]+` of the enrollment regexes and the `\d+`
 * of the routine ones, so one probe serves `channels.*.settings_policy` and
 * `routines.*.precheck` alike.
 */
export function rulePatternProbe(pattern: string): string {
  return pattern.replace(/(^|\.)\*(?=\.|$)/g, '$10');
}

/**
 * One concrete path per execution-adjacent family, matched against the pattern
 * itself rather than against its probe.
 *
 * The probe alone is not enough here: `*` and `*.*` are legal patterns that name
 * no family literally — their probes are `0` and `0.0`, which match nothing — yet
 * at runtime they lower `permission_mode`, `env.KEY` and the rest to whatever list
 * they were written in. A probe-only check would let the two broadest rules an
 * operator can write pass the validator in silence, which is exactly where the
 * warning is worth the most.
 */
const EXECUTION_ADJACENT_SAMPLES = [
  'permission_mode', 'env', 'env.KEY', 'monitors', 'monitors.0', 'monitors.0.command',
  'boot_skill', 'shutdown_skill', 'voice', 'voice.prose',
  'routines.0.precheck', 'routines.0.precheck_timeout_s',
];

/** Does this rule pattern reach anything execution-adjacent, literally or by wildcard? */
export function ruleReachesExecutionAdjacent(pattern: string): boolean {
  return isExecutionAdjacentPath(rulePatternProbe(pattern))
    || EXECUTION_ADJACENT_SAMPLES.some(sample => ruleMatches(pattern, sample));
}
