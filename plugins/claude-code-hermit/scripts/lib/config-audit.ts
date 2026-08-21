// Settings audit ledger — one row per changed config leaf, appended after the
// owning writer's own successful write.
//
// This is deliberately NOT a shared config-write chokepoint. The scripts that
// write config.json each have a different, intentional failure contract
// (settings-edit aborts on a malformed file, hatch-config validates then dies,
// evolve-finalize returns a structured error and re-reads to verify,
// channel-bot-id degrades to a SKIP line, channel-hook is silently fail-open).
// A shared writer would flatten all five. Instead each writer keeps its own
// write and calls auditConfigChange() afterwards; the diff happens here, so a
// writer cannot forget to report a change or report one that did not happen.
//
// Every failure mode is swallowed: an audit row is never worth breaking a
// settings write that already succeeded.

import fs from 'node:fs';
import path from 'node:path';
import { appendJsonlLine } from './append-jsonl';
import { readRuntimeJson } from './runtime';
import { utcISOStamp } from './time';

type Json = any;

export type AuditTarget = 'config.json' | '.claude/settings.json' | '.claude/settings.local.json';

export interface AuditRow {
  ts: string;
  session_id: string;
  actor: string;
  target: AuditTarget;
  path: string;
  old?: Json;
  new?: Json;
}

const RETENTION_DAYS = 90;
const VALUE_CAP = 120;

/** Path segments whose values never enter the ledger — only presence markers. */
const SECRET_SEGMENT = /^(.*token|.*secret|.*password|.*bearer)$/i;

export function ledgerPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'settings-audit.jsonl');
}

/** True when the leaf at `dotted` carries a credential, so its value must never be stored. */
export function isSecretPath(dotted: string): boolean {
  const segments = dotted.split('.');
  if (segments[0] === 'env') return true;
  return segments.some((s) => SECRET_SEGMENT.test(s));
}

/** Presence marker for a redacted leaf: what it became, never what it was. */
function presence(value: Json): string {
  return value === undefined || value === null || value === '' ? '[cleared]' : '[set]';
}

/** Serialize a value for the ledger, capped so a tail-read stays bounded. */
function capValue(value: Json): Json {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') {
    return value.length > VALUE_CAP ? value.slice(0, VALUE_CAP) + '…' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const encoded = JSON.stringify(value) ?? '';
  return encoded.length > VALUE_CAP ? encoded.slice(0, VALUE_CAP) + '…' : encoded;
}

function isPlainObject(v: Json): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Leaf-level diff. Arrays are atomic: a routines[] edit is one row, not one row
 * per index — index-level rows churn on reorder and read as noise.
 */
export function diffLeaves(before: Json, after: Json, prefix = ''): Array<{ path: string; old: Json; new: Json }> {
  const changes: Array<{ path: string; old: Json; new: Json }> = [];
  const keys = new Set([
    ...(isPlainObject(before) ? Object.keys(before) : []),
    ...(isPlainObject(after) ? Object.keys(after) : []),
  ]);
  for (const key of keys) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    const b = isPlainObject(before) ? before[key] : undefined;
    const a = isPlainObject(after) ? after[key] : undefined;
    if (isPlainObject(b) && isPlainObject(a)) {
      changes.push(...diffLeaves(b, a, dotted));
      continue;
    }
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    changes.push({ path: dotted, old: b, new: a });
  }
  return changes;
}

/** Drop rows older than the retention window; only called when the head row is stale. */
function pruneStale(file: string, now: Date): void {
  const cutoff = now.getTime() - RETENTION_DAYS * 86_400_000;
  const kept = fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => {
      if (!line.trim()) return false;
      try {
        return new Date(JSON.parse(line).ts).getTime() >= cutoff;
      } catch {
        return true; // unparseable lines are kept verbatim, per house rule
      }
    });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Prune only when the ledger's oldest row has aged out — avoids rewriting on every append. */
function pruneIfHeadStale(file: string, now: Date): void {
  if (!fs.existsSync(file)) return;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(512);
    const read = fs.readSync(fd, buf, 0, 512, 0);
    const head = buf.subarray(0, read).toString('utf-8').split('\n')[0];
    if (!head.trim()) return;
    const ts = new Date(JSON.parse(head).ts).getTime();
    if (Number.isNaN(ts) || ts >= now.getTime() - RETENTION_DAYS * 86_400_000) return;
  } catch {
    return;
  } finally {
    fs.closeSync(fd);
  }
  pruneStale(file, now);
}

/**
 * Append one row per changed leaf. `before === undefined` means the file did not
 * exist (hatch), which records a single "config created" row rather than one row
 * per default the template ships.
 *
 * Call this AFTER the caller's own write has succeeded — auditing first would
 * record changes that a failed write never made. Never throws.
 */
export function auditConfigChange(
  stateDir: string,
  before: Json,
  after: Json,
  actor: string,
  target: AuditTarget = 'config.json',
): void {
  try {
    // The ledger belongs to an existing hermit. Never bring the state dir into
    // being here: a caller that resolved the wrong directory would otherwise
    // scatter .claude-code-hermit/ dirs outside any project (and a stray one
    // captures hermitDir()'s walk-up for every later script run).
    if (!fs.existsSync(stateDir)) return;

    const ts = utcISOStamp();
    const runtime = readRuntimeJson(path.join(stateDir, 'state'));
    const session_id = runtime?.session_id ?? 'unknown';

    const rows: AuditRow[] =
      before === undefined
        ? [{ ts, session_id, actor, target, path: '*', new: 'config created' }]
        : diffLeaves(before, after).map(({ path: dotted, old, new: next }) =>
            isSecretPath(dotted)
              ? { ts, session_id, actor, target, path: dotted, old: presence(old), new: presence(next) }
              : { ts, session_id, actor, target, path: dotted, old: capValue(old), new: capValue(next) },
          );
    if (rows.length === 0) return;

    const file = ledgerPath(stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    pruneIfHeadStale(file, new Date());
    // Create with 0600 before appending — rows can carry channel and user IDs,
    // and appendFileSync would otherwise leave the file at the process umask.
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'a', 0o600));
    for (const row of rows) appendJsonlLine(file, JSON.stringify(row));
  } catch {
    // Fail open: the config write already landed, and a missing audit row must
    // never turn a successful settings change into an error for the operator.
  }
}

/** Newest-last rows, optionally filtered by dotted-path prefix. Bounded by `limit`. */
export function readHistory(stateDir: string, dotted?: string, limit = 20): AuditRow[] {
  const file = ledgerPath(stateDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const rows: AuditRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as AuditRow;
      if (dotted && row.path !== dotted && !row.path.startsWith(`${dotted}.`)) continue;
      rows.push(row);
    } catch {
      continue;
    }
  }
  return rows.slice(-limit);
}
