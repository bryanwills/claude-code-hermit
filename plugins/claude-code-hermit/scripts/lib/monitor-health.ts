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
