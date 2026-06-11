// Shared time-parsing helpers for the HA snapshot pipeline.
// WP7 tier 1 port of src/ha_agent_lab/time_utils.py.
//
// Representation note: Python returned datetime objects (naive datetimes kept
// naive until days_since's astimezone(UTC), which interprets them as local
// time). JS Dates are always instants; new Date() applies the same
// local-time interpretation to offset-less inputs, so daysSince arithmetic
// matches the Python behavior.

const ISO_RE =
  /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2}(:\d{2})?)?)?)?$/;

/** Parse an ISO 8601 timestamp. Returns null for falsy or malformed input. */
export function parseIso(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  if (!ISO_RE.test(ts)) return null;
  // Date-only input: Python's fromisoformat yields naive local midnight,
  // while bare "YYYY-MM-DD" in JS parses as UTC midnight — append a local
  // time component to match Python.
  const date = new Date(ts.length === 10 ? `${ts}T00:00:00` : ts);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Whole days between two timestamps (now - then). Returns null if `then` is null. */
export function daysSince(now: Date, then: Date | null): number | null {
  if (then === null) return null;
  // Python: int(delta.total_seconds() // 86400) — floor division.
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}
