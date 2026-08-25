#!/usr/bin/env bun
/**
 * Boot script for hermit autonomous sessions.
 *
 * Reads .claude-code-hermit/config.json and starts Claude Code
 * in a tmux session with the configured channels and options.
 *
 * Usage:
 *     bun scripts/hermit-start.ts              # from project root
 *     bun scripts/hermit-start.ts --no-tmux    # run in current terminal
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { acquireLock, releaseLock } from './lib/lockfile';
import { readConfigRaw } from './lib/config-read';
import { auditConfigChange } from './lib/config-audit';
import { writeRuntimeJson, readRuntimeJson, readRuntimeState, STATE_DIR, RUNTIME_JSON, RUNTIME_TMP, LIFECYCLE_LOCK } from './lib/runtime';
import { localISOStamp } from './lib/time';
import { tmuxSessionAlive, getSessionName } from './lib/tmux';
import { clearStatusCache } from './lib/context-reset';
import { defaultConfigDir, readTokenValue, TOKEN_ENV_VAR } from './lib/setup-token';
import { sharedLivenessAgeSecs, LIVENESS_FRESH_SECS } from './lib/liveness';
import { isContainer } from './lib/container';
import { pyTruthy, isDict, iterChannelConfigs, getEnabledChannels, channelStateDirKey } from './lib/channel-config';
import { cmpSemver } from './lib/semver';
import { sanitizeLanguage } from './lib/operator-language';
import { HERMIT_OUTPUT_STYLE, voiceFileExists, resolveProjectStyle } from './lib/voice';
import { automodeAllowEntry, AUTOMODE_ENV_ENTRIES, AUTOMODE_SOFT_DENY_ENTRY } from './lib/settings/automode-entries';
import { writeFileAtomic } from './lib/md-write';

type Json = any;

const CONFIG_PATH = '.claude-code-hermit/config.json';
const PROFILE_LEVELS: Record<string, number> = { minimal: 0, standard: 1, strict: 2 };

/**
 * Which launch this is. Decided once at `main()` from the tmux flag and tmux's
 * availability, and passed down rather than re-derived — `config.always_on` is
 * not written until much later in the boot, so anything reading that flag to
 * decide launch behavior gets last boot's answer on a first run.
 */
type BootMode = 'interactive' | 'tmux';

/**
 * The hook profile a launch gets when nobody has said otherwise.
 *
 * A managed (tmux) hermit runs unattended, so it defaults to `strict` — that is
 * what makes the config.json / OPERATOR.md / settings guards in
 * deny-patterns.json actually enforce, and it is what a Docker hermit has always
 * had via its compose environment block. An interactive launch stays `standard`:
 * the operator is present, and the strict set is scoped to the unattended
 * session by design — the native `permissions.deny` list is the one that reaches
 * an operator's own sessions, which is why the two legitimately differ.
 */
function defaultProfileFor(bootMode: BootMode): string {
  return bootMode === 'tmux' ? 'strict' : 'standard';
}

/**
 * Resolve the hook profile for this launch, and say where it came from.
 *
 * Precedence is ambient > config > mode default. Ambient wins because it is the
 * deployment speaking (Docker's compose block, or an operator's one-off
 * `AGENT_HOOK_PROFILE=… hermit-start`), which is more specific than a value
 * committed to config.json.
 *
 * Every source is validated and floored the same way. That is a change: the old
 * code computed a profile, then only wrote it to `process.env` when nothing was
 * already there — so an ambient `minimal`, or an ambient typo, bypassed both the
 * validation and the "non-negotiable" always-on floor entirely and became what
 * the session actually ran at. An invalid value falls back to the mode default
 * rather than the global one, so a garbled managed launch fails safe (strict)
 * instead of quietly weakening itself.
 */
function resolveHookProfile(
  config: Json,
  bootMode: BootMode,
): { profile: string; source: 'ambient' | 'config' | 'default'; warning: string | null } {
  const fallback = defaultProfileFor(bootMode);
  const ambient = process.env.AGENT_HOOK_PROFILE;
  const configured = (config?.env ?? {}).AGENT_HOOK_PROFILE;

  let source: 'ambient' | 'config' | 'default' = 'default';
  let raw: unknown = undefined;
  if (ambient !== undefined && ambient !== '') {
    source = 'ambient';
    raw = ambient;
  } else if (configured !== undefined && configured !== null && configured !== '') {
    source = 'config';
    raw = configured;
  }

  let warning: string | null = null;
  let profile = fallback;
  if (source !== 'default') {
    // Normalized the way the hooks themselves read it (hook-input.ts
    // hookProfile()), so an ambient `Strict` resolves to strict rather than
    // being rejected as invalid and silently demoted to the mode default. A
    // non-string config value has no normalized form and so falls through to
    // the warning, rather than being mislabelled as the mode default.
    const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (normalized in PROFILE_LEVELS) {
      profile = normalized;
    } else {
      warning = `[hermit] Warning: invalid AGENT_HOOK_PROFILE=${String(raw)} from ${source}, using ${fallback}`;
      source = 'default';
    }
  }

  // The always-on floor, applied to every source rather than only to config.
  if (bootMode === 'tmux') {
    const floor = 'standard'; // non-negotiable minimum for a managed session
    if (PROFILE_LEVELS[profile] < PROFILE_LEVELS[floor]) {
      warning = `[hermit] Warning: AGENT_HOOK_PROFILE=${profile} below always-on floor, forcing to ${floor}`;
      profile = floor;
    }
  }

  return { profile, source, warning };
}

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');

const DEFAULT_CONFIG: Json = {
  _hermit_versions: {},
  agent_name: null,
  language: null,
  timezone: null,
  escalation: 'balanced',
  operator_profile: 'technical',
  sign_off: null,
  channels: {},
  remote: true,
  model: 'sonnet',
  effort: null,
  permission_mode: 'auto',
  tmux_session_name: 'hermit-{project_name}',
  auto_session: true,
  always_on: false,
  chrome: false,
  push_notifications: true,
  ask_gate: true,
  settings_from_chat: true,
  idle_behavior: 'discover',
  routines: [
    { id: 'heartbeat-restart', schedule: '0 4 * * *', skill: 'claude-code-hermit:hermit-routines load', run_during_waiting: true, enabled: true },
    { id: 'reflect', schedule: '0 9 * * *', skill: 'claude-code-hermit:reflect', enabled: true },
    { id: 'scheduled-checks', schedule: '5 9 * * *', skill: 'claude-code-hermit:reflect --scheduled-checks', run_during_waiting: true, enabled: true },
    { id: 'weekly-review', schedule: '0 23 * * 0', skill: 'claude-code-hermit:weekly-review', enabled: true },
    { id: 'daily-auto-close', schedule: '0 0 * * *', skill: 'claude-code-hermit:session-close --scheduled', model: 'haiku', run_during_waiting: true, enabled: true, precheck: 'auto-close' },
    { id: 'doctor', schedule: '10 9 * * 1', skill: 'claude-code-hermit:hermit-doctor --maintainer', model: 'haiku', run_during_waiting: true, enabled: true, precheck: 'doctor', precheck_timeout_s: 120 },
  ],
  monitors: [],
  // No AGENT_HOOK_PROFILE here, and none in config.json.template either. Its
  // absence is the signal that the operator has expressed no preference, which
  // is what lets writeSettingsEnv default a managed launch to `strict`. Seeding
  // it would make every hermit look like it had chosen `standard` deliberately.
  env: {
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '65',
    MAX_THINKING_TOKENS: '10000',
  },
  boot_skill: null,
  shutdown_skill: null,
  scheduled_checks: [],
  docker: {
    packages: [],
    recommended_plugins: [],
  },
  compact: {
    monitoring_threshold: 30,
    monitoring_keep: 20,
    summary_threshold: 30,
    summary_keep: 15,
  },
  heartbeat: {
    enabled: true,
    every: '30m',
    active_hours: {
      start: '08:00',
      end: '23:00',
    },
    stale_threshold: '2h',
    waiting_timeout: null,
    clean_recheck_cooldown: '6h',
    model: 'haiku',
  },
  quality_gate: {
    tier: 'budget',
  },
  knowledge: {
    raw_retention_days: 14,
    compiled_budget_chars: 2500,
    working_set_warn: 20,
    usage_stale_days: 30,
    usage_auto_archive: true,
    archive_retention_days: null,
    channel_log_enabled: true,
    channel_log_retention_days: 90,
  },
  // wedge_floor is deliberately template-only, not part of this boot merge: the
  // always-on branch writes the merged config back to disk, and stamping the `4h`
  // default there on a restart would look like an operator-set value to the
  // upgrade that derives wedge_floor from the pre-upgrade threshold. The watchdog
  // reads it through lib/config-read, which supplies the same default.
  watchdog: {
    enabled: false,
    stale_factor: 2,
    escalate_after: 3,
    operator_grace: '15m',
    context_clear_tokens: 700000,
  },
  budget: {
    daily_usd: null,
    weekly_usd: null,
    monthly_usd: null,
    action: 'alert',
  },
  telemetry_export: {
    _note: 'Operator-directed health/cost export to your own webhook. Inert until you set destination.url. Never sent to plugin authors.',
    enabled: false,
    destination: { type: 'webhook', url: null, bearer_env: 'HERMIT_TELEMETRY_TOKEN' },
    interval_hours: 24,
    redact_operator_text: true,
  },
  artifacts: {
    dashboard: true,
    proposals: true,
    weekly_review: true,
    publish_authorized: null,
    backend: 'claude',
  },
  context_hygiene: {
    compact: {
      enabled: true,
      min_context_tokens: 100000,
      min_interval: '4h',
    },
  },
  reflection: {
    graduation_min_sessions: 1,
  },
  routine_wake_lint: {
    max_windows: 6,
  },
  doctor: {
    routine_cost_floor_usd: 2,
  },
  storage_drift: {
    ignore: [],
  },
  post_close_clear: true,
};

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

/** Python shlex.quote: safe chars pass through, everything else single-quoted. */
function shlexQuote(s: string): string {
  if (s === '') return "''";
  if (!/[^A-Za-z0-9_@%+=:,./-]/.test(s)) return s;
  return "'" + s.replaceAll("'", "'\"'\"'") + "'";
}

/** Join args into a shell-safe string using shlexQuote. */
function shlexJoin(args: string[]): string {
  return args.map(shlexQuote).join(' ');
}

/** True when config.json exists but could not be parsed — gates the write-back. */
let configReadFailed = false;

/** Load config.json or return defaults. */
function loadConfig(): Json {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(`[hermit] No config found at ${CONFIG_PATH}`);
    console.log('[hermit] Run /claude-code-hermit:hatch inside Claude Code first.');
    process.exit(1);
  }

  // Malformed JSON no longer aborts the boot: fail open to the defaults merge
  // below (validate-config and doctor surface the corruption). The always-on
  // branch writes config.json back, so record the failure — writing the merged
  // defaults over an unparseable file would destroy the operator's config.
  const raw = readConfigRaw(path.dirname(CONFIG_PATH));
  configReadFailed = raw === null;
  const config: Json = raw ?? {};

  // Merge with defaults — shallow for top-level, deep for nested dicts.
  // This boot-time merge deliberately SEEDS containers (routines, env) for
  // sparse configs — different from lib/config-read's read-path settling,
  // which settles missing containers to empty.
  // Values in config may be null (JSON null), so fall back to {} for spreading.
  const merged: Json = { ...DEFAULT_CONFIG, ...config };
  for (const [key, def] of Object.entries(DEFAULT_CONFIG)) {
    if (isDict(def)) {
      merged[key] = { ...(def as Json), ...(config[key] || {}) };
    }
  }
  // One more level for heartbeat.active_hours
  if ('active_hours' in (DEFAULT_CONFIG.heartbeat ?? {})) {
    const mergedHb = merged.heartbeat ?? {};
    mergedHb.active_hours = {
      ...DEFAULT_CONFIG.heartbeat.active_hours,
      ...((config.heartbeat || {}).active_hours || {}),
    };
    merged.heartbeat = mergedHb;
  }
  return merged;
}

// One-way ratchet: an always-on boot upgrades template-default doctor fields.
// Only exact known defaults move forward; operator-customized schedules and
// skill arguments are left alone. Does not downgrade the schedule on stop; a
// box that reverts to interactive keeps daily doctor, which is harmless.
//
// The set has three entries, not one, because it must recognize schedules from
// every prior template generation: '0 10 * * 1' is the pre-clustering weekly
// default, '10 9 * * 1' is the current (clustered) weekly default, and
// '0 10 * * *' is what THIS ratchet itself already wrote for any hermit that
// went always-on before clustering shipped — those live fleet hermits are the
// primary reason for the entry, since without it they'd read as "custom" and
// never pick up the clustered daily schedule (the CHANGELOG's evolve-time
// migration is the primary path for already-installed hermits; this ratchet is
// the deterministic backstop for installs that skip that step, or that switch
// from interactive to always-on later).
const KNOWN_DEFAULT_SCHEDULES = ['0 10 * * 1', '10 9 * * 1', '0 10 * * *'];
const DOCTOR_DAILY_SCHEDULE = '10 9 * * *';
const LEGACY_DOCTOR_SKILL = 'claude-code-hermit:hermit-doctor';
const MAINTAINER_DOCTOR_SKILL = 'claude-code-hermit:hermit-doctor --maintainer';

function applyAlwaysOnDoctorSchedule(config: Json): void {
  const routine = Array.isArray(config.routines)
    ? config.routines.find((r: Json) => r?.id === 'doctor')
    : null;
  if (routine && KNOWN_DEFAULT_SCHEDULES.includes(routine.schedule)) {
    routine.schedule = DOCTOR_DAILY_SCHEDULE;
  }
  if (routine?.skill === LEGACY_DOCTOR_SKILL) {
    routine.skill = MAINTAINER_DOCTOR_SKILL;
  }
}

/** Print a notice when the loaded plugin and the applied config stamp disagree.
 *  Which way they disagree decides the remedy, so the direction is compared, never
 *  just equality: plugin newer means an upgrade is pending, plugin OLDER means this
 *  boot resolved a stale copy and evolve is the wrong tool (it would no-op, or
 *  downgrade the applied stamp). Unparseable either side stays silent.
 *
 *  The remedy differs from check-upgrade.sh's on purpose: that one runs from the
 *  SessionStart hook against the installed plugin (a `claude plugin list` entry), while
 *  bin/hermit-run resolves PLUGIN_ROOT by scanning the marketplace clone, which never
 *  appears in that listing — so this surface points at the marketplace refresh. */
function checkForUpgrade(config: Json): void {
  const pluginJson = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
  try {
    const pluginVer = JSON.parse(fs.readFileSync(pluginJson, 'utf-8')).version ?? '0.0.0';
    const configVer = (config._hermit_versions ?? {})['claude-code-hermit'] ?? '0.0.0';
    const rel = cmpSemver(pluginVer, configVer);
    if (rel > 0) {
      console.log(`[hermit] Upgrade available: v${configVer} -> v${pluginVer}`);
      console.log('[hermit] Run /claude-code-hermit:hermit-evolve inside Claude Code');
    } else if (rel < 0) {
      console.log(`[hermit] Stale plugin runtime: boot scripts loaded v${pluginVer} from ${PLUGIN_ROOT},`);
      console.log(`[hermit] older than this hermit's applied state v${configVer}. hermit-evolve cannot fix this.`);
      console.log('[hermit] Run: claude plugin marketplace update claude-code-hermit');
    }
  } catch {}
}

/** Parse up to the first three dot-separated version parts as integers (null on garbage). */
function parseVersionTuple(v: string): number[] | null {
  const nums: number[] = [];
  for (const p of v.split('.').slice(0, 3)) {
    if (!/^\d+$/.test(p.trim())) return null; // Python int() would raise ValueError
    nums.push(parseInt(p, 10));
  }
  return nums;
}

/** Python tuple comparison: element-wise, shorter prefix sorts first. */
function versionLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

/** Check that required tools are available. */
function checkPrerequisites(): Json {
  const errors: string[] = [];

  // PATH, not a missing install, is the usual culprit here: a watchdog systemd
  // unit baked before the Environment=PATH fix starts us with a near-empty PATH,
  // so both probes below miss tools that are demonstrably present.

  // Claude Code
  if (!Bun.which('claude')) {
    errors.push(
      'claude: Claude Code CLI not on PATH. Install from https://claude.ai/download, ' +
        'or re-run `bin/hermit-watchdog install` if this started from a systemd unit.',
    );
  }

  // tmux (optional but recommended)
  const hasTmux = Bun.which('tmux') !== null;

  // bun (required runtime for hooks/scripts since the bun migration)
  const hasBun = Bun.which('bun') !== null;
  if (!hasBun) {
    errors.push(
      'bun: required runtime not on PATH. Install with `curl -fsSL https://bun.sh/install | bash`, ' +
        'or re-run `bin/hermit-watchdog install` if this started from a systemd unit.',
    );
  } else {
    // Already running under bun, so Bun.version is a free in-process probe.
    const bunVersion = Bun.version.trim();
    let required = '1.3.0';
    try {
      const metaPath = path.join(PLUGIN_ROOT, '.claude-plugin', 'hermit-meta.json');
      const declared = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).required_bun_version;
      if (pyTruthy(declared)) required = String(declared).replace(/^[>=]+/, '').trim();
    } catch {} // unreadable meta — fall back to the baseline floor
    const cur = parseVersionTuple(bunVersion);
    const req = parseVersionTuple(required);
    // unparseable version — don't block boot on the probe itself
    if (cur && req && versionLess(cur, req)) {
      errors.push(`bun: version ${bunVersion} below required ${required}. Upgrade: bun upgrade`);
    }
  }

  if (errors.length) {
    for (const err of errors) console.log(`[hermit] ERROR: ${err}`);
    process.exit(1);
  }

  return { tmux: hasTmux, bun: hasBun };
}

/** Check for stale runtime state from a previous run and warn. */
function checkStaleRuntime(config: Json, sessionName: string): void {
  const runtime = readRuntimeJson();
  if (runtime === null) return;

  const state = runtime.session_state;
  const mode = runtime.runtime_mode;
  const shutdownCompleted = runtime.shutdown_completed_at;

  if (['in_progress', 'waiting', 'suspect_process'].includes(state)) {
    if (mode === 'tmux' || mode === 'docker') {
      // Check if the tmux session from the previous run still exists
      const prevTmux = 'tmux_session' in runtime ? runtime.tmux_session : '';
      if (!tmuxSessionAlive(prevTmux)) {
        console.log(
          `[hermit] Warning: Previous session crashed (runtime.json says ${state}, tmux session "${prevTmux}" is gone).`,
        );
        console.log('[hermit] /session-start will offer recovery.');
        runtime.last_error = 'unclean_shutdown';
        writeRuntimeJson(runtime);
      }
    } else if (mode === 'interactive' && !pyTruthy(shutdownCompleted)) {
      console.log('[hermit] Warning: Previous interactive session did not close cleanly.');
      console.log('[hermit] /session-start will offer recovery.');
      runtime.last_error = 'unclean_shutdown';
      writeRuntimeJson(runtime);
    }
  }

  if (runtime.last_error === 'session_died_on_boot') {
    console.log('[hermit] Note: previous start failed (tmux session died on boot).');
  }

  // Check for interrupted transitions
  const transition = runtime.transition;
  if (pyTruthy(transition)) {
    const target = 'transition_target' in runtime ? runtime.transition_target : 'unknown';
    console.log(`[hermit] Warning: Interrupted transition detected: ${transition} (target: ${target})`);
    console.log('[hermit] /session-start will resume or clean up.');
  }
}

/**
 * Clears shutdown_requested_at/shutdown_completed_at on an existing runtime.json
 * before a fresh hermit-start boot. A deliberate start supersedes any prior
 * shutdown intent — a stamp left over from a non-hermit-stop close (a nightly
 * auto-close reusing /session-close's "Full Shutdown" framing while the always-on
 * process stays alive) otherwise bricks watchdog restart recovery AND
 * context-hygiene compaction/clear forever, since passesLifecycleGuards treats any
 * non-null stamp as "the hermit is stopping". Mutates `existing` in place.
 */
function clearShutdownStampsOnBoot(existing: Json): void {
  existing.shutdown_requested_at = null;
  existing.shutdown_completed_at = null;
}

/**
 * Removes the sessions/.status.json cost cache on an always-on boot. cost-tracker
 * writes the current harness session id there each turn, and the watchdog's idle-phase
 * hygiene fallback (resolveHygieneSessionId) reads it when no S-NNN arc is open. Across
 * a restart the harness session id changes, but the old file survives until the first
 * post-boot turn rewrites it — a stale pointer that would make the watchdog resolve the
 * DEFUNCT prior session's last (possibly bloated) cost entry and fire a spurious /compact
 * or /clear into the fresh, near-empty context. Removing it here makes the fallback
 * return "no session id" (a clean skip) until a real turn re-populates it. cost-tracker
 * treats a missing file as first-run and rebuilds cumulative totals from the index, so
 * nothing is lost.
 *
 * The watchdog also imports this and calls it mid-run at context-reset time (post-close
 * and emergency /clear in hermit-watchdog.ts) for the same reason: once /clear destroys a
 * context, its last cost entry is stale, and the same fallback must not resolve it into a
 * spurious /compact against the fresh context.
 */
function clearStatusCacheOnBoot(): void {
  clearStatusCache(path.join(STATE_DIR, '..'));
}

/**
 * Stamps a fresh per-process nonce at state/.boot-id on every always-on boot.
 * `routines.ts cron-registry` (the hermit-routines diff planner) compares this against the
 * boot_id stored in its state/cron-registry.json mirror: a mismatch means the
 * mirror describes a prior process's CronCreates, which durable:false already
 * killed on exit, so the planner treats every enabled routine as CREATE with no
 * matching DELETE (nothing live to tear down). Written unconditionally, before
 * hermit-routines load's first run, so the very first load after boot always
 * sees a mismatch and does a full (and correct) re-registration.
 */
function writeBootId(): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, '.boot-id'), randomUUID() + '\n');
  } catch {}
}

/** Acquire exclusive lifecycle lock. Exits on contention. */
function acquireLifecycleLock(): void {
  if (process.platform === 'win32') {
    console.log('[hermit] Always-on mode requires Linux, macOS, or WSL2. See https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/faq.md.');
    process.exit(1);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!acquireLock(LIFECYCLE_LOCK)) {
    console.log('[hermit] Another lifecycle operation in progress. Aborting.');
    process.exit(1);
  }
  // The Python flock released automatically on process death (and on exec,
  // via O_CLOEXEC). The link-based lock needs an explicit unlink — release
  // it on every exit path, including the process.exit() calls sprinkled
  // through boot.
  process.on('exit', () => releaseLock(LIFECYCLE_LOCK));
}

const CHANNEL_PLUGINS: Record<string, string> = {
  discord: 'plugin:discord@claude-plugins-official',
  telegram: 'plugin:telegram@claude-plugins-official',
  imessage: 'plugin:imessage@claude-plugins-official',
};

/**
 * Return registered marketplaces as [{name: string, repo: string|null}, ...].
 *
 * Returns null when the call fails or the output is unrecognized — caller
 * must treat null as "skip pre-flight" (fail-soft). A returned list (even
 * empty) means the check ran and is authoritative.
 */
function fetchRegisteredMarketplaces(): Json[] | null {
  try {
    const result = spawnSync('claude', ['plugin', 'marketplace', 'list', '--json'], {
      timeout: 10_000,
      encoding: 'utf-8',
    });
    if (result.status !== 0) return null;
    const data = JSON.parse(result.stdout);
    if (!Array.isArray(data)) return null;
    const entries: Json[] = [];
    for (const item of data) {
      if (isDict(item) && typeof item.name === 'string') {
        entries.push({
          name: item.name,
          repo: typeof item.repo === 'string' ? item.repo : null,
        });
      }
    }
    return entries;
  } catch {
    return null;
  }
}

/** Resolve a state_dir path (absolute pass-through, relative against cwd). */
function resolveStateDir(stateDir: string): string {
  return path.isAbsolute(stateDir) ? stateDir : path.join(process.cwd(), stateDir);
}

/** A channel's configured state_dir, or the conventional default. */
function channelStateDir(name: string, cfg: Json): string {
  return pyTruthy(cfg.state_dir) ? cfg.state_dir : path.join('.claude.local', 'channels', name);
}

/** Read one line from stdin (Python input(): prompt to stdout, EOF → ''). */
function inputLine(promptText: string): string {
  process.stdout.write(promptText);
  const buf = Buffer.alloc(1);
  let line = '';
  try {
    while (true) {
      const n = fs.readSync(0, buf, 0, 1, null);
      if (n === 0) break; // EOF
      const ch = buf.toString('utf-8', 0, n);
      if (ch === '\n') break;
      line += ch;
    }
  } catch {
    return ''; // unreadable stdin — Python raises EOFError, caller used ''
  }
  return line;
}

/** Build the claude launch command from config. */
function buildClaudeCommand(config: Json, tools: Json): string[] {
  const cmd = ['claude'];

  let enabledChannels = getEnabledChannels(config);
  if (enabledChannels.length) {
    // Bun is required for all channel plugins.
    if (!pyTruthy(tools.bun)) {
      const names = enabledChannels.join(', ');
      console.log(`[hermit] WARNING: channels skipped (${names}) — bun is not installed.`);
      console.log('[hermit]   Install bun: https://bun.sh');
      console.log('[hermit]   Then run /claude-code-hermit:channel-setup to activate.');
      enabledChannels = [];
    }

    const activeChannels: string[] = [];
    for (const [channel, chCfg] of iterChannelConfigs(config)) {
      if (!enabledChannels.includes(channel)) continue;

      // Warn if the token file is missing — still add the channel so the
      // plugin can surface its own auth error.
      const stateDir = channelStateDir(channel, chCfg);
      if (!fs.existsSync(path.join(resolveStateDir(stateDir), '.env'))) {
        console.log(`[hermit] WARNING: channel "${channel}" has no token configured.`);
        console.log('[hermit]   Run /claude-code-hermit:channel-setup to add it.');
      }

      activeChannels.push(channel);
    }

    if (activeChannels.length) {
      const channelCfgs: Json = Object.fromEntries(iterChannelConfigs(config));
      const registered = fetchRegisteredMarketplaces(); // null = skip pre-flight
      const registeredNames = new Set((registered ?? []).map((e: Json) => e.name));

      const channelArgs: string[] = [];
      for (const channel of activeChannels) {
        let pluginId: string | undefined = CHANNEL_PLUGINS[channel];
        if (!pluginId) {
          // Fall back to channels.<name>.marketplace for third-party channel
          // plugins (custom marketplaces, forks, operator-built channels).
          const marketplace = (channelCfgs[channel] ?? {}).marketplace;
          if (pyTruthy(marketplace)) {
            pluginId = `plugin:${channel}@${marketplace}`;
          }
        }

        if (pluginId) {
          if (registered !== null) {
            const at = pluginId.indexOf('@');
            const marketplaceName = at !== -1 ? pluginId.slice(at + 1) : '';
            if (at !== -1 && marketplaceName) {
              if (!registeredNames.has(marketplaceName)) {
                const repoMatch = registered.find((e: Json) => e.repo === marketplaceName) ?? null;
                if (repoMatch) {
                  console.log(
                    `[hermit] WARNING: channel "${channel}" — "${marketplaceName}" is a repo path, not a marketplace name.`,
                  );
                  console.log(`[hermit]   That repo IS registered as "${repoMatch.name}".`);
                  console.log(
                    `[hermit]   Fix: set channels.${channel}.marketplace = "${repoMatch.name}" in config.json`,
                  );
                } else {
                  console.log(
                    `[hermit] WARNING: channel "${channel}" — marketplace "${marketplaceName}" is not registered with claude.`,
                  );
                  console.log('[hermit]   Fix: claude plugin marketplace add <repo>');
                }
                console.log(
                  `[hermit]   Dropping "${channel}" from --channels to avoid silent boot with no channels active.`,
                );
                continue;
              }
            }
          }
          channelArgs.push(pluginId);
        } else {
          if (channel.startsWith('-')) {
            console.log(
              `[hermit] WARNING: channel "${channel}" starts with "-" — refusing to pass as a bare arg (looks like a CLI flag).`,
            );
            continue;
          }
          console.log(
            `[hermit] WARNING: unrecognized channel "${channel}" — expected discord, telegram, or imessage (or set channels.${channel}.marketplace in config.json)`,
          );
          channelArgs.push(channel);
        }
      }

      if (channelArgs.length) {
        cmd.push('--channels', ...channelArgs);
      }
    }
  }

  // Add remote control for web/mobile access (with session name)
  if (pyTruthy('remote' in config ? config.remote : false)) {
    const remoteName = config.agent_name || getSessionName(config);
    cmd.push('--remote-control', remoteName);
  }

  if (pyTruthy(config.chrome)) {
    if (isContainer()) {
      console.log('[hermit] WARNING: chrome=true ignored — browser not available in containers.');
    } else {
      cmd.push('--chrome');
    }
  }

  // Auto-mode classifier policy for THIS session only — see
  // renderClassifierOverlay(). Written fresh each boot; absent on write failure,
  // which degrades the classifier to its defaults rather than blocking the boot.
  const overlay = renderClassifierOverlay(config);
  if (overlay) {
    cmd.push('--settings', overlay);
  }

  if (pyTruthy(config.model)) {
    cmd.push('--model', config.model);
  }

  // Re-asserted on every boot for the same reason as --model: a runtime /effort writes
  // through to the user-scope settings default ("saved as your default for new
  // sessions"), and the boot flag outranks it — so a channel-requested effort change
  // reverts on restart instead of silently becoming permanent. NOT the same lever as
  // config.env.CLAUDE_CODE_EFFORT_LEVEL, which pins the session and would make a
  // runtime /effort a no-op (see the how-to-use guide).
  if (pyTruthy(config.effort)) {
    cmd.push('--effort', config.effort);
  }

  const mode = 'permission_mode' in config ? config.permission_mode : 'auto';
  if (mode === 'bypassPermissions') {
    if (!isContainer()) {
      console.log('[hermit] WARNING: bypassPermissions is intended for containers/VMs only.');
      console.log('[hermit] You appear to be running on a host machine.');
      const answer = inputLine('[hermit] Continue anyway? [y/N] ').trim().toLowerCase();
      if (answer !== 'y') {
        console.log('[hermit] Aborted. Change permission_mode in config.json or use a container.');
        process.exit(1);
      }
    }
    cmd.push('--dangerously-skip-permissions');
  } else if (['acceptEdits', 'plan', 'dontAsk', 'auto'].includes(mode)) {
    cmd.push('--permission-mode', mode);
  } else if (mode !== 'default' && mode !== null) {
    console.log(`[hermit] WARNING: unknown permission_mode "${mode}" — skipping (using default)`);
  }

  return cmd;
}

/**
 * Write config env vars to .claude/settings.local.json.
 *
 * Claude Code reads the `env` key from settings.json and exports those
 * values to hooks and Bash tool calls. It does NOT reach plugin MCP servers
 * (anthropics/claude-code#11927, open), so anything a channel plugin needs is
 * also hydrated into process.env here — see the channel loop below.
 *
 * Auth vars (ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR) are NOT written here —
 * they must be in the shell env before claude launches. OAuth credentials
 * live in .credentials.json (written by `claude /login`).
 */
/**
 * Returns the resolved hook profile so the caller can report it. Returned rather
 * than stashed in a module variable: the launch banner is printed before this
 * runs, so a side-channel global is read while still unset and the line never
 * appears.
 */
function writeSettingsEnv(
  config: Json,
  bootMode: BootMode = 'interactive',
): { profile: string; source: string } {
  const settingsPath = '.claude/settings.local.json';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  // A file that exists but doesn't parse is NOT an empty file. Falling back to
  // {} and writing would rewrite it from scratch and destroy whatever the
  // operator has in it — including their own /config choices, which now live
  // alongside the keys this function writes. Suppress only the WRITE: the rest
  // of this function has process-scoped side effects (AGENT_HOOK_PROFILE and
  // every channel's *_STATE_DIR reach the session through process.env, not
  // through this file), and skipping those would silently drop the always-on
  // hook profile and leave channel MCP servers without a state dir.
  let settings: Json = {};
  let skipWrite = false;
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (!isDict(parsed)) throw new Error('not a JSON object');
      settings = parsed;
    } catch {
      console.log(
        `[hermit] WARNING: ${settingsPath} is not valid JSON — skipping boot settings write so the file is left intact. Fix or remove it, then restart.`,
      );
      skipWrite = true;
    }
  }

  if (!('env' in settings)) settings.env = {};

  const envVars: Json = { ...('env' in config ? config.env : {}) }; // copy — don't mutate config

  // AGENT_HOOK_PROFILE is process-scoped: forwarded via tmux env file or
  // docker-compose environment block. NOT written to settings.local.json,
  // which is shared between container and host via bind mount.
  delete envVars.AGENT_HOOK_PROFILE;
  const resolved = resolveHookProfile(config, bootMode);
  if (resolved.warning) console.log(resolved.warning);
  // Assigned unconditionally. The old `=== undefined` guard meant an ambient
  // value was never re-written, so it escaped validation and the floor above and
  // became the session's real profile whatever it said.
  process.env.AGENT_HOOK_PROFILE = resolved.profile;

  if (pyTruthy(envVars)) {
    Object.assign(settings.env, envVars);
  }

  // Migration: remove AGENT_HOOK_PROFILE from settings.local.json if present
  // (older versions wrote it there, causing host/container leak)
  delete settings.env.AGENT_HOOK_PROFILE;

  // MCP servers (channel plugins) are separate processes that inherit OS env —
  // they don't read settings.local.json directly. Without *_STATE_DIR the
  // plugin defaults to ~/.claude/channels/<plugin>/, which is lost on Docker
  // container restart.
  const claimedStateDirKeys = new Set<string>();
  for (const [chName, chCfg] of iterChannelConfigs(config)) {
    const stateDir = channelStateDir(chName, chCfg);
    // Guard rationale: see channelStateDirKey in lib/channel-config.ts. The
    // forwardVars loop in main() drops the same names for that reason.
    const key = channelStateDirKey(chName);
    if (!key) {
      console.log(`[hermit] Warning: channel "${chName}" has no valid env-var name — ${chName.toUpperCase()}_STATE_DIR not exported.`);
      continue;
    }
    claimedStateDirKeys.add(key);
    // Relative paths resolved against project root (cwd at boot).
    settings.env[key] = resolveStateDir(stateDir);
    // Both bare-host launches read the value from here: the tmux path copies
    // it into the env file it sources, the no-tmux path inherits it via execvp.
    // Truthiness, not presence: an empty ambient value (a profile leak, an unset
    // compose interpolation) would otherwise win over the config path and hand
    // the MCP server an empty state dir — an empty state dir is never intent.
    if (!pyTruthy(process.env[key])) {
      process.env[key] = settings.env[key]; // already-set (Docker/compose) wins
    }
  }

  // Drop *_STATE_DIR keys no configured channel claims — pre-guard cruft, or a
  // channel that was removed or renamed since the key was written. (A merely
  // disabled channel still claims its key: the loop above iterates every
  // configured channel, enabled or not.) Two exemptions, both about not
  // destroying state on someone else's behalf:
  //   - keys the operator put in config.env, which was merged into settings.env
  //     above — that block is operator-owned and `_STATE_DIR` is not a reserved
  //     suffix there (`HERMIT_STATE_DIR` is a real one). Sweeping them would
  //     delete-and-readd forever, and the var would never reach the session.
  //   - everything, when config.json failed to parse: loadConfig fails open to
  //     defaults, so `channels` is empty and every live channel would look
  //     stale. Same reason the config write-back is gated on this flag.
  const configEnvKeys = new Set(Object.keys(envVars));
  const staleStateDirKeys = configReadFailed
    ? []
    : Object.keys(settings.env).filter(
        (k) =>
          k.endsWith('_STATE_DIR') && !claimedStateDirKeys.has(k) && !configEnvKeys.has(k),
      );
  for (const key of staleStateDirKeys) delete settings.env[key];
  if (staleStateDirKeys.length) {
    console.log(`[hermit] Cleaned stale state-dir vars from settings.local.json: ${staleStateDirKeys.join(', ')}`);
  }

  // Remove channel bot tokens — they must only live in
  // .claude.local/channels/<plugin>/.env. A stale token here
  // overrides the file via process.env and fails silently.
  const staleKeys = Object.keys(settings.env).filter((k) => k.endsWith('_BOT_TOKEN'));
  for (const key of staleKeys) delete settings.env[key];
  if (staleKeys.length) {
    console.log(`[hermit] Cleaned stale token vars from settings.local.json: ${staleKeys.join(', ')}`);
  }

  // hermit-start does not own sandbox.enabled — that's a hatch/operator decision;
  // hermit-evolve migrates existing installs. Here we only strip the obsolete
  // enableWeakerNestedSandbox key that older versions wrote on container boot.
  let sandbox = settings.sandbox || {};
  if (!isDict(sandbox)) sandbox = {};
  delete sandbox.enableWeakerNestedSandbox;
  if (pyTruthy(sandbox)) {
    settings.sandbox = sandbox;
  } else {
    delete settings.sandbox;
  }

  // Voice carrier. Seed the style key only when the hermit's voice file is
  // actually present (an install that never adopted it stays untouched) and
  // only when nothing owns the key — a style the operator chose in /config is
  // their decision, and hermit-doctor reports the mismatch rather than boot
  // silently reclaiming it every restart. The absence test spans both project
  // scopes, not just this file's key: hatch may have stamped the key into
  // committed settings.json, and seeding a duplicate here would put a
  // local-scope copy in front of it that outranks — and permanently shadows —
  // any later /config change made at project scope. It stops there: user scope
  // ranks below both, so a value there cannot shadow this write and must not
  // block a repair that would have taken effect.
  if (!skipWrite && voiceFileExists() && resolveProjectStyle().value === null) {
    settings.outputStyle = HERMIT_OUTPUT_STYLE;
    console.log(`[hermit] Voice: outputStyle set to ${HERMIT_OUTPUT_STYLE} in ${settingsPath}`);
  }

  // Language mirror. config.json stays authoritative — it is what the
  // deterministic senders (watchdog, cost alerts, deny notices) localize from,
  // outside any session. This derives the native key so the main session also
  // gets it from the system prompt instead of session-start context alone.
  // Sanitized because the value reaches a prompt and `hermit-settings language`
  // can be driven from a channel turn.
  const mirroredLanguage = sanitizeLanguage(config.language);
  if (mirroredLanguage) settings.language = mirroredLanguage;
  else delete settings.language;

  // Malformed file — warned above, left byte-for-byte intact. The profile is
  // still resolved and exported, so a bad settings file cannot silently drop the
  // session to a weaker set of deny patterns.
  if (skipWrite) return { profile: resolved.profile, source: resolved.source };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  if (pyTruthy(envVars)) {
    console.log(`[hermit] Env: ${Object.keys(envVars).length} vars written to .claude/settings.local.json`);
  }

  // Narrowed to the declared shape: `warning` is already consumed above, and
  // handing it back would let a caller print it a second time.
  return { profile: resolved.profile, source: resolved.source };
}

/**
 * Boot-time artifact publish grant. Runs pre-launch in the operator's shell —
 * outside any Claude session, so the auto-mode classifier is not in play. This
 * is the out-of-session executor for the decision a channel reply recorded in
 * config.artifacts.publish_authorized (a channel reply may only flip hermit
 * config, never permissions — this is where the permission write happens).
 * Idempotent and self-healing: sealed set-merges, re-ensured every boot.
 *
 * Scoped to the default backend. What it grants is the native Artifact tool —
 * exactly the tool a hermit on a non-claude artifacts.backend must never call
 * (the artifacts doc's § Non-claude backend deviations forbids that fallback).
 * A standing grant there would pre-approve, prompt-free, the one publish the
 * operator configured a backend to prevent.
 */
function applyArtifactGrant(config: Json): void {
  if (!artifactGrantApplies(config)) return;
  const script = path.join(PLUGIN_ROOT, 'scripts', 'apply-settings.ts');
  const r = spawnSync('bun', [script, '.claude/settings.local.json', 'artifact-allow'], { stdio: 'pipe', encoding: 'utf-8' });
  if (r.status !== 0) {
    console.log(`[hermit] WARNING: boot grant 'artifact-allow' failed: ${(r.stderr || '').trim()} — continuing boot.`);
    return;
  }
  console.log('[hermit] Artifact publish grant ensured (permissions.allow in .claude/settings.local.json)');
}

/**
 * Does the artifact publish grant apply — a page enabled, explicit
 * authorization, and the default/claude backend?
 *
 * Shared by applyArtifactGrant (which performs the boot-time permission
 * write) and renderClassifierOverlay (whose sealed self-maintenance entries
 * exist to clear exactly that write, so they ship only where it is live).
 */
function artifactGrantApplies(config: Json): boolean {
  const artifacts = isDict(config.artifacts) ? config.artifacts : {};
  const anyPage = ['dashboard', 'proposals', 'weekly_review'].some((k) => pyTruthy(artifacts[k]));
  if (!anyPage || artifacts.publish_authorized !== true) return false;
  const backend = typeof artifacts.backend === 'string' ? artifacts.backend.trim() : '';
  return backend === '' || backend === 'claude';
}

/**
 * Render the per-session auto-mode classifier overlay and return its absolute
 * path (null when it could not be written — boot continues without it).
 *
 * Why a launch-time overlay rather than a settings file: since Claude Code
 * 2.1.207 the classifier reads autoMode only from user scope, managed
 * settings, or --settings. A project-local write is silently ignored
 * (anthropics/claude-code#87545), and a user-scope write would apply this
 * project's policy to every other Claude session on the machine — with no
 * cross-project locking, two hermits booting could also clobber each other's
 * merge. The overlay is per-hermit, rewritten from scratch every boot (so it
 * self-heals and never accumulates drift), and passed only to the session this
 * boot launches.
 *
 * Written via tmp + rename so a crash mid-write can never leave the launch
 * pointing at a half-written file.
 */
function renderClassifierOverlay(config: Json): string | null {
  const autoMode: Record<string, string[]> = {
    soft_deny: ['$defaults', AUTOMODE_SOFT_DENY_ENTRY],
  };
  if (artifactGrantApplies(config)) {
    autoMode.allow = ['$defaults', automodeAllowEntry(path.join(defaultConfigDir(), 'plugins'), PLUGIN_ROOT)];
    autoMode.environment = ['$defaults', ...AUTOMODE_ENV_ENTRIES];
  }
  const file = path.resolve(STATE_DIR, 'claude-settings.overlay.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify({ autoMode }, null, 2) + '\n');
    return file;
  } catch (e: any) {
    console.log(`[hermit] WARNING: classifier overlay not written (${e?.message ?? e}) — continuing boot without it.`);
    return null;
  }
}

/**
 * os.execvp replacement: Bun cannot replace the process image, so spawn the
 * command with inherited stdio and exit with its status. The lifecycle lock
 * is released first — Python's flock fd was O_CLOEXEC and released on exec.
 */
function execvp(cmd: string[]): never {
  releaseLock(LIFECYCLE_LOCK);
  const res = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

/**
 * Export an installed setup-token into this process's environment.
 *
 * Both launch paths depend on this running first: the interactive execvp path
 * inherits process.env directly, and the tmux path copies forwardVars into the
 * env-file it sources. An already-set env var wins, matching the CLI's own
 * precedence and letting an operator override the installed token for one boot.
 *
 * The token is read from disk at every process start, which is what makes
 * renewal work without touching the host: write a new token file, bounce the
 * process, done — no container recreate, no .env edit.
 */
export function hydrateSetupTokenEnv(): void {
  if (process.env[TOKEN_ENV_VAR]) return;
  const token = readTokenValue(defaultConfigDir());
  if (token) process.env[TOKEN_ENV_VAR] = token;
}

/**
 * True when this project's Docker hermit service is running. Fail-soft: a
 * missing compose file, absent docker, timeout, or non-zero status all read as
 * "not running" so a plain host boot is never blocked by the probe itself.
 */
export function dockerHermitRunning(): boolean {
  if (!fs.existsSync('docker-compose.hermit.yml')) return false;
  try {
    const r = spawnSync(
      'docker',
      ['compose', '-f', 'docker-compose.hermit.yml', 'ps', '--status', 'running', '--format', '{{.Service}}'],
      { timeout: 5000, encoding: 'utf-8' },
    );
    if (r.status !== 0 || !r.stdout) return false;
    return r.stdout.split('\n').some((l: string) => l.trim() === 'hermit');
  } catch {
    return false;
  }
}

/**
 * Decide whether to refuse booting a second instance beside a live one for this
 * project — the host↔Docker split-brain guard. Returns an operator-facing reason
 * (multi-line) to refuse, or null to proceed. Pure of side effects so it's unit
 * testable; the process.exit wrapper is refuseIfAnotherInstanceAlive.
 *
 * Same-namespace boots are already serialized by the lifecycle lock the caller
 * holds; the cross-namespace (host vs container) case is covered by the shared
 * liveness signal. Skipped inside a container (the entrypoint owns that guard)
 * and when HERMIT_FORCE_BOOT=1 (split-state recovery).
 */
export function shouldRefuseBoot(bootMode: BootMode): string[] | null {
  if (isContainer() || process.env.HERMIT_FORCE_BOOT === '1') return null;
  if (dockerHermitRunning()) {
    return [
      "This project's Docker hermit is running — a second host instance would fight it for state and channels.",
      'Stop it first: .claude-code-hermit/bin/hermit-docker down   (attach: .claude-code-hermit/bin/hermit-docker attach)',
      'Override (split-state recovery only): HERMIT_FORCE_BOOT=1',
    ];
  }
  const rt = readRuntimeJson();
  if (rt && rt.runtime_mode && rt.runtime_mode !== bootMode) {
    // A cleanly-stopped instance is definitively dead; its frozen runtime_mode
    // and not-yet-aged liveness file don't prove it's still running. Mirrors the
    // watchdog's own "deliberately down" gate (session_state idle / shutdown_*).
    const cleanlyStopped = rt.session_state === 'idle' || Boolean(rt.shutdown_completed_at);
    const age = sharedLivenessAgeSecs();
    if (!cleanlyStopped && age !== null && age < LIVENESS_FRESH_SECS) {
      return [
        `A ${rt.runtime_mode} instance appears to be alive for this project (state activity ${Math.round(age)}s ago).`,
        'Stop it first (bin/hermit-stop or hermit-docker down), or override with HERMIT_FORCE_BOOT=1.',
      ];
    }
  }
  return null;
}

function refuseIfAnotherInstanceAlive(bootMode: BootMode): void {
  const reason = shouldRefuseBoot(bootMode);
  if (reason) {
    for (const line of reason) console.log(`[hermit] ${line}`);
    process.exit(1);
  }
}

/**
 * Decide what to do when tmux reports the session already exists: refusal lines,
 * or null to report "already running" and exit 0. Pure of side effects so it's
 * unit testable, like shouldRefuseBoot above.
 *
 * A duplicate means the session predates this invocation, so this process never
 * observed its boot and cannot assume lifecycle state was written. A plain
 * double-run has a healthy runtime.json and is waved through; a hermit whose
 * state was lost underneath it (project dir recreated, state cleaned, a botched
 * migration) is refused — 'invalid' as hard as 'missing', since a corrupt record
 * may hold the only copy of state (see RuntimeRead in lib/runtime.ts).
 * Deliberately rebuilds nothing either way: runtime.json is the declared single
 * source of truth (skills/session-start/SKILL.md), so a synthesized record would
 * defeat the recovery branches that read it.
 *
 * Parseable is not the same as usable: a stub record (no runtime_mode, or no
 * tmux_session while a session of that name is demonstrably alive) dead-ends
 * bin/hermit-attach exactly like a missing file does ("Unknown runtime mode" /
 * "No tmux session recorded"). updateRuntimeField() seeds `{}` on a missing
 * read, so an interrupted hermit-stop leaves precisely that stub behind —
 * checking the fields, not just the JSON, is what keeps the loop broken.
 *
 * Callers must also not mutate config on this path: no boot happened, so
 * always_on / applyAlwaysOnDoctorSchedule() must not fire — the doctor ratchet
 * only takes effect via a new session's `hermit-routines load`, so writing it
 * here would desync config from the scheduler actually running.
 */
export function duplicateSessionRefusal(sessionName: string): string[] | null {
  const runtime = readRuntimeState();
  let detail: string;
  if (runtime.kind === 'missing') {
    detail = 'state/runtime.json is missing';
  } else if (runtime.kind === 'invalid') {
    detail = `state/runtime.json is unusable: ${runtime.reason}`;
  } else if (!pyTruthy(runtime.data.runtime_mode) || !pyTruthy(runtime.data.tmux_session)) {
    detail = 'state/runtime.json records no live session (runtime_mode/tmux_session are empty)';
  } else {
    return null;
  }

  return [
    `ERROR: session "${sessionName}" is running, but ${detail}.`,
    'Lifecycle state cannot be rebuilt from a session already in flight — attach,',
    'the watchdog and session recovery stay degraded until the session restarts.',
    'Recover:',
    '  .claude-code-hermit/bin/hermit-stop',
    '  .claude-code-hermit/bin/hermit-start',
    `To inspect it first: tmux attach -t ${sessionName}`,
  ];
}

async function main(): Promise<void> {
  const noTmuxFlag = process.argv.includes('--no-tmux');

  hydrateSetupTokenEnv();
  const config = loadConfig();
  acquireLifecycleLock();
  checkForUpgrade(config);
  const tools = checkPrerequisites();

  // Singleton guard (under the lifecycle lock): don't boot a second instance
  // beside a live one for this project. Boot mode mirrors the tmux/interactive
  // branch chosen further down.
  const bootMode = noTmuxFlag || !pyTruthy(tools.tmux) ? 'interactive' : 'tmux';
  refuseIfAnotherInstanceAlive(bootMode);

  const cmd = buildClaudeCommand(config, tools);
  const sessionName = getSessionName(config);

  // Setup-mode gate: docker-setup touches this marker before first boot so channel
  // pairing commands land on an idle REPL prompt rather than racing the bootstrap turn.
  // Consumed (deleted) here — one-shot, so a crashed setup doesn't suppress bootstrap permanently.
  const setupMarker = path.join(STATE_DIR, '.setup-mode');
  const setupMode = fs.existsSync(setupMarker);
  if (setupMode) {
    try {
      fs.unlinkSync(setupMarker);
    } catch {}
    console.log('[hermit] Setup mode — skipping bootstrap prompt (one-shot)');
  }

  // send-keys races the TUI init on slow boots — argv does not.
  const hb = 'heartbeat' in config ? config.heartbeat : {};
  const autoSession = pyTruthy('auto_session' in config ? config.auto_session : true);
  const hbEnabled = pyTruthy('enabled' in hb ? hb.enabled : false);
  const hasRoutines = pyTruthy(config.routines);
  // Domain hermits (e.g. homeassistant-hermit) declare a boot_skill that
  // wraps /claude-code-hermit:session-start plus their own domain setup.
  // When set, it replaces the core session skill in the bootstrap — the
  // domain skill is responsible for calling session-start itself.
  const bootSkill = config.boot_skill || '/claude-code-hermit:session';

  const steps: string[] = [];
  if (hbEnabled) steps.push('/claude-code-hermit:heartbeat start');
  if (hasRoutines) steps.push('/claude-code-hermit:hermit-routines load');
  if (autoSession) steps.push(bootSkill);

  // Bootstrap fires only in always-on mode; interactive runs are operator-driven.
  const isAlwaysOn = !noTmuxFlag && pyTruthy(tools.tmux);
  if (steps.length && !setupMode && isAlwaysOn) {
    let bootstrap: string;
    if (steps.length === 1) {
      bootstrap = steps[0];
    } else {
      const numbered = steps.map((s, i) => `(${i + 1}) ${s}`).join(', ');
      bootstrap = `Always-on bootstrap. Invoke these skills in order: ${numbered}.`;
    }
    cmd.push(bootstrap);
  }

  checkStaleRuntime(config, sessionName);

  // Print launch info
  const agentName = config.agent_name;
  const language = config.language;
  const timezone = config.timezone;
  if (pyTruthy(agentName)) {
    const identityParts = [agentName];
    if (pyTruthy(language)) identityParts.push(language);
    if (pyTruthy(timezone)) identityParts.push(timezone);
    console.log(`[hermit] Agent: ${identityParts.join(', ')}`);
  } else {
    console.log('[hermit] Agent: (unnamed)');
  }
  console.log(`[hermit] Project: ${path.basename(process.cwd())}`);
  console.log(`[hermit] Model: ${config.model || 'default'}`);
  console.log(`[hermit] Effort: ${config.effort || 'default'}`);
  console.log(`[hermit] Channels: ${getEnabledChannels(config).join(', ') || 'none'}`);
  console.log(`[hermit] Remote: ${pyTruthy(config.remote) ? 'enabled' : 'disabled'}`);
  console.log(`[hermit] Chrome: ${pyTruthy(config.chrome) ? 'enabled' : 'disabled'}`);
  console.log(`[hermit] Permissions: ${config.permission_mode || 'auto'}`);

  const hookProfile = writeSettingsEnv(config, bootMode);
  // Named at launch because it decides which deny patterns enforce, and a hermit
  // that silently resolved a weaker profile than the operator expected is
  // otherwise invisible until something gets through that should not have.
  console.log(`[hermit] Hook profile: ${hookProfile.profile} (${hookProfile.source})`);
  applyArtifactGrant(config);

  if (noTmuxFlag || !pyTruthy(tools.tmux)) {
    if (!noTmuxFlag && !pyTruthy(tools.tmux)) {
      console.log('[hermit] tmux not found — running in current terminal.');
      console.log('[hermit] Install tmux for persistent sessions.');
    }
    // Create or update runtime.json for interactive mode
    const existing = readRuntimeJson();
    if (existing === null) {
      writeRuntimeJson({
        version: 1,
        session_state: 'idle',
        session_id: null,
        created_at: localISOStamp(),
        runtime_mode: 'interactive',
        tmux_session: null,
        transition: null,
        transition_target: null,
        transition_started_at: null,
        shutdown_requested_at: null,
        shutdown_completed_at: null,
        last_error: null,
        last_shell_snapshot_at: null,
      });
    } else {
      // Preserve lifecycle fields for session-start recovery.
      existing.version = 1;
      existing.runtime_mode = 'interactive';
      existing.tmux_session = null;
      clearShutdownStampsOnBoot(existing);
      writeRuntimeJson(existing);
    }
    console.log(`[hermit] Running: ${shlexJoin(cmd)}`);
    execvp(cmd);
  }

  // Start tmux session (handles "already exists" as a graceful exit)
  //
  // tmux starts a new shell that does NOT inherit the caller's environment.
  // Auth vars must be in shell env before claude launches.
  // *_STATE_DIR vars must be OS env because MCP servers (channel plugins)
  // inherit shell env but don't read settings.local.json.
  const forwardVars = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', TOKEN_ENV_VAR, 'AGENT_HOOK_PROFILE'];
  // *_STATE_DIR vars must reach MCP servers via OS env — writeSettingsEnv already
  // hydrated process.env for every channel (default or explicit state_dir) above
  // main()'s call to it, so the only filter needed here is the identifier guard.
  // Guard rationale: see channelStateDirKey in lib/channel-config.ts.
  for (const [chName] of iterChannelConfigs(config)) {
    const key = channelStateDirKey(chName);
    if (key) {
      forwardVars.push(key);
    }
  }
  const envFile = path.join('/tmp', `.hermit-env-${sessionName}`);
  // CLAUDE_PLUGIN_ROOT is not injected into the tmux shell by the harness;
  // set it explicitly so Bash tool calls in skills work in cron-triggered sessions.
  let envContent = `export CLAUDE_PLUGIN_ROOT=${shlexQuote(PLUGIN_ROOT)}\n`;
  // HERMIT_MANAGED marks this as THE unattended managed session — the one path
  // ask-gate.ts denies AskUserQuestion on. It rides the process-scoped env-file
  // only (sourced then rm'd by the tmux shell below), never settings.local.json
  // or the docker-compose env block, so a hand-launched `claude` in the same
  // always_on project — or a `docker exec` maintenance shell — never inherits it
  // and is correctly treated as attended.
  envContent += `export HERMIT_MANAGED=1\n`;
  for (const v of forwardVars) {
    const val = process.env[v];
    if (val !== undefined) {
      envContent += `export ${v}=${shlexQuote(val)}\n`;
    }
  }
  // Unlink-then-create-0600 rather than write-then-chmod: this file now carries
  // the long-lived setup-token alongside any API key, it sits on a predictable
  // path in a world-writable tmpdir, and write-then-chmod leaves it briefly
  // world-readable. 'wx' also refuses to follow a pre-planted symlink.
  fs.rmSync(envFile, { force: true });
  fs.writeFileSync(envFile, envContent, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(envFile, 0o600);

  const shellCmd = `. ${shlexQuote(envFile)} && rm -f ${shlexQuote(envFile)} && ${shlexJoin(cmd)}`;
  const result = spawnSync('tmux', ['new-session', '-d', '-s', sessionName, shellCmd], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    // The env file's only cleanup is the `rm -f` inside shellCmd, which runs in
    // the session tmux was asked to create. No session, no cleanup — so a failed
    // launch would strand a 0600 file holding the forwarded API key / setup token
    // on a predictable path in a world-writable tmpdir. Remove it on every
    // failure path before deciding what to report.
    fs.rmSync(envFile, { force: true });

    const stderrMsg = result.stderr ? result.stderr.trim() : '';
    if (stderrMsg.includes('duplicate session')) {
      const refusal = duplicateSessionRefusal(sessionName);
      if (refusal) {
        for (const line of refusal) console.log(`[hermit] ${line}`);
        process.exit(1);
      }
      console.log(`[hermit] Session "${sessionName}" already running (always-on).`);
      console.log(`[hermit] Attach: .claude-code-hermit/bin/hermit-attach  (or: tmux attach -t ${sessionName})`);
      console.log('[hermit] Send tasks via channel, or run hermit-stop to shut down.');
      process.exit(0);
    } else {
      console.log('[hermit] ERROR: tmux new-session failed.');
      if (stderrMsg) console.log(`[hermit]   tmux: ${stderrMsg}`);
      process.exit(1);
    }
  }

  console.log(`[hermit] Started tmux session: ${sessionName}`);

  // Detect runtime mode
  const runtimeMode = isContainer() ? 'docker' : 'tmux';

  // The prior process's harness session is over — drop its stale cost cache so the
  // watchdog's idle-phase hygiene fallback can't resolve a defunct session (see helper).
  clearStatusCacheOnBoot();
  // Fresh boot marker for hermit-routines' cron-registry diff (see helper).
  writeBootId();

  // Create or update runtime.json as the single source of lifecycle truth
  const existing = readRuntimeJson();
  if (existing === null) {
    writeRuntimeJson({
      version: 1,
      session_state: 'idle',
      session_id: null,
      created_at: localISOStamp(),
      runtime_mode: runtimeMode,
      tmux_session: sessionName,
      transition: null,
      transition_target: null,
      transition_started_at: null,
      shutdown_requested_at: null,
      shutdown_completed_at: null,
      last_error: null,
      last_shell_snapshot_at: null,
    });
  } else {
    // Preserve lifecycle fields for session-start recovery.
    existing.version = 1;
    existing.runtime_mode = runtimeMode;
    existing.tmux_session = sessionName;
    clearShutdownStampsOnBoot(existing);
    writeRuntimeJson(existing);
  }

  // Mark as always-on mode in config
  const alwaysOnBefore = structuredClone(config);
  config.always_on = true;
  applyAlwaysOnDoctorSchedule(config);
  // Skipped when the on-disk config was unparseable: `config` is then pure
  // DEFAULT_CONFIG, and writing it would silently replace the operator's
  // identity, channels, routines and budget with template defaults.
  if (!configReadFailed) {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
      auditConfigChange(path.dirname(CONFIG_PATH), alwaysOnBefore, config, 'hermit-start');
    } catch {}
  }

  // Verify the session survived the boot period
  await sleep(3); // Wait for Claude to boot — increase if on slow hardware
  if (!tmuxSessionAlive(sessionName)) {
    console.log(`[hermit] ERROR: tmux session "${sessionName}" died after creation.`);
    console.log('[hermit] The shell command inside tmux likely failed.');
    console.log('[hermit] Common causes: `claude` not in PATH, missing ANTHROPIC_API_KEY.');
    console.log('[hermit] To debug: tmux new-session -s hermit-debug then run `claude` manually.');
    console.log('[hermit] Falling back to interactive mode...');
    // Same secret-hygiene reason as the spawn-failure branch above: tmux created
    // the session, but a shell that died before reaching `rm -f` (a non-POSIX
    // default shell, a failed `.`) leaves the 0600 env file behind — and execvp
    // below never returns to clean it up.
    fs.rmSync(envFile, { force: true });
    const stale = readRuntimeJson();
    stale.runtime_mode = 'interactive';
    stale.tmux_session = null;
    stale.last_error = 'session_died_on_boot';
    writeRuntimeJson(stale);
    execvp(cmd);
  }

  if (hbEnabled) {
    const every = 'every' in hb ? hb.every : '30m';
    console.log(`[hermit] Bootstrap: /claude-code-hermit:heartbeat start queued (every ${every})`);
  } else {
    console.log('[hermit] Heartbeat: disabled');
  }
  if (hasRoutines) {
    console.log('[hermit] Bootstrap: /claude-code-hermit:hermit-routines load queued');
  }
  if (autoSession) {
    console.log(`[hermit] Bootstrap: ${bootSkill} queued`);
  }

  console.log('[hermit] Mode: always-on (session stays open between tasks)');
  console.log(`[hermit] Attach: .claude-code-hermit/bin/hermit-attach  (or: tmux attach -t ${sessionName})`);
  console.log('[hermit] Stop: .claude-code-hermit/bin/hermit-stop');
}

export {
  CONFIG_PATH,
  STATE_DIR,
  RUNTIME_JSON,
  RUNTIME_TMP,
  LIFECYCLE_LOCK,
  PROFILE_LEVELS,
  DEFAULT_CONFIG,
  CHANNEL_PLUGINS,
  loadConfig,
  applyAlwaysOnDoctorSchedule,
  checkForUpgrade,
  checkPrerequisites,
  isContainer,
  writeRuntimeJson,
  readRuntimeJson,
  readRuntimeState,
  checkStaleRuntime,
  clearShutdownStampsOnBoot,
  clearStatusCacheOnBoot,
  writeBootId,
  acquireLifecycleLock,
  fetchRegisteredMarketplaces,
  iterChannelConfigs,
  getEnabledChannels,
  resolveStateDir,
  buildClaudeCommand,
  renderClassifierOverlay,
  writeSettingsEnv,
  applyArtifactGrant,
  shlexQuote,
  shlexJoin,
  main,
};

if (import.meta.main) {
  await main();
}
