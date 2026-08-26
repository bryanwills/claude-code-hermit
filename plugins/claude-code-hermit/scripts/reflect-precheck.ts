// reflect-precheck.ts — determines which reflect phases are due before invoking LLM.
// Usage: bun reflect-precheck.ts <hermit-state-dir> <plugin-root> [--quick [--force]]
// Output (stdout, one line): EMPTY  |  RUN|<phases-json>  |  RUN|<sha256-hash> (--quick)
//
// On EMPTY: this script owns the audit trail — it calls update-reflection-state.ts
// and appends the mandatory Progress Log line to SHELL.md before exiting.
//
// --quick gates the event-driven `reflect --quick` chain (reflect_after routines) against
// a content hash of SHELL.md's ## Findings + ## Blockers, isolated from the scheduled
// cadence state above (never touches last_run_at/counters). --force (only meaningful with
// --quick) skips the EMPTY decision entirely and always returns RUN|<hash> — used by manual
// `/reflect --quick` invocations, which need a deterministic hash to commit after processing,
// not a gating decision (the skill is already loaded by the time this runs).
//
// Exit 0 always, EXCEPT a foreign state-dir argv (see the pin below) — that is
// a mis-invocation, not a runtime condition, so it exits 1 on stderr instead.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentHHMM, todayYMD } from './lib/time';
import { observationLine } from './lib/observations';
import { readFrontmatter, isEmptyAutoArchive } from './lib/frontmatter';
import { findStorageDrift, findSchemaDrift } from './lib/drift';
import { sha256 } from './lib/hash';
import { appendToProgressLog } from './lib/progress-log';
import { extractSection, stripPlaceholders } from './lib/md-write';
import { pinStateDirOrExit, hermitDir as resolveHermitRoot } from './lib/cc-compat';
import { readSettledConfig } from './lib/config-read';
import { costIndexPath, readCostIndex } from './lib/cost-log';

type Json = any;

function emit(verdict: string): never {
  process.stdout.write(verdict + '\n');
  process.exit(0);
}

const stateDirArg = process.argv[2];
const pluginRoot = process.argv[3];
const flags = process.argv.slice(4);
const quickMode = flags.includes('--quick');
const forceMode = flags.includes('--force');

// Missing is fail-open (existing behaviour); foreign is not — see header.
if (!stateDirArg) emit('RUN|{}');

// The state dir is not caller-chosen. Reachable through a pre-approved
// `Bash(bun */scripts/reflect-precheck.ts*)` grant that covers every argument,
// and this script forwards it on to archive-shell.ts, archive-raw.ts and
// update-reflection-state.ts, so an unvalidated root would have reached all
// three. Deliberately a usage error (stderr, exit 1), not a stdout verdict —
// callers branch on the EMPTY|RUN|... grammar.
const stateDir = pinStateDirOrExit(stateDirArg, 'reflect-precheck.ts');

const readJSON = (p: string): Json => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
};

// A top-level ## Section of SHELL.md with placeholder comments and blank lines
// dropped, so a real finding appended under a retained `<!-- ... -->` placeholder
// still counts. Feeds the --quick content hash, so the normalization (trim each
// line, drop empties) must stay stable — it decides whether the chain re-fires.
function extractQuickSection(md: string, name: string): string {
  return stripPlaceholders(extractSection(md, name) ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n');
}

function logQuickEmpty(stateDir: string): void {
  const timezone = readSettledConfig(stateDir).timezone ?? 'UTC';
  const hhmm = currentHHMM(timezone);
  appendToProgressLog(
    path.join(stateDir, 'sessions', 'SHELL.md'),
    `- [${hhmm}] reflect (quick, post-routine) — no new candidates`,
  );
}

function runQuickPrecheck(stateDir: string, force: boolean): never {
  const shellPath = path.join(stateDir, 'sessions', 'SHELL.md');
  let shellContent = '';
  try { shellContent = fs.readFileSync(shellPath, 'utf-8'); } catch { /* missing SHELL.md → nothing to scan */ }

  const findings = extractQuickSection(shellContent, 'Findings');
  const blockers = extractQuickSection(shellContent, 'Blockers');
  const hash = sha256(`${findings}\n---\n${blockers}`);

  if (force) emit('RUN|' + hash);

  if (!findings && !blockers) {
    logQuickEmpty(stateDir);
    emit('EMPTY');
  }

  const reflectionState = readJSON(path.join(stateDir, 'state', 'reflection-state.json')) ?? {};
  const storedHash = reflectionState.last_quick_hash;

  // No prior cursor (storedHash undefined) never equals a hex hash, so first-run
  // correctly falls through to RUN below without a separate branch.
  if (storedHash === hash) {
    logQuickEmpty(stateDir);
    emit('EMPTY');
  }

  emit('RUN|' + hash);
}

if (quickMode) runQuickPrecheck(stateDir, forceMode);

function computePhase(since: string | null) {
  if (!since) return 'adult';
  const sinceDate = new Date(since);
  if (isNaN(sinceDate.getTime())) return 'adult';
  const ageDays = Math.floor((Date.now() - sinceDate.getTime()) / (1000 * 60 * 60 * 24));
  if (ageDays < 3) return 'newborn';
  if (ageDays < 14) return 'juvenile';
  return 'adult';
}

function daysSince(isoStr: string | null) {
  if (!isoStr) return Infinity;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

// Reads whole-day totals from state/cost-index.json (maintained by cost-tracker.ts's
// Stop hook and subagent-cost.ts's SubagentStop hook) instead of tailing the raw log —
// a busy install's day is hundreds of entries, so a fixed-line tail spans at most one
// or two dates and can never assemble a real baseline. The index already keeps today
// plus 7 complete prior days (BY_DATE_RETENTION_DAYS in lib/cost-log.ts), tz-bucketed
// the same way `today` is computed here, so the two keys can't disagree across an
// offset.
//
// Returns the two figures rather than a boolean so this script can record the
// observation itself. It previously computed them, discarded them, and set a phase
// flag that asked the skill to re-read the same log and redo the same arithmetic —
// a round trip through prose that, across the live fleet, never once produced a row.
function checkCostSpike(hermitRoot: string, timezone: string): { todayTotal: number; median: number; date: string } | null {
  try {
    const index = readCostIndex(costIndexPath(hermitRoot));
    if (!index) return null;

    const today = todayYMD(timezone);
    const todayTotal = index.by_date?.[today]?.cost ?? 0;

    const priorDays = Object.entries(index.by_date ?? {})
      .filter(([date]) => date !== today)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(-7)
      .map(([, bucket]) => (bucket as { cost: number }).cost);
    if (priorDays.length < 3) return null;

    const sorted = [...priorDays].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

    if (!(median > 0 && todayTotal > 0 && todayTotal > 2 * median)) return null;
    return { todayTotal, median, date: today };
  } catch {
    return null;
  }
}

function hasAcceptedProposals(stateDir: string) {
  try {
    const proposalsDir = path.join(stateDir, 'proposals');
    const files = fs.readdirSync(proposalsDir).filter(f => /^PROP-\d+(?:-.+)?\.md$/.test(f));
    return files.some(f => {
      try {
        const head = fs.readFileSync(path.join(proposalsDir, f), 'utf-8').slice(0, 1000);
        return /^\s*status:\s*accepted\s*$/mi.test(head);
      } catch { return false; }
    });
  } catch {
    return false;
  }
}

// Short-circuits cheaply: in_progress or missing lastRunAt require no I/O.
function hasComputeActivity(stateDir: string, lastRunAt: string | null, sessionState: string) {
  if (sessionState === 'in_progress') return true;
  if (!lastRunAt) return true;

  const lastRun = new Date(lastRunAt);
  if (isNaN(lastRun.getTime())) return true;

  try {
    const sessionsDir = path.join(stateDir, 'sessions');
    // Exclude empty auto-archives: their auto-close mtime bump would trigger compute
    // on a report with no operator content. Daily-lull closes carry operator_turns > 0
    // and DO trigger compute. See isEmptyAutoArchive in lib/frontmatter.ts.
    const reports = fs.readdirSync(sessionsDir)
      .filter(f => /^S-\d+-REPORT\.md$/.test(f))
      .filter(f => !isEmptyAutoArchive(readFrontmatter(path.join(sessionsDir, f))));
    return reports.some(f => {
      try { return fs.statSync(path.join(sessionsDir, f)).mtime > lastRun; }
      catch { return false; }
    });
  } catch {
    return false;
  }
}

// Returns true when SHELL.md is large enough AND ≥24h has elapsed since the
// last snapshot. Null last_shell_snapshot_at fires on size alone.
function isShellSnapshotDue(stateDir: string, runtime: Json) {
  const SHELL_LINE_THRESHOLD = 400;
  try {
    const shellPath = path.join(stateDir, 'sessions', 'SHELL.md');
    const content = fs.readFileSync(shellPath, 'utf-8');
    const lines = content.split('\n').length;
    if (lines < SHELL_LINE_THRESHOLD) return false;
    const last = runtime.last_shell_snapshot_at;
    if (!last) return true;
    return daysSince(last) >= 1;
  } catch {
    return false;
  }
}

const reflectionStatePath = path.join(stateDir, 'state', 'reflection-state.json');
const reflectionState = readJSON(reflectionStatePath) ?? {};
const counters = reflectionState.counters ?? {};
const lastRunAt = counters.last_run_at ?? null;
const since = counters.since ?? null;
const phase = computePhase(since);

const runtime = readJSON(path.join(stateDir, 'state', 'runtime.json')) ?? {};
const sessionState = runtime.session_state ?? 'idle';

const config = readSettledConfig(stateDir);
const timezone = config.timezone ?? 'UTC';

const phases: Record<string, boolean> = {};

// Cheaper checks first: compute (short-circuits on in_progress/null lastRunAt),
// then resolution_check (reads proposal files), then cost spike (reads cost log).
if (hasComputeActivity(stateDir, lastRunAt, sessionState)) phases.compute = true;

const lastResolutionCheck = reflectionState.last_resolution_check ?? null;
if (hasAcceptedProposals(stateDir) && daysSince(lastResolutionCheck) > 7) {
  phases.resolution_check = true;
}

// Anchor cost-index resolution: a relative stateDir (real invocation passes
// `.claude-code-hermit`) would otherwise resolve against a drifted cwd and
// silently suppress the cost-spike phase. Absolute (as tests pass) is verbatim.
const costHermitRoot = path.isAbsolute(stateDir) ? stateDir : resolveHermitRoot();
const costSpike = checkCostSpike(costHermitRoot, timezone);
// The phase still flags the spike for the skill's narrative step; the row itself is
// written below, from these figures, rather than re-derived from prose.
if (costSpike) phases.cost_spike = true;

// Behavioral-telemetry digest — weekly for every hermit (not age-gated like
// `digest` below): reflect's evidence step reads ground-truth transcript counters
// (defer-loop wakes, tool failures, denial spikes) it can't get from self-report.
if (daysSince(reflectionState.last_behavior_digest_at) > 7) {
  phases.behavior = true;
}

if (phase === 'juvenile' && daysSince(reflectionState.last_digest_at) > 7) {
  phases.digest = true;
}

if (phase === 'newborn') phases.newborn = true;

// Run archive synchronously so the LLM (when other phases fire) sees a
// bounded SHELL.md.
const archiveDue = isShellSnapshotDue(stateDir, runtime);
let archiveTaken = false;

if (archiveDue) {
  if (!pluginRoot) {
    console.error('[reflect-precheck] archive_due skipped: pluginRoot missing');
  } else {
    try {
      const stdout = execFileSync(process.execPath, [
        path.join(pluginRoot, 'scripts', 'archive-shell.ts'),
        '--source=routine',
        `--state-dir=${stateDir}`,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        const result = JSON.parse(stdout.toString().trim());
        archiveTaken = result && result.archived === true;
      } catch { /* malformed output → treat as not-archived */ }
    } catch { /* fail-open */ }
  }
}

// Gate on archiveTaken: a failed subprocess shouldn't cost LLM tokens
// reasoning about a snapshot that never landed.
const onlyArchive = archiveDue && Object.keys(phases).length === 0;
if (archiveTaken && !onlyArchive) phases.archive_due = true;

// Run archive-raw.ts on a 7-day debounce so raw/.archive/ is bounded on every hermit
// regardless of whether weekly-review is configured.
if (pluginRoot && daysSince(runtime.last_raw_archive_at) >= 7) {
  try {
    execFileSync(process.execPath, [
      path.join(pluginRoot, 'scripts', 'archive-raw.ts'),
      stateDir,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Re-read before writing — archive-shell may have updated runtime.json concurrently.
    const runtimePath = path.join(stateDir, 'state', 'runtime.json');
    const freshRuntime = readJSON(runtimePath) ?? runtime;
    freshRuntime.last_raw_archive_at = new Date().toISOString();
    try {
      fs.writeFileSync(
        runtimePath,
        JSON.stringify(freshRuntime, null, 2) + '\n',
        'utf-8',
      );
    } catch { /* fail-open */ }
  } catch { /* fail-open */ }
}

const ledgerPath = path.join(stateDir, 'state', 'observations.jsonl');

// --- Drift capture: write storage/schema drift rows to observations ledger ---
// Drift is structural (a dir/type is present or absent), not a recurring behavior, so
// dedup by pattern alone: a standing unresolved drift writes exactly one row and then
// stays silent, instead of writing a fresh row every session (which would flip the
// freshness gate to RUN on every session forever). The row ages out of the ledger after
// prune-observations' 30-day window, so persistent drift re-surfaces ~monthly on the next
// reflect run rather than never. Mechanical drift is always own-work; writing happens
// before the freshness gate so a first-sighting row triggers RUN on the same invocation.
let wroteNewRows = false;
try {
  // runtime.session_id is commonly null (written at startup, cleared on shutdown) — treat null as 'unknown'
  const sessionId = (runtime.session_id ?? 'unknown') as string;

  // Load existing pattern labels to dedup-on-write. Drift slugs are namespaced
  // (storage-drift:/schema-drift:), so scanning all patterns can't collide with
  // reflect-noticed/cost-spike rows.
  const existingPatterns = new Set<string>();
  try {
    for (const line of fs.readFileSync(ledgerPath, 'utf-8').trim().split('\n').filter(Boolean)) {
      try {
        const row = JSON.parse(line);
        if (row.pattern) existingPatterns.add(row.pattern);
      } catch {}
    }
  } catch {}

  const newRows: string[] = [];
  // Rows go through the shared constructor so this writer and observations.ts
  // cannot drift apart on field order, timestamp format, or origin rules.
  // `origin` belongs only to startup-drift here — cost-spike is a measurement, not
  // something with a provenance, and the constructor rejects the key on sources that
  // never carried it.
  const capture = (slug: string, source: 'startup-drift' | 'cost-spike' = 'startup-drift', extra?: Record<string, unknown>) => {
    if (existingPatterns.has(slug)) return;
    existingPatterns.add(slug);
    const built = observationLine(
      source === 'startup-drift'
        ? { source, pattern: slug, sessionId, origin: 'own-work' }
        : { source, pattern: slug, sessionId, extra },
    );
    if ('line' in built) newRows.push(built.line);
  };

  // Storage drift — capture the full subpath so raw/foo and raw/bar get distinct slugs
  for (const hit of findStorageDrift(stateDir)) {
    const m = hit.match(/\.claude-code-hermit\/(.+)\/ \(/);
    if (m) capture(`storage-drift:${m[1]}`);
  }

  // Schema drift
  for (const { type } of findSchemaDrift(stateDir)) {
    capture(`schema-drift:${type}`);
  }

  // Cost spike — the label is date-scoped, never value-bearing. `todayTotal` climbs
  // through the day, so embedding it (as the prose row used to) would defeat the
  // dedup above and write a fresh row on every precheck run of a spike day. The
  // figures ride as fields instead, where a reader can still get at them.
  if (costSpike) {
    capture(`cost-spike:${costSpike.date}`, 'cost-spike', {
      today_total: Number(costSpike.todayTotal.toFixed(4)),
      median_7d: Number(costSpike.median.toFixed(4)),
    });
  }

  if (newRows.length > 0) {
    fs.appendFileSync(ledgerPath, newRows.join('\n') + '\n', 'utf-8');
    wroteNewRows = true;
  }
} catch { /* fail-open */ }

// --- Freshness gate: flip EMPTY→RUN when ledger has rows newer than last_run_at ---
// Only precheck-written rows (startup-drift, cost-spike) self-trigger, because they are
// written above, before this gate runs — each at most once per pattern, so a standing
// drift or a spike day forces exactly one RUN, not one per tick. Rows written *during* a
// run (reflect-noticed, quick-deferral, skill-correction, behavior-digest) have
// ts ≤ last_run_at on the next tick and do NOT self-trigger — they surface opportunistically.
// skill-preference-applied rows are written mid-conversation (settlement telemetry, never a
// candidate), so they're excluded explicitly — a run they trigger would have nothing to do.
// Pending skill-preference rows are NOT excluded: they graduate, so their run is productive.
if (wroteNewRows) {
  // Rows just appended carry ts = now > last_run_at by construction — skip the re-read.
  phases.observations_fresh = true;
} else try {
  const content = fs.readFileSync(ledgerPath, 'utf-8').trim();
  if (content) {
    // null last_run_at (fresh hermit) → cutoff = 0 → any valid ts triggers
    const cutoff = lastRunAt ? new Date(lastRunAt).getTime() : 0;
    const hasFresh = content.split('\n').filter(Boolean).some(line => {
      try {
        const row = JSON.parse(line);
        const rowTime = new Date(row.ts).getTime();
        return !isNaN(rowTime) && rowTime > cutoff && row.source !== 'skill-preference-applied';
      } catch { return false; }
    });
    if (hasFresh) phases.observations_fresh = true;
  }
} catch { /* fail-open: scan error → skip trigger, don't force RUN */ }

if (Object.keys(phases).length > 0) emit('RUN|' + JSON.stringify(phases));

// EMPTY path: update reflection-state.json and append Progress Log line.
if (pluginRoot) {
  const updateScript = path.join(pluginRoot, 'scripts', 'update-reflection-state.ts');
  try {
    execFileSync(process.execPath, [
      updateScript,
      reflectionStatePath,
      JSON.stringify({ ran_with_candidates: false }),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch { /* fail-open */ }
}

const hhmm = currentHHMM(timezone);
const snapshotSuffix = archiveTaken ? ' (snapshot taken)' : '';
const logLine = `- [${hhmm}] reflect (${phase}) — 0 candidates; verdicts: accept=0 downgrade=0 suppress=0; outcomes: none${snapshotSuffix}`;
appendToProgressLog(path.join(stateDir, 'sessions', 'SHELL.md'), logLine);

emit('EMPTY');
