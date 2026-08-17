#!/usr/bin/env bun
/**
 * Single-shot watchdog for hermit autonomous sessions.
 *
 * Runs once per scheduler tick (systemd/launchd/cron), decides, acts, exits.
 * Can't hang or leak — the OS scheduler drives recurrence.
 *
 * Decision flow:
 *   1. Config gate    — exit if watchdog.enabled is false
 *   2. Shutdown gate  — exit if operator stopped the session intentionally
 *   3. Dead detection — restart when tmux session is gone
 *   3b. Stall-question detection — notify once when the pane is stuck on an
 *       un-redirectable dialog (native permission prompt, harness prompt)
 *   4. Wedge detection — nudge-then-escalate when heartbeat is stale
 *   5. Re-arm fallback — re-arm when heartbeat-restart routine missed its window
 *                        (damped + pause-gated, like step 6)
 *   6. Monitor re-arm  — re-arm a heartbeat/routine Monitor whose liveness file
 *                        went stale mid-session (any cause), damped per monitor
 *
 * Usage: bun scripts/hermit-watchdog.ts [run|install|uninstall]
 *        (invoked by .claude-code-hermit/bin/hermit-watchdog run)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { acquireLock, releaseLock, pidAlive } from './lib/lockfile';
import { utcISOStamp as utcStamp, currentHHMM, currentHHMMOrUTC, parseSimpleCronTime, friendlyBoundary } from './lib/time';
import { writeRuntimeJson, readRuntimeJson, STATE_DIR, LIFECYCLE_LOCK } from './lib/runtime';
import { anchoredPaneTail, tmuxSessionAlive, getSessionName as deriveSessionName, sendKeys } from './lib/tmux';
import { paneRootPids, collectTree, terminateSurvivors } from './lib/proc';
import { sharedLivenessAgeSecs, LIVENESS_FRESH_SECS } from './lib/liveness';
import { costLogPath, transcriptDirFor } from './lib/cc-compat';
import { readSettledConfig } from './lib/config-read';
import { wallMinutes } from './lib/cron-shift';
import { isPaused, pauseReasonLabel } from './lib/pause';
import { WATCHDOG, resolveLocale, type Locale } from './lib/messages';
import { defaultConfigDir, msUntilExpiry, tokenModeActive } from './lib/setup-token';
import { AUTO_CLOSE_LULL_MS } from './lib/auto-close';
import { promptTokensOf as promptTokens, isEstimateOnly, compactibleTokens, MAX_PLAUSIBLE_PROMPT_TOKENS } from './lib/context-signal';
import { readContextSurface } from './lib/context-surface';
import { runTelemetryExportIfDue } from './report-export';
import { applyContextReset, stampContextReset, clearStatusCache as clearStatusCacheAt } from './lib/context-reset';
import { lastRoutineFire } from './lib/routines/history';

type Json = any;

const CONFIG_PATH = '.claude-code-hermit/config.json';
const HEARTBEAT_FILE = path.join(STATE_DIR, '.heartbeat');
const ROUTINE_METRICS_JSONL = path.join(STATE_DIR, 'routine-metrics.jsonl');
const CLEAR_REQUESTED_JSON = path.join(STATE_DIR, 'clear-requested.json');
// Paths the decision cascade reaches through World.paths (watchdog-state.json,
// watchdog-events.jsonl, last-operator-action.json, compact-requested.json) are
// joined at their use sites off world.paths.stateDir, not pinned here.
const HERMIT_ROOT = path.dirname(STATE_DIR); // '.claude-code-hermit' — isPaused() joins its own 'state/pause.json'
const REAUTH_MARKER_JSON = path.join(STATE_DIR, 'reauth-relay.json');
const REAUTH_MINT_SCRIPT = path.join(import.meta.dir, 'setup-token-mint.ts');
// Backstop against PID reuse on a long-lived box; liveness is the real signal.
const REAUTH_MARKER_MAX_AGE_MS = 26 * 3600000;
// Skill-driven mints have no usable PID (verb per process), so age is the only
// signal — sized to the flow's own timeouts rather than the relay's ack wait.
const REAUTH_SKILL_MARKER_MAX_AGE_MS = 2 * 3600000;

// --- Injectable world ---

/**
 * The decision cascade's view of everything outside itself: the clock, the tmux
 * pane, the filesystem, and where state lives. Gates take a World instead of
 * reaching for module-level constants and spawnSync directly, so a test can hand
 * them a fake and assert which gate decided what — rather than inferring it from
 * side effects observed through a subprocess with fake executables on PATH.
 *
 * Two implementations only: REAL_WORLD below (production, delegating to the same
 * lib functions the file already used) and whatever a test constructs.
 */
export type World = {
  clock: { nowMs(): number };
  tmux: { alive(s: string): boolean; capture(s: string): string | null; send(s: string, text: string): void };
  files: { readJson(p: string): Json | null; readText(p: string): string | null; writeJson(p: string, v: Json): void; rm(p: string): void };
  paths: { stateDir: string; hermitRoot: string; costLog: string };
  /** Per-tick memo for the cost-log read, shared by both hygiene tiers (one
   *  process per scheduler tick, so its lifetime is the tick). Lives on the world
   *  rather than in module scope so each fake world in a test starts cold. */
  memo: { costLogEntry?: { sessionId: string; entry: Json } };
};

const REAL_WORLD: World = {
  clock: { nowMs: () => Date.now() },
  tmux: {
    alive: (s) => tmuxSessionAlive(s),
    capture: (s) => capturePane(s),
    send: (s, text) => { sendKeys(s, text); },
  },
  files: {
    readJson,
    readText: (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
    writeJson,
    rm: (p) => { try { fs.rmSync(p); } catch {} },
  },
  paths: { stateDir: STATE_DIR, hermitRoot: HERMIT_ROOT, costLog: costLogPath() },
  memo: {},
};

// --- Utilities ---

/** Parse a duration string ('15m', '2h', '26h') to seconds. */
function parseDuration(s: Json): number {
  if (typeof s === 'number') return Math.trunc(s);
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(String(s).trim());
  if (!m) return 0;
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return Math.trunc(parseFloat(m[1]) * (mult[m[2] ?? 's'] ?? 1));
}

function readJson(p: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/** Atomic write via tmp + rename. */
function writeJson(p: string, data: Json): void {
  const tmp = `${p}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, p);
  } catch (e) {
    process.stderr.write(`[watchdog] write ${path.basename(p)}: ${e}\n`);
  }
}

/** Append one audit line to watchdog-events.jsonl. */
function appendEvent(action: string, reason: string, world: World = REAL_WORLD): void {
  const line = JSON.stringify({ ts: worldStamp(world), action, reason }) + '\n';
  try {
    fs.appendFileSync(path.join(world.paths.stateDir, 'watchdog-events.jsonl'), line);
  } catch (e) {
    process.stderr.write(`[watchdog] append_event: ${e}\n`);
  }
}

// --- Deterministic operator pushes (channel voice) ---
//
// The watchdog is out-of-process and single-shot, so a direct import of the
// async lib/channel-send.ts would require converting this whole file's
// control flow (including several interleaved process.exit(0) calls) to
// async. Instead it reaches the send through the channel-send.ts CLI via
// spawnSync — one more external effect alongside the tmux/pgrep/systemctl
// calls this file already shells out to, and spawnSync blocks until the
// child exits so a slow send can never race a process.exit that would kill
// it mid-flight.
const CHANNEL_SEND_SCRIPT = path.join(import.meta.dir, 'channel-send.ts');

// The operator's locale for all watchdog pushes. Resolved once from config in
// main() before any compose call fires; the compose functions default to this
// value at call time (tests override it by passing an explicit locale arg). The
// watchdog is single-shot, so a module-level holder IS "pinned at run start".
let OPERATOR_LOCALE: Locale = 'en';

/** Best-effort operator push. Watchdog lifecycle events are ops content, so they
 * route maintainer-tier — falling back to the primary chat when no maintainer
 * channel is configured (byte-identical to today). Failure is logged, never
 * blocks the watchdog's real work. */
function pushOperatorMessage(text: string): void {
  try {
    const r = spawnSync(process.execPath, [CHANNEL_SEND_SCRIPT, HERMIT_ROOT, '--tier', 'maintainer', '-'], {
      input: text,
      timeout: 12000,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    if (r.status !== 0) appendEvent('push_failed', text.slice(0, 80));
  } catch (e) {
    appendEvent('push_failed', String(e).slice(0, 80));
  }
}

/** Current time as "HH:MM" in `timezone`, falling back to the UTC clock if the zone is invalid. */
function nowHHMM(timezone: string, ref?: Date): string {
  return currentHHMMOrUTC(timezone, ref);
}

/** Operator-language message for a watchdog restart. */
export function composeRestartMessage(reason: string, timezone: string, locale: Locale = OPERATOR_LOCALE): string {
  const hhmm = nowHHMM(timezone);
  const cause = reason === 'dead-process'
    ? WATCHDOG[locale].restartCauseNotRunning()
    : WATCHDOG[locale].restartCauseFrozen();
  return WATCHDOG[locale].restart(hhmm, cause);
}

/** Operator-language message for the first tick of a wedge episode. */
export function composeWedgeMessage(timezone: string, locale: Locale = OPERATOR_LOCALE): string {
  return WATCHDOG[locale].wedge(nowHHMM(timezone));
}

/** Operator-language message for an un-redirectable stalled question (PROP-024's fail-loud half). */
export function composeStallQuestionMessage(timezone: string, locale: Locale = OPERATOR_LOCALE): string {
  return WATCHDOG[locale].stallQuestion(nowHHMM(timezone));
}

/** Operator-language message for a session that stopped consuming its queued notifications. */
export function composeSessionWedgedMessage(timezone: string, locale: Locale = OPERATOR_LOCALE): string {
  return WATCHDOG[locale].sessionWedged(nowHHMM(timezone));
}

/** Operator-language message for a likely orphan (tmux gone, state still fresh). */
export function composeOrphanMessage(timezone: string, locale: Locale = OPERATOR_LOCALE): string {
  return WATCHDOG[locale].orphan(nowHHMM(timezone));
}

export type CompactFlavor = 'boundary' | 'mid-arc';

/**
 * Which steering flavor a compact fires with. Sole owner of the predicate — the fire
 * site logs this same value to the event log, so message and forensics label can never
 * disagree.
 *
 * Both conditions are required, because neither alone bounds the claim the boundary
 * message makes ("the previous work arc is complete and archived"):
 *   - `session_state === 'idle'` is unbounded in time. Only `/session-start` writes
 *     `in_progress` (session-archive.ts verbOpen) — routines, heartbeats, and channel
 *     replies never flip it — so an always-on hermit sits at 'idle' for hours while
 *     still doing real, unarchived work.
 *   - A fresh `compact-requested.json` marks a genuine work-done boundary, but only
 *     bounds it to COMPACT_MARKER_TTL_SECS; on its own it can't tell that a new
 *     session opened inside that window.
 * Together they confine the boundary flavor to the ≤1h window after a work-done
 * archive with no session open — the only window where the claim is true. Everything
 * else falls to 'mid-arc', the conservative keep-everything flavor.
 */
function compactFlavor(sessionState: unknown, markerFresh: boolean): CompactFlavor {
  return sessionState === 'idle' && markerFresh ? 'boundary' : 'mid-arc';
}

/**
 * Steering text for the watchdog-fired `/compact`. Never operator-facing (it's typed
 * into the pane for Claude, not shown in a channel), so no locale — unlike the
 * compose*Message functions above.
 */
export function composeCompactSteeringMessage(flavor: CompactFlavor): string {
  return flavor === 'boundary'
    ? '/compact the previous work arc is complete and archived, summarize it in one or two lines, keep pending operator items, open questions, and standing commitments, drop completed-work detail'
    : '/compact focus on unfinished work, pending operator items, and in-flight decisions';
}

/** Operator-language message for a forced pause enforcement (any reason). */
export function composePauseMessage(reason: string, until: string | null, timezone: string, locale: Locale = OPERATOR_LOCALE): string {
  const label = pauseReasonLabel(reason, locale);
  // Fall back to the indefinite phrasing when `until` is absent or unparseable —
  // a malformed timestamp shouldn't leak a raw ISO string to the operator. Dated
  // form (not bare HH:MM) so a resume days/weeks out isn't read as minutes away.
  const valid = until != null && !isNaN(new Date(until).getTime());
  if (!valid) return WATCHDOG[locale].pauseUntilResume(label);
  return WATCHDOG[locale].pauseUntilDate(label, friendlyBoundary(until as string, timezone));
}

/** Seconds elapsed since an ISO-8601 timestamp, or null when unparseable. */
function ageSecs(ts: string, world: World = REAL_WORLD): number | null {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  return (world.clock.nowMs() - d.getTime()) / 1000;
}

/** utcStamp read off the world clock, so a fake clock produces a fixed stamp. */
function worldStamp(world: World): string {
  return utcStamp(new Date(world.clock.nowMs()));
}

// --- Tmux helpers ---

/** Capture pane content as text, or null on failure. */
function capturePane(sessionName: string): string | null {
  try {
    const r = spawnSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout;
  } catch {
    return null;
  }
}

/** SHA-256 hash of the current pane content, or null on failure. */
function getPaneHash(sessionName: string, world: World = REAL_WORLD): string | null {
  const content = world.tmux.capture(sessionName);
  return content === null ? null : crypto.createHash('sha256').update(content).digest('hex');
}

// A blocking modal (AskUserQuestion widget, a native permission prompt, or a
// harness-shipped setup wizard) renders a pointer-marked option plus a dialog footer
// — verified against real captures in compiled/spike-ask-gate-probe-2026-07-05.md and
// against the CC 2.1.233 "Set up auto mode for your environment?" wizard that wedged a
// live hermit for ~2.5 days. Neither token appears in ordinary session output (tool
// calls, prose, status bar), so requiring both is a conservative, low-false-positive
// signal that the pane is stalled on an unanswerable dialog. Over-detection costs one
// deduped push; under-detection is a silent stall.
//
// The option label is deliberately NOT constrained to a number: the wizard's selector
// reads "❯ Continue", and requiring `\d+\.` is exactly why the live wedge went
// undetected. The pointer glyph also starts the composer prompt ("❯ Try ..."), but a
// modal replaces the composer rather than rendering above it, so the footer anchor
// below keeps the composer out of every match.
const PENDING_OPTION_RE = /❯\s+\S/;
// A dialog footer must terminate the visible pane. Both spellings are load-bearing:
// AskUserQuestion and permission prompts end "· Esc to cancel", while a wizard step
// that cannot be cancelled offers only "Enter to continue".
const PENDING_FOOTERS = ['Esc to cancel', 'Enter to continue'];

// Only the pane TAIL counts: a live blocking modal renders at the bottom of the
// pane, whereas the same tokens appearing in scrollback or quoted tool output
// (a rendered menu, or output that echoes "Esc to cancel") sit higher up. Scanning
// the whole capture would let such incidental text trip a false stall — and because
// stall detection early-returns before wedge/restart, a false positive silently
// *disables recovery* for as long as the text stays on screen. The tail window
// keeps the genuine bottom-of-pane prompt while dropping that class.
const PENDING_TAIL_LINES = 15;

/** True when the pane TAIL looks stalled on an interactive dialog nobody can answer. */
export function hasPendingQuestion(paneContent: string): boolean {
  return PENDING_FOOTERS.some((footer) => {
    const tail = anchoredPaneTail(paneContent, PENDING_TAIL_LINES, footer);
    return tail !== null && PENDING_OPTION_RE.test(tail);
  });
}

// A wedged session is shape-independent: whatever holds stdin (a dialog the pane
// scanner above doesn't recognise, a modal from a future CC release, a hung render),
// the harness keeps ENQUEUEING monitor notifications it never DEQUEUES. On the live
// 2026-08-17 incident that signal ran for ~2.5 days — 16 straight enqueues, zero
// dequeues — while every pane-shaped check stayed silent. Reading only the tail of
// the transcript keeps this cheap; transcripts reach megabytes.
const WEDGE_QUEUE_STALE_SECS = 30 * 60;
const QUEUE_TAIL_BYTES = 64 * 1024;

/**
 * Verdict on the newest queue-operation in a transcript tail.
 * 'wedged' — the last queue record is an enqueue older than the threshold.
 * 'draining' — the last queue record is a dequeue, or a newer non-queue record exists.
 * 'unknown' — no queue records at all (fail-open: a fresh or quiet session).
 */
export function classifyQueueTail(tailText: string, nowMs: number, staleSecs = WEDGE_QUEUE_STALE_SECS): 'wedged' | 'draining' | 'unknown' {
  let last: { op: string; ts: number } | null = null;
  for (const line of tailText.split('\n')) {
    if (!line.includes('"queue-operation"')) continue;
    let rec: Json;
    try { rec = JSON.parse(line); } catch { continue; } // a truncated first line is expected
    if (rec?.type !== 'queue-operation' || typeof rec.operation !== 'string') continue;
    const ts = Date.parse(String(rec.timestamp ?? ''));
    if (Number.isNaN(ts)) continue;
    if (last === null || ts >= last.ts) last = { op: rec.operation, ts };
  }
  if (last === null) return 'unknown';
  if (last.op !== 'enqueue') return 'draining';
  return nowMs - last.ts > staleSecs * 1000 ? 'wedged' : 'draining';
}

/** Tail of the active session's transcript, or null when it can't be located/read.
 *  The session id is passed in from the runtime.json main() already read this tick —
 *  re-deriving it here would re-read the same file a second time on every tick. */
function readTranscriptTail(sessionId: string | null, world: World = REAL_WORLD): string | null {
  if (!sessionId) return null; // no session between runs — nothing to judge
  // hermitRoot is repo-relative ('.claude-code-hermit'), and CC keys transcript dirs by
  // ABSOLUTE project path — resolve against cwd rather than path.dirname (which yields '.').
  const projectRoot = path.resolve(world.paths.hermitRoot, '..');
  const file = path.join(transcriptDirFor(projectRoot), `${sessionId}.jsonl`);
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const start = Math.max(0, size - QUEUE_TAIL_BYTES);
      const len = size - start;
      const buf = Buffer.alloc(len);
      // readSync may return a short read; slice to what was actually read so a
      // zero-filled remainder can't inject NUL bytes into the newest lines — the
      // same guard report-export.ts's bounded tail read carries.
      const bytesRead = fs.readSync(fd, buf, 0, len, start);
      return buf.subarray(0, bytesRead).toString('utf-8');
    } finally { fs.closeSync(fd); }
  } catch {
    return null; // absent/unreadable transcript is not evidence of a wedge
  }
}

// sendKeys now lives in lib/tmux.ts so the harness-command drain shares one
// implementation (and one bracketed-paste workaround) with the watchdog.

// --- Lifecycle lock ---

/** The lifecycle lock file under the world's state dir. Must resolve to the same
 *  path as lib/runtime's LIFECYCLE_LOCK for the real world — the restart, nudge and
 *  post-close-clear paths still lock via that constant, and the two only exclude
 *  each other while both name the same file. */
function lifecycleLockPath(world: World): string {
  return path.join(world.paths.stateDir, '.lifecycle.lock');
}

/** Non-blocking exclusive lock. Returns true on success, false when held. */
function tryAcquireLifecycleLock(world: World = REAL_WORLD): boolean {
  try {
    fs.mkdirSync(world.paths.stateDir, { recursive: true });
    return acquireLock(lifecycleLockPath(world));
  } catch {
    return false;
  }
}

// --- State readers ---

/** Seconds since last modification, or null if absent. */
function getFileAgeSecs(p: string): number | null {
  try {
    return (Date.now() - fs.statSync(p).mtimeMs) / 1000;
  } catch {
    return null;
  }
}

/** True if the current time in `timezone` is within the active_hours window. Pass `ref` to override the reference instant. */
export function inActiveHours(activeHours: Json, timezone: string, ref?: Date): boolean {
  try {
    const start = String(activeHours.start ?? '00:00');
    const end = String(activeHours.end ?? '23:59');
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return true; // fail-open on malformed window
    const now = currentHHMM(timezone, ref);
    if (now === null) return true; // fail-open on unparseable tz
    return start <= now && now < end; // end-exclusive, matching heartbeat.ts precheck
  } catch {
    return true; // fail-open
  }
}

/** Seconds since last-operator-action.json was written, or null if absent. */
function getOperatorLastActionAgeSecs(world: World = REAL_WORLD): number | null {
  const data = world.files.readJson(path.join(world.paths.stateDir, 'last-operator-action.json'));
  if (!data || !data.at) return null;
  return ageSecs(data.at, world);
}

/**
 * Seconds since the last 'fired' event for routineId in routine-metrics.jsonl.
 * Returns null when the file is absent or no matching event exists.
 */
function getLastRoutineFiredAgeSecs(routineId: string): number | null {
  const lastTs = lastRoutineFire(ROUTINE_METRICS_JSONL, routineId);
  return lastTs ? ageSecs(lastTs) : null;
}

function checkProcessRunning(pattern: string): boolean {
  return spawnSync('pgrep', ['-f', pattern], { stdio: 'ignore' }).status === 0;
}

/**
 * True if the `daily-auto-close` routine's next fire is within `windowSecs` of now.
 * The post-close /clear (maybePostCloseClear) already resets context for free right
 * after that routine archives the session — a routine-hygiene compact just before it
 * would spend a summarization call on a context about to be wiped anyway.
 * Pass `ref` to override the reference instant (tests only — mirrors inActiveHours).
 */
export function isNearDailyAutoClose(config: Json, windowSecs: number, ref?: Date): boolean {
  try {
    const routines = Array.isArray(config.routines) ? config.routines : [];
    const routine = routines.find((r: Json) => r && r.id === 'daily-auto-close' && r.enabled !== false);
    if (!routine || typeof routine.schedule !== 'string') return false;
    const fireTime = parseSimpleCronTime(routine.schedule);
    if (!fireTime) return false;

    const nowMinutes = wallMinutes(config.timezone ?? 'UTC', ref ?? new Date());
    if (nowMinutes === null) return false;
    const fireMinutes = fireTime.hour * 60 + fireTime.minute;

    let deltaMinutes = fireMinutes - nowMinutes;
    if (deltaMinutes < 0) deltaMinutes += 24 * 60; // wraps to tomorrow
    return deltaMinutes * 60 <= windowSecs;
  } catch {
    return false; // fail-open — never let a parse error suppress hygiene compaction
  }
}

function readWatchdogState(world: World = REAL_WORLD): Json {
  const data = world.files.readJson(path.join(world.paths.stateDir, 'watchdog-state.json'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { consecutive_stale: 0, last_pane_hash: null, last_nudge_at: null };
  }
  return data;
}

function writeWatchdogState(state: Json, world: World = REAL_WORLD): void {
  state.last_check_at = worldStamp(world);
  world.files.writeJson(path.join(world.paths.stateDir, 'watchdog-state.json'), state);
}

// --- Actions ---

/** Try-acquire lock, mark runtime, kill session, verify the old tree died, spawn hermit-start. */
async function doRestart(sessionName: string, reason: string, runtime: Json, timezone: string): Promise<void> {
  if (!tryAcquireLifecycleLock()) {
    process.stderr.write('[watchdog] lifecycle lock held — backing off restart\n');
    return;
  }

  try {
    // Mark runtime before killing so session-start recovery sees the reason
    runtime.last_error = 'unclean_shutdown';
    runtime.watchdog_restart_reason = reason;
    writeRuntimeJson(runtime);

    // Capture the pane's process tree BEFORE the kill so we can verify the old
    // claude actually died. (For a dead-session restart tmux is already gone, so
    // this is empty and the restart proceeds unchanged.)
    const tree = collectTree(paneRootPids(sessionName));
    spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
    const survivors = await terminateSurvivors(tree.pids);

    if (survivors.length > 0 || tree.capped) {
      // The old process survived the kill. Spawning a replacement now would
      // recreate the duplicate-instance incident, so abort and alert instead.
      releaseLock(LIFECYCLE_LOCK);
      appendEvent('restart-aborted', `survivors: ${(survivors.length ? survivors : tree.pids).join(' ')}`);
      process.stderr.write(`[watchdog] restart aborted — process survived kill: ${survivors.join(' ')}\n`);
      pushOperatorMessage(composeOrphanMessage(timezone));
      return;
    }

    // Release before spawning hermit-start (it re-acquires)
    releaseLock(LIFECYCLE_LOCK);

    const startBin = '.claude-code-hermit/bin/hermit-start';
    const child = spawn(startBin, [], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (e) => process.stderr.write(`[watchdog] restart failed: ${e}\n`));
    child.unref();
    appendEvent('restart', `${reason}, tree-verified`);
    process.stderr.write(`[watchdog] restarted "${sessionName}", reason: ${reason}\n`);
    // Only claim a restart to the operator when the start binary is actually
    // present — a missing/ENOENT binary makes spawn fail asynchronously via the
    // 'error' handler above, after this synchronous path already returned, so
    // guard the push on the binary existing rather than on spawn's async result.
    // The lock is already released above, so a slow send never holds it.
    if (fs.existsSync(startBin)) pushOperatorMessage(composeRestartMessage(reason, timezone));
  } catch (e) {
    process.stderr.write(`[watchdog] restart failed: ${e}\n`);
  } finally {
    releaseLock(LIFECYCLE_LOCK); // no-op once already released
  }
}

// --- Re-auth relay (step 3a) ---
//
// A lapsed setup-token leaves the hermit alive but unable to reach the API, and
// no amount of restarting fixes that — only a human browser tap does. The relay
// is the deterministic recovery: ask the operator over their channel, mint a
// fresh token, install it, restart. No model in the loop, because by definition
// the model can't run.
//
// Note what is deliberately NOT suppressed: dead-session restart (step 3) still
// fires during a relay. The relay polls the channel log for the operator's
// reply, and inbound messages only reach that log through the channel plugin
// living inside the claude session — so keeping the session up, even 401-dead,
// is what makes the reply reachable at all.

/** True when a relay process is genuinely still working. Clears a dead marker. */
function reauthRelayActive(): boolean {
  const marker = readJson(REAUTH_MARKER_JSON);
  if (!marker) return false;
  const age = ageSecs(marker.updated_at ?? marker.started_at ?? '');
  const isSkillMode = marker.mode === 'skill';
  // The /relogin skill drives the mint one verb at a time, each its own
  // short-lived process, so its recorded PID is always dead by the time we look.
  // Age is the only usable signal there — and it has to be one, because
  // otherwise we read a live flow as abandoned and spawn a relay whose
  // startMint() kills the pane holding the operator's pending sign-in link.
  // Its window is the flow's own timeouts (link 90s + code 30m + token 3m),
  // not the relay's 24h operator-ack wait.
  const maxAge = isSkillMode ? REAUTH_SKILL_MARKER_MAX_AGE_MS : REAUTH_MARKER_MAX_AGE_MS;
  const tooOld = age === null || age * 1000 > maxAge;
  // Liveness over age: a relay legitimately waits many hours for the operator to
  // reach a browser, so only a dead PID (or an absurd age) means abandoned — skill
  // mode has no PID to check, so age alone is its liveness signal.
  if (!tooOld && (isSkillMode || (typeof marker.pid === 'number' && pidAlive(marker.pid)))) return true;
  try {
    fs.unlinkSync(REAUTH_MARKER_JSON);
    appendEvent('reauth-relay', 'cleared stale marker');
  } catch {}
  return false;
}

/** 'active' → relay in flight; 'spawned' → just started one; 'idle' → nothing to do. */
function evaluateReauth(): 'active' | 'spawned' | 'idle' {
  if (reauthRelayActive()) return 'active';
  if (!tokenModeActive(defaultConfigDir())) return 'idle';
  const msLeft = msUntilExpiry(HERMIT_ROOT);
  if (msLeft === null || msLeft > 0) return 'idle';

  try {
    const child = spawn(process.execPath, [REAUTH_MINT_SCRIPT, 'relay'], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (e) => process.stderr.write(`[watchdog] reauth relay spawn failed: ${e}\n`));
    child.unref();
    appendEvent('reauth-relay', 'setup-token expired — relay spawned');
    process.stderr.write('[watchdog] setup-token expired — spawned re-auth relay\n');
    return 'spawned';
  } catch (e) {
    process.stderr.write(`[watchdog] reauth relay spawn failed: ${e}\n`);
    return 'idle';
  }
}

/** Send a heartbeat run nudge to a potentially wedged session. */
function doNudge(sessionName: string, watchdogState: Json, consecutive: number, paneHash: string | null, timezone: string): void {
  if (isPaused(HERMIT_ROOT).paused) return; // PROP-015 — no nudges while paused
  sendKeys(sessionName, '/claude-code-hermit:heartbeat run');
  // One push per wedge episode. Keying on `consecutive === 1` alone re-fires when
  // the operator-recency guard resets consecutive_stale to 0 mid-episode (an
  // operator poke isn't a heartbeat recovery); a sticky flag, cleared only when the
  // heartbeat actually recovers (the fresh-heartbeat branch in main), fixes that.
  const shouldNotify = !watchdogState.wedge_notified;
  if (shouldNotify) watchdogState.wedge_notified = true;
  watchdogState.consecutive_stale = consecutive;
  watchdogState.last_pane_hash = paneHash;
  watchdogState.last_nudge_at = utcStamp();
  writeWatchdogState(watchdogState);
  appendEvent('nudge', `stale cycle ${consecutive}`);
  process.stderr.write(`[watchdog] nudged "${sessionName}" (stale cycle ${consecutive})\n`);
  if (shouldNotify) pushOperatorMessage(composeWedgeMessage(timezone));
}

/** Re-arm heartbeat when the in-session routine missed its window. */
function doRearm(sessionName: string): void {
  sendKeys(sessionName, '/claude-code-hermit:hermit-routines load');
  Bun.sleepSync(2000);
  sendKeys(sessionName, '/claude-code-hermit:heartbeat start');
  appendEvent('re-arm-fallback', 'heartbeat-restart routine missed ~26h window');
  process.stderr.write(`[watchdog] re-armed "${sessionName}"\n`);
}

// --- Monitor-liveness re-arm (step 6) ---
//
// Step 5 above re-arms only when the heartbeat-restart routine's `fired` age crosses
// ~26h — a model-issued metric that can be missing entirely, leaving that fallback
// permanently inert. This step keys off ground truth instead: the per-poll liveness
// files the monitors themselves stamp. Its staleness logic mirrors doctor's
// checkHeartbeat/checkRoutineMonitor (trusted-tick vs started_at, startup grace) so a
// doctor 'fail' and a watchdog re-arm trip on the same signal.

// A monitor writes liveness on its first loop iteration, so a real tick lands within
// seconds of spawn; the grace only needs to cover spawn + first precheck.
const MONITOR_STARTUP_GRACE_SECS = 120;
// One re-arm attempt per monitor per this window. Essential: where Monitor spawn is
// blocked outright (seccomp / nested-userns), an undamped liveness-keyed re-arm would
// re-inject every tick forever — each injection a paid full-context wake.
export const MONITOR_REARM_DAMPER_SECS = 6 * 3600;

/**
 * True when a monitor that should be ticking has a liveness timestamp stale past
 * thresholdSecs — or, lacking any trusted tick, a registration older than the startup
 * grace. Trust mirrors doctor: a tick predating started_at belongs to a prior session's
 * monitor and is not proof the current one is alive. A monitor never registered
 * (runtimeData null, so started_at unknown) returns false — re-registering that is
 * session-start's job, not the watchdog's.
 */
function monitorLivenessStale(livenessFile: string, runtimeData: Json, thresholdSecs: number): boolean {
  const startedAt: string | null =
    runtimeData && typeof runtimeData.started_at === 'string' ? runtimeData.started_at : null;
  const startedAtMs = startedAt !== null ? Date.parse(startedAt) : NaN;

  const liveness = readJson(path.join(STATE_DIR, livenessFile));
  const lastPeekAt: string | null =
    liveness && typeof liveness.last_peek_at === 'string' ? liveness.last_peek_at : null;
  const lastPeekMs = lastPeekAt !== null ? Date.parse(lastPeekAt) : NaN;

  const trusted = Number.isFinite(lastPeekMs) && (!Number.isFinite(startedAtMs) || lastPeekMs >= startedAtMs);
  if (trusted) {
    const age = ageSecs(lastPeekAt!);
    return age !== null && age > thresholdSecs;
  }
  if (Number.isFinite(startedAtMs)) {
    const startAge = ageSecs(startedAt!);
    return startAge !== null && startAge >= MONITOR_STARTUP_GRACE_SECS;
  }
  return false;
}

/** Heartbeat monitor stale? Gated + thresholded exactly as doctor's checkHeartbeat. */
function heartbeatMonitorStale(config: Json): boolean {
  const hbCfg = config?.heartbeat;
  if (!hbCfg || typeof hbCfg !== 'object' || Array.isArray(hbCfg) || !hbCfg.enabled) return false;
  const thresholdSecs = 3 * parseDuration(hbCfg.every ?? '2h');
  const monRt = readJson(path.join(STATE_DIR, 'heartbeat-monitor.runtime.json'));
  return monitorLivenessStale('heartbeat-liveness.json', monRt, thresholdSecs);
}

/** Routine monitor stale? Gated + thresholded exactly as doctor's checkRoutineMonitor. */
function routineMonitorStale(config: Json): boolean {
  const routines = Array.isArray(config?.routines) ? config.routines : [];
  const anyEnabled = routines.some((r: Json) => r && r.enabled === true && r.id !== 'heartbeat-restart');
  if (!anyEnabled) return false;
  const monRt = readJson(path.join(STATE_DIR, 'routine-monitor.runtime.json'));
  if (!monRt || monRt.mode === 'croncreate-fallback') return false; // not loaded, or CronCreate fallback (no Monitor)
  const interval = typeof monRt.interval === 'number' && monRt.interval > 0 ? monRt.interval : 60;
  const thresholdSecs = Math.max(10 * interval, 10 * 60);
  return monitorLivenessStale('routine-monitor-liveness.json', monRt, thresholdSecs);
}

/** Damper open when the given re-arm timestamp is older than MONITOR_REARM_DAMPER_SECS
 *  (or missing). Shared by the step-6 monitor re-arm and the step-5 routine fallback. */
export function rearmDamperOpen(lastStamp: unknown, world: World = REAL_WORLD): boolean {
  if (typeof lastStamp !== 'string') return true;
  const age = ageSecs(lastStamp, world);
  return age === null || age >= MONITOR_REARM_DAMPER_SECS;
}

/**
 * Re-arm a heartbeat/routine Monitor that died mid-session, detected via its stale
 * liveness file rather than step 5's fired-age heuristic. Injects only the dead
 * monitor's re-arm command (both are in record-operator-action's INJECTED_EXACT, so
 * neither stamps the operator-activity clock). `alreadyRearmed` short-circuits when
 * step 5 already fired doRearm this tick — that re-armed both, nothing left to do.
 */
function maybeMonitorRearm(config: Json, sessionName: string, operatorGraceSecs: number, alreadyRearmed: boolean): void {
  if (alreadyRearmed) return;
  if (isPaused(HERMIT_ROOT).paused) return;               // no injection while paused (mirrors doNudge)
  if (!tmuxSessionAlive(sessionName)) return;             // dead session belongs to the doRestart path
  const opAge = getOperatorLastActionAgeSecs();
  if (opAge !== null && opAge < operatorGraceSecs) return; // operator mid-conversation — back off

  const heartbeatStale = heartbeatMonitorStale(config);
  const routineStale = routineMonitorStale(config);
  if (!heartbeatStale && !routineStale) return;

  const state = readWatchdogState();
  const lastRearm =
    state.last_monitor_rearm && typeof state.last_monitor_rearm === 'object' && !Array.isArray(state.last_monitor_rearm)
      ? state.last_monitor_rearm
      : {};

  const doHeartbeat = heartbeatStale && rearmDamperOpen(lastRearm.heartbeat);
  const doRoutines = routineStale && rearmDamperOpen(lastRearm.routines);
  if (!doHeartbeat && !doRoutines) return; // stale but still inside the per-monitor damper window

  // Routine reload first, then heartbeat start after a settle gap — same ordering
  // doRearm uses when it sends both.
  if (doRoutines) {
    sendKeys(sessionName, '/claude-code-hermit:hermit-routines load');
    if (doHeartbeat) Bun.sleepSync(2000);
  }
  if (doHeartbeat) sendKeys(sessionName, '/claude-code-hermit:heartbeat start');

  const stamp = utcStamp();
  if (doHeartbeat) lastRearm.heartbeat = stamp;
  if (doRoutines) lastRearm.routines = stamp;
  state.last_monitor_rearm = lastRearm;
  writeWatchdogState(state);

  const targets = [doHeartbeat ? 'heartbeat' : null, doRoutines ? 'routine-monitor' : null].filter(Boolean).join('+');
  appendEvent('monitor-rearm', `${targets} liveness stale`);
  process.stderr.write(`[watchdog] monitor re-arm "${sessionName}" (${targets})\n`);
}

// --- Post-close context reset ---

/**
 * Runs before the watchdog.enabled gate — independent of watchdog restart behavior;
 * fires on any hermit with post_close_clear: true and a running scheduler.
 * /clear preserves CronCreate routines and Monitor tasks (process-scoped, not
 * conversation-scoped), so no re-arm is needed after clearing.
 * Takes the lifecycle lock around the send so it can't race a concurrent tick or restart.
 */
function maybePostCloseClear(config: Json): void {
  if (config.post_close_clear !== true) return;
  if (!fs.existsSync(CLEAR_REQUESTED_JSON)) return;
  if (isPaused(HERMIT_ROOT).paused) return; // PROP-015 — never clear while paused

  const runtime = readRuntimeJson();
  if (!runtime) return;
  if (runtime.session_state !== 'idle') return;
  if (runtime.shutdown_requested_at || runtime.shutdown_completed_at) return; // never clear a stopping hermit

  const sessionName = runtime.tmux_session ?? '';
  if (!sessionName) return;
  if (!tmuxSessionAlive(sessionName)) return;

  const opAge = getOperatorLastActionAgeSecs();
  if (opAge !== null && opAge < AUTO_CLOSE_LULL_MS / 1000) return; // operator active within the lull — back off

  if (!tryAcquireLifecycleLock()) return; // another lifecycle action in flight, retry next tick
  try {
    // Deliberately NOT applyContextReset: this path has never written a SHELL.md
    // breadcrumb (the close itself already left an archived report), and adding one
    // here would change shipped behaviour. Only the stamp + cache clear are shared.
    runtime.context_cleared = true;
    writeRuntimeJson(runtime);
    // Same machine-readable reset stamp every other reset path writes: PreCompact never
    // fires for /clear, so without it the pre-clear cost entry stays the newest one for
    // this session and poisonedEntrySkip cannot tell it apart from a live reading.
    stampContextReset(HERMIT_ROOT);
    sendKeys(sessionName, '/clear');
    clearStatusCacheAt(HERMIT_ROOT);
    try { fs.rmSync(CLEAR_REQUESTED_JSON); } catch {}
    appendEvent('post-close-clear', 'daily-auto-close context reset');
  } finally {
    releaseLock(LIFECYCLE_LOCK);
  }
  process.exit(0);
}

// --- Shared lifecycle/token guards (maybeContextClear + maybeContextCompact) ---

/** Discriminated result for passesLifecycleGuards — the reason string feeds
 *  last_hygiene_eval so a starved hygiene tier is diagnosable from state alone. */
export type GuardReason = 'paused' | 'interactive' | 'transition' | 'suspect-process' | 'shutdown-stamp' | 'no-tmux' | 'operator-recent';
export type GuardResult = { ok: true; sessionName: string } | { ok: false; reason: GuardReason };

/**
 * Common lifecycle gates for the two auto-compaction mechanisms: not paused
 * (PROP-015), always-on only, no in-flight transition, no watchdog-internal
 * suspect state, no shutdown in progress, a live tmux session, and operator
 * silence ≥10 min. Returns the live session name when every gate passes, or
 * a reason string when the caller should bail.
 */
export function passesLifecycleGuards(runtime: Json, world: World = REAL_WORLD): GuardResult {
  if (isPaused(world.paths.hermitRoot).paused) return { ok: false, reason: 'paused' }; // PROP-015 — never auto-clear/compact while paused
  if (runtime.runtime_mode === 'interactive') return { ok: false, reason: 'interactive' }; // interactive sessions must never be auto-managed
  if (runtime.transition) return { ok: false, reason: 'transition' }; // archiving/cleaning recovery is mid-flight — never interfere
  const sessionState: string = runtime.session_state ?? '';
  if (sessionState === 'suspect_process') return { ok: false, reason: 'suspect-process' }; // exclusion model: only bail on watchdog-internal state

  if (runtime.shutdown_requested_at || runtime.shutdown_completed_at) return { ok: false, reason: 'shutdown-stamp' };

  const sessionName: string = runtime.tmux_session ?? '';
  if (!sessionName || !world.tmux.alive(sessionName)) return { ok: false, reason: 'no-tmux' };

  const opAge = getOperatorLastActionAgeSecs(world);
  if (opAge !== null && opAge < 10 * 60) return { ok: false, reason: 'operator-recent' }; // operator-recency backoff

  return { ok: true, sessionName };
}

// Shared between maybeContextClear and maybeContextCompact — both need "the last
// cost-log entry for this session" on every tick. Memoized per invocation (this
// script is single-shot, one process per scheduler tick) so the two mechanisms
// don't each re-read and re-parse the full (append-only, unbounded-growth) cost
// log JSONL in the same tick.
function getLastCostLogEntry(sessionId: string, world: World = REAL_WORLD): Json {
  const cached = world.memo.costLogEntry;
  if (cached && cached.sessionId === sessionId) return cached.entry;
  let lastEntry: Json = null; // stays null when the cost-log is absent — fail safe
  const raw = world.files.readText(world.paths.costLog);
  for (const rawLine of raw?.split('\n') ?? []) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      // Subagent lines are appended after the dispatching turn's main line
      // (cost-tracker.ts) and carry their own small token count — the hygiene
      // mechanisms want the main turn's context size, not a subagent's.
      if (e && e.session_id === sessionId && e.subagent !== true) lastEntry = e;
    } catch {}
  }
  world.memo.costLogEntry = { sessionId, entry: lastEntry };
  return lastEntry;
}

// promptTokens (context size from a cost-log entry), isEstimateOnly and
// MAX_PLAUSIBLE_PROMPT_TOKENS now live in lib/context-signal.ts, shared with
// doctor-check.ts and cost-tracker.ts so they can't drift again.

/**
 * Why this cost-log entry must not drive a hygiene decision, or null when it may.
 *
 * Both tiers act on "the last cost entry for this session", which is only a proxy for
 * current context size. Two ways that proxy lies: the entry was observed before the
 * context was reset (it describes a context that no longer exists — measured live, where
 * a re-billed pre-compaction turn drove a compaction of a context 47k UNDER the
 * threshold), or the number itself is impossible. Both skip rather than guess: a real
 * turn produces a fresh entry within one wake.
 */
function poisonedEntrySkip(entry: Json, runtime: Json): PoisonReason | null {
  // observed_at is the source-side observation; the row's own timestamp is ingestion time,
  // which is fresh even on an entry describing an old context. Legacy rows have only the
  // latter — better than nothing, and they age out within a session.
  const observedAt: string = entry.observed_at ?? entry.timestamp ?? '';
  const resetAt: string = runtime.last_context_reset_at ?? '';
  if (observedAt && resetAt && observedAt < resetAt) return 'stale-entry';
  if (promptTokens(entry) > MAX_PLAUSIBLE_PROMPT_TOKENS) return 'aberrant-reading';
  return null;
}

/** Active arc ID, falling back to the harness session id cost-tracker persists to
 *  sessions/.status.json (cost-tracker.ts:runtimeSessionId || sessionId) — the same
 *  value used to key cost-log entries when no S-NNN arc is open (idle-phase wakes:
 *  heartbeat/routines/channel messages). Without this fallback both hygiene tiers
 *  are blind to exactly the accumulation they exist to catch. */
function resolveHygieneSessionId(runtime: Json, world: World = REAL_WORLD): string {
  const sid: string = runtime.session_id ?? '';
  if (sid) return sid;
  const status = world.files.readJson(path.join(world.paths.hermitRoot, 'sessions', '.status.json'));
  return status && typeof status.session_id === 'string' ? status.session_id : '';
}

/** The two ways a cost-log entry can be poisoned (see poisonedEntrySkip). Typed so
 *  the `skip:${PoisonReason}` template below stays a closed set. */
type PoisonReason = 'stale-entry' | 'aberrant-reading';

/** Closed registry of hygiene evaluation outcomes — every setHygieneEval call site
 *  resolves into this union, so hygiene_eval_counts has a fixed key set by
 *  construction (≤20 distinct strings across both mechanisms) and a typo'd or
 *  novel outcome is a compile error, not a silent new counter key. */
export type HygieneOutcome =
  | 'fired'
  | `skip:lifecycle:${GuardReason}`
  | `skip:${PoisonReason}`
  | 'skip:no-session-id'
  | 'skip:no-cost-entry'
  | 'skip:estimate-only'
  | 'skip:under-threshold'
  | 'skip:below-floor'
  | 'skip:interval-cooldown'
  | 'skip:midnight-adjacent'
  | 'skip:already-processed'
  | 'skip:quiescence-pending'
  | 'skip:lock-held';

/** Records this tick's hygiene outcome on a held watchdog-state object, keyed by
 *  mechanism, so the clear and compact tiers each keep their own most-recent eval.
 *  A single tick runs clear then compact; a shared slot would let compact's outcome
 *  clobber clear's every time compact is enabled, hiding the clear tier's skip/fire
 *  reason — the exact diagnosability this record exists to provide. The caller owns
 *  the subsequent writeWatchdogState (folds into a write it was already making).
 *
 *  Also increments hygiene_eval_counts[mechanism][outcome] — durable, monotonic
 *  FIRST-BLOCKER counters (each evaluation stamps exactly one outcome, the first
 *  guard that returned, not every simultaneously-binding constraint). Counts ≠
 *  scheduler ticks: disabled/invalid config, a missing runtime.json, post-close-clear
 *  ticks, and the process.exit(0) after a clear-tier fire all leave one or both
 *  mechanisms unstamped. Readers diff snapshots against `since` for rates. */
export function setHygieneEval(world: World, ws: Json, mechanism: 'clear' | 'compact', outcome: HygieneOutcome, promptTokensVal?: number, compactibleVal?: number): void {
  if (!ws.last_hygiene_eval || typeof ws.last_hygiene_eval !== 'object') ws.last_hygiene_eval = {};
  ws.last_hygiene_eval[mechanism] = {
    ts: worldStamp(world),
    outcome,
    ...(promptTokensVal != null ? { prompt_tokens: promptTokensVal } : {}),
    ...(compactibleVal != null ? { compactible_tokens: compactibleVal } : {}),
  };
  if (!ws.hygiene_eval_counts || typeof ws.hygiene_eval_counts !== 'object') {
    ws.hygiene_eval_counts = { since: worldStamp(world), clear: {}, compact: {} };
  }
  if (!ws.hygiene_eval_counts[mechanism] || typeof ws.hygiene_eval_counts[mechanism] !== 'object') {
    ws.hygiene_eval_counts[mechanism] = {};
  }
  ws.hygiene_eval_counts[mechanism][outcome] = (ws.hygiene_eval_counts[mechanism][outcome] ?? 0) + 1;
}

/** stampHygieneEval that also returns the outcome, so an early-exit branch reads as
 *  `return stamped(...)` — one line per gate, and the outcome the gate decided on is
 *  the function's return value rather than something a test has to read back off disk. */
function stamped(world: World, mechanism: 'clear' | 'compact', outcome: HygieneOutcome, promptTokensVal?: number, compactibleVal?: number): HygieneOutcome {
  stampHygieneEval(world, mechanism, outcome, promptTokensVal, compactibleVal);
  return outcome;
}

/** Read-modify-write variant of setHygieneEval for early-exit branches that don't
 *  already hold a loaded watchdogState in hand. */
export function stampHygieneEval(world: World, mechanism: 'clear' | 'compact', outcome: HygieneOutcome, promptTokensVal?: number, compactibleVal?: number): void {
  const ws = readWatchdogState(world);
  setHygieneEval(world, ws, mechanism, outcome, promptTokensVal, compactibleVal);
  writeWatchdogState(ws, world);
}

/** stamped() for a branch that already holds a loaded watchdogState. Not stamped()
 *  itself: that re-reads state from disk, which would drop whatever the caller has
 *  already mutated in memory but not yet written — a freshly recorded pane hash,
 *  say — and silently cost a quiescence tick. */
function stampedState(world: World, ws: Json, mechanism: 'clear' | 'compact', outcome: HygieneOutcome, promptTokensVal?: number, compactibleVal?: number): HygieneOutcome {
  setHygieneEval(world, ws, mechanism, outcome, promptTokensVal, compactibleVal);
  writeWatchdogState(ws, world);
  return outcome;
}

// --- Context-size clear ---

/**
 * Runs before the watchdog.enabled gate — independent of watchdog restart behavior.
 * Sends /clear when the last hermit-owned turn exceeded a prompt-side token threshold
 * and the session is quiescent (pane unchanged across two consecutive ticks).
 * Guards: always-on only, no in-flight transition, operator silent ≥10 min, no shutdown.
 */
export function maybeContextClear(config: Json, world: World = REAL_WORLD): HygieneOutcome | null {
  const threshold = config.watchdog?.context_clear_tokens;
  if (typeof threshold !== 'number' || threshold <= 0) return null;

  const runtime = readRuntimeJson(world.paths.stateDir);
  if (!runtime) return null;

  const guard = passesLifecycleGuards(runtime, world);
  if (!guard.ok) return stamped(world, 'clear', `skip:lifecycle:${guard.reason}`);
  const sessionName = guard.sessionName;

  // Token check: find the last cost-log entry for this hermit session
  const sessionId = resolveHygieneSessionId(runtime, world);
  if (!sessionId) return stamped(world, 'clear', 'skip:no-session-id');

  const lastEntry = getLastCostLogEntry(sessionId, world);
  if (!lastEntry) return stamped(world, 'clear', 'skip:no-cost-entry');

  const poisoned = poisonedEntrySkip(lastEntry, runtime);
  if (poisoned) return stamped(world, 'clear', `skip:${poisoned}`, promptTokens(lastEntry));

  // Never fire the DESTRUCTIVE /clear on an estimated context size — the per-call mean
  // could sit either side of the 700k threshold. The non-destructive compact tier keeps
  // using the estimate (it self-corrects, and would compact the same context anyway one
  // turn later when a real entry lands).
  if (isEstimateOnly(lastEntry)) return stamped(world, 'clear', 'skip:estimate-only');

  const prompt = promptTokens(lastEntry);
  if (prompt <= threshold) return stamped(world, 'clear', 'skip:under-threshold', prompt);

  // Idempotence: bail if this entry was already cleared
  const watchdogState = readWatchdogState(world);
  if (watchdogState.last_cleared_cost_ts && watchdogState.last_cleared_cost_ts === lastEntry.timestamp) {
    return stampedState(world, watchdogState, 'clear', 'skip:already-processed', prompt);
  }

  // Quiescence guard: require pane unchanged across two consecutive ticks
  const currentHash = getPaneHash(sessionName, world);
  const prevHash = watchdogState.last_pane_hash_ctx ?? null;
  if (currentHash === null || currentHash !== prevHash) {
    // First qualifying tick — record hash and wait for next tick
    watchdogState.last_pane_hash_ctx = currentHash;
    return stampedState(world, watchdogState, 'clear', 'skip:quiescence-pending', prompt);
  }

  // Pane stable across two ticks — safe to clear
  if (!tryAcquireLifecycleLock(world)) {
    return stampedState(world, watchdogState, 'clear', 'skip:lock-held', prompt);
  }
  try {
    // Runtime stamp + breadcrumb + status-cache clear, shared with every other reset
    // path (lib/context-reset.ts). Runs BEFORE the destructive keystroke: PreCompact
    // never fires on /clear (see precompact-stamp.ts), so the breadcrumb is the only
    // trace, and an interrupted reset must still leave it. Fail-open internally — it
    // can never delay or suppress the safety clear below.
    applyContextReset(world.paths.hermitRoot, runtime, {
      kind: 'cleared',
      trigger: `watchdog-${Math.round(threshold / 1000)}k`,
      hhmm: nowHHMM(config.timezone ?? 'UTC', new Date(world.clock.nowMs())),
      tokens: prompt,
    });
    world.tmux.send(sessionName, '/clear');
    watchdogState.last_cleared_cost_ts = lastEntry.timestamp;
    // Cross-stamp: runtime.session_id short-circuits resolveHygieneSessionId when an
    // arc is open, so cache deletion alone can't stop the compact tier from resolving
    // this same (now-destroyed) entry — mark it consumed for compact too.
    watchdogState.last_compacted_cost_ts = lastEntry.timestamp;
    watchdogState.last_pane_hash_ctx = null; // reset so next bloat cycle re-arms
    setHygieneEval(world, watchdogState, 'clear', 'fired', prompt);
    writeWatchdogState(watchdogState, world);
    appendEvent('context-clear', `prompt tokens ${prompt} over threshold ${threshold}`, world);
  } finally {
    releaseLock(lifecycleLockPath(world));
  }
  // The caller exits the tick on 'fired' (main step 0b) — returning it rather than
  // calling process.exit here keeps the fired path reachable from an in-process test.
  return 'fired';
}

// --- Routine-hygiene compaction ---

// Never compact away a context this small, even if a boundary marker waives the
// interval cooldown — summarizing a small context loses fidelity for nothing.
const MIN_COMPACT_FLOOR_TOKENS = 60_000;
// A boundary marker older than this is stale — a boundary is a moment, not a
// standing request. Consumed either way so it never survives into a new arc.
const COMPACT_MARKER_TTL_SECS = 3600;

/**
 * Routine-hygiene compaction — separate mechanism from maybeContextClear (destructive
 * /clear, 700k emergency backstop) and maybePostCloseClear (archived boundary /clear).
 * Fires arc-preserving /compact at a low threshold (default 100k of estimated
 * compactible conversation — total prompt minus the recorded fixed-surface upper
 * bound, or minus the 50k cold-start assumption) so cold-cache wakes
 * (heartbeat/routines/channel messages, always ≥5min apart — past the prompt cache TTL)
 * pay a small prompt instead of the full accumulated context. Sends no pointer payload
 * itself — pointers survive via startup-context.ts's SessionStart source==="compact"
 * section (PROP-011 commit 2), which fires on every compaction including this one.
 *
 * Guards mirror maybeContextClear (always-on/transition/shutdown/operator-recency/
 * cost-log token read/two-tick pane quiescence) plus three compact-specific additions:
 * its own min_interval cooldown (waivable by a fresh boundary marker, never by an
 * absolute floor), a midnight-adjacency suppression (skip right before the post-close
 * /clear would wipe the context anyway), and its own quiescence/idempotence state keys
 * so the two mechanisms' trackers don't interfere with each other.
 */
export function maybeContextCompact(config: Json, world: World = REAL_WORLD): HygieneOutcome | null {
  const compactCfg = config.context_hygiene?.compact;
  if (!compactCfg || compactCfg.enabled !== true) return null;

  const threshold = compactCfg.min_context_tokens;
  if (typeof threshold !== 'number' || threshold <= 0) return null;

  const minIntervalSecs = parseDuration(compactCfg.min_interval ?? '4h');

  const runtime = readRuntimeJson(world.paths.stateDir);
  if (!runtime) return null;

  const guard = passesLifecycleGuards(runtime, world);
  if (!guard.ok) return stamped(world, 'compact', `skip:lifecycle:${guard.reason}`);
  const sessionName = guard.sessionName;

  // Boundary marker: a fresh marker keeps its interval-cooldown waiver until the
  // compact it enables actually fires (deleted in the success block below). The
  // two-tick quiescence gate lands a full tick after this read, so a fresh marker
  // consumed here would be gone before the pane is confirmed stable — wasting the
  // waiver in exactly the interval-cooldown case it exists for. A stale marker is
  // consumed on read so it can never linger into a later tick/arc.
  let boundaryWaive = false;
  const markerPath = path.join(world.paths.stateDir, 'compact-requested.json');
  const marker = world.files.readJson(markerPath);
  if (marker && typeof marker.requested_at === 'string') {
    const markerAge = ageSecs(marker.requested_at, world);
    if (markerAge !== null && markerAge <= COMPACT_MARKER_TTL_SECS) {
      boundaryWaive = true; // fresh — leave on disk until the compact fires or it goes stale
    } else {
      world.files.rm(markerPath); // stale — never let it linger
    }
  }

  // Midnight-adjacency suppression: the post-close /clear wipes context for free
  // right after daily-auto-close archives — a compact just before it is wasted spend.
  if (isNearDailyAutoClose(config, 2 * 3600, new Date(world.clock.nowMs()))) return stamped(world, 'compact', 'skip:midnight-adjacent');

  // Token check: find the last cost-log entry for this hermit session
  const sessionId = resolveHygieneSessionId(runtime, world);
  if (!sessionId) return stamped(world, 'compact', 'skip:no-session-id');

  const lastEntry = getLastCostLogEntry(sessionId, world);
  if (!lastEntry) return stamped(world, 'compact', 'skip:no-cost-entry');

  const poisoned = poisonedEntrySkip(lastEntry, runtime);
  if (poisoned) return stamped(world, 'compact', `skip:${poisoned}`, promptTokens(lastEntry));

  const prompt = promptTokens(lastEntry);

  // Conversation gate (PROP-076): subtract the hermit's recorded fixed-surface
  // upper bound (state/context-surface.json, derived by cost-tracker at each
  // compaction boundary) — or the 50k cold-start assumption before the first
  // measurement — so min_context_tokens denominates estimated compactible
  // conversation rather than total prompt. Total prompt included a per-hermit
  // fixed surface compaction cannot reclaim, which made one configured number
  // fire at very different conversation sizes per hermit and silently tighten
  // as plugins/memory grew. The recorded value is an upper bound (it carries
  // post-boundary wake messages), so `compactible` is a lower bound: the gate
  // errs toward compacting later, never earlier.
  const surface = readContextSurface(world.paths.hermitRoot);
  const compactible = compactibleTokens(lastEntry, surface?.surface_upper_bound_tokens ?? null);

  // Token floor: never compact away a small compactible conversation, even with a
  // boundary marker in play — same units as the threshold above.
  if (compactible < MIN_COMPACT_FLOOR_TOKENS) return stamped(world, 'compact', 'skip:below-floor', prompt, compactible);
  if (compactible <= threshold) return stamped(world, 'compact', 'skip:under-threshold', prompt, compactible);

  const watchdogState = readWatchdogState(world);

  // Quiescence tracking: record the pane hash on every qualifying tick, independent
  // of whether interval/idempotence will end up blocking. If recording were gated
  // behind those checks, a single interval-blocked tick would erase the "pane
  // observed stable" progress and cost an extra tick once the interval reopened
  // (e.g. via a boundary marker) — even though the pane never actually moved.
  // Own hash key (last_pane_hash_compact) so this tracker never collides with
  // maybeContextClear's (last_pane_hash_ctx) — both can be mid-cycle at once.
  const currentHash = getPaneHash(sessionName, world);
  const prevHash = watchdogState.last_pane_hash_compact ?? null;
  const paneStable = currentHash !== null && currentHash === prevHash;
  if (currentHash !== prevHash) {
    watchdogState.last_pane_hash_compact = currentHash;
    writeWatchdogState(watchdogState, world);
  }

  // Interval cooldown — waived only by a fresh boundary marker
  if (!boundaryWaive && watchdogState.last_compacted_at) {
    const sinceLast = ageSecs(watchdogState.last_compacted_at, world);
    if (sinceLast !== null && sinceLast < minIntervalSecs) {
      return stampedState(world, watchdogState, 'compact', 'skip:interval-cooldown', prompt, compactible);
    }
  }

  // Idempotence: bail if this cost-log entry was already compacted
  if (watchdogState.last_compacted_cost_ts && watchdogState.last_compacted_cost_ts === lastEntry.timestamp) {
    return stampedState(world, watchdogState, 'compact', 'skip:already-processed', prompt, compactible);
  }

  if (!paneStable) {
    return stampedState(world, watchdogState, 'compact', 'skip:quiescence-pending', prompt, compactible);
  }

  // Pane stable across two ticks — safe to compact
  if (!tryAcquireLifecycleLock(world)) {
    return stampedState(world, watchdogState, 'compact', 'skip:lock-held', prompt, compactible);
  }
  try {
    // session_state is read at fire time; boundaryWaive was resolved at the top of this
    // same tick and the marker is still on disk, so both halves describe this instant.
    // A marker that went stale between the two quiescence ticks was consumed on the
    // second read, which correctly demotes the flavor to mid-arc.
    const flavor = compactFlavor(runtime.session_state, boundaryWaive);
    world.tmux.send(sessionName, composeCompactSteeringMessage(flavor));
    watchdogState.last_compacted_cost_ts = lastEntry.timestamp;
    watchdogState.last_compacted_at = worldStamp(world);
    watchdogState.last_pane_hash_compact = null; // reset so next bloat cycle re-arms
    setHygieneEval(world, watchdogState, 'compact', 'fired', prompt, compactible);
    writeWatchdogState(watchdogState, world);
    world.files.rm(markerPath); // consume the boundary waiver now that it fired
    // Both token counts travel in the event so the next cost-log entry gives a
    // before/after for free — feeds /hermit-evolution and threshold calibration.
    appendEvent('context-compact', `prompt tokens ${prompt} (compactible ~${compactible}) over threshold ${threshold}, flavor ${flavor}`, world);
  } finally {
    releaseLock(lifecycleLockPath(world));
  }
  // The caller exits the tick on 'fired' (main step 0c) — see maybeContextClear.
  return 'fired';
}

// --- Pause enforcement (PROP-015) ---

/**
 * Escape-to-pane while paused. The PreToolUse gate (pause-gate.ts) blocks the
 * model's *next* tool call the instant state/pause.json is set, but the
 * currently in-flight call (if any) runs to completion — tmux Escape kills it
 * immediately (probe-verified: compiled/spike-channel-stop-probe-2026-07-03.md).
 * Runs independent of watchdog.enabled, like 0a-0c — pause must interrupt
 * whether or not wedge-detection/nudging is turned on.
 *
 * Deliberately does NOT reuse passesLifecycleGuards()'s operator-recency
 * backoff: pause is an explicit override that must act immediately, not defer
 * because the operator/sender was just active — recency is exactly what a
 * "stop" is responding to.
 *
 * One-shot per pause episode: setPause() stamps a fresh `ts` on every call, so
 * comparing against the last-escaped ts (persisted in watchdog-state.json)
 * sends Escape once per pause, not every tick — repeat Escapes would also
 * interrupt the reply the paused hermit is still allowed to send.
 */
function maybeEscapePausedSession(timezone: string): void {
  const status = isPaused(HERMIT_ROOT);
  if (!status.paused) return;

  const runtime = readRuntimeJson();
  if (!runtime) return;
  if (runtime.runtime_mode === 'interactive') return; // never auto-manage an attended session
  if (runtime.transition) return; // archiving/cleaning recovery mid-flight
  if (runtime.shutdown_requested_at || runtime.shutdown_completed_at) return;
  if (runtime.session_state !== 'in_progress') return; // nothing plausibly in flight

  const sessionName: string = runtime.tmux_session ?? '';
  if (!sessionName || !tmuxSessionAlive(sessionName)) return;

  const watchdogState = readWatchdogState();
  // Dedup per pause episode by the flag's `ts`. Fall back to a fixed sentinel
  // for a ts-less flag (hand-crafted/partial write) so the guard still fires
  // exactly once — a bare `status.ts` comparison would read undefined === undefined
  // as "already escaped" on the first tick and skip the interrupt entirely.
  const episodeKey = status.ts ?? 'no-ts';
  if (watchdogState.last_escaped_pause_ts === episodeKey) return; // already escaped this episode

  spawnSync('tmux', ['send-keys', '-t', sessionName, 'Escape'], { stdio: 'ignore' });
  watchdogState.last_escaped_pause_ts = episodeKey;
  writeWatchdogState(watchdogState);
  appendEvent('pause-enforced', status.reason ?? 'operator');
  pushOperatorMessage(composePauseMessage(status.reason ?? 'operator', status.until ?? null, timezone));
}

// --- Main decision loop ---

async function main(): Promise<void> {
  if (!fs.existsSync(CONFIG_PATH)) process.exit(0); // absence: not a hermit project
  const config: Json = readSettledConfig(HERMIT_ROOT); // malformed settles to defaults

  // 0. Liveness stamp — record that the scheduler/loop invoked us, before any gate or
  // pre-gate handler (which can process.exit(0)). A fresh last_run proves the watchdog
  // is firing (systemd/launchd/cron or the Docker entrypoint loop); doctor reads it as
  // the liveness signal. Stamped even when watchdog.enabled is false.
  const liveness = readWatchdogState();
  liveness.last_run = utcStamp();
  writeWatchdogState(liveness);

  // Pause enforcement (PROP-015) — independent of watchdog.enabled; see
  // maybeEscapePausedSession for why this doesn't wait for the later
  // config/runtime gates below.
  const timezone = config.timezone ?? 'UTC';
  OPERATOR_LOCALE = resolveLocale(config.language); // pins the locale for every compose call below
  maybeEscapePausedSession(timezone);

  // 0a. Post-close clear — independent of watchdog.enabled; runs on any hermit with a scheduler
  maybePostCloseClear(config);

  // 0b. Context-size clear — independent of watchdog.enabled; runs on any always-on hermit.
  // A fired clear ends the tick: the context it was measuring no longer exists, so every
  // gate below would be deciding on a stale reading.
  if (maybeContextClear(config) === 'fired') process.exit(0);

  // 0c. Routine-hygiene compact — independent of watchdog.enabled; runs on any always-on
  // hermit. Evaluated after the emergency clear so a 700k context takes the /clear path,
  // not compact, on the same tick.
  if (maybeContextCompact(config) === 'fired') process.exit(0);

  // 0d. Telemetry export — independent of watchdog.enabled, like 0a-0c; opt-in via
  // config.telemetry_export. Self-gates on enabled + interval and always returns
  // (never process.exit(0)) so it can't skip steps 1-5 below.
  //
  // Wall-capped so a slow/hung endpoint can't delay dead-session recovery (steps
  // 3-5) — recovery is the core promise; telemetry is a best-effort nicety. The
  // cap equals one POST timeout, so the fresh bundle POST completes-or-times-out
  // within it (recording its own state); only a multi-bundle spool drain can be
  // cut short, and those bundles simply retry next tick. Left unawaited past the
  // cap, so it doesn't block the tick further. (A full reorder is avoided because
  // telemetry must run even when the watchdog is disabled, whereas recovery is
  // gated on watchdog.enabled below.)
  const TELEMETRY_WALL_MS = Number(process.env.HERMIT_TELEMETRY_TIMEOUT_MS) || 5000;
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  const telemetryResult = await Promise.race([
    runTelemetryExportIfDue(config, HERMIT_ROOT).finally(() => { if (wallTimer) clearTimeout(wallTimer); }),
    new Promise<{ ran: boolean; ok?: boolean; detail?: string }>((resolve) => {
      wallTimer = setTimeout(() => resolve({ ran: false, detail: 'deferred (wall-cap)' }), TELEMETRY_WALL_MS);
      // Don't let the cap timer itself hold the process open when telemetry isn't due.
      if (typeof wallTimer.unref === 'function') wallTimer.unref();
    }),
  ]);
  if (telemetryResult.ran) {
    appendEvent('telemetry-export', telemetryResult.ok ? 'success' : (telemetryResult.detail ?? 'failed'));
  }

  // 1. Config gate
  const watchdogCfg = config?.watchdog ?? {};
  if (!watchdogCfg || typeof watchdogCfg !== 'object' || Array.isArray(watchdogCfg) || !watchdogCfg.enabled) {
    process.exit(0);
  }

  const staleFactor = watchdogCfg.stale_factor ?? 2;
  const escalateAfter = watchdogCfg.escalate_after ?? 3;
  const operatorGraceSecs = parseDuration(watchdogCfg.operator_grace ?? '15m');

  const runtime = readRuntimeJson();
  if (runtime === null) process.exit(0);

  // 2. Shutdown-intent gate — never resurrect a deliberately-stopped hermit
  if (runtime.session_state === 'idle') process.exit(0);
  if (runtime.shutdown_requested_at || runtime.shutdown_completed_at) process.exit(0);
  if (runtime.runtime_mode === 'interactive') process.exit(0);

  const sessionName = runtime.tmux_session ?? '';
  if (!sessionName) process.exit(0);

  const sessionState = runtime.session_state ?? '';

  // 3. Dead-session detection
  // Deliberately NOT gated on isPaused() (PROP-015): the channel MCP plugin
  // lives inside the session, so a dead+paused session can't hear "resume" —
  // restart must stay live. The PreToolUse gate (pause-gate.ts) keeps the
  // restarted session inert until resumed.
  if (['in_progress', 'waiting', 'suspect_process'].includes(sessionState)) {
    if (!tmuxSessionAlive(sessionName)) {
      // A gone tmux session with FRESH shared-state activity is the orphan shape
      // (process survived, tmux didn't) — restarting would spawn a second claude
      // beside the live one. Abort and alert instead; only restart when the
      // signal is stale, i.e. the old process really is dead.
      const age = sharedLivenessAgeSecs();
      const ws = readWatchdogState();
      const looksAlive = age !== null && age < LIVENESS_FRESH_SECS;
      if (looksAlive && !ws.orphan_notified) {
        pushOperatorMessage(composeOrphanMessage(timezone));
        appendEvent('restart-aborted', 'liveness-fresh-no-tmux');
        ws.orphan_notified = true;
        writeWatchdogState(ws);
      }
      if (looksAlive) process.exit(0);
      if (ws.orphan_notified) {
        ws.orphan_notified = false;
        writeWatchdogState(ws);
      }
      await doRestart(sessionName, 'dead-process', runtime, timezone);
      process.exit(0);
    }
  }

  // 3a. Re-auth relay — runs after dead-session restart on purpose (see the
  // block comment above evaluateReauth). While a relay is in flight the session
  // can't do useful work, so the nudge/wedge tiers below are suppressed: they'd
  // be noise, and an escalated restart mid-flow would churn the session the
  // relay is about to bounce itself.
  const reauth = evaluateReauth();
  if (reauth === 'spawned' || reauth === 'active') process.exit(0);

  // 3b. Stall-question detection (PROP-024) — catches the un-redirectable remainder
  // the AskUserQuestion PreToolUse gate (ask-gate.ts) can't reach: native permission
  // dialogs and harness-rendered prompts below the tool layer. Notify only, once per
  // episode (re-arms when the pane clears) — never auto-answer or send Escape, that's
  // always the operator's call.
  const paneContent = capturePane(sessionName);
  const pendingQuestion = paneContent !== null && hasPendingQuestion(paneContent);
  {
    const watchdogState = readWatchdogState();
    if (pendingQuestion) {
      if (!watchdogState.stall_question_notified) {
        pushOperatorMessage(composeStallQuestionMessage(timezone));
        appendEvent('stall-question-detected', 'pending dialog on pane, session alive');
        watchdogState.stall_question_notified = true;
        writeWatchdogState(watchdogState);
      }
    } else if (watchdogState.stall_question_notified) {
      watchdogState.stall_question_notified = false;
      writeWatchdogState(watchdogState);
    }
  }

  // 3c. Queue-liveness wedge detection — the shape-independent net behind 3b. Whatever
  // holds stdin (a dialog 3b's pane scanner doesn't recognise, a modal from a future CC
  // release), the harness keeps enqueueing monitor notifications it never dequeues.
  // Alert-only, deduped like 3b: the operator decides how to clear it, and sending keys
  // into an unknown blocker is exactly the auto-answer 3b refuses to do.
  {
    const sessionId = typeof runtime.session_id === 'string' ? runtime.session_id : null;
    const tail = readTranscriptTail(sessionId);
    const verdict = tail === null ? 'unknown' : classifyQueueTail(tail, Date.now());
    const watchdogState = readWatchdogState();
    if (verdict === 'wedged') {
      if (!watchdogState.session_wedged_notified) {
        pushOperatorMessage(composeSessionWedgedMessage(timezone));
        appendEvent('session-wedged', 'queued notifications not draining, session alive');
        watchdogState.session_wedged_notified = true;
        writeWatchdogState(watchdogState);
      }
    } else if (watchdogState.session_wedged_notified) {
      // Re-arm on ANY non-wedged verdict, 'unknown' included: a restart starts a fresh
      // transcript with no queue records yet, and holding the flag through that would
      // suppress the NEXT genuine wedge — the silent stall this check exists to prevent.
      watchdogState.session_wedged_notified = false;
      writeWatchdogState(watchdogState);
    }
  }

  // A pane stalled on a pending prompt is not a wedge — the operator has just been
  // notified above (once per episode). Stop here: never fall through to the wedge
  // nudge (step 4) or the re-arm fallback (step 5), both of which send keystrokes
  // into the pane. On a focused permission / AskUserQuestion modal those keystrokes
  // (a command string then Enter) would confirm the highlighted default option, or
  // the pane-frozen restart path would kill the session outright — either way
  // auto-answering a decision that is always the operator's to make.
  if (pendingQuestion) process.exit(0);

  // 4. Wedge detection (only when heartbeat is enabled + within active hours)
  const heartbeatCfg = config?.heartbeat ?? {};
  const heartbeatIsObj = heartbeatCfg && typeof heartbeatCfg === 'object' && !Array.isArray(heartbeatCfg);
  if (heartbeatIsObj && ('enabled' in heartbeatCfg ? heartbeatCfg.enabled : true)) {
    const activeHours = heartbeatCfg.active_hours;
    const activeHoursIsObj = activeHours && typeof activeHours === 'object' && !Array.isArray(activeHours);
    if (!activeHoursIsObj || inActiveHours(activeHours, config.timezone ?? 'UTC')) {
      const heartbeatEverySecs = parseDuration(heartbeatCfg.every ?? '2h');
      const staleThresholdSecs = heartbeatEverySecs * staleFactor;

      const heartbeatAge = getFileAgeSecs(HEARTBEAT_FILE);
      if (heartbeatAge !== null) {
        const watchdogState = readWatchdogState();
        const currentPaneHash = getPaneHash(sessionName);

        if (heartbeatAge > staleThresholdSecs) {
          // Operator-recency guard: back off if operator was active recently
          const opAge = getOperatorLastActionAgeSecs();
          if (opAge !== null && opAge < operatorGraceSecs) {
            watchdogState.consecutive_stale = 0;
            watchdogState.last_pane_hash = currentPaneHash;
            writeWatchdogState(watchdogState);
            process.exit(0);
          }

          const monitorDead = !checkProcessRunning('heartbeat-monitor.sh');

          const prevHash = watchdogState.last_pane_hash;
          const paneFrozen =
            currentPaneHash !== null && prevHash != null && currentPaneHash === prevHash;

          const consecutive = (watchdogState.consecutive_stale ?? 0) + 1;

          if (consecutive >= escalateAfter && paneFrozen && monitorDead) {
            // Persist the bumped count so doctor's checkWatchdog reports it
            // accurately even though doRestart doesn't touch watchdog-state.
            watchdogState.consecutive_stale = consecutive;
            watchdogState.last_pane_hash = currentPaneHash;
            writeWatchdogState(watchdogState);
            await doRestart(sessionName, 'pane-frozen', runtime, timezone);
          } else {
            doNudge(sessionName, watchdogState, consecutive, currentPaneHash, timezone);
          }
        } else {
          // Heartbeat recovered — reset the episode and re-arm the wedge push so a
          // genuinely new wedge later can notify again.
          watchdogState.consecutive_stale = 0;
          watchdogState.wedge_notified = false;
          watchdogState.last_pane_hash = currentPaneHash;
          writeWatchdogState(watchdogState);
        }
      }
    }
  }

  // 5. Re-arm fallback: fire if heartbeat-restart routine hasn't fired in ~26h.
  // Damped like step 6 (one attempt per MONITOR_REARM_DAMPER_SECS): the fired
  // metric only advances at the routine's next real fire, so an undamped check
  // re-injects both bootstrap prompts every tick for up to ~24h. Never inject
  // while paused (PROP-015), mirroring the other send paths.
  let rearmedThisTick = false;
  const rearmThresholdSecs = 26 * 3600;
  const routineAge = getLastRoutineFiredAgeSecs('heartbeat-restart');
  if (routineAge !== null && routineAge > rearmThresholdSecs && !isPaused(HERMIT_ROOT).paused) {
    const opAge = getOperatorLastActionAgeSecs();
    // Only re-arm when operator is silent (not in the middle of a conversation)
    if (opAge === null || opAge >= operatorGraceSecs) {
      const watchdogState = readWatchdogState();
      if (rearmDamperOpen(watchdogState.last_rearm_fallback) && tmuxSessionAlive(sessionName)) {
        doRearm(sessionName);
        watchdogState.last_rearm_fallback = utcStamp();
        writeWatchdogState(watchdogState);
        rearmedThisTick = true;
      }
    }
  }

  // 6. Liveness-keyed monitor re-arm: recover a heartbeat/routine Monitor that died
  // mid-session, detected via its stale liveness file rather than step 5's fired-age
  // heuristic (which needs a model-issued 'fired' metric that can be missing).
  maybeMonitorRearm(config, sessionName, operatorGraceSecs, rearmedThisTick);
}

// --- Install / uninstall ---

/** Read tmux session name from config for install commands. */
function getSessionName(): string {
  if (!fs.existsSync(CONFIG_PATH)) return 'hermit';
  return deriveSessionName(readSettledConfig(HERMIT_ROOT));
}

/** Locate state-templates/watchdog/ relative to this script's plugin root. */
function findTemplatesDir(): string | null {
  const candidate = path.resolve(import.meta.dir, '..', 'state-templates', 'watchdog');
  try {
    if (fs.statSync(candidate).isDirectory()) return candidate;
  } catch {}
  return null;
}

/**
 * The PATH to bake into generated units.
 *
 * systemd user services, launchd agents and cron all run with an environment
 * that does not carry ~/.bun/bin, so the bare `bun` at the end of the
 * hermit-watchdog shim exits 127 on every tick — silently, forever. Baking a
 * PATH fixes that, but a hardcoded directory list cannot: it varies by OS, by
 * architecture (Intel vs Apple Silicon homebrew prefixes) and by how the
 * operator installed each tool. Snapshotting the installer's own environment is
 * correct by construction — cmdInstall runs under bun in the operator's shell,
 * so process.execPath is exactly the bun being used and process.env.PATH is an
 * environment where claude and tmux resolve too. The restart path needs those:
 * hermit-start's preflight hard-fails without them.
 */
function resolveUnitPath(): string {
  const seen = new Set<string>();
  const out: string[] = [];
  // Absolute entries only: a relative one (npm/bun script wrappers prepend
  // `node_modules/.bin`) would resolve against the unit's WorkingDirectory —
  // the project root — turning a repo-writable dir into a lookup path the
  // watchdog consults every five minutes.
  for (const entry of [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)]) {
    if (!entry || !path.isAbsolute(entry) || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.join(path.delimiter);
}

// One value, three renderers, three escaping grammars. systemd expands
// %-specifiers in unit files, so a literal percent must be doubled
// (systemd.unit(5)). cron converts an unescaped % to a newline and feeds
// everything after it to the command as stdin, truncating the line
// (crontab(5)). The plist value sits inside an XML <string>. Applied to every
// substituted value, not just PATH — a project path can carry the same
// characters.
const escapeSystemd = (v: string) => v.replaceAll('%', '%%');
const escapeCron = (v: string) => v.replaceAll('%', '\\%');
const escapeXml = (v: string) =>
  v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function printCronFallback(root: string, unitPath: string): void {
  // The assignment must sit on the watchdog invocation itself: a shell
  // assignment prefix applies only to the single command it precedes, and `cd`
  // is a builtin, so `PATH=... cd x && cmd` leaves cmd on cron's default PATH.
  const cronLine =
    `*/5 * * * * cd "${escapeCron(root)}" && PATH="${escapeCron(unitPath)}" ` +
    `.claude-code-hermit/bin/hermit-watchdog run ` +
    `2>>.claude-code-hermit/state/watchdog.log`;
  console.log('[watchdog] Add the following line via `crontab -e`:');
  console.log(`  ${cronLine}`);
}

const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'inherit' });

/** Platform-dispatching install: systemd (Linux/WSL), launchd (macOS), cron fallback. */
function cmdInstall(): void {
  const root = fs.realpathSync(process.cwd());
  const name = getSessionName();
  const templates = findTemplatesDir();
  const unitPath = resolveUnitPath();

  const render = (templateText: string, escape: (v: string) => string) =>
    templateText
      .replaceAll('{{NAME}}', escape(name))
      .replaceAll('{{ROOT}}', escape(root))
      .replaceAll('{{UNIT_PATH}}', escape(unitPath));

  if (process.platform === 'linux') {
    if (!Bun.which('systemctl')) {
      console.log('[watchdog] systemctl not found — systemd is unavailable on this host.');
      console.log(
        '[watchdog] In the hermit Docker container the entrypoint already runs the ' +
          'watchdog on a ~5 min cycle; no install is needed there.'
      );
      printCronFallback(root, unitPath);
      return;
    }

    const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(systemdDir, { recursive: true });
    const serviceName = `hermit-watchdog@${name}`;

    for (const [tplName, outName] of [
      ['hermit-watchdog@.service', `${serviceName}.service`],
      ['hermit-watchdog@.timer', `${serviceName}.timer`],
    ]) {
      if (templates) {
        const tpl = fs.readFileSync(path.join(templates, tplName), 'utf-8');
        fs.writeFileSync(path.join(systemdDir, outName), render(tpl, escapeSystemd));
      } else {
        process.stderr.write(`[watchdog] template ${tplName} not found; skipping\n`);
      }
    }

    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', `${serviceName}.timer`]);
    console.log(`[watchdog] Installed systemd user timer: ${serviceName}.timer`);
    console.log('[watchdog] To persist across reboots without a user session: loginctl enable-linger');
  } else if (process.platform === 'darwin') {
    const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgents, { recursive: true });
    const plistName = `com.hermit.watchdog.${name}.plist`;
    const plistPath = path.join(launchAgents, plistName);

    if (templates) {
      const tpl = fs.readFileSync(path.join(templates, 'com.hermit.watchdog.plist'), 'utf-8');
      fs.writeFileSync(plistPath, render(tpl, escapeXml));
    } else {
      process.stderr.write('[watchdog] plist template not found; using inline fallback\n');
      fs.writeFileSync(
        plistPath,
        render(
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
            '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
            '<plist version="1.0"><dict>' +
            '<key>Label</key><string>com.hermit.watchdog.{{NAME}}</string>' +
            '<key>ProgramArguments</key><array>' +
            '<string>{{ROOT}}/.claude-code-hermit/bin/hermit-watchdog</string>' +
            '<string>run</string></array>' +
            '<key>WorkingDirectory</key><string>{{ROOT}}</string>' +
            '<key>EnvironmentVariables</key><dict>' +
            '<key>PATH</key><string>{{UNIT_PATH}}</string>' +
            '</dict>' +
            '<key>StartInterval</key><integer>300</integer>' +
            '<key>RunAtLoad</key><false/>' +
            '</dict></plist>\n',
          escapeXml
        )
      );
    }
    // load is a no-op when the label is already loaded, so re-running install —
    // the documented remedy for a bad unit — would silently keep the old plist.
    // Ignore output: on a first install there is nothing to unload.
    spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
    run('launchctl', ['load', plistPath]);
    console.log(`[watchdog] Installed LaunchAgent: ${plistName}`);
  } else {
    console.log('[watchdog] systemd and launchd not available on this platform.');
    printCronFallback(root, unitPath);
  }
}

/** Remove the installed OS timer for this project. */
function cmdUninstall(): void {
  const name = getSessionName();

  if (process.platform === 'linux') {
    if (!Bun.which('systemctl')) {
      console.log('[watchdog] systemctl not found — no systemd timer to remove.');
      console.log('[watchdog] In Docker the watchdog runs via the entrypoint loop, not an OS timer.');
      return;
    }

    const serviceName = `hermit-watchdog@${name}`;
    run('systemctl', ['--user', 'disable', '--now', `${serviceName}.timer`]);
    const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    for (const suffix of ['.service', '.timer']) {
      try {
        fs.unlinkSync(path.join(systemdDir, `${serviceName}${suffix}`));
      } catch {}
    }
    run('systemctl', ['--user', 'daemon-reload']);
    console.log(`[watchdog] Removed systemd timer: ${serviceName}.timer`);
  } else if (process.platform === 'darwin') {
    const plistName = `com.hermit.watchdog.${name}.plist`;
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', plistName);
    if (fs.existsSync(plistPath)) {
      run('launchctl', ['unload', plistPath]);
      fs.unlinkSync(plistPath);
    }
    console.log(`[watchdog] Removed LaunchAgent: ${plistName}`);
  } else {
    console.log('[watchdog] Cron entries must be removed manually with `crontab -e`.');
  }
}

/**
 * Bounce the managed session on demand, reusing the same locked restart path
 * the watchdog's own recovery uses. Exists because credentials are read at
 * process start: after a token renewal something has to restart claude, and
 * every front door (terminal mint, relay, /relogin skill) should go through
 * one implementation rather than improvising its own kill-and-respawn.
 */
async function cmdRestart(reason: string): Promise<void> {
  if (!fs.existsSync(CONFIG_PATH)) {
    process.stderr.write('[watchdog] no config — nothing to restart\n');
    process.exit(0);
  }
  const config: Json = readSettledConfig(HERMIT_ROOT);
  const runtime = readRuntimeJson();
  if (runtime === null) process.exit(0);
  const sessionName = runtime.tmux_session || deriveSessionName(config);
  if (!sessionName) process.exit(0);
  await doRestart(sessionName, reason, runtime, config.timezone ?? 'UTC');
}

if (import.meta.main) {
  const subcommand = process.argv[2] ?? 'run';
  if (subcommand === 'run' || subcommand === '') {
    try {
      await main();
    } catch (e) {
      process.stderr.write(`[watchdog] fatal: ${e}\n`);
      process.exit(0); // fail-open: watchdog must never crash the calling shell
    }
  } else if (subcommand === 'install') {
    cmdInstall();
  } else if (subcommand === 'uninstall') {
    cmdUninstall();
  } else if (subcommand === 'restart') {
    await cmdRestart(process.argv[3] ?? 'manual');
  } else {
    process.stderr.write(`[watchdog] unknown subcommand: ${subcommand}\n`);
    process.exit(1);
  }
}
