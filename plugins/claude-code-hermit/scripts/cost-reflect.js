'use strict';

const fs = require('fs');
const path = require('path');

const { costByType } = require('./lib/pricing');

// Cold-start heuristic: a turn where the context was NOT warm.
// These turns drive cache_write cost without benefiting from a warm cache.
// Condition: cache was written (non-trivial turn), no prior cache was read,
// and output is small (i.e. this was a context-warm-up rather than real work).
const COLD_START_OUTPUT_MAX = 1000; // tokens

const COST_LOG = path.resolve('.claude/cost-log.jsonl');
const MAX_TOP_SESSIONS = 3;
const MAX_CHARS = 1500;

function parseLogEntries() {
  try {
    const content = fs.readFileSync(COST_LOG, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').reduce((acc, line) => {
      try { acc.push(JSON.parse(line)); } catch {}
      return acc;
    }, []);
  } catch {
    return [];
  }
}

function pct(part, total) {
  if (total === 0) return '0%';
  return Math.round((part / total) * 100) + '%';
}

function formatCost(n) {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function run() {
  const stateDir = process.argv[2] || '.claude-code-hermit';
  const days = Math.max(1, parseInt(process.argv[3], 10) || 7);

  const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const entries = parseLogEntries();

  const window = entries.filter(e => {
    const d = (e.timestamp || '').slice(0, 10);
    return d && d >= cutoffDate;
  });

  if (window.length === 0) {
    process.stdout.write(`No cost data in the last ${days} days.\n`);
    return;
  }

  const totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let coldStartTurns = 0;
  let coldStartCost = 0;
  const sessionMap = {}; // session_id -> { cost, turns, byType }

  for (const e of window) {
    const model = e.model || 'sonnet';
    const inp  = e.input_tokens        || 0;
    const cw   = e.cache_write_tokens  || 0;
    const cr   = e.cache_read_tokens   || 0;
    const out  = e.output_tokens       || 0;

    const types = costByType(model, inp, cw, cr, out);
    const entryCost = types.input + types.cacheWrite + types.cacheRead + types.output;
    totals.input      += types.input;
    totals.cacheWrite += types.cacheWrite;
    totals.cacheRead  += types.cacheRead;
    totals.output     += types.output;

    if (cw > 0 && cr === 0 && out < COLD_START_OUTPUT_MAX) {
      coldStartTurns++;
      coldStartCost += entryCost;
    }

    // Per-session attribution (by sub-cost, not token volume)
    const sid = e.session_id || '';
    if (sid) {
      if (!sessionMap[sid]) {
        sessionMap[sid] = { cost: 0, turns: 0, byType: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } };
      }
      const s = sessionMap[sid];
      s.cost += entryCost;
      s.turns++;
      s.byType.input      += types.input;
      s.byType.cacheWrite += types.cacheWrite;
      s.byType.cacheRead  += types.cacheRead;
      s.byType.output     += types.output;
    }
  }

  const total = totals.input + totals.cacheWrite + totals.cacheRead + totals.output;
  const sessions = Object.keys(sessionMap).length;
  const turns = window.length;

  const topSessions = Object.entries(sessionMap)
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, MAX_TOP_SESSIONS)
    .map(([sid, s]) => {
      const dominant = Object.entries(s.byType).sort((a, b) => b[1] - a[1])[0][0];
      const label = dominant === 'cacheRead' ? 'cache_read' : dominant === 'cacheWrite' ? 'cache_write' : dominant;
      return { id: sid.slice(0, 8), cost: s.cost, turns: s.turns, dominant: label };
    });

  const header = `### Cost by token type (${days}d · ${formatCost(total)} · ${turns} turns / ${sessions} sessions)\n` +
    `- cache_read ${formatCost(totals.cacheRead)} (${pct(totals.cacheRead, total)})` +
    ` · cache_write ${formatCost(totals.cacheWrite)} (${pct(totals.cacheWrite, total)})` +
    ` · output ${formatCost(totals.output)} (${pct(totals.output, total)})` +
    ` · input ${formatCost(totals.input)} (${pct(totals.input, total)})\n`;

  const coldSection = coldStartTurns > 0
    ? `\n### Cold starts\n- ${coldStartTurns} turn${coldStartTurns === 1 ? '' : 's'} · ${formatCost(coldStartCost)} (${pct(coldStartCost, total)}) — cache-write, no cache-read, <${COLD_START_OUTPUT_MAX} output tokens\n`
    : '';

  function buildTopSection(n) {
    if (topSessions.length === 0) return '';
    const lines = topSessions.slice(0, n).map(s =>
      `- ${s.id}: ${formatCost(s.cost)} (${s.turns} turn${s.turns === 1 ? '' : 's'}, mostly ${s.dominant})`
    ).join('\n');
    return `\n### Top sessions\n${lines}\n`;
  }

  // Enforce ≤1500 chars by dropping top-sessions entries until it fits
  for (let n = MAX_TOP_SESSIONS; n >= 0; n--) {
    const body = header + coldSection + buildTopSection(n);
    if (body.length <= MAX_CHARS || n === 0) {
      process.stdout.write(body);
      return;
    }
  }
}

try {
  run();
} catch (err) {
  // Fail-open: never block on a cost-reflect failure
  process.stdout.write(`cost-reflect: error — ${err.message}\n`);
  process.exit(0);
}
