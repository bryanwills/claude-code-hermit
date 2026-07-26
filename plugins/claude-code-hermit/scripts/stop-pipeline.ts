// stop-pipeline.ts — unified Stop hook
// Reads stdin once, runs all stop stages in sequence, touches heartbeat.
// All stage output goes to stderr; nothing is emitted on stdout.

import { run as costTracker } from './cost-tracker';
import { run as sessionDiff } from './session-diff';
import { run as evaluateSession } from './evaluate-session';
import { sessionCrons, backgroundTasks, ccVersion, hermitDir } from './lib/cc-compat';
import { readRuntimeJson } from './lib/runtime';
import { capturePane, sendEnter, sendKeys, tmuxSessionAlive } from './lib/tmux';
import { applyContextReset } from './lib/context-reset';
import {
  MODEL_CONFIRM_RENDER_MS,
  clearPendingCommand,
  isModelSwitchConfirmation,
  readPendingCommand,
  renderCommand,
} from './lib/harness-command';
import { currentHHMMOrUTC } from './lib/time';
import fs from 'node:fs';
import path from 'node:path';

type Json = any;

const HERMIT_DIR = hermitDir();
const HEARTBEAT_FILE = path.join(HERMIT_DIR, 'state', '.heartbeat');
const SNAPSHOT_FILE = path.join(HERMIT_DIR, 'state', 'cc-stop-snapshot.json');
const TURN_FILE = path.join(HERMIT_DIR, 'state', 'operator-turn-open.json');

/** Hermit timezone for breadcrumb stamps — every other Progress Log writer uses it. */
function configTimezone(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERMIT_DIR, 'config.json'), 'utf-8')).timezone ?? 'UTC';
  } catch { return 'UTC'; }
}

/**
 * Deliver a pending channel-requested harness command into the pane.
 *
 * Guards, in order: marker present and within TTL; runtime readable; not interactive
 * (those sessions have no tmux_session); no lifecycle transition or shutdown in flight
 * (the same runtime stamps passesLifecycleGuards checks in hermit-watchdog.ts — a /clear
 * landing mid-archive would destroy the context session-close is still writing from);
 * tmux session alive. The marker is deleted ONLY on a confirmed send — sendKeys returning
 * false means tmux never accepted the keys, so leaving the marker lets the next turn retry
 * rather than silently dropping the request.
 *
 * A /clear additionally routes the hermit-owned bookkeeping through applyContextReset, so
 * an operator-initiated clear leaves the same trace a watchdog-initiated one does —
 * without it the status cache would survive and the watchdog could fire a spurious
 * /compact against the freshly-cleared context. /compact deliberately gets NOTHING: it is
 * exactly what an operator typing /compact in the pane already does, PreCompact fires for
 * a manual /compact and writes the breadcrumb itself (precompact-stamp.ts), and
 * context_cleared is /clear's marker alone (the watchdog's compact tier never sets it).
 */
function drainHarnessCommand(): void {
  const pending = readPendingCommand(HERMIT_DIR);
  if (!pending) return;

  const runtime = readRuntimeJson();
  if (!runtime || runtime.runtime_mode === 'interactive') return;
  if (runtime.transition || runtime.shutdown_requested_at || runtime.shutdown_completed_at) return;

  const sessionName: string = runtime.tmux_session ?? '';
  if (!sessionName || !tmuxSessionAlive(sessionName)) return;

  const text = renderCommand(pending);

  if (!sendKeys(sessionName, text)) {
    console.error(`[stop-pipeline] harness-command: tmux refused "${text}" — marker kept for retry`);
    return;
  }
  clearPendingCommand(HERMIT_DIR);

  // Claude Code applies a model switch immediately when the session has no context.
  // With cached context it instead renders a confirmation whose selected default is
  // "Yes". The trusted channel command already authorized that exact switch, so confirm
  // only the model-specific dialog immediately caused by this delivery. A capture miss,
  // wording drift, or failed Enter leaves the pane untouched and never reissues /model.
  if (pending.command === '/model') {
    Bun.sleepSync(MODEL_CONFIRM_RENDER_MS);
    const pane = capturePane(sessionName);
    if (pane !== null && isModelSwitchConfirmation(pane)) {
      if (sendEnter(sessionName)) {
        console.error(`[stop-pipeline] harness-command: confirmed cached-context switch for "${text}"`);
      } else {
        console.error(`[stop-pipeline] harness-command: tmux refused model-switch confirmation for "${text}"`);
      }
    }
  }

  // Bookkeeping AFTER the confirmed send, not before: a refused send keeps the marker for
  // the next turn, and a pre-send stamp would have recorded a reset that never happened —
  // then re-recorded it on every retry until the TTL expired.
  if (pending.command === '/clear') {
    applyContextReset(HERMIT_DIR, runtime, {
      kind: 'cleared',
      trigger: 'channel',
      hhmm: currentHHMMOrUTC(configTimezone()),
    });
  }
  console.error(`[stop-pipeline] harness-command: delivered "${text}" (requested by ${pending.by})`);
}

async function main(): Promise<void> {
  // Read stdin once
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of process.stdin) {
    totalSize += chunk.length;
    if (totalSize > 1024 * 1024) break;
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();

  // Defensive: fall back to {} on malformed/truncated input.
  // Stages that don't need the payload still run even on bad input.
  let payload: Json = {};
  if (raw) {
    try { payload = JSON.parse(raw); } catch {
      console.error('[stop-pipeline] malformed stdin, falling back to empty payload');
    }
  }

  // Operator-turn marker: whichever turn opened it is over — routines may fire.
  // Cleared before the stages, not after: this hook has a 15s timeout and the
  // stages below can burn it on a large session. A clear stranded behind them
  // would defer every monitor-delivered routine for the marker's full TTL —
  // the starvation class issue #617 fixed, just time-bounded.
  try { fs.unlinkSync(TURN_FILE); } catch {}

  const profile = (process.env.AGENT_HOOK_PROFILE || 'standard').trim().toLowerCase();
  const isStandardPlus = profile !== 'minimal';

  // Stage 1: cost-tracker (always)
  try {
    const out = await costTracker(payload);
    if (out) console.error(out);
  } catch (e: any) { console.error(`[stop-pipeline] cost-tracker: ${e.message}`); }

  // Stage 2: session-diff (standard+, state-aware debounce)
  if (isStandardPlus) {
    try { await sessionDiff(payload); }
    catch (e: any) { console.error(`[stop-pipeline] session-diff: ${e.message}`); }
  }

  // Stage 3: evaluate-session (standard+)
  if (isStandardPlus) {
    try {
      const out = await evaluateSession(payload);
      if (out) console.error(out);
    } catch (e: any) { console.error(`[stop-pipeline] evaluate-session: ${e.message}`); }
  }

  // Stage 4: drain a channel-requested harness command (/model, /effort, /compact, /clear).
  // The turn it arrived on has just ended, so the pane is idle and safe to type into —
  // the hook that recorded it deliberately did NOT type, because it runs at turn START.
  // Runs before the heartbeat touch but after the accounting stages, so a /clear can
  // never race cost-tracker still reading the outgoing transcript.
  try { drainHarnessCommand(); }
  catch (e: any) { console.error(`[stop-pipeline] harness-command: ${e.message}`); }

  // Guaranteed heartbeat touch — runs even if all stages fail
  try { fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString() + '\n'); } catch {}

  // Write CC-stop-payload snapshot (tri-state, labeled with captured_at).
  // sole writer for state/cc-stop-snapshot.json. Fail-open.
  try {
    const crons = sessionCrons(payload);
    const tasks = backgroundTasks(payload);
    const snapshot = {
      captured_at: new Date().toISOString(),
      cc_version: ccVersion(payload),
      session_crons:    { state: crons.state, count: crons.count },
      background_tasks: { state: tasks.state, count: tasks.count },
    };
    const tmp = SNAPSHOT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, SNAPSHOT_FILE);
  } catch {}
}

main().catch(e => { console.error(`[stop-pipeline] ${e.message}`); });
