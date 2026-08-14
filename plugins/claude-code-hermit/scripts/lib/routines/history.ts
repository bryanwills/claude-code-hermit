// state/routine-metrics.jsonl → an ordered per-routine attempt projection.
//
// The ledger records four event kinds: `started` (precheck, at fire time),
// `fired` / `failed-<reason>` (finish — exactly one terminal per attempt), and
// `skipped-*` (due.ts gates, which open no attempt at all). Counting those
// independently — the `errored = started − fired` arithmetic this replaces — is
// wrong in three ways the fold below fixes:
//
//   - `finish` writes a terminal row with no preceding `started` when precheck
//     never stamped one (finish.ts's no-run-record branch), so a subtraction can
//     run negative and mask a real gap elsewhere.
//   - an attempt still open at the window edge is indistinguishable from a
//     crashed one under subtraction. Here it stays `open_attempt`, uncounted,
//     until a later event resolves it.
//   - an attempt straddling the window start belongs to its own attempt, not to
//     the window's counters.
//
// The fold is ordered per routine and carries attempt state across the window
// boundary; only in-window events increment counters.

import fs from 'node:fs';

export type RoutineHistoryEntry = {
  id: string;
  /** `fired` terminals in-window — what "how often did this run" means. */
  fires: number;
  /** `failed-<reason>` terminals in-window, keyed by bare reason. */
  failures: Record<string, number>;
  failure_total: number;
  /** Attempts provably abandoned: a `started` superseded by another `started`. */
  incomplete: number;
  /** Terminals that arrived with no attempt open — never invents a start. */
  orphan_terminals: number;
  /** An attempt was open at the end of the window (may still be running). */
  open_attempt: boolean;
  /** `skipped-*` rows: the routine was due but gated, so no attempt was made. */
  skips: number;
  last_fire: string | null;
};

export type RoutineHistory = {
  routines: RoutineHistoryEntry[];
  /** Rows that failed JSON.parse or lacked a usable ts/routine_id/event. */
  malformed_rows: number;
  source: 'ok' | 'missing' | 'unreadable';
};

type ParsedRow = { ts: number; tsRaw: string; id: string; event: string; seq: number };

function emptyEntry(id: string): RoutineHistoryEntry {
  return {
    id,
    fires: 0,
    failures: {},
    failure_total: 0,
    incomplete: 0,
    orphan_terminals: 0,
    open_attempt: false,
    skips: 0,
    last_fire: null,
  };
}

/**
 * Parses ledger lines into time-ordered rows, counting anything unusable.
 *
 * Ties are common and load-bearing: `utcISOStamp()` truncates to whole seconds,
 * so a `started` and its `fired` routinely share a timestamp. Sorting on ts
 * alone would be free to swap them and turn a normal attempt into an orphan
 * terminal, so the original line order breaks every tie (Array#sort is stable,
 * and `seq` makes that explicit rather than implied).
 */
function parseRows(lines: string[]): { rows: ParsedRow[]; malformed: number } {
  const rows: ParsedRow[] = [];
  let malformed = 0;
  let seq = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    seq += 1;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!e || typeof e.routine_id !== 'string' || !e.routine_id
        || typeof e.event !== 'string' || !e.event || typeof e.ts !== 'string') {
      malformed += 1;
      continue;
    }
    const ts = Date.parse(e.ts);
    if (isNaN(ts)) {
      malformed += 1;
      continue;
    }
    rows.push({ ts, tsRaw: e.ts, id: e.routine_id, event: e.event, seq });
  }
  rows.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
  return { rows, malformed };
}

/** Folds already-read ledger lines. Exported for table tests; `readRoutineHistory` does the IO. */
export function foldRoutineHistory(
  lines: string[],
  sinceMs: number,
  asOfMs: number,
): Omit<RoutineHistory, 'source'> {
  const { rows, malformed } = parseRows(lines);
  const entries = new Map<string, RoutineHistoryEntry>();
  const open = new Map<string, boolean>();
  const touched = new Set<string>();

  const entryFor = (id: string): RoutineHistoryEntry => {
    let entry = entries.get(id);
    if (!entry) { entry = emptyEntry(id); entries.set(id, entry); }
    return entry;
  };

  for (const row of rows) {
    if (row.ts > asOfMs) continue;              // future rows: outside the window entirely
    const inWindow = row.ts >= sinceMs;
    const entry = entryFor(row.id);
    if (inWindow) touched.add(row.id);

    if (row.event === 'started') {
      // A second `started` with the previous attempt still open means the first
      // one never reached `finish`. That is the signal the old subtraction was
      // reaching for, measured directly.
      if (open.get(row.id) && inWindow) entry.incomplete += 1;
      open.set(row.id, true);
      continue;
    }

    const isFired = row.event === 'fired';
    const isFailure = row.event.startsWith('failed-');
    if (isFired || isFailure) {
      const wasOpen = !!open.get(row.id);
      open.set(row.id, false);
      if (!inWindow) continue;
      if (!wasOpen) entry.orphan_terminals += 1;
      if (isFired) {
        entry.fires += 1;
        if (!entry.last_fire || row.tsRaw > entry.last_fire) entry.last_fire = row.tsRaw;
      } else {
        const reason = row.event.slice('failed-'.length) || 'unspecified';
        entry.failures[reason] = (entry.failures[reason] || 0) + 1;
        entry.failure_total += 1;
      }
      continue;
    }

    // `skipped-*` (and any other event string the ledger accepts — event.ts
    // deliberately does not validate) open no attempt and close none.
    if (inWindow && row.event.startsWith('skipped-')) entry.skips += 1;
  }

  for (const [id, isOpen] of open) {
    if (isOpen) { entryFor(id).open_attempt = true; touched.add(id); }
  }

  const routines = [...entries.values()]
    .filter((e) => touched.has(e.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { routines, malformed_rows: malformed };
}

function readLines(metricsPath: string): { lines: string[]; source: RoutineHistory['source'] } {
  if (!fs.existsSync(metricsPath)) return { lines: [], source: 'missing' };
  try {
    return { lines: fs.readFileSync(metricsPath, 'utf-8').split('\n'), source: 'ok' };
  } catch {
    return { lines: [], source: 'unreadable' };
  }
}

/** Reads the ledger and folds it over `[asOf - days, asOf]`. */
export function readRoutineHistory(
  metricsPath: string,
  days: number,
  asOf: Date = new Date(),
): RoutineHistory {
  const { lines, source } = readLines(metricsPath);
  const asOfMs = asOf.getTime();
  const sinceMs = asOfMs - days * 86400000;
  return { ...foldRoutineHistory(lines, sinceMs, asOfMs), source };
}

/**
 * Scans one routine's rows in file order, returning whatever `pick` last
 * yielded. Both lifetime lookups below want the newest row matching a
 * predicate, which is a different question from the windowed fold above — the
 * watchdog and the dedup guard ask "what happened most recently, ever", not
 * "what happened in the last N days".
 */
// `pick` returning undefined means "this row does not answer the question" and
// leaves the previous value standing; returning null clears it.
function lastMatching(
  metricsPath: string,
  routineId: string,
  pick: (e: any) => string | null | undefined,
): string | null {
  const { lines } = readLines(metricsPath);
  let last: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.routine_id === routineId) {
        const value = pick(e);
        if (value !== undefined) last = value;
      }
    } catch { /* skip corrupt lines */ }
  }
  return last;
}

/** Timestamp of the most recent `fired` for one routine, or null. */
export function lastRoutineFire(metricsPath: string, routineId: string): string | null {
  return lastMatching(metricsPath, routineId, (e) =>
    (e.event === 'fired' && typeof e.ts === 'string' ? e.ts : undefined));
}

/**
 * Raw `event` string of the routine's most recent row, or null. Drives
 * event.ts's fired-dedup guard (issue #464), whose invariant is specifically
 * "the latest same-routine event is already `fired`" — so unlike
 * lastRoutineFire this must see every event kind, not just terminals.
 */
export function lastRoutineEvent(metricsPath: string, routineId: string): string | null {
  return lastMatching(metricsPath, routineId, (e) => (typeof e.event === 'string' ? e.event : null));
}
