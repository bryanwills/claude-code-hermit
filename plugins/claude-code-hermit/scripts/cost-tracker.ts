// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code)
// Original: scripts/hooks/cost-tracker.js — MIT License
// Changes: Added SHELL.md cost injection for session tracking,
//          simplified pricing model, removed ECC-specific metric paths,
//          added cumulative cost tracking.

import fs from 'node:fs';
import path from 'node:path';

import { calculateCost, PRICING } from './lib/pricing';
import { kStr, formatTokens } from './lib/format';
import { sessionId as ccSessionId, transcriptPath as ccTranscriptPath, readTailLines, entryText, isToolResult, extractUsage, isCompactBoundary, turnPromptText, toolUseNames, costLogPath, hermitDir } from './lib/cc-compat';
import { costIndexPath, updateCostIndex, readCostIndex, scanCostLogWarnings, buildMainCostRow, buildSubagentCostRow, appendCostRows } from './lib/cost-log';
import { todayYMD, thisWeekKey, thisMonthYYYYMM, friendlyBoundary } from './lib/time';
import { extractSection, isResolvedBlockerLine, stripPlaceholders } from './lib/md-write';
import { mutateOwnedAlerts, budgetAlertsPath } from './lib/alert-state';
import { readSettledConfig } from './lib/config-read';
import { setPause, isPaused } from './lib/pause';
import { evaluateBudget, pauseBoundary } from './lib/budget';
import { sendOperatorNotice } from './lib/channel-send';
import { BUDGET, resolveLocale, type Locale } from './lib/messages';
import { classifySource } from './lib/trigger-source';
import { runtimeTmpPath } from './lib/runtime';
import { readContextSurface, writeContextSurface } from './lib/context-surface';
import { MAX_PLAUSIBLE_PROMPT_TOKENS } from './lib/context-signal';

type Json = any;

const MAX_STDIN = 1024 * 1024; // 1MB safety limit
const HERMIT_DIR = hermitDir();
const COST_LOG = costLogPath(HERMIT_DIR);
const COST_INDEX = costIndexPath(HERMIT_DIR);
const SHELL_SESSION = path.join(HERMIT_DIR, 'sessions', 'SHELL.md');
const STATUS_JSON = path.join(HERMIT_DIR, 'sessions', '.status.json');
const STATUS_JSON_TMP = path.join(HERMIT_DIR, 'sessions', '.status.json.tmp');
const RUNTIME_JSON = path.join(HERMIT_DIR, 'state', 'runtime.json');
const RUNTIME_JSON_TMP = runtimeTmpPath(path.join(HERMIT_DIR, 'state'));
const HEARTBEAT_FILE = path.join(HERMIT_DIR, 'state', '.heartbeat');
const COST_SUMMARY = path.join(HERMIT_DIR, 'cost-summary.md');
const BUDGET_ALERTS = budgetAlertsPath(HERMIT_DIR);

let _runtimeCache: Json;
function readRuntimeJsonCached(): Json {
  if (_runtimeCache !== undefined) return _runtimeCache;
  try {
    _runtimeCache = JSON.parse(fs.readFileSync(RUNTIME_JSON, 'utf-8'));
  } catch {
    _runtimeCache = {};
  }
  return _runtimeCache;
}

function readRuntimeSessionId(): string {
  return readRuntimeJsonCached().session_id || '';
}

function touchHeartbeat(): void {
  try {
    const now = new Date();
    fs.utimesSync(HEARTBEAT_FILE, now, now);
  } catch {
    try { fs.writeFileSync(HEARTBEAT_FILE, '', 'utf-8'); } catch {}
  }
}

function detectModel(modelStr: string | undefined): string {
  if (!modelStr) return 'sonnet';
  const lower = modelStr.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  return 'sonnet';
}

// A subagent-completion notification: CC opens a turn with this when a dispatched
// agent comes to rest, and that ingestion turn is real cost caused by whatever
// dispatched the agent. The prompt itself carries no routine/heartbeat marker, so
// prompt-only classification would bucket it as 'other' — resolveTurnSource hops
// from these ids back to the dispatching turn instead. Measured on live hermit
// transcripts: every such notification carried a <task-id>, and the dispatch was
// locatable in-transcript for 264 of 265 of them.
const RE_TASK_ID = /<task-id>([A-Za-z0-9_-]+)<\/task-id>/;
const RE_TOOL_USE_ID = /<tool-use-id>([A-Za-z0-9_-]+)<\/tool-use-id>/;

// Classify a turn by its delivered prompt, hopping once through a subagent-completion
// notification to the turn that dispatched it.
//
// The prompt-only rule (turnPromptText) is what stops a turn's own tool output from
// capturing it: classifySource matches `[hermit-routine:<id>]` anywhere in the text it
// is handed, so scanning the whole turn billed any turn whose tool output merely named
// a routine — e.g. heartbeat-restart's re-arm, whose CronDelete/CronList output lists
// concrete routine ids, was billed to whichever routine it happened to print first.
//
// `boundaryFound` is false when the walk ran off the start of a truncated tail window;
// the caller downgrades to 'other' rather than trust a prompt that may belong to an
// earlier turn.
//
// `inherited` is true only when the source came from the dispatch hop rather than this
// turn's own prompt. Such a turn is real cost of the dispatching source but it is NOT an
// independent invocation of it — a routine that dispatches an async agent produces two
// billed main turns (the wake and the completion ingestion) for one fire. Consumers that
// divide cost by invocations (doctor's routine-cost $/run) must not count the second, so
// the flag is persisted on the cost row; see lib/cost-log.ts scanRoutineLedger.
function resolveTurnSource(lines: string[], billedIndex: number): { source: string; boundaryFound: boolean; inherited: boolean } {
  const prompt = turnPromptText(lines, billedIndex);
  const direct = classifySource(prompt.text);
  if (direct !== 'other' || !prompt.boundaryFound) {
    return { source: direct, boundaryFound: prompt.boundaryFound, inherited: false };
  }
  // Unclassified: if this turn opened on a subagent-completion notification, attribute it
  // to the dispatching turn. Prefer the tool-use id (present on tool-dispatched agents),
  // falling back to the task id. One hop only — a dispatch turn is itself a real prompt.
  const ids = [RE_TOOL_USE_ID.exec(prompt.text)?.[1], RE_TASK_ID.exec(prompt.text)?.[1]].filter(Boolean) as string[];
  for (const id of ids) {
    for (let j = prompt.index - 1; j >= 0; j--) {
      if (!lines[j].includes(id)) continue;
      let e: Json;
      try { e = JSON.parse(lines[j]); } catch { continue; }
      // Match the dispatch STRUCTURALLY, not on "this line contains the id". An agent's id
      // appears on several earlier lines — CC can notify more than once for one task — and a
      // first-substring-match returns the nearest of those, which is a real user entry, so
      // turnPromptText stops on the notification itself and classifies 'other'.
      if (e.type === 'assistant') {
        // The dispatch site: the entry that emitted the tool_use block carrying this id.
        // Walks from j exclusive; the fallback below passes j+1 because ITS j is a user entry
        // that may itself be the dispatching turn's prompt (the Agent tool_result case).
        if (!toolUseNames(e).some(t => t.id === id)) continue;
        return { source: classifySource(turnPromptText(lines, j).text), boundaryFound: true, inherited: true };
      }
      // A sibling completion notification for the same agent is never the dispatch — keep
      // walking. Narrow on purpose: every other non-classifying match still stops the scan.
      if (RE_TASK_ID.test(entryText(e))) continue;
      return { source: classifySource(turnPromptText(lines, j + 1).text), boundaryFound: true, inherited: true };
    }
  }
  return { source: 'other', boundaryFound: true, inherited: false };
}

// classifySource moved to lib/trigger-source.ts (imported above, re-exported below)
// so transcript-digest.ts can classify wake sources without importing this module
// (whose load-time HERMIT_DIR init would pollute in-process test cwd resolution).

// Collect Agent tool_results from the current turn window.
// Subagent assistant entries live in separate transcript files and never appear here;
// only the Agent tool_result (type:'user' with toolUseResult.usage) does. extractUsage
// skips these because they aren't type:'assistant', so collect them explicitly or their
// tokens vanish from the ledger.
// Limitation: shares sumTurnUsage's TAIL_BYTES window — a turn larger than the 512KB tail
// is scanned from buffer start, so a prior turn's dispatch can bleed in. Same rare
// over-count as the main-turn sum, accepted for the same reason.
function collectSubagentUsage(lines: string[], billedIndex: number): Array<{
  model: string; inputTokens: number; cacheWriteTokens: number;
  cacheReadTokens: number; outputTokens: number; agentType: string;
}> {
  const out: Array<{
    model: string; inputTokens: number; cacheWriteTokens: number;
    cacheReadTokens: number; outputTokens: number; agentType: string;
  }> = [];
  for (let j = billedIndex; j >= 0; j--) {
    try {
      const e = JSON.parse(lines[j]);
      const r = e.toolUseResult;
      if (e.type === 'user' && r && r.agentType && r.usage) {
        const u = r.usage;
        out.push({
          model: r.resolvedModel || '',
          inputTokens: u.input_tokens || 0,
          cacheWriteTokens: u.cache_creation_input_tokens || 0,
          cacheReadTokens: u.cache_read_input_tokens || 0,
          outputTokens: u.output_tokens || 0,
          agentType: r.agentType,
        });
      }
      // Same turn boundary as sumTurnUsage: the first non-tool_result user entry.
      // Deliberately looser than resolveTurnSource's boundary, which additionally skips
      // structured injections (isSkillInjection). This one decides which tokens are
      // summed, so tightening it would move billed amounts, not just labels — don't
      // "align" the two without re-measuring cost totals.
      if (e.type === 'user' && !isToolResult(e)) break;
    } catch {}
  }
  return out;
}

// Limitation: a turn spanning more than TAIL_BYTES is summed from buffer start, not the real
// boundary — token counts still over-count in this case (deliberately: discarding real token
// data would be worse than a bounded over-count). Source attribution no longer shares this
// bleed — see the boundaryFound guard in readLastTurnUsage().
function sumTurnUsage(lines: string[], billedIndex: number): {
  inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number;
  outputTokens: number; model: string; apiCalls: number; maxPromptTokens: number;
} {
  let inputTokens = 0, cacheWriteTokens = 0, cacheReadTokens = 0, outputTokens = 0;
  let model = 'sonnet';
  let apiCalls = 0;
  // The per-turn sum below bills every API call the turn made, so a multi-tool-call
  // turn logs a multiple of its actual context size. Consumers that care about context
  // size (watchdog's context-hygiene thresholds) need the single largest call instead —
  // that's the real prompt the model was holding at its fullest point in the turn.
  let maxPromptTokens = 0;

  for (let j = billedIndex; j >= 0; j--) {
    try {
      const entry = JSON.parse(lines[j]);
      const usage = extractUsage(entry);
      if (usage) {
        inputTokens += usage.inputTokens;
        cacheWriteTokens += usage.cacheWriteTokens;
        cacheReadTokens += usage.cacheReadTokens;
        outputTokens += usage.outputTokens;
        apiCalls++;
        // Model is constant within a turn; capture it once from the outermost call.
        if (apiCalls === 1) model = usage.model;
        const callPrompt = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
        if (callPrompt > maxPromptTokens) maxPromptTokens = callPrompt;
      }
      // Turn boundary: the first non-tool_result user entry. Intentionally looser than
      // resolveTurnSource's — see the note in collectSubagentUsage above.
      if (entry.type === 'user' && !isToolResult(entry)) break;
    } catch {}
  }

  return { inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens, model, apiCalls, maxPromptTokens };
}

// Peak prompt size (input + cache) over the calls made since the turn's last compaction,
// seeded with the last billed call. The max rather than the newest entry alone, because a
// trailing entry with a degenerate/partial `usage` (cache fields absent → extractUsage
// zeroes them) would otherwise report a near-empty context and blind both hygiene tiers.
// Prompts grow monotonically within a segment, so this equals the newest call in the
// normal case. Boundary checks mirror sumTurnUsage's, for a different purpose: context
// size at a point in time, not the turn's total bill.
function peakPromptTokensSinceCompaction(lines: string[], billedIndex: number, seed: number): number {
  let peak = seed;
  for (let j = billedIndex - 1; j >= 0; j--) {
    let prev: Json;
    try { prev = JSON.parse(lines[j]); } catch { continue; }
    if (isCompactBoundary(prev)) break;                      // older calls describe a dead context
    if (prev.type === 'user' && !isToolResult(prev)) break;  // turn boundary (same as sumTurnUsage)
    const usage = extractUsage(prev);
    if (!usage) continue;
    const prompt = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
    if (prompt > peak) peak = prompt;
  }
  return peak;
}

function readLastTurnUsage(transcriptPath: string): Json {
  const TAIL_BYTES = 524288; // 512KB — covers most multi-step agentic turns
  try {
    const { lines, readFrom } = readTailLines(transcriptPath, TAIL_BYTES);

    // A half-written trailing record means CC is still flushing this turn. Scanning past
    // it finds an OLDER turn's usage and bills it again under a fresh timestamp — measured
    // live on a production hermit, where a pre-compaction turn was re-billed hours later
    // and its dead 173k context then drove a needless watchdog compaction. Bill nothing;
    // the next Stop sees a complete tail. Unbilled beats double-billed.
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try { JSON.parse(lines[i]); } catch { return null; }
      break;
    }

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        // Reaching a compaction boundary before any usage means every remaining entry
        // describes a context CC already destroyed — never bill or measure it.
        if (isCompactBoundary(entry)) return null;
        const usage = extractUsage(entry);
        if (!usage) continue;

        // Found the last billed entry — sum the whole turn.
        const summed = sumTurnUsage(lines, i);
        // Context size at the END of the turn, for the hygiene thresholds — not the
        // turn-wide max, which would still report the pre-compaction peak for a turn that
        // compacted mid-flight. Paired with the source-side timestamp so consumers can
        // tell when the context was observed, not when the row was written.
        const lastCallPromptTokens = peakPromptTokensSinceCompaction(
          lines, i, usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens,
        );
        const observedAt = typeof entry.timestamp === 'string' ? entry.timestamp : '';

        // Detect operator interaction for operator_turns tracking.
        // Note: real transcripts use type:'user', not type:'human', so this is
        // effectively always false in production — left intact for future correctness.
        let hadHumanTurn = false;
        for (let j = i - 1; j >= 0; j--) {
          try {
            const prev = JSON.parse(lines[j]);
            hadHumanTurn = prev.type === 'human';
            break;
          } catch {}
        }

        const resolved = resolveTurnSource(lines, i);
        // A truncated tail (readFrom > 0) whose turn boundary fell outside the window
        // can't be trusted — the prompt found may belong to an earlier, unrelated turn
        // still in the window. Attribute to 'other' rather than risk misattributing a
        // large turn (e.g. a plugin upgrade run) to an unrelated source.
        const trusted = resolved.boundaryFound || readFrom <= 0;
        const source = trusted ? resolved.source : 'other';
        const sourceInherited = trusted && resolved.inherited;
        const subagents = collectSubagentUsage(lines, i);
        return { ...summed, hadHumanTurn, source, sourceInherited, subagents, observedAt, lastCallPromptTokens, tailLines: lines };
      } catch {}
    }
  } catch {}
  return null;
}

// Fixed-surface derivation (state/context-surface.json): when the tail contains a
// compact_boundary not yet recorded, the earliest assistant call after it minus the
// boundary's compactMetadata.postTokens (the summarized conversation alone) is an
// upper bound on this hermit's fixed surface — the input the watchdog's compact
// gate subtracts. Runs on the tail readLastTurnUsage already read; a boundary
// outside that window was recorded on an earlier Stop. peakPromptTokensSinceCompaction
// cannot be reused here: it breaks at the turn's user-entry boundary before ever
// reaching the compact_boundary record. postTokens is an uncontracted harness field
// (probe-verified, not documented), so every branch validates and skips rather than
// guesses — a failed derivation keeps the previous record.
function maybeDeriveSurface(lines: string[]): void {
  try {
    // Cheap prefilter: boundaries are rare (one per compaction) but this runs on
    // every Stop, and the backward scan below JSON.parses the whole tail when no
    // boundary exists — the common case. A substring miss is an exact negative
    // (isCompactBoundary can't match without the literal appearing); a false
    // positive just falls through to the precise parse loop.
    if (!lines.some(l => l.includes('compact_boundary'))) return;

    let boundaryIdx = -1;
    let boundary: Json = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      let e: Json;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (isCompactBoundary(e)) { boundaryIdx = i; boundary = e; break; }
    }
    if (boundaryIdx < 0) return;
    const boundaryAt: string = typeof boundary.timestamp === 'string' ? boundary.timestamp : '';
    if (!boundaryAt) return;
    const existing = readContextSurface(HERMIT_DIR);
    if (existing && existing.boundary_at === boundaryAt) return; // already recorded
    const postTokens = boundary.compactMetadata?.postTokens;
    if (typeof postTokens !== 'number' || !Number.isFinite(postTokens) || postTokens <= 0) return;
    // Earliest assistant call after the boundary — extractUsage is assistant-only,
    // so subagent tool_result usage can never be picked up here.
    for (let j = boundaryIdx + 1; j < lines.length; j++) {
      let e: Json;
      try { e = JSON.parse(lines[j]); } catch { continue; }
      const usage = extractUsage(e);
      if (!usage) continue;
      const surface = (usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens) - postTokens;
      // Implausible — never guess from this call, but keep scanning rather than
      // abandoning the boundary. A degenerate/partial `usage` (the shape
      // peakPromptTokensSinceCompaction defends against) on the earliest post-boundary
      // call would otherwise fail this boundary for good: nothing is written, so every
      // later Stop re-selects the same call until the boundary leaves the tail window.
      // A later call only inflates the result, and the record is an upper bound — the
      // compact gate still errs toward firing later, never earlier.
      if (surface <= 0 || surface > MAX_PLAUSIBLE_PROMPT_TOKENS) continue;
      writeContextSurface(HERMIT_DIR, {
        surface_upper_bound_tokens: surface,
        post_tokens: postTokens,
        boundary_at: boundaryAt,
        observed_at: typeof e.timestamp === 'string' ? e.timestamp : '',
        prev: existing
          ? { surface_upper_bound_tokens: existing.surface_upper_bound_tokens, boundary_at: existing.boundary_at }
          : null,
      });
      return;
    }
  } catch {}
}

// Newest main (non-subagent) row already in the cost log — the duplicate check in run()
// compares against it. Tail-read: the log is append-only and unbounded, so a full parse
// on every turn is exactly the cost this codebase avoids elsewhere (see updateCostIndex).
function lastLoggedMainRow(): Json {
  // Wide enough that the subagent rows a fan-out turn appends AFTER its main row can't
  // push that main row out of the window — a turn dispatching ~25 agents writes ~15KB of
  // them, which would silently disable the guard on exactly the heaviest turns.
  const TAIL_BYTES = 131072;
  try {
    const { lines } = readTailLines(COST_LOG, TAIL_BYTES);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const row = JSON.parse(lines[i]);
        if (row && row.subagent !== true) return row;
      } catch {}
    }
  } catch {}
  return null;
}

function parseLogEntries(): Json[] {
  try {
    const content = fs.readFileSync(COST_LOG, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').reduce((acc: Json[], line) => {
      try { acc.push(JSON.parse(line)); } catch {}
      return acc;
    }, []);
  } catch {
    return [];
  }
}

function getCumulativeCost(newCost: number, newTokens: number, hadHumanTurn: boolean, currentSessionId: string, index: Json): { cost: number; tokens: number; operatorTurns: number } {
  // O(1) path: read running totals from .status.json
  try {
    const status = JSON.parse(fs.readFileSync(STATUS_JSON, 'utf-8'));
    // Reset when the hermit session changes — prevents cumulative carryover across sessions.
    if (currentSessionId && status.session_id && status.session_id !== currentSessionId) {
      return { cost: newCost, tokens: newTokens, operatorTurns: hadHumanTurn ? 1 : 0 };
    }
    return {
      cost: (status.cost_usd || 0) + newCost,
      tokens: (status.tokens || 0) + newTokens,
      operatorTurns: (status.operator_turns || 0) + (hadHumanTurn ? 1 : 0),
    };
  } catch {
    // First run or missing .status.json — fall back to index (O(1); index already updated)
  }

  if (index) {
    return {
      cost: index.total_cost_usd,
      tokens: index.total_tokens,
      operatorTurns: hadHumanTurn ? 1 : 0,
    };
  }

  const idx = readCostIndex(COST_INDEX);
  if (idx) {
    return { cost: idx.total_cost_usd, tokens: idx.total_tokens, operatorTurns: hadHumanTurn ? 1 : 0 };
  }
  return { cost: newCost, tokens: newTokens, operatorTurns: hadHumanTurn ? 1 : 0 };
}

const MAX_SUMMARY_LEN = 120;

function readRuntimeSessionState(): string {
  return readRuntimeJsonCached().session_state || 'unknown';
}

// Fresh-reads runtime.json (bypassing the per-run cache, to avoid clobbering a
// field written by another process since the cache was populated), applies a set
// of field updates, and writes back atomically. Skips silently if runtime.json
// can't be read — never fabricates a partial file missing session_state/session_id.
function writeRuntimeFields(fields: Record<string, Json>): void {
  let runtime: Json;
  try {
    runtime = JSON.parse(fs.readFileSync(RUNTIME_JSON, 'utf-8'));
  } catch {
    return;
  }
  Object.assign(runtime, fields);
  fs.writeFileSync(RUNTIME_JSON_TMP, JSON.stringify(runtime, null, 2) + '\n', 'utf-8');
  fs.renameSync(RUNTIME_JSON_TMP, RUNTIME_JSON);
}

// Maintains the [opened_at, closed_at] window that lib/cost-report/session.ts sums cost-log
// rows over — the logical-session boundary, since cost-log rows carry the shared
// transcript UUID (never the logical S-NNN) and one transcript holds many logical
// sessions (see lib/cost-report/session.ts). Three runtime.json fields define an arc:
//   opened_at        — arc start (first in_progress turn)
//   closed_at        — arc end, stamped on the idle transition; null while live
//   opened_transcript— the CC transcript/process id that owns the current arc
// A new arc is started (opened_at re-stamped, closed_at cleared) when there is no
// live arc, the previous one has already closed, OR the transcript changed — the
// last case resets a *stale* opened_at left by a process that died before its idle
// clear (a crash/restart mints a new transcript id), so the next session's window
// never bleeds in the dead arc's rows. `closed_at` is stamped rather than nulling
// `opened_at` so a close that runs after the idle transition can still recover the
// window instead of falling back to the always-zero exact-id match. 'waiting' is
// left untouched so a waiting<->in_progress bounce stays one arc. Best-effort —
// a lost write under concurrent access just re-applies next turn.
function maintainOpenedAt(nowIso: string, transcriptId: string): void {
  try {
    const cached = readRuntimeJsonCached();
    const state = cached.session_state || 'unknown';
    if (state === 'in_progress') {
      const newArc = !cached.opened_at || cached.closed_at != null || cached.opened_transcript !== transcriptId;
      if (newArc) {
        writeRuntimeFields({ opened_at: nowIso, closed_at: null, opened_transcript: transcriptId });
      }
    } else if (state === 'idle' && cached.opened_at && cached.closed_at == null) {
      writeRuntimeFields({ closed_at: nowIso });
    }
  } catch {
    // Non-fatal — never block cost tracking on runtime.json write failure.
  }
}

function writeStatusJson(shellContent: string, cumulative: { cost: number; tokens: number; operatorTurns: number }, sessionId: string): void {
  const { cost: cumulativeCost, tokens: cumulativeTokens, operatorTurns: cumulativeOperatorTurns } = cumulative;
  const taskSection = extractSection(shellContent, 'Task');
  const blockersSection = extractSection(shellContent, 'Blockers');
  const tasksMatch = shellContent.match(/\*\*Tasks Completed:\*\*\s*(\d+)/);

  const task = stripPlaceholders(taskSection ?? '');

  // Resolved (`~` / `[resolved]`) entries are dropped, matching the other blocker
  // surfaces: bin/hermit-status prints this field verbatim as "BLOCKED: …".
  // The dash filter drops the bare "-" a comment-only bullet leaves behind once
  // stripPlaceholders runs (startup-context's dropBulletResidue, same shape).
  const blockersText = stripPlaceholders(blockersSection ?? '')
    .split('\n')
    .filter(l => !isResolvedBlockerLine(l) && !/^\s*-+\s*$/.test(l))
    .join('\n')
    .trim();
  const hasBlockers = blockersText.length > 0 && !/^none$/i.test(blockersText);

  const statusData = {
    updated: new Date().toISOString(),
    session_id: sessionId,
    status: readRuntimeSessionState(),
    task: task.split('\n')[0].substring(0, MAX_SUMMARY_LEN),
    tasks_completed: tasksMatch ? parseInt(tasksMatch[1], 10) : 0,
    cost_usd: Math.round(cumulativeCost * 10000) / 10000,
    tokens: cumulativeTokens,
    operator_turns: cumulativeOperatorTurns,
    blockers: hasBlockers ? blockersText.split('\n')[0].substring(0, MAX_SUMMARY_LEN) : null,
  };

  // Atomic write: write to tmp, then rename
  fs.writeFileSync(STATUS_JSON_TMP, JSON.stringify(statusData, null, 2) + '\n', 'utf-8');
  fs.renameSync(STATUS_JSON_TMP, STATUS_JSON);
}

function writeCostSummary(index: Json, timezone: string = 'UTC'): void {
  if (!index) return;

  const today = todayYMD(timezone);
  try {
    const stat = fs.statSync(COST_SUMMARY);
    if (todayYMD(timezone, stat.mtime) === today) {
      const existing = fs.readFileSync(COST_SUMMARY, 'utf-8');
      if (/^total_tokens:/m.test(existing)) return;
    }
  } catch {
    // File missing — regenerate
  }

  if (index.total_tokens === 0 && index.total_cost_usd === 0) return;

  const weekAgo = todayYMD(timezone, new Date(Date.now() - 7 * 86400000));
  const byDate: Record<string, Json> = index.by_date || {};

  const totalCost = index.total_cost_usd || 0;
  const totalTokens = index.total_tokens || 0;
  const totalSessions = index.total_sessions || 0;
  const avgCost = totalSessions > 0 ? totalCost / totalSessions : 0;
  const avgSessionTokens = totalSessions > 0 ? totalTokens / totalSessions : 0;

  const todayEntry = byDate[today] || { cost: 0, tokens: 0, session_ids: [] };
  const todayCost = todayEntry.cost;
  const todayTokens = todayEntry.tokens;
  const todaySessions = (todayEntry.session_ids || []).length;

  let weekCost = 0;
  let weekTokens = 0;
  const weekSessionIds = new Set();
  for (const [date, entry] of Object.entries(byDate)) {
    if (date >= weekAgo) {
      weekCost += entry.cost || 0;
      weekTokens += entry.tokens || 0;
      for (const s of (entry.session_ids || [])) weekSessionIds.add(s);
    }
  }
  const weekSessionCount = weekSessionIds.size;
  const weekAvg = weekSessionCount > 0 ? weekCost / weekSessionCount : 0;

  const { opusWake, unpriced } = scanCostLogWarnings(COST_LOG, weekAgo, timezone);
  const opusWakeLine = opusWake.count > 0
    ? `\n- ⚠ ${opusWake.count} automated wake(s) on Opus this week ($${opusWake.cost.toFixed(2)}) — consider a lower session model`
    : '';

  const unpricedLine = unpriced.count > 0
    ? `\n- ⚠ ${unpriced.count} turn(s) this week priced at the sonnet fallback for an unrecognized model string ($${unpriced.cost.toFixed(2)}) — pricing.ts may need a new model entry`
    : '';

  let trendTable = '| Date | Sessions | Cost | Tokens |\n|------|----------|------|--------|\n';
  for (let i = 0; i < 7; i++) {
    const d = todayYMD(timezone, new Date(Date.now() - i * 86400000));
    const entry = byDate[d] || { cost: 0, tokens: 0, session_ids: [] };
    const dCost = entry.cost || 0;
    const dTok = entry.tokens || 0;
    const dSessions = (entry.session_ids || []).length;
    if (dCost > 0 || dSessions > 0) {
      trendTable += `| ${d} | ${dSessions} | $${dCost.toFixed(2)} | ${formatTokens(dTok)} |\n`;
    }
  }

  const content = `---
updated: ${new Date().toISOString()}
total_cost_usd: ${Math.round(totalCost * 10000) / 10000}
total_tokens: ${totalTokens}
total_sessions: ${totalSessions}
avg_session_cost_usd: ${Math.round(avgCost * 10000) / 10000}
avg_session_tokens: ${Math.round(avgSessionTokens)}
---
# Cost Summary

## Today
- Sessions: ${todaySessions}
- Cost: $${todayCost.toFixed(2)}
- Tokens: ${kStr(todayTokens)}

## This Week
- Sessions: ${weekSessionCount}
- Cost: $${weekCost.toFixed(2)}
- Tokens: ${kStr(weekTokens)}
- Avg per session: $${weekAvg.toFixed(2)}${opusWakeLine}${unpricedLine}

## All Time
- Sessions: ${totalSessions}
- Cost: $${totalCost.toFixed(2)}
- Tokens: ${kStr(totalTokens)}
- Avg per session: $${avgCost.toFixed(2)}

## Cost Trend (Last 7 Days)
${trendTable}`;

  try {
    fs.writeFileSync(COST_SUMMARY, content, 'utf-8');
  } catch {
    // Non-fatal
  }
}

function updateShellSession(content: string, costStr: string, tokenStr: string): string {
  const costSection = `## Cost\n${costStr} (${tokenStr})`;

  if (content.includes('## Cost')) {
    content = content.replace(
      /## Cost[\s\S]*?(?=\n## |$)/,
      costSection + '\n'
    );
  } else {
    content = content.trimEnd() + '\n\n' + costSection + '\n';
  }

  return content;
}

// Bound on the budget push, kept well under the Stop pipeline's 15s hook budget
// so a slow/hung platform API can't starve the pipeline's remaining stages.
const BUDGET_PUSH_TIMEOUT_MS = 6000;

// Operator-language push for the periods that just newly crossed a warn/breach
// threshold this tick (never for periods whose alert already existed — see the
// create-only dedup in applyBudgetCheck). Breached and warned periods are framed
// separately so a warn batched with a breach isn't mislabeled "cap reached".
// This is the maintainer-tier text (full USD/cap/ratio detail). Exported for tests.
function composeBudgetMessage(newPeriods: Json[], action: 'alert' | 'pause', until: string | null, timezone: string, locale: Locale = 'en'): string {
  const B = BUDGET[locale];
  const clause = (p: Json) =>
    B.clause(B.periodPossessive(p.period), p.spend, p.cap, Math.round(p.ratio * 100));
  const breached = newPeriods.filter((p) => p.level === 'breach');
  const warned = newPeriods.filter((p) => p.level === 'warn');
  if (breached.length > 0) {
    let msg = B.capReachedPrefix() + breached.map(clause).join('; ');
    if (warned.length > 0) msg += B.alsoApproaching() + warned.map(clause).join('; ');
    if (action === 'pause' && until) msg += B.pausedUntilSuffix(friendlyBoundary(until, timezone));
    return `${msg}.`;
  }
  return B.headsUpPrefix() + warned.map(clause).join('; ') + '.';
}

// Record `notified: true` on already-persisted budget alert entries via a fresh
// read-modify-write, so the confirmation write reflects current on-disk state
// rather than a snapshot taken before the (awaited) send. Fail-open.
function markAlertNotified(alerts: Json, key: string): void {
  const entry = alerts[key];
  if (entry && !entry.notified) entry.notified = true;
}

function markBudgetNotified(newPeriods: Json[], periodKey: Record<string, string>): void {
  mutateOwnedAlerts(BUDGET_ALERTS, (alerts) => {
    for (const p of newPeriods) {
      markAlertNotified(alerts, `budget-${p.level}:${p.period}:${periodKey[p.period]}`);
    }
  });
}

// PROP-016 budget enforcement: compare this turn's freshly-updated index against
// config.budget's caps and, on a breach/warn, write a deduped alert-state entry
// (one per period per level — `budget-<level>:<period>:<period-key>`, create-only so
// a re-detected breach later the same period never resets `notified` back to false)
// and, for `action:"pause"`, set the PROP-015 pause flag with an auto-resume boundary.
// Newly-created entries also get a direct channel push; `notified` is only
// flipped true on a confirmed send, so a failed send leaves the existing
// `heartbeat.ts precheck` EVALUATE wake as the fallback announcement path.
// Fail-open throughout — never throws, since run()'s caller must never be blocked by
// this check.
async function applyBudgetCheck(costIdx: Json, timezone: string, budgetConfig: Json, locale: Locale = 'en'): Promise<void> {
  try {
    if (!budgetConfig || typeof budgetConfig !== 'object') return;
    const caps = {
      daily_usd: typeof budgetConfig.daily_usd === 'number' ? budgetConfig.daily_usd : null,
      weekly_usd: typeof budgetConfig.weekly_usd === 'number' ? budgetConfig.weekly_usd : null,
      monthly_usd: typeof budgetConfig.monthly_usd === 'number' ? budgetConfig.monthly_usd : null,
    };
    if (caps.daily_usd === null && caps.weekly_usd === null && caps.monthly_usd === null) return; // inert
    const action: 'alert' | 'pause' = budgetConfig.action === 'pause' ? 'pause' : 'alert';

    const periodKey = { daily: todayYMD(timezone), weekly: thisWeekKey(timezone), monthly: thisMonthYYYYMM(timezone) };
    const result = evaluateBudget({
      dailySpend: costIdx?.by_date?.[periodKey.daily]?.cost || 0,
      weeklySpend: costIdx?.by_week?.[periodKey.weekly]?.cost || 0,
      monthlySpend: costIdx?.by_month?.[periodKey.monthly]?.cost || 0,
      caps,
      action,
    });
    if (result.level === 'none') return;

    // Read-modify-write budget-alerts.json — cost-tracker's own file, so a plain
    // atomic write needs no lock (the split from the shared alert-state.json is what
    // removes the cross-process clobber with the watchdog's export-alert writer).
    // mutateOwnedAlerts returns false on an ioerror read (healthy file we couldn't
    // read) — in which case we act on nothing, as before.
    const newPeriods: Json[] = [];
    const applied = mutateOwnedAlerts(BUDGET_ALERTS, (alerts) => {
      for (const p of result.periods) {
        const key = `budget-${p.level}:${p.period}:${periodKey[p.period]}`;
        if (alerts[key]) continue; // dedup: one entry per period+level, create-only
        alerts[key] = {
          kind: 'budget',
          level: p.level,
          period: p.period,
          action: result.action,
          spend: Math.round(p.spend * 10000) / 10000,
          cap: p.cap,
          ratio: Math.round(p.ratio * 100) / 100,
          notified: false,
          ts: new Date().toISOString(),
        };
        newPeriods.push(alerts[key]);
      }
      // Reap budget-* entries from prior periods — created on breach/warn but
      // otherwise never removed, so the file would grow unbounded on a hermit that
      // breaches regularly. A key is `budget-<level>:<period>:<period-key>`; any
      // whose trailing period-key isn't the current one is a past period.
      for (const key of Object.keys(alerts)) {
        const e = alerts[key];
        if (e?.kind !== 'budget') continue;
        const current = periodKey[e.period as keyof typeof periodKey];
        if (current && !key.endsWith(`:${current}`)) delete alerts[key];
      }
    });
    if (!applied) return; // ioerror — never act on a state we couldn't read

    // Decide the pause action. `until` (the auto-resume boundary) is set whenever
    // the hermit is or will be budget-paused, so the operator message can name it.
    // `willPause` gates the actual setPause write and is false when a budget pause
    // is already in force at the same boundary — otherwise re-stamping pause.json's
    // ts every breach tick would defeat the watchdog's once-per-episode Escape/notify
    // dedup — or when a stronger operator/watchdog stop is in force (never downgrade
    // an indefinite stop into an auto-resuming budget pause). isPaused applies
    // reader-side expiry, so an already-lapsed pause counts as unpaused.
    let willPause = false;
    let until: string | null = null;
    if (result.action === 'pause' && result.level === 'breach') {
      const breachedPeriods = result.periods.filter(p => p.level === 'breach').map(p => p.period);
      const boundary = pauseBoundary(breachedPeriods, timezone);
      const existing = isPaused(HERMIT_DIR);
      if (!existing.paused) {
        willPause = true;
        until = boundary;
      } else if (existing.reason === 'budget') {
        until = boundary; // already budget-paused until this boundary
        willPause = existing.until !== boundary; // re-assert only if the boundary moved
      }
    }

    // The alert entries were already persisted inside mutateOwnedAlerts above
    // (create-only dedup), so a failed push below won't re-send next tick. Set the
    // pause synchronously before the awaited send.
    if (willPause) setPause(HERMIT_DIR, { reason: 'budget', by: 'cost-tracker', until });

    // Then push — bounded well under the Stop pipeline's 15s budget — and record
    // `notified` via a fresh read-modify-write. On failure, notified stays false so
    // `heartbeat.ts precheck`'s EVALUATE wake remains the fallback announcement path.
    if (newPeriods.length > 0) {
      // Full USD/cap/ratio detail is maintainer-tier; on a stock install (no
      // maintainer channel, technical profile) it falls back to the primary chat,
      // byte-identical to today. When a pause is in force, the client chat also
      // gets a plain localized "paused until X" line — dropped by sendOperatorNotice
      // when the maintainer text already landed in that same chat.
      const message = composeBudgetMessage(newPeriods, result.action, until, timezone, locale);
      const clientLine = until ? BUDGET[locale].clientPaused(friendlyBoundary(until, timezone)) : undefined;
      const res = await sendOperatorNotice(HERMIT_DIR, {
        client: clientLine,
        maintainer: { text: message, fallback: 'client' },
        timeoutMs: BUDGET_PUSH_TIMEOUT_MS,
      });
      // Mark notified only when the alert actually reached a live counterparty:
      // the maintainer leg was delivered (a chat, or its intended Findings home),
      // OR the client "paused until X" line landed on the primary chat. A degraded
      // Findings fallback (configured maintainer channel unreachable) leaves
      // notified:false so `heartbeat.ts precheck`'s EVALUATE wake re-announces once the
      // channel recovers.
      if (res.maintainer?.delivered || res.client?.ok === true) markBudgetNotified(newPeriods, periodKey);
    }
  } catch (err: any) {
    console.error(`[cost-tracker] budget check error: ${err.message}`);
  }
}

// Exported run() function for use by stop-pipeline.ts.
// Returns the summary string, or null if there is nothing to report.
// process.exit() calls become returns so the pipeline is not killed.
async function run(data: Json): Promise<string | null> {
  try {
    const sessionId = ccSessionId(data) || 'unknown';
    const transcriptPath = ccTranscriptPath(data);

    if (!transcriptPath) {
      return null;
    }

    const turn = readLastTurnUsage(transcriptPath);
    if (!turn) {
      return null;
    }

    // Surface derivation is idempotent (boundary_at-gated) and independent of the
    // billing dedupe below — run it before any early return can skip it.
    maybeDeriveSurface(turn.tailLines);

    const { inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens, model: rawModel, hadHumanTurn, source, sourceInherited, apiCalls, maxPromptTokens, subagents, observedAt, lastCallPromptTokens } = turn;
    const model = detectModel(rawModel);

    const totalTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
    if (totalTokens === 0) {
      return null;
    }

    const cost = calculateCost(model, inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens);
    const roundedCost = Math.round(cost * 10000) / 10000;

    // Read session_id from runtime.json once per turn (used for log entry + writeStatusJson)
    const runtimeSessionId = readRuntimeSessionId();

    // Duplicate guard: a turn whose newest call is no newer than the last logged row's
    // already went through here. The scan guards above catch the flush race that produced
    // the measured incident; this catches every other way the same transcript entry can be
    // re-found (a manual run racing the Stop hook, a retried hook), which would otherwise
    // double-bill the spend and republish a dead context size. Same session only — a fresh
    // session legitimately starts from older transcript entries — and legacy rows without
    // observed_at never block, so the first post-upgrade turn always bills.
    const lastRow = lastLoggedMainRow();
    if (observedAt && lastRow && lastRow.session_id === (runtimeSessionId || sessionId)
        && typeof lastRow.observed_at === 'string' && observedAt <= lastRow.observed_at) {
      return null;
    }

    maintainOpenedAt(new Date().toISOString(), sessionId);

    // Read config once per turn — timezone drives by_date/by_week/by_month bucketing and
    // budget-window boundaries (PROP-016); budgetConfig drives the breach check below.
    const config: Json = readSettledConfig(HERMIT_DIR);
    const timezone = typeof config.timezone === 'string' && config.timezone ? config.timezone : 'UTC';

    // Unknown model string → still priced at sonnet rates (refusing would zero the log),
    // but flagged so the drift is auditable instead of a silent mis-bill. A falsy/absent
    // rawModel is a different, unflagged case (no model info at all, not an unrecognized one).
    // Derived from PRICING's own keys (not a hand-copied literal list) so a new tier can't
    // silently drift out of sync with this check.
    const rawModelLower = rawModel ? rawModel.toLowerCase() : '';
    const modelUnpriced = !!rawModel && !Object.keys(PRICING).some(tier => rawModelLower.includes(tier));

    // Log to JSONL. The row shape lives in lib/cost-log.ts — `observed_at` is the
    // context size and WHEN it was observed, both from the turn's newest call (the
    // row's own `timestamp` is ingestion time and says nothing about the context it
    // describes), and `source_inherited` marks a source that came from the dispatch
    // hop rather than this turn's own prompt. Both are absent, not false, when they
    // do not apply.
    const logEntry = buildMainCostRow({
      sessionId: runtimeSessionId || sessionId,
      source,
      model,
      inputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      outputTokens,
      totalTokens,
      apiCalls,
      maxPromptTokens,
      observedAt,
      lastCallPromptTokens,
      contextUsage: data.context_usage ?? data.contextUsage ?? null,
      estimatedCostUsd: roundedCost,
      modelUnpriced,
      sourceInherited,
    });

    // Emit one log line per dispatched subagent at its resolved model.
    // Subagent assistant entries live in separate transcript files; only the Agent tool_result
    // (type:'user' with toolUseResult.usage) appears here. collectSubagentUsage captured them;
    // attribute them to the same source so cost-reflect folds them into the dispatching row.
    let subTokens = 0, subCost = 0;
    const subagentRows: any[] = [];
    for (const sa of (subagents || [])) {
      const saTotal = sa.inputTokens + sa.cacheWriteTokens + sa.cacheReadTokens + sa.outputTokens;
      if (saTotal === 0) continue;
      const saModel = detectModel(sa.model);
      const saCostRaw = calculateCost(saModel, sa.inputTokens, sa.cacheWriteTokens, sa.cacheReadTokens, sa.outputTokens);
      const saCost = Math.round(saCostRaw * 10000) / 10000;
      subagentRows.push(buildSubagentCostRow({
        sessionId: runtimeSessionId || sessionId,
        source,
        model: saModel,
        inputTokens: sa.inputTokens,
        cacheWriteTokens: sa.cacheWriteTokens,
        cacheReadTokens: sa.cacheReadTokens,
        outputTokens: sa.outputTokens,
        totalTokens: saTotal,
        agentType: sa.agentType,
        modelResolved: !!sa.model,
        estimatedCostUsd: saCost,
      }));
      subTokens += saTotal;
      subCost += saCost;
    }

    appendCostRows(COST_LOG, [logEntry, ...subagentRows]);

    // Update incremental index — O(1) in the common case; O(n) only on first run or log truncation.
    // Must happen before getCumulativeCost so the index fallback sees this turn's lines.
    const costIdx = updateCostIndex(COST_LOG, COST_INDEX, timezone);

    // PROP-016: compare the freshly-updated index against config.budget's caps.
    await applyBudgetCheck(costIdx, timezone, config.budget, resolveLocale(config.language));

    // Running total from .status.json (O(1)), falls back to index (O(1)) on first run.
    // Include subagent spend so .status.json stays consistent with the index.
    const cumulative = getCumulativeCost(roundedCost + subCost, totalTokens + subTokens, hadHumanTurn, runtimeSessionId || sessionId, costIdx);
    const costStr = `$${cumulative.cost.toFixed(4)}`;

    // Read SHELL.md for task/blockers — do NOT write back (avoids race condition with Claude's edits)
    try {
      const shellContent = fs.readFileSync(SHELL_SESSION, 'utf-8');
      writeStatusJson(shellContent, cumulative, runtimeSessionId || sessionId);
    } catch {
      // Non-fatal — session file may not exist yet
    }

    writeCostSummary(costIdx, timezone);

    // Return brief summary (pipeline writes this to stderr)
    return `[cost-tracker] ${model}: ${kStr(totalTokens)} tokens (${kStr(cacheReadTokens)} cached), $${cost.toFixed(4)} (cumulative: ${costStr})`;
  } catch (err: any) {
    // Non-fatal — never block on cost tracking failure
    console.error(`[cost-tracker] Error: ${err.message}`);
    return null;
  }
}

export { run, getCumulativeCost, classifySource, resolveTurnSource, sumTurnUsage, collectSubagentUsage, detectModel, composeBudgetMessage, maintainOpenedAt };

if (import.meta.main) {
  // Mark-only entrypoint (synchronous, no stdin): the heartbeat SKILL calls this
  // to flip a delivered budget alert's `notified` flag. Keeps cost-tracker the
  // sole writer of budget-alerts.json so the SKILL never races the owned write.
  const markKey = process.argv[2] === '--mark-budget-notified' ? process.argv[3] : null;
  if (markKey) {
    mutateOwnedAlerts(BUDGET_ALERTS, (alerts) => markAlertNotified(alerts, markKey));
    process.exit(0);
  }
  (async () => {
    try {
      const chunks: Buffer[] = [];
      let totalSize = 0;

      for await (const chunk of process.stdin) {
        totalSize += chunk.length;
        if (totalSize > MAX_STDIN) {
          console.error('[cost-tracker] Stdin exceeds 1MB limit');
          process.exit(0);
        }
        chunks.push(chunk);
      }

      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        process.exit(0);
      }

      const data = JSON.parse(raw);
      const summary = await run(data);
      if (summary) console.log(summary);
      touchHeartbeat();
    } catch (err: any) {
      console.error(`[cost-tracker] Error: ${err.message}`);
      process.exit(0);
    }
  })();
}
