// Source-owned constructors for `state/observations.jsonl`.
//
// Every row is { ts, pattern, session_id, source } plus source-specific extras.
// `ts` is stamped here and `session_id` resolved here, so nothing — script or
// skill prose — hand-assembles either. Sources split two ways:
//
//   CLI_SOURCES            model-authored labels, written through observations.ts
//   DETERMINISTIC_SOURCES  computed facts, written by the script that computes them
//
// The split is enforced rather than documented: observations.ts rejects a
// deterministic source, so a computed row cannot be forged from prose, and the
// script that owns a fact is the only thing that can record it.

import path from 'node:path';
import { appendJsonlLine } from './append-jsonl';
import { readJson } from './cli';
import { utcISOStamp } from './time';

type Origin = 'own-work' | 'external-content';

const CLI_SOURCES = ['quick-deferral', 'reflect-noticed', 'skill-correction'] as const;
const DETERMINISTIC_SOURCES = ['cost-spike', 'behavior-digest', 'startup-drift'] as const;

type CliSource = (typeof CLI_SOURCES)[number];
type Source = CliSource | (typeof DETERMINISTIC_SOURCES)[number];

// Sources whose rows carry an `origin`. The rest omit the key entirely — readers
// treat a missing origin as own-work (skills/reflect/SKILL.md § observations).
const ORIGIN_SOURCES = new Set<string>(['reflect-noticed', 'skill-correction', 'startup-drift']);

const ORIGINS: string[] = ['own-work', 'external-content'];

// `pattern` is the grouping key reflect matches on by exact string equality, so a
// runaway label would never group with anything and would bloat every read of the
// ledger. Bounded at the boundary where model text enters.
const MAX_PATTERN = 200;

function observationsPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'observations.jsonl');
}

// runtime.json is optional and carries a null session_id between sessions —
// 'unknown' is what reflect-precheck has always written in that case.
function resolveSessionId(stateDir: string): string {
  const id = readJson(path.join(stateDir, 'state', 'runtime.json'))?.session_id;
  return typeof id === 'string' && id ? id : 'unknown';
}

type RowInput = {
  source: Source;
  pattern: string;
  sessionId: string;
  origin?: Origin;
  extra?: Record<string, unknown>;
};

// Returns the row or an error token. Field insertion order matches the rows this
// ledger has always carried — JSON.stringify preserves it, so historical and new
// rows are indistinguishable to every reader.
function observationRow(input: RowInput): { row: Record<string, unknown> } | { error: string } {
  const pattern = input.pattern.trim();
  if (!pattern) return { error: 'empty-pattern' };
  if (pattern.includes('\n')) return { error: 'multiline-pattern' };
  if (pattern.length > MAX_PATTERN) return { error: `pattern-too-long:${pattern.length}` };

  if (input.origin !== undefined) {
    if (!ORIGIN_SOURCES.has(input.source)) return { error: `origin-not-allowed:${input.source}` };
    if (!ORIGINS.includes(input.origin)) return { error: `invalid-origin:${input.origin}` };
  }

  const row: Record<string, unknown> = {
    ts: utcISOStamp(),
    pattern,
    session_id: input.sessionId,
    source: input.source,
  };
  if (input.origin !== undefined) row.origin = input.origin;
  // `extra` may only widen a row, never rewrite its identity — an extra key named
  // `source` or `session_id` would otherwise silently forge the very fields this
  // module exists to own.
  for (const [k, v] of Object.entries(input.extra ?? {})) {
    if (k in row) return { error: `reserved-extra-key:${k}` };
    row[k] = v;
  }
  return { row };
}

// Serializes one row without writing — for callers that batch several appends into
// a single write (reflect-precheck collects its drift rows this way).
function observationLine(input: RowInput): { line: string } | { error: string } {
  const built = observationRow(input);
  return 'error' in built ? built : { line: JSON.stringify(built.row) };
}

function appendObservation(stateDir: string, input: RowInput): string | null {
  const built = observationRow(input);
  if ('error' in built) return built.error;
  return appendJsonlLine(observationsPath(stateDir), JSON.stringify(built.row));
}

export {
  CLI_SOURCES,
  DETERMINISTIC_SOURCES,
  MAX_PATTERN,
  observationsPath,
  resolveSessionId,
  observationRow,
  observationLine,
  appendObservation,
};
export type { Origin, Source, CliSource, RowInput };
