// Evaluate or validate a success_signal predicate for a hermit proposal.
//
// Validate mode (grammar check only — no state reads, so no state dir):
//   proposal.ts success-signal --validate "<predicate>"
//   Exits 0 + prints "OK" if valid. Exits 1 + prints a reason if invalid — callers
//   (proposal-create, proposal-act) branch on that exit code, so it must stay
//   non-zero even though every other proposal.ts verb exits 0.
//
// Evaluate mode (check predicate against session reports):
//   proposal.ts success-signal <stateDir> "<accepted_date>" "<accepted_in_session|null>" "<predicate>"
//   Prints one JSON line:
//     {"verdict":"MET|UNMET|INSUFFICIENT_DATA","metric":"...","op":"...","threshold":N,"window":N,"observed":N,"sessions_counted":N}
//   Never throws — any failure emits INSUFFICIENT_DATA.
//
// v1 grammar (one metric):
//   avg_session_cost_usd <OP> <NUMBER> over <N> sessions
//   OP in {<, <=, >, >=}; NUMBER positive float; N positive integer.

import path from 'node:path';
import { readFrontmatter, globDir } from '../frontmatter';

type Json = any;

// ─── Grammar ──────────────────────────────────────────────────────────────────

const GRAMMAR = /^(\w+)\s*(<=?|>=?)\s*(\d+(?:\.\d+)?)\s+over\s+(\d+)\s+sessions?$/;

const SUPPORTED_METRICS = new Set(['avg_session_cost_usd']);

function parseSignal(predicate: string): { metric: string; op: string; threshold: number; window: number } | null {
  const m = GRAMMAR.exec(predicate.trim());
  if (!m) return null;
  const metric = m[1];
  const op = m[2];
  const threshold = parseFloat(m[3]);
  const window = parseInt(m[4], 10);
  if (!SUPPORTED_METRICS.has(metric)) return null;
  if (threshold <= 0) return null;
  if (window < 1) return null;
  return { metric, op, threshold, window };
}

function applyOp(observed: number, op: string, threshold: number): boolean {
  switch (op) {
    case '<':  return observed < threshold;
    case '<=': return observed <= threshold;
    case '>':  return observed > threshold;
    case '>=': return observed >= threshold;
    default:   return false;
  }
}

// ─── Validate mode ────────────────────────────────────────────────────────────

function runValidate(predicate: string) {
  const parsed = parseSignal(predicate);
  if (!parsed) {
    // Give a specific reason.
    const m = GRAMMAR.exec(predicate.trim());
    if (!m) {
      process.stdout.write(
        `invalid grammar; expected: avg_session_cost_usd <OP> <NUMBER> over <N> sessions (OP: < <= > >=)\n`
      );
    } else if (!SUPPORTED_METRICS.has(m[1])) {
      process.stdout.write(`unsupported metric '${m[1]}'; v1 supports: ${[...SUPPORTED_METRICS].join(', ')}\n`);
    } else {
      process.stdout.write(`invalid predicate values\n`);
    }
    process.exit(1);
  }
  process.stdout.write('OK\n');
  process.exit(0);
}

// ─── Evaluate mode ────────────────────────────────────────────────────────────

function emit(obj: Json) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitInsufficient(parsed: Json) {
  emit({
    verdict: 'INSUFFICIENT_DATA',
    metric: parsed ? parsed.metric : null,
    op: parsed ? parsed.op : null,
    threshold: parsed ? parsed.threshold : null,
    window: parsed ? parsed.window : null,
    observed: null,
    sessions_counted: 0,
  });
}

function runEvaluate(stateDir: string, acceptedDateStr: string, acceptedInSession: string, predicate: string) {
  const parsed = parseSignal(predicate);
  if (!parsed) {
    emitInsufficient(null);
    return;
  }

  let acceptedDate: Date;
  try {
    acceptedDate = new Date(acceptedDateStr);
    if (isNaN(acceptedDate.getTime())) throw new Error('bad date');
  } catch {
    emitInsufficient(parsed);
    return;
  }

  const sessionsDir = path.join(stateDir, 'sessions');
  const reportFiles = globDir(sessionsDir, /^S-\d+-REPORT\.md$/);

  const candidates: { id: string; date: Date; cost_usd: number }[] = [];
  for (const file of reportFiles) {
    try {
      const fm = readFrontmatter(file);
      if (!fm) continue;
      const id = fm.id || path.basename(file).replace(/-REPORT\.md$/, '');
      if (acceptedInSession && acceptedInSession !== 'null' && id === acceptedInSession) continue;
      if (!fm.date) continue;
      const reportDate = new Date(fm.date);
      if (isNaN(reportDate.getTime())) continue;
      if (reportDate < acceptedDate) continue;
      // cost_usd is populated only when the cost-tracker hook is active; the
      // template default is 0.00. Treat <= 0 as unrecorded (not a real $0
      // session) and skip it, so an install without cost tracking can't
      // spuriously satisfy a cost-reduction predicate. The window simply takes
      // longer to fill (INSUFFICIENT_DATA holds) until N recorded sessions exist.
      const cost = parseFloat(fm.cost_usd || 0);
      if (!(cost > 0)) continue;
      candidates.push({ id, date: reportDate, cost_usd: cost });
    } catch {
      // readFrontmatter is fail-open, but downstream date/float parsing can still throw.
    }
  }

  candidates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (candidates.length < parsed.window) {
    emit({
      verdict: 'INSUFFICIENT_DATA',
      metric: parsed.metric,
      op: parsed.op,
      threshold: parsed.threshold,
      window: parsed.window,
      observed: null,
      sessions_counted: candidates.length,
    });
    return;
  }

  const sample = candidates.slice(0, parsed.window);
  let observed: number;
  switch (parsed.metric) {
    case 'avg_session_cost_usd': {
      const total = sample.reduce((sum, s) => sum + s.cost_usd, 0);
      observed = Math.round((total / sample.length) * 10000) / 10000;
      break;
    }
    default:
      emitInsufficient(parsed);
      return;
  }

  const met = applyOp(observed, parsed.op, parsed.threshold);
  emit({
    verdict: met ? 'MET' : 'UNMET',
    metric: parsed.metric,
    op: parsed.op,
    threshold: parsed.threshold,
    window: parsed.window,
    observed,
    sessions_counted: sample.length,
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function run(args: string[]): void {
  if (args[0] === '--validate') {
    if (args.length < 2) {
      process.stdout.write('usage: proposal.ts success-signal --validate "<predicate>"\n');
      process.exit(1);
    }
    runValidate(args.slice(1).join(' '));
  } else {
    if (args.length < 4) {
      process.stdout.write(
        'usage: proposal.ts success-signal <stateDir> "<accepted_date>" "<accepted_in_session|null>" "<predicate>"\n'
      );
      // Fail open — emit INSUFFICIENT_DATA so reflect doesn't crash.
      emitInsufficient(null);
      return;
    }
    const [stateDir, acceptedDate, acceptedInSession, ...rest] = args;
    runEvaluate(stateDir, acceptedDate, acceptedInSession, rest.join(' '));
  }
}
