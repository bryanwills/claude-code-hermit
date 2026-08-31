import { readJson } from './cli';

export type MonitorFreshnessReason =
  | 'fresh'
  | 'stale'
  | 'warming-up'
  | 'liveness-absent'
  | 'liveness-predates-start'
  | 'unregistered';

export type MonitorFreshness = {
  fresh: boolean;
  reason: MonitorFreshnessReason;
};

/**
 * Evaluate monitor liveness from caller-supplied values only.
 *
 * A tick is trusted when it belongs to the current registration. A registered
 * monitor without a trusted tick remains fresh only during its startup grace.
 * An unregistered monitor is not stale: registration belongs to the arming flow.
 */
export function monitorFreshness(
  startedAt: string | null,
  lastPeekAt: string | null,
  thresholdSecs: number,
  graceSecs: number,
  nowMs: number,
): MonitorFreshness {
  const startedAtMs = startedAt === null ? NaN : Date.parse(startedAt);
  const lastPeekAtMs = lastPeekAt === null ? NaN : Date.parse(lastPeekAt);
  const hasStart = Number.isFinite(startedAtMs);
  const hasPeek = Number.isFinite(lastPeekAtMs);
  const trusted = hasPeek && (!hasStart || lastPeekAtMs >= startedAtMs);

  if (trusted) {
    return nowMs - lastPeekAtMs > thresholdSecs * 1000
      ? { fresh: false, reason: 'stale' }
      : { fresh: true, reason: 'fresh' };
  }

  if (!hasStart) return { fresh: true, reason: 'unregistered' };
  if (nowMs - startedAtMs < graceSecs * 1000) {
    return { fresh: true, reason: 'warming-up' };
  }
  return {
    fresh: false,
    reason: hasPeek ? 'liveness-predates-start' : 'liveness-absent',
  };
}

/**
 * Wait up to 10s for a just-registered monitor to write its first liveness tick.
 * Both arming legs (`routines.ts arm commit`, `heartbeat.ts start-commit`) ask the
 * same question — did the subprocess actually spawn? — and both delete the previous
 * record first, so any file that appears here belongs to the registration under test.
 * A healthy monitor writes liveness on its first loop iteration, before any sleep.
 */
export async function waitForFirstTick(livenessFile: string): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() <= deadline) {
    if (typeof readJson(livenessFile)?.last_peek_at === 'string') return true;
    await Bun.sleep(100);
  }
  return false;
}

/**
 * Does a runtime registration belong to a previous boot? A Monitor dies with the
 * session that registered it, and its last liveness tick is at most one interval
 * (heartbeat) or one 60s poll (routines) old when that happens — well inside either
 * leg's freshness window. So liveness alone reads a just-dead registration as "alive"
 * until that window expires. The boot marker is the only thing that proves a
 * registration belongs to THIS process. Both ids must be present to conclude
 * anything: a record written before this field existed, or a hermit with no
 * `.boot-id`, falls through to the plain freshness check instead.
 */
export function bootMismatch(runtimeBootId: unknown, currentBootId: string | null): boolean {
  return typeof runtimeBootId === 'string' && typeof currentBootId === 'string' && runtimeBootId !== currentBootId;
}
