// Drain a pending channel-requested harness command into the tmux pane.
// Split out of stop-pipeline.ts so the guard cascade is unit-testable without
// spawning the whole Stop hook.

import { readRuntimeJson } from './runtime';
import { sendKeys, tmuxSessionAlive } from './tmux';
import { applyContextReset } from './context-reset';
import { clearPendingCommand, readPendingCommand, renderCommand, writeSwitchVerify } from './harness-command';
import { currentHHMMOrUTC } from './time';
import { readSettledConfig } from './config-read';
import path from 'node:path';

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
 *
 * Every path here is anchored to `hermitRoot`, reads included: the runtime object read
 * below is the same object applyContextReset writes back to `hermitRoot/state`, and a
 * cwd-relative read would pair a drifted (or decoy) source with an anchored write — the
 * exact split context-reset.ts already had to fix once.
 */
export function drainHarnessCommand(hermitRoot: string): void {
  const pending = readPendingCommand(hermitRoot);
  if (!pending) return;

  const runtime = readRuntimeJson(path.join(hermitRoot, 'state'));
  if (!runtime || runtime.runtime_mode === 'interactive') return;
  if (runtime.transition || runtime.shutdown_requested_at || runtime.shutdown_completed_at) return;

  const sessionName: string = runtime.tmux_session ?? '';
  if (!sessionName || !tmuxSessionAlive(sessionName)) return;

  const text = renderCommand(pending);

  if (!sendKeys(sessionName, text)) {
    console.error(`[stop-pipeline] harness-command: tmux refused "${text}" — marker kept for retry`);
    return;
  }
  clearPendingCommand(hermitRoot);

  // Claude does not process the submitted slash command until this Stop hook returns.
  // Delegate the narrowly-scoped confirmation check so it can observe the resulting
  // dialog after this process exits; doing a synchronous capture here races a pane that
  // cannot render yet.
  if (pending.command === '/model' || pending.command === '/effort') {
    // The session cannot see its own switch: the model's sense of which model it runs
    // is fixed at session start. Leave a marker so the prompt path answers that from
    // the transcript instead of from stale self-perception (lib/prompt-stages/
    // harness-verify.ts). Only a confirmed send reaches here, so the marker can never
    // describe a switch that was not delivered.
    writeSwitchVerify(hermitRoot, {
      command: pending.command,
      arg: pending.arg,
      by: pending.by,
      delivered_at: new Date().toISOString(),
    });

    const helper = path.join(import.meta.dir, '..', 'confirm-harness-switch.ts');
    const child = Bun.spawn([process.execPath, helper, sessionName, pending.command], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      env: process.env,
    });
    child.unref();
  }

  // Bookkeeping AFTER the confirmed send, not before: a refused send keeps the marker for
  // the next turn, and a pre-send stamp would have recorded a reset that never happened —
  // then re-recorded it on every retry until the TTL expired.
  if (pending.command === '/clear') {
    applyContextReset(hermitRoot, runtime, {
      kind: 'cleared',
      trigger: 'channel',
      hhmm: currentHHMMOrUTC(readSettledConfig(hermitRoot).timezone ?? 'UTC'),
    });
  }
  console.error(`[stop-pipeline] harness-command: delivered "${text}" (requested by ${pending.by})`);
}
