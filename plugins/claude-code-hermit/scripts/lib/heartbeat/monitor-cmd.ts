// The heartbeat monitor's registration identity, in one place.
//
// Two callers judge whether the live heartbeat monitor is the one the config
// currently describes: `routines.ts arm anchor` (deciding whether the daily
// re-arm has anything to do) and `heartbeat.ts start-check` (deciding whether to
// re-register at all). They must agree byte-for-byte — a second rendering of the
// command string is a second definition of "healthy", and the two drift the first
// time an interval or a path changes.

import path from 'node:path';
import { readJson } from '../cli';
import { monitorFreshness } from '../monitor-health';
import { parseDuration } from '../time';

type Json = any;

/** Matches the routine monitor's grace (hermit-watchdog.ts MONITOR_STARTUP_GRACE_SECS). */
export const STARTUP_GRACE_SECS = 120;

export type LegHealth = { healthy: boolean; reason: string };

/**
 * Namespace a freshness reason to its monitor leg. Some of the predicate's own
 * reasons (`liveness-absent`, `liveness-predates-start`) already carry the prefix;
 * adding a second one produced `liveness-liveness-absent`.
 */
export function livenessReason(reason: string): string {
  return reason.startsWith('liveness-') ? reason : `liveness-${reason}`;
}

/** Poll interval in whole seconds, floored at 1 so a `0m` config can't spin. */
export function heartbeatInterval(config: Json): number {
  return Math.max(1, Math.round(parseDuration(config?.heartbeat?.every, 30 * 60_000) / 1000));
}

export function heartbeatCommand(pluginRoot: string, hermitDir: string, config: Json): string {
  return `bash ${path.join(pluginRoot, 'scripts', 'heartbeat-monitor.sh')} ${heartbeatInterval(config)} ${hermitDir}`;
}

/**
 * Is the registered heartbeat monitor current and ticking? `disabled` is reported
 * healthy so the daily anchor leaves a deliberately-off heartbeat alone; `start`
 * is an explicit operator act and treats that reason as a re-arm instead.
 */
export function heartbeatHealth(hermitDir: string, pluginRoot: string, config: Json, nowMs: number): LegHealth {
  if (config?.heartbeat?.enabled === false) return { healthy: true, reason: 'disabled' };
  const runtime = readJson(path.join(hermitDir, 'state', 'heartbeat-monitor.runtime.json'));
  if (!runtime) return { healthy: false, reason: 'runtime-missing' };
  const interval = heartbeatInterval(config);
  if (runtime.interval !== interval) return { healthy: false, reason: 'interval-drift' };
  if (runtime.command !== heartbeatCommand(pluginRoot, hermitDir, config)) {
    return { healthy: false, reason: 'command-drift' };
  }
  const live = readJson(path.join(hermitDir, 'state', 'heartbeat-liveness.json'));
  const freshness = monitorFreshness(
    typeof runtime.started_at === 'string' ? runtime.started_at : null,
    typeof live?.last_peek_at === 'string' ? live.last_peek_at : null,
    3 * interval,
    STARTUP_GRACE_SECS,
    nowMs,
  );
  // `unregistered` means no started_at to trust the tick against — fresh by the
  // predicate's lights, but not evidence THIS registration is alive.
  if (freshness.fresh && freshness.reason !== 'unregistered') {
    return { healthy: true, reason: freshness.reason };
  }
  return { healthy: false, reason: livenessReason(freshness.reason) };
}
