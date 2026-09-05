// scripts/session-archive.ts — deterministic replacement for the session-mgr subagent.
//
// session-mgr (agents/session-mgr.md) was a 16.3KB sonnet subagent dispatched at every
// idle transition, operator close, auto-close, and recovery/start branch. Investigation
// (see .claude-code-hermit/compiled/brainstorm-subagent-delegation-economics-2026-07-08.md
// and the PR-2 plan) found 12 of its 13 tasks are mechanical transforms given a payload
// main already compiles in-context — this script takes over every one of those writes.
//
// Four verbs:
//   archive --mode=idle|close|auto --state-dir=<dir>   (stdin: structured payload)
//   open --state-dir=<dir>                             (stdin: Task: <text>)
//   recover --state-dir=<dir>                           (no stdin payload — reads on-disk state)
//   auto-close-decision --state-dir=<dir>               (no stdin — daily-auto-close branch table)
//
// Every verb emits exactly one line of JSON to stdout: {"ok": boolean, ...}. `ok` is the
// explicit outcome contract review found missing — no subagent judgment layer exists
// anymore to tell main "this succeeded", so callers must branch on this field, not on
// exit code alone (the script always exits 0, fail-open).
//
// Runtime I/O note: this script reuses scripts/lib/alert-state.ts's tri-state reader
// (readAlertState/quarantineAlertState — generic path-in, tri-state-JSON-read-out
// helpers with nothing alert-specific in them) rather than scripts/lib/runtime.ts's
// writer. That helper's readRuntimeJson() collapses missing/corrupt/ioerror into one
// `null`, and updateRuntimeField() seeds `{}` on that null before an atomic overwrite —
// a transient read error (EACCES/EMFILE) would silently destroy a healthy runtime.json.
// Fixing the shared helper for its OTHER callers (hermit-start.ts, hermit-stop.ts,
// hermit-watchdog.ts, channel-responder, etc.) is a separate, out-of-scope follow-up —
// not bundled into this refactor.

import fs from 'node:fs';
import path from 'node:path';
import { globDir, readFrontmatter } from './lib/frontmatter';
import { localISOStamp } from './lib/time';
import { readAlertState as readRuntime, quarantineAlertState as quarantineRuntime } from './lib/alert-state';
import { costLogPath, pinStateDirOrExit } from './lib/cc-compat';
import { computeSessionCost } from './lib/session-cost';
import { AUTO_CLOSE_LULL_MINUTES } from './lib/auto-close';
import { readSettledConfig } from './lib/config-read';
import { extractSection as sectionBody, firstContentLine, isResolvedBlockerLine, replaceSectionInPlace, stripPlaceholders, stripResolvedMarker } from './lib/md-write';
import { isResetBreadcrumb } from './lib/progress-log';

type Json = any;

// ---------------------------------------------------------------------------
// Time helpers (HERMIT_NOW-aware, matching archive-shell.ts's pattern so tests
// can pin a deterministic clock).
// ---------------------------------------------------------------------------

function getNow(): Date {
  const env = process.env.HERMIT_NOW;
  if (env) {
    const d = new Date(env);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }

// ISO-8601 with a colon-separated offset in the given IANA timezone, e.g.
// 2026-04-06T14:30:00+01:00 — the report frontmatter's `date` field format.
// Falls back to the machine-local offset on any Intl failure (unknown timezone).
function zonedISOStamp(timezone: string, ref: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(ref);
    const get = (t: string) => parts.find(p => p.type === t)!.value;
    const offsetParts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, timeZoneName: 'longOffset',
    }).formatToParts(ref);
    const tzName = offsetParts.find(p => p.type === 'timeZoneName')?.value || 'GMT+00:00';
    const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(tzName);
    const offset = m ? `${m[1]}:${m[2] || '00'}` : '+00:00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
  } catch {
    return localISOStamp(ref).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  }
}

function formatDuration(ms: number): string {
  if (ms < 0) return 'unknown';
  if (ms === 0) return '0m';
  if (ms < 60000) return '<1m';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ---------------------------------------------------------------------------
// Arg parsing (archive-shell.ts's own convention: --key=value flags).
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { verb: string; flags: Record<string, string | true> } {
  const rest = argv.slice(2);
  const verb = rest[0] || '';
  const flags: Record<string, string | true> = {};
  for (const arg of rest.slice(1)) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
    if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  }
  return { verb, flags };
}

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

// Shared setup every verb needs: resolved state dir + derived paths + clock.
function resolveRunContext(flags: Record<string, string | true>): { stateDir: string; sessionsDir: string; runtimePath: string; now: Date } {
  // The state dir is not caller-chosen. Reachable through a pre-approved
  // `Bash(bun */scripts/session-archive.ts*)` grant that covers every argument,
  // and every verb here writes: an unvalidated root let one such call archive
  // over another project's SHELL.md and S-NNN-REPORT.md. See cc-compat.ts
  // assertStateDir(); the absolute-AGENT_DIR env prefix stays the one override.
  const stateDir = typeof flags['state-dir'] === 'string'
    ? pinStateDirOrExit(flags['state-dir'] as string, 'session-archive')
    : path.resolve('.claude-code-hermit');
  const sessionsDir = path.join(stateDir, 'sessions');
  const runtimePath = path.join(stateDir, 'state', 'runtime.json');
  return { stateDir, sessionsDir, runtimePath, now: getNow() };
}

// ---------------------------------------------------------------------------
// Stdin payload parser. Recognized keys are copied through verbatim (main
// already composed the free text) — the script never invents prose, it only
// extracts and writes. "none" (case-insensitive) collapses to empty. A
// literal "## Plan" line switches into verbatim capture mode for the rest of
// stdin. No shipped skill emits it any more (plan tracking moved to the SHELL.md
// Progress Log); the branch stays so a session still holding pre-upgrade skill
// text in context can't spill a plan table into the Next Start Point field.
// ---------------------------------------------------------------------------

const PAYLOAD_KEYS = [
  'Status', 'Blockers', 'Lessons', 'Changed', 'Artifacts', 'Cost',
  'Closed Via', 'Next Start Point', 'Task',
];

// Precompiled once — PAYLOAD_KEYS is static, so there's no reason to rebuild
// the same 9 RegExps for every line of every payload.
const PAYLOAD_KEY_PATTERNS = PAYLOAD_KEYS.map(key => ({ key, re: new RegExp(`^${key}:\\s*(.*)$`) }));

function parsePayload(stdin: string): Record<string, string> & { plan?: string } {
  const out: Record<string, string> = {};
  let current: string | null = null;
  let plan: string | null = null;
  const lines = stdin.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '## Plan') {
      plan = lines.slice(i + 1).join('\n').trim();
      break;
    }
    let matched = false;
    for (const { key, re } of PAYLOAD_KEY_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        current = key;
        out[key] = m[1];
        matched = true;
        break;
      }
    }
    if (!matched && current !== null) {
      out[current] = out[current] ? out[current] + '\n' + line : line;
    }
  }
  for (const key of Object.keys(out)) {
    if (/^none$/i.test(out[key].trim())) out[key] = '';
    else out[key] = out[key].trim();
  }
  const result: Record<string, string> & { plan?: string } = out;
  if (plan) result.plan = plan;
  return result;
}

// ---------------------------------------------------------------------------
// Atomic file writes + the runtime.json read-modify-write wrapper.
// ---------------------------------------------------------------------------

function writeFileAtomic(p: string, content: string): void {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, p);
}

function writeRuntimeAtomic(p: string, obj: Json, now: Date): void {
  obj.updated_at = localISOStamp(now);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeFileAtomic(p, JSON.stringify(obj, null, 2) + '\n');
}

// Read-modify-write with the ioerror guard: a transient read failure declines
// the write entirely rather than seeding {} over a healthy file.
function updateRuntime(p: string, now: Date, updates: Json): { ok: true; value: Json } | { ok: false; reason: string } {
  const r = readRuntime(p);
  let base: Json;
  if (r.kind === 'ok') base = r.value;
  else if (r.kind === 'missing') base = {};
  else if (r.kind === 'corrupt') { quarantineRuntime(p, now.getTime()); base = {}; }
  else return { ok: false, reason: `runtime-ioerror${r.code ? ':' + r.code : ''}` };
  Object.assign(base, updates);
  try {
    writeRuntimeAtomic(p, base, now);
  } catch (e: any) {
    return { ok: false, reason: 'runtime-write-error: ' + e.message };
  }
  return { ok: true, value: base };
}

function readRuntimeValueOrEmpty(p: string): Json {
  const r = readRuntime(p);
  return r.kind === 'ok' ? r.value : {};
}

// ---------------------------------------------------------------------------
// S-NNN resolution: glob existing reports, extract the highest NNN, +1; else
// S-001. Pure arithmetic — no judgment.
// ---------------------------------------------------------------------------

function nextSessionId(sessionsDir: string): string {
  const files = globDir(sessionsDir, /^S-(\d+)-REPORT\.md$/);
  let max = 0;
  for (const f of files) {
    const m = /S-(\d+)-REPORT\.md$/.exec(path.basename(f));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'S-' + String(max + 1).padStart(3, '0');
}

function resolveSessionId(runtime: Json, sessionsDir: string): string {
  if (runtime && typeof runtime.session_id === 'string' && runtime.session_id) return runtime.session_id;
  return nextSessionId(sessionsDir);
}

// ---------------------------------------------------------------------------
// SHELL.md field extraction helpers.
// ---------------------------------------------------------------------------

function readFileSafe(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

// Trimmed, missing-section-is-empty flavour of md-write's section read — the
// shape this file's callers expect.
function extractSection(shell: string, heading: string): string {
  return (sectionBody(shell, heading) ?? '').trim();
}

function extractTags(shell: string): string[] {
  const m = /\*\*Tags:\*\*\s*(.*)/.exec(shell);
  if (!m) return [];
  const raw = stripPlaceholders(m[1]);
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// Scans the whole of SHELL.md for proposal IDs. session-mgr.md's own spec is
// ambiguous about which section holds "Proposals Created" (SHELL.md.template
// has no such heading — proposals get created via a separate skill during the
// session and logged wherever main happened to note them). Scanning the full
// document is the robust reading: the regex is scoped enough not to false-hit,
// and it's tolerant of main logging a created-proposal line in Findings,
// Progress Log, or anywhere else.
function extractProposalIds(shell: string): string[] {
  const matches = shell.match(/PROP-[a-z0-9][a-z0-9-]*/gi) || [];
  return Array.from(new Set(matches));
}

// ---------------------------------------------------------------------------
// Cost precedence: measured cost-log window (computeSessionCost) -> legacy
// payload Cost line -> 0.00/0. `sessions/.status.json` is NEVER consulted for
// cost — it's a cumulative running total (cost-tracker.ts), not a per-session
// value, and stamping it onto a report silently records the hermit's lifetime
// spend as one session's cost (the auto-close inflation bug this replaced).
// The legacy Cost: line parse is kept as the second tier for rollout
// back-compat (in-flight sessions / not-yet-evolved skill text may still emit
// one) even though session-close/session no longer instruct writing it.
// ---------------------------------------------------------------------------

// Recover path only: the cost verbArchive already wrote to the report frontmatter.
// The crash landed after the report was written, so its frontmatter is the
// authoritative session cost — not a fresh (and by then window-less) recomputation.
// readFrontmatter returns scalars as strings — coerce, don't typeof-check.
function recoveredReportCost(reportPath: string): { cost_usd: number; tokens: number } {
  const fm = readFrontmatter(reportPath);
  const cost = Number(fm?.cost_usd);
  const tokens = Number(fm?.tokens);
  return {
    cost_usd: Number.isFinite(cost) ? cost : 0,
    tokens: Number.isFinite(tokens) ? tokens : 0,
  };
}

function resolveCost(
  payload: Record<string, string>,
  opts: { logPath: string; openedAt?: string; closedAt?: string },
): { cost_usd: number; tokens: number } {
  const measured = computeSessionCost(opts);
  if (measured.available) return { cost_usd: measured.cost_usd, tokens: measured.tokens };

  const costLine = payload['Cost'] || '';
  // Tolerate thousands separators (`$1,234.50 (1,526,890 tokens)`).
  const m = /\$([\d,]+(?:\.\d+)?)\s*\(([\d,]+)\s*tokens?\)/.exec(costLine);
  if (m) return { cost_usd: Math.round(parseFloat(m[1].replace(/,/g, '')) * 10000) / 10000, tokens: parseInt(m[2].replace(/,/g, ''), 10) };
  return { cost_usd: 0, tokens: 0 };
}

// config.json is static for the duration of one invocation — read it once per
// verb and pass the parsed object into these instead of each resolving it
// independently (was 3 separate reads+parses per idle-mode archive call).
function readConfig(stateDir: string): Json {
  return readSettledConfig(stateDir);
}

function resolveEscalation(config: Json): string {
  const allowed = ['conservative', 'balanced', 'autonomous'];
  return allowed.includes(config.escalation) ? config.escalation : 'balanced';
}

function resolveTimezone(config: Json): string {
  return typeof config.timezone === 'string' && config.timezone ? config.timezone : 'UTC';
}

function resolveCompactConfig(config: Json): { monitoring_threshold: number; monitoring_keep: number; summary_threshold: number; summary_keep: number } {
  const defaults = { monitoring_threshold: 30, monitoring_keep: 20, summary_threshold: 30, summary_keep: 15 };
  return { ...defaults, ...(config.compact || {}) };
}

// ---------------------------------------------------------------------------
// session-diff.json merge: format each changed_files entry, append to
// whatever Changed text the payload already carried, dedup exact lines.
// ---------------------------------------------------------------------------

function mergeSessionDiff(changedText: string, stateDir: string): string {
  const raw = readFileSafe(path.join(stateDir, 'state', 'session-diff.json'));
  if (!raw) return changedText;
  let diff: Json;
  try { diff = JSON.parse(raw); } catch { return changedText; }
  const files: Array<{ file: string; status: string }> = Array.isArray(diff.changed_files) ? diff.changed_files : [];
  if (!files.length) return changedText;
  const existingLines = new Set(changedText.split('\n').map(l => l.trim()).filter(Boolean));
  const newLines: string[] = [];
  for (const f of files) {
    const line = `- \`${f.file}\` (${f.status})`;
    if (!existingLines.has(line)) newLines.push(line);
  }
  if (!newLines.length) return changedText;
  return changedText ? changedText + '\n' + newLines.join('\n') : newLines.join('\n');
}

// ---------------------------------------------------------------------------
// Compaction roll-up: count non-empty, non-comment lines in a section body;
// above threshold, summarize all but the last `keep` into one [Earlier] line,
// bucketed by a simple keyword sniff (alert / self-eval / everything else),
// merging into an existing [Earlier] line if present.
// ---------------------------------------------------------------------------

function compactSection(body: string, threshold: number, keep: number): string {
  const lines = body.split('\n');
  const contentLines = lines.filter(l => l.trim() && !l.trim().startsWith('<!--'));
  if (contentLines.length <= threshold) return body;

  const earlierRe = /^\[Earlier\]\s+(.*)$/;
  let existingCounts = { alerts: 0, selfEvals: 0, entries: 0 };
  let existingRange: { first: string; last: string } | null = null;
  const nonEarlier: string[] = [];
  for (const line of contentLines) {
    const m = earlierRe.exec(line.trim());
    if (m) {
      const a = /(\d+)\s+alerts?/.exec(m[1]);
      const s = /(\d+)\s+self-evals?/.exec(m[1]);
      const e = /(\d+)\s+entries/.exec(m[1]);
      if (a) existingCounts.alerts += parseInt(a[1], 10);
      if (s) existingCounts.selfEvals += parseInt(s[1], 10);
      if (e) existingCounts.entries += parseInt(e[1], 10);
      const r = /\(([^)]+)\)\s*$/.exec(m[1]);
      if (r) {
        const [first, last] = r[1].split('—').map(x => x.trim());
        let mergedFirst = first;
        let mergedLast = last;
        if (existingRange !== null) {
          const prevFirst: string = existingRange.first;
          const prevLast: string = existingRange.last;
          if (prevFirst < mergedFirst) mergedFirst = prevFirst;
          if (prevLast > mergedLast) mergedLast = prevLast;
        }
        existingRange = { first: mergedFirst, last: mergedLast };
      }
    } else {
      nonEarlier.push(line);
    }
  }

  const toSummarize = nonEarlier.slice(0, Math.max(0, nonEarlier.length - keep));
  const toKeep = nonEarlier.slice(Math.max(0, nonEarlier.length - keep));
  if (!toSummarize.length && existingCounts.alerts + existingCounts.selfEvals + existingCounts.entries === 0) return body;

  const counts = { ...existingCounts };
  const timestamps: string[] = existingRange ? [existingRange.first, existingRange.last] : [];
  for (const line of toSummarize) {
    if (/alert/i.test(line)) counts.alerts++;
    else if (/self-eval/i.test(line)) counts.selfEvals++;
    else counts.entries++;
    const ts = /\[([^\]]+)\]/.exec(line);
    if (ts) timestamps.push(ts[1]);
  }
  timestamps.sort();
  const first = timestamps[0] || '';
  const last = timestamps[timestamps.length - 1] || '';

  const parts: string[] = [];
  if (counts.alerts) parts.push(`${counts.alerts} alerts`);
  if (counts.selfEvals) parts.push(`${counts.selfEvals} self-evals`);
  if (counts.entries) parts.push(`${counts.entries} entries`);
  const summaryLine = `[Earlier] ${parts.join(', ')}${first && last ? ` (${first} — ${last})` : ''}`;

  return [summaryLine, ...toKeep].join('\n');
}

// ---------------------------------------------------------------------------
// Frontmatter + report assembly.
// ---------------------------------------------------------------------------

function normalizeStatus(raw: string): { status: string; note: string | null } {
  const allowed = ['completed', 'partial', 'blocked'];
  const v = (raw || '').trim().toLowerCase();
  if (allowed.includes(v)) return { status: v, note: null };
  // An empty/absent Status is the ordinary idle-archive case, not a bad value —
  // default it to `partial` silently. Only a non-empty, out-of-set value earns the
  // normalization note (otherwise every normal archive pollutes Blockers with it).
  if (v === '') return { status: 'partial', note: null };
  return { status: 'partial', note: `Status normalized: original value \`${raw}\` coerced to \`partial\`.` };
}

function yamlArray(items: string[]): string {
  // Quote anything that isn't a safe plain scalar. A bareword starting with a YAML
  // indicator (`#`, `[`, `{`, `&`, `*`, `!`, etc.) or containing a comma/space breaks
  // the flow sequence, so tags like `#urgent` must be quoted to stay parseable.
  const safeBareword = /^[A-Za-z0-9][\w./-]*$/;
  return `[${items.map(s => safeBareword.test(s) ? s : JSON.stringify(s)).join(', ')}]`;
}

// Frontmatter digest of a prose section: content lines only (no template
// comments), each clipped, list capped — readers use this as the index row
// and open the body section only when it overflows.
function contentLines(s: string): string[] {
  const maxItems = 6;
  const maxLen = 150;
  return s.split('\n')
    .map(l => l.trim().replace(/^-\s+/, ''))
    .filter(l => l && !l.startsWith('<!--'))
    .slice(0, maxItems)
    .map(l => l.length > maxLen ? l.slice(0, maxLen - 1) + '…' : l);
}

// Recorded SHELL.md Task first, then the close payload's `Task:`, then the first real
// Progress Log entry. The payload can fill an empty recorded Task — a session that
// never wrote one still did something nameable — but never overwrite one: what the
// session recorded while working outranks what the model says about it at close.
function firstRecordedTask(shell: string, payloadTask?: string): string {
  const task = firstContentLine(extractSection(shell, 'Task'), 120);
  if (task) return task;

  const fromPayload = firstContentLine(payloadTask ?? '', 120);
  if (fromPayload) return fromPayload;

  const progress = stripPlaceholders(extractSection(shell, 'Progress Log'));
  for (const line of progress.split('\n')) {
    const candidate = line.trim().replace(/^-\s+/, '');
    if (!candidate || isResetBreadcrumb(candidate)) continue;
    return candidate.slice(0, 120);
  }
  return '';
}

type MergedPayloadField = 'Blockers' | 'Artifacts' | 'Task';

function blockerText(line: string): string {
  return line.trim().replace(/^-\s+/, '').trim();
}

// The one convention for "this blocker cleared": a `~` in front of its text — the same
// sigil the close payload uses (`Blockers: ~ <prefix>`), so there is one thing to learn.
// It marks rather than deletes: the text stays legible in SHELL.md until the archive,
// which is what keeps a recorded fact recorded. The report renders it as `[resolved]`,
// the next session's SHELL.md drops it, and startup-context skips it when naming current
// blockers — see isResolvedBlockerLine, which both sides share.

function mergeRecordedBlockers(
  recorded: string,
  payload: string,
  recoveryBlockers: string | undefined,
  statusNote: string | null,
): { content: string; contributed: boolean; carryForward: string } {
  const recordedLines = recorded.split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  // A recorded line already marked resolved was cleared during the session; strip the
  // marker for matching and display, and seed `resolved` with it so the payload doesn't
  // have to repeat what SHELL.md already says.
  const recordedText = recordedLines.map(line => stripResolvedMarker(blockerText(line)));
  const seen = new Set(recordedText.map(line => line.toLowerCase()));
  const resolved = new Set<number>(
    recordedLines.map((line, i) => (isResolvedBlockerLine(line) ? i : -1)).filter(i => i !== -1),
  );
  const additions: string[] = [];
  let contributed = false;

  for (const rawLine of payload.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^none$/i.test(line)) continue;

    if (line.startsWith('~')) {
      const resolution = blockerText(line.slice(1));
      if (!resolution || /^none$/i.test(resolution)) continue;
      const prefix = resolution.toLowerCase();
      const match = recordedText.findIndex(candidate => candidate.toLowerCase().startsWith(prefix));
      if (match !== -1) {
        if (!resolved.has(match)) {
          resolved.add(match);
          contributed = true;
        }
        continue;
      }

      const key = resolution.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      additions.push(resolution);
      contributed = true;
      continue;
    }

    const key = blockerText(line).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    additions.push(line);
    contributed = true;
  }

  const shellLines = recordedLines.map((line, index) => (
    resolved.has(index) ? `- [resolved] ${recordedText[index]}` : line
  ));
  // What the next session inherits: the same recorded lines minus the resolved ones,
  // and nothing else. Payload additions, the recovery note and the status note are
  // report-only — a session that has already ended is not handing itself new blockers.
  const carryForward = recordedLines.filter((_, index) => !resolved.has(index)).join('\n');
  return {
    content: [
      ...shellLines,
      ...additions,
      recoveryBlockers,
      statusNote,
    ].filter(Boolean).join('\n'),
    contributed,
    carryForward,
  };
}

function recordedArtifacts(
  shell: string,
  payload: string,
  stateDir: string,
  sessionId: string,
): { content: string; contributed: boolean } {
  const taskScopedShell = ['Task', 'Progress Log', 'Blockers', 'Findings', 'Changed']
    .map(heading => extractSection(shell, heading))
    .join('\n');
  const shellLinks = taskScopedShell.match(/\[\[compiled\/[^\]\r\n]+\]\]/g) || [];
  const stampedLinks = globDir(path.join(stateDir, 'compiled'), /^[^.].*\.md$/)
    .filter(file => readFrontmatter(file)?.session === sessionId)
    .map(file => `[[compiled/${path.basename(file, '.md')}]]`);
  const recorded = new Set([...shellLinks, ...stampedLinks]);
  const payloadOnly: string[] = [];
  for (const link of payload.match(/\[\[compiled\/[^\]\r\n]+\]\]/g) || []) {
    if (recorded.has(link)) continue;
    recorded.add(link);
    payloadOnly.push(link);
  }
  const links = Array.from(new Set([...shellLinks, ...payloadOnly, ...stampedLinks]));
  return {
    content: links.map(link => `- ${link}`).join('\n'),
    contributed: payloadOnly.length > 0,
  };
}

// Duration is the runtime's cost arc, the same [opened_at, closed_at] window
// resolveCost sums against — so the two figures in a report can never describe
// different spans. cost-tracker re-stamps opened_at whenever the transcript changes
// (lib maintainOpenedAt), which is what makes the window provably this runtime's.
//
// It deliberately does NOT require runtime.session_id to equal the archived id.
// close/auto null the id — that null is the auto-close gate's "resting, nothing to
// close" state — so requiring the match reported `unknown` for every archive after the
// first on exactly the always-on installs that archive nightly. `unknown` now means
// what it says: no arc was ever opened, or the window is inverted (a crash or a
// recovered close that never got a real bound).
function resolveDuration(
  openedAt: string | undefined,
  closedAt: string | undefined,
  now: Date,
): string {
  if (!openedAt) return 'unknown';
  const start = Date.parse(openedAt);
  if (!Number.isFinite(start)) return 'unknown';
  const parsedEnd = closedAt ? Date.parse(closedAt) : NaN;
  const end = Number.isFinite(parsedEnd) ? parsedEnd : now.getTime();
  // An end before the start is not a short session, it is a broken window — the same
  // condition the cost path already refuses to sum over. Report it as unknown rather
  // than as a negative or a rounded-to-zero span.
  if (end < start) return 'unknown';
  return formatDuration(end - start);
}

function buildReport(opts: {
  sessionId: string; mode: 'idle' | 'close' | 'auto'; now: Date;
  payload: Record<string, string> & { plan?: string }; shell: string; stateDir: string; config: Json;
  openedAt?: string; durationClosedAt?: string; costClosedAt?: string; recoveryBlockers?: string;
}): { content: string; statusNote: string | null; cost: { cost_usd: number; tokens: number }; mergedPayloadFields: MergedPayloadField[]; blockersCarryForward: string } {
  const { sessionId, mode, now, payload, shell, stateDir, config, openedAt, durationClosedAt, costClosedAt, recoveryBlockers } = opts;
  const sessionsDir = path.join(stateDir, 'sessions');
  const timezone = resolveTimezone(config);
  const { status, note: statusNote } = normalizeStatus(payload['Status'] || '');
  const duration = resolveDuration(openedAt, durationClosedAt, now);
  const cost = resolveCost(payload, { logPath: costLogPath(stateDir), openedAt, closedAt: costClosedAt ?? localISOStamp(now) });
  const { cost_usd, tokens } = cost;
  const tags = extractTags(shell);
  const proposalsCreated = extractProposalIds(shell);
  const recordedTask = firstContentLine(extractSection(shell, 'Task'), 120);
  const payloadTask = firstContentLine(payload['Task'] ?? '', 120);
  const task = recordedTask || firstRecordedTask(shell, payload['Task']);
  const escalation = resolveEscalation(config);
  const closedVia = payload['Closed Via'] || (mode === 'auto' ? 'auto' : 'operator');

  const blockersMerge = mergeRecordedBlockers(
    stripPlaceholders(extractSection(shell, 'Blockers')),
    payload['Blockers'] || '',
    recoveryBlockers,
    statusNote,
  );
  const blockers = blockersMerge.content;
  const changed = mergeSessionDiff(payload['Changed'] || '', stateDir);
  const artifactsMerge = recordedArtifacts(shell, payload['Artifacts'] || '', stateDir, sessionId);
  const artifacts = artifactsMerge.content;
  const findings = stripPlaceholders(extractSection(shell, 'Findings'));
  const lessons = payload['Lessons'] || '';
  const mergedPayloadFields: MergedPayloadField[] = [];
  if (blockersMerge.contributed) mergedPayloadFields.push('Blockers');
  if (artifactsMerge.contributed) mergedPayloadFields.push('Artifacts');
  // Only when it actually filled an empty recorded Task — a payload Task alongside a
  // recorded one contributed nothing and must not claim it did, and neither did a
  // `Task:` that held only a placeholder comment (the Progress Log named the work).
  if (!recordedTask && payloadTask) {
    mergedPayloadFields.push('Task');
  }
  // Idle-mode payloads may still carry a stale 'Next Start Point:' line (it isn't
  // part of the idle contract, same as the omitted body section below) — force it
  // empty so frontmatter and body agree.
  const nextStart = mode !== 'idle' ? (payload['Next Start Point'] || '') : '';

  const fm = [
    '---',
    `id: ${sessionId}`,
    `status: ${status}`,
    `date: ${zonedISOStamp(timezone, now)}`,
    `duration: ${duration}`,
    `cost_usd: ${cost_usd}`,
    `tokens: ${tokens}`,
    `tags: ${yamlArray(tags)}`,
    `proposals_created: ${yamlArray(proposalsCreated)}`,
    `task: ${JSON.stringify(task)}`,
    `artifacts: ${yamlArray(contentLines(artifacts))}`,
    `blockers: ${yamlArray(contentLines(blockers))}`,
    `lessons: ${yamlArray(contentLines(lessons))}`,
    `next_start: ${JSON.stringify(firstContentLine(nextStart, 200))}`,
    `escalation: ${escalation}`,
    `closed_via: ${closedVia}`,
    '---',
  ].join('\n');

  const sections: string[] = [];
  sections.push(`# Session Report: ${sessionId}`);
  sections.push(`## Overview\n${task || '<!-- One-line task description -->'}`);
  if (payload.plan) sections.push(`## Plan\n${payload.plan}`);
  const completed = stripPlaceholders(extractSection(shell, 'Progress Log'));
  sections.push(`## Completed\n${completed || '<!-- What was accomplished (narrative). Durable outputs must also be listed under ## Artifacts. -->'}`);
  sections.push(`## Findings\n${findings || '<!-- Anything unexpected found during work. Proposal-worthy items get their own file. -->'}`);
  sections.push(`## Changed\n${changed || '<!-- Files modified/created/deleted -->'}`);
  sections.push(`## Artifacts\n${artifacts || '<!-- Links to durable outputs written to compiled/ (cite as [[compiled/<type>-<slug>-<date>]]) -->'}`);
  sections.push(`## Blockers\n${blockers || '<!-- What couldn\'t be resolved -->'}`);
  sections.push(`## Lessons\n${lessons || '<!-- Genuinely useful insights (not obvious statements) -->'}`);
  sections.push(`## Proposals Created\n${proposalsCreated.length ? proposalsCreated.map(p => `- ${p}`).join('\n') : '<!-- Links to any proposals generated during this session -->'}`);
  if (mode !== 'idle') {
    sections.push(`## Next Start Point\n${nextStart || '<!-- Exactly what the next session should do first -->'}`);
  }

  return {
    content: fm + '\n\n' + sections.join('\n\n') + '\n',
    statusNote, cost, mergedPayloadFields,
    blockersCarryForward: blockersMerge.carryForward,
  };
}

// ---------------------------------------------------------------------------
// SHELL.md reset (mode-dependent).
// ---------------------------------------------------------------------------

// `mode` isn't needed here — both call sites only invoke this when mode is
// already known to be 'idle', so the cost the caller already has (computed once
// by buildReport, or read back from the written report in the recover path) is
// passed in directly instead of `sessionsDir` + a second cost resolution.
function idleReset(shell: string, sessionId: string, now: Date, payload: Record<string, string>, compactCfg: ReturnType<typeof resolveCompactConfig>, cost: { cost_usd: number; tokens: number }): string {
  // Snapshot the task summary from the ORIGINAL (pre-reset) shell — once the
  // Task section is cleared below, extracting from the mutated copy would
  // read the placeholder and fall through to the whole document's first line.
  const originalTask = firstContentLine(extractSection(shell, 'Task'), 80);
  let out = shell;

  const tasksMatch = /\*\*Tasks Completed:\*\*\s*(\d+)/.exec(out);
  const tasksCompleted = tasksMatch ? parseInt(tasksMatch[1], 10) + 1 : 1;
  out = out.replace(/\*\*Tasks Completed:\*\*\s*\d+/, `**Tasks Completed:** ${tasksCompleted}`);

  out = replaceSectionInPlace(out, 'Task', '\n<!-- Awaiting next task -->\n\n');
  out = replaceSectionInPlace(out, 'Progress Log', '\n<!-- Primary record of work -->\n<!-- Format: [HH:MM] Did X — result/outcome -->\n\n');
  out = replaceSectionInPlace(out, 'Blockers', '\n<!-- What\'s preventing progress? Include enough context for the next session. -->\n\n');
  out = replaceSectionInPlace(out, 'Findings', '\n<!-- Anything unexpected found during work. Proposal-worthy items get their own file. -->\n\n');
  out = replaceSectionInPlace(out, 'Changed', '\n<!-- Populated by session-diff hook, or list files manually -->\n\n');

  const monitoringBody = extractSection(out, 'Monitoring');
  const compactedMonitoring = compactSection(monitoringBody, compactCfg.monitoring_threshold, compactCfg.monitoring_keep);
  if (compactedMonitoring !== monitoringBody) out = replaceSectionInPlace(out, 'Monitoring', '\n' + compactedMonitoring + '\n\n');

  const summaryBody = extractSection(out, 'Session Summary');
  const status = (payload['Status'] || 'partial');
  const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const summaryLine = `**${sessionId}** (${dateStr}): ${originalTask || '(no task summary)'} — ${normalizeStatus(status).status} ($${cost.cost_usd.toFixed(2)})`;
  const withNewLine = summaryBody ? summaryBody + '\n' + summaryLine : summaryLine;
  const compactedSummary = compactSection(withNewLine, compactCfg.summary_threshold, compactCfg.summary_keep);
  out = replaceSectionInPlace(out, 'Session Summary', '\n' + compactedSummary + '\n\n');

  return out;
}

// `blockers` is what the next session inherits: the merge's carry-forward list (recorded
// lines minus the ones resolved this session) from the archive path, or the raw SHELL
// section from the recover path, which has no merge to draw on. Resolved lines are
// filtered here either way — a blocker the operator or the close payload marked cleared
// must not come back, or the next session, and every compaction capsule after it,
// resumes believing it is still blocked.
function closeReset(templatePath: string, blockers: string): string {
  let template: string;
  try { template = fs.readFileSync(templatePath, 'utf-8'); }
  catch {
    template = '# Active Session\n\n## Session Info\n- **ID:** S-NNN (assigned on close)\n- **Started:** YYYY-MM-DD HH:MM\n- **Tags:** \n- **Tasks Completed:** 0\n- **Session Mode:** \n\n## Task\n\n## Progress Log\n\n## Blockers\n\n## Findings\n\n## Changed\n\n## Monitoring\n\n## Session Summary\n';
  }
  const carried = blockers.split('\n')
    .filter(line => !line.trim() || !isResolvedBlockerLine(line))
    .join('\n')
    .trim();
  if (carried) {
    template = replaceSectionInPlace(template, 'Blockers', '\n' + carried + '\n\n');
  }
  return template;
}

// Shared by verbArchive and verbRecover: only stamp shutdown_completed_at if
// hermit-stop.ts already signaled a real shutdown is underway — otherwise this
// "close" is session-close's own framing reused by an unattended auto-close
// (or a recovered crash that was never a real hermit-stop), and stamping it
// would falsely tell the watchdog the whole hermit is stopping.
function closeFinalUpdates(mode: 'idle' | 'close' | 'auto', sessionsDir: string, currentShutdownRequestedAt: unknown, now: Date): Json {
  const finalUpdates: Json = {
    transition: null, transition_target: null, transition_started_at: null, transition_mode: null,
    session_state: 'idle',
  };
  if (mode === 'idle') {
    finalUpdates.session_id = nextSessionId(sessionsDir);
  } else {
    finalUpdates.session_id = null;
    if (currentShutdownRequestedAt) {
      finalUpdates.shutdown_completed_at = localISOStamp(now);
    }
  }
  return finalUpdates;
}

// ---------------------------------------------------------------------------
// Post-archive marker bookkeeping — mode-keyed consequences of a successful
// archive (formerly prose steps: session/SKILL.md 7b, session-close steps 9/10).
// Each sub-action is individually guarded; failures land in the returned map
// and never flip the archive's ok. `suppressWrites` (the recover path) skips
// the two marker WRITES but still deletes pending-close.json: a recovered
// close is still a completed close and a surviving flag could AUTO_CLOSE the
// next session, while the writes trigger watchdog actions (compaction, /clear)
// that must not fire off a boot-time recovery.
// ---------------------------------------------------------------------------

// Deletes state/pending-close.json if present; tolerates absence, reports
// errors. Shared by applyPostArchiveMarkers (close/auto archive) and the
// auto-close-decision verb's stale-flag reap.
function reapPendingClose(stateDir: string): string {
  const pendingPath = path.join(stateDir, 'state', 'pending-close.json');
  try {
    if (fs.existsSync(pendingPath)) { fs.rmSync(pendingPath); return 'deleted'; }
    return 'absent';
  } catch (e: any) {
    return 'error: ' + e.message;
  }
}

function applyPostArchiveMarkers(stateDir: string, mode: 'idle' | 'close' | 'auto', now: Date, suppressWrites: boolean): Json {
  const markers: Json = {};
  const writeMarker = (name: string, reason: string): string => {
    try {
      fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
      writeFileAtomic(path.join(stateDir, 'state', name),
        JSON.stringify({ requested_at: localISOStamp(now), reason }, null, 2) + '\n');
      return 'written';
    } catch (e: any) {
      return 'error: ' + e.message;
    }
  };
  if (mode === 'idle') {
    markers.compact_requested = suppressWrites ? 'skipped' : writeMarker('compact-requested.json', 'session-work-done');
  }
  if (mode === 'close' || mode === 'auto') {
    markers.pending_close = reapPendingClose(stateDir);
  }
  if (mode === 'auto') {
    markers.clear_requested = suppressWrites ? 'skipped' : writeMarker('clear-requested.json', 'daily-auto-close');
  }
  return markers;
}

// ---------------------------------------------------------------------------
// Verb: archive
// ---------------------------------------------------------------------------

function verbArchive(
  flags: Record<string, string | true>,
  stdin: string,
  opts: { skipMarkerWrites?: boolean; recoveryBlockers?: string; includeMergedPayloadFields?: boolean } = {},
): Json {
  const mode = flags['mode'];
  if (mode !== 'idle' && mode !== 'close' && mode !== 'auto') {
    return { ok: false, reason: `archive requires --mode=idle|close|auto, got: ${mode ?? '(none)'}` };
  }
  const { stateDir, sessionsDir, runtimePath, now } = resolveRunContext(flags);

  let shell: string | null;
  try { shell = fs.readFileSync(path.join(sessionsDir, 'SHELL.md'), 'utf-8'); }
  catch { return { ok: false, reason: 'shell-missing' }; }
  if (shell === null) return { ok: false, reason: 'shell-missing' };

  const payload = parsePayload(stdin);
  if (Object.keys(payload).length === 0 && !payload.plan) {
    return { ok: false, reason: 'payload-unparseable' };
  }

  const runtimeBefore = readRuntimeValueOrEmpty(runtimePath);
  const sessionId = resolveSessionId(runtimeBefore, sessionsDir);

  const setTransition = updateRuntime(runtimePath, now, {
    transition: 'archiving',
    transition_target: `${sessionId}-REPORT.md`,
    transition_started_at: localISOStamp(now),
    transition_mode: mode,
    session_id: sessionId,
  });
  if (!setTransition.ok) return { ok: false, reason: setTransition.reason };

  const config = readConfig(stateDir);
  const openedAt = typeof runtimeBefore.opened_at === 'string' ? runtimeBefore.opened_at : undefined;
  // Cost aggregation keeps its prior positive-window requirement. Preserve a raw zero or
  // inverted bound for honest duration reporting, but let cost resolution end at `now`.
  const rawClosedAt = typeof runtimeBefore.closed_at === 'string' ? runtimeBefore.closed_at : undefined;
  const costClosedAt = rawClosedAt && Date.parse(rawClosedAt) > Date.parse(openedAt ?? '') ? rawClosedAt : undefined;
  const { content: reportContent, cost: reportCost, mergedPayloadFields, blockersCarryForward } = buildReport({
    sessionId, mode, now, payload, shell, stateDir, config,
    openedAt, durationClosedAt: rawClosedAt, costClosedAt,
    recoveryBlockers: opts.recoveryBlockers,
  });

  const reportPath = path.join(sessionsDir, `${sessionId}-REPORT.md`);
  try {
    writeFileAtomic(reportPath, reportContent);
  } catch (e: any) {
    return { ok: false, reason: 'report-write-error: ' + e.message };
  }

  const advanceTransition = updateRuntime(runtimePath, now, { transition: 'cleaning' });
  if (!advanceTransition.ok) return { ok: false, reason: advanceTransition.reason };

  let newShell: string;
  if (mode === 'idle') {
    newShell = idleReset(shell, sessionId, now, payload, resolveCompactConfig(config), reportCost);
  } else {
    newShell = closeReset(path.join(stateDir, 'templates', 'SHELL.md.template'), blockersCarryForward);
  }
  try {
    writeFileAtomic(path.join(sessionsDir, 'SHELL.md'), newShell);
  } catch (e: any) {
    return { ok: false, reason: 'shell-write-error: ' + e.message };
  }

  // advanceTransition already read+merged the full runtime, so reuse its in-memory
  // value for shutdown_requested_at instead of re-reading runtime.json from disk.
  const finalUpdates = closeFinalUpdates(mode, sessionsDir, advanceTransition.value?.shutdown_requested_at, now);
  const clearTransition = updateRuntime(runtimePath, now, finalUpdates);
  if (!clearTransition.ok) return { ok: false, reason: clearTransition.reason };

  const markers = applyPostArchiveMarkers(stateDir, mode, now, !!opts.skipMarkerWrites);
  const result: Json = { ok: true, archived: true, session_id: sessionId, report_path: reportPath, mode, markers };
  if (opts.includeMergedPayloadFields !== false) result.merged_payload_fields = mergedPayloadFields;
  return result;
}

// ---------------------------------------------------------------------------
// Verb: open
// ---------------------------------------------------------------------------

function verbOpen(flags: Record<string, string | true>, stdin: string): Json {
  const { stateDir, sessionsDir, runtimePath, now } = resolveRunContext(flags);
  const shellPath = path.join(sessionsDir, 'SHELL.md');

  const payload = parsePayload(stdin);
  const task = payload['Task'] || '';

  const runtimeBefore = readRuntimeValueOrEmpty(runtimePath);
  const sessionId = resolveSessionId(runtimeBefore, sessionsDir);

  let shell = readFileSafe(shellPath);
  if (shell === null) {
    const templatePath = path.join(stateDir, 'templates', 'SHELL.md.template');
    try { shell = fs.readFileSync(templatePath, 'utf-8'); }
    catch {
      return { ok: false, reason: 'shell-template-missing' };
    }
    shell = shell.replace('YYYY-MM-DD HH:MM', localISOStamp(now).slice(0, 16).replace('T', ' '));
  }

  shell = shell.replace(/\*\*ID:\*\*\s*S-NNN \(assigned on close\)/, `**ID:** ${sessionId}`);
  if (task) {
    shell = replaceSectionInPlace(shell, 'Task', '\n' + task + '\n\n');
  }

  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    writeFileAtomic(shellPath, shell);
  } catch (e: any) {
    return { ok: false, reason: 'shell-write-error: ' + e.message };
  }

  // Start this session's cost arc here rather than waiting for cost-tracker's first
  // in_progress turn. Without it, runtime still carries the PREVIOUS arc's
  // [opened_at, closed_at]; a session archived before that first turn lands
  // (auto-close, an immediate idle, recover's re-archive) would measure the previous
  // session's window and stamp its cost onto this report. cost-tracker's arc logic is
  // unaffected: closed_at is null so no new arc is forced, and a transcript change
  // still re-stamps opened_at to the first turn (no cost accrues before it).
  const update = updateRuntime(runtimePath, now, {
    session_state: 'in_progress', session_id: sessionId,
    opened_at: localISOStamp(now), closed_at: null,
  });
  if (!update.ok) return { ok: false, reason: update.reason };

  return { ok: true, session_id: sessionId };
}

// ---------------------------------------------------------------------------
// Verb: recover — the deterministic branch table for interrupted transitions.
// ---------------------------------------------------------------------------

function verbRecover(flags: Record<string, string | true>): Json {
  const { stateDir, sessionsDir, runtimePath, now } = resolveRunContext(flags);

  const r = readRuntime(runtimePath);
  if (r.kind === 'ioerror') return { ok: false, reason: `runtime-ioerror${r.code ? ':' + r.code : ''}` };
  if (r.kind === 'corrupt') { quarantineRuntime(runtimePath, now.getTime()); return { ok: true, recovered: false, reason: 'runtime-corrupt-quarantined' }; }
  const runtime = r.kind === 'ok' ? r.value : {};

  const transition = runtime.transition;
  if (!transition) return { ok: true, recovered: false, reason: 'no-interrupted-transition' };

  let mode: 'idle' | 'close' | 'auto' = 'close';
  let legacyNote: string | null = null;
  if (runtime.transition_mode === 'idle' || runtime.transition_mode === 'close' || runtime.transition_mode === 'auto') {
    mode = runtime.transition_mode;
  } else {
    legacyNote = 'Recovered via legacy transition marker (pre-upgrade); treated as full close.';
  }

  const sessionId = runtime.session_id || resolveSessionId(runtime, sessionsDir);
  const targetName = runtime.transition_target || `${sessionId}-REPORT.md`;
  const targetPath = path.join(sessionsDir, targetName);
  const targetExists = fs.existsSync(targetPath);

  if (transition === 'archiving' && !targetExists) {
    // Re-run archive with a degraded synthetic payload — the original close
    // payload lived only in main's context and was lost on crash.
    const blockers = [
      'Recovered from interrupted archiving transition — pre-crash close payload was not persisted; status inferred as partial.',
      ...(legacyNote ? [legacyNote] : []),
    ].join('\n');
    const syntheticPayload = `Status: partial\nClosed Via: recovered\n`;
    const result = verbArchive(
      { mode, 'state-dir': stateDir },
      syntheticPayload,
      { skipMarkerWrites: true, recoveryBlockers: blockers, includeMergedPayloadFields: false },
    );
    if (!result.ok) {
      // Re-archive couldn't complete (e.g. SHELL.md itself is gone, so buildReport
      // has nothing to work from). Clear the transition markers so the next start
      // doesn't re-enter this same branch and fail identically, pinning the session
      // in recovery forever — mirroring the null-shell handling further below.
      updateRuntime(runtimePath, now, {
        transition: null, transition_target: null, transition_started_at: null, transition_mode: null,
        session_state: 'idle',
      });
      return { ok: false, recovered: false, reason: result.reason, recovery_path: 're-archive-failed' };
    }
    return { ...result, recovered: true, recovery_path: 're-archive' };
  }

  // Either the report already exists (archiving completed, crash happened
  // before SHELL cleanup) or the transition had already advanced to
  // "cleaning" — either way, skip straight to the SHELL.md reset for the
  // resolved mode and clear the markers.
  let shell = readFileSafe(path.join(sessionsDir, 'SHELL.md'));
  if (shell === null) {
    const clear = updateRuntime(runtimePath, now, {
      transition: null, transition_target: null, transition_started_at: null, transition_mode: null,
      session_state: 'idle',
    });
    if (!clear.ok) return { ok: false, reason: clear.reason };
    const markers = applyPostArchiveMarkers(stateDir, mode, now, /* suppressWrites */ true);
    return { ok: true, recovered: true, recovery_path: 'markers-cleared-no-shell', legacy: !!legacyNote, markers };
  }

  const config = readConfig(stateDir);
  // Idempotency guard: an idle transition that crashed AFTER the SHELL reset but
  // before the marker-clear leaves transition='cleaning' with SHELL already reset.
  // Re-running idleReset would double-count Tasks Completed and append a duplicate
  // Session Summary line, so skip it when this session's summary line is already
  // present. (An `archiving`+target-exists crash lands here too, but with SHELL not
  // yet reset — no summary line — so the guard correctly lets idleReset run then.)
  const idleAlreadyReset = mode === 'idle' && shell.includes(`**${sessionId}**`);
  let newShell: string;
  if (mode === 'idle') {
    newShell = idleAlreadyReset
      ? shell
      : idleReset(shell, sessionId, now, {}, resolveCompactConfig(config), recoveredReportCost(targetPath));
  } else {
    newShell = closeReset(path.join(stateDir, 'templates', 'SHELL.md.template'), extractSection(shell, 'Blockers') ?? '');
  }
  try {
    writeFileAtomic(path.join(sessionsDir, 'SHELL.md'), newShell);
  } catch (e: any) {
    return { ok: false, reason: 'shell-write-error: ' + e.message };
  }

  const finalUpdates = closeFinalUpdates(mode, sessionsDir, runtime.shutdown_requested_at, now);
  const clear = updateRuntime(runtimePath, now, finalUpdates);
  if (!clear.ok) return { ok: false, reason: clear.reason };

  const markers = applyPostArchiveMarkers(stateDir, mode, now, /* suppressWrites */ true);
  return { ok: true, recovered: true, recovery_path: 'shell-reset', mode_used: mode, legacy: !!legacyNote, markers };
}

// ---------------------------------------------------------------------------
// Verb: auto-close-decision — the daily-auto-close midnight branch table
// (session-close/SKILL.md --scheduled path). Reads lifecycle state and the
// operator-action clock, mutates pending-close.json itself, and returns the
// decision; the model only executes a close-now via the --auto archive path.
// A corrupt/unreadable runtime maps to noop, not close-now: the prose
// fail-open rule covers only the last-operator-action clock, and closing a
// session whose state is unknowable would be fail-destructive. That noop is
// also non-destructive — it leaves pending-close.json alone, since a queued
// flag is only provably stale once we know there is no session worth closing
// (a read `session_state` outside {in_progress, idle}, or no runtime.json at
// all). No quarantine here — recover owns quarantine.
// ---------------------------------------------------------------------------

function verbAutoCloseDecision(flags: Record<string, string | true>): Json {
  const { stateDir, runtimePath, now } = resolveRunContext(flags);
  const pendingPath = path.join(stateDir, 'state', 'pending-close.json');

  const r = readRuntime(runtimePath);
  if (r.kind === 'corrupt' || r.kind === 'ioerror') {
    // Unknown state: noop WITHOUT touching pending-close.json. `ioerror` is a
    // healthy file we transiently could not read (lib/alert-state.ts marks it
    // do-not-destroy), and a corrupt runtime may still front a live session —
    // deleting the flag either way strands it until the next midnight.
    return { ok: true, decision: 'noop', reason: `runtime unreadable (${r.kind})` };
  }
  // `missing` falls through: no runtime.json means no session, so any flag is stale.
  // Both noop exits below reap a stale pending-close flag the same way, differing
  // only in the reason string, so share the reap+format instead of repeating it.
  // `resting` marks the one noop that means "the hermit is at rest, nothing was
  // interrupted" — the auto-close gate stamps the daily context-reset marker on
  // that branch only. Every other noop (a `waiting`/`unset` session, a missing or
  // unreadable runtime) leaves live context in place, so a `/clear` there would
  // wipe it with no archive behind it.
  const noop = (reason: string, resting = false): Json => {
    const reaped = reapPendingClose(stateDir) === 'deleted';
    return { ok: true, decision: 'noop', resting, reason: `${reason}${reaped ? '; stale pending-close deleted' : ''}` };
  };
  const sessionState = r.kind === 'ok' ? (r.value?.session_state ?? 'unset') : r.kind;
  if (sessionState !== 'in_progress' && sessionState !== 'idle') {
    // Nothing to close; a leftover flag from a prior session is stale — reap it.
    return noop(`session_state=${sessionState}`);
  }
  const sessionId = r.kind === 'ok' ? (r.value?.session_id ?? null) : null;
  if (sessionState === 'idle' && sessionId == null) {
    // Distinguish "resting, nothing to close" from "in_progress, needs archiving".
    // closeFinalUpdates() (below) nulls session_id only on a real close and stamps a
    // fresh one on the idle-archive rollover path — so idle + null id is the terminal
    // rest state, not a session worth an empty nightly archive.
    return noop('idle, no active session', true);
  }

  let lastAction: Json = null;
  try { lastAction = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'last-operator-action.json'), 'utf-8')); } catch {}
  const atMs = lastAction && typeof lastAction.at === 'string' ? new Date(lastAction.at).getTime() : NaN;
  if (isNaN(atMs)) {
    // Fail-open per the --scheduled prose: no valid operator clock → idle indefinitely.
    return { ok: true, decision: 'close-now', reason: 'last-operator-action missing/invalid' };
  }
  if (atMs > now.getTime()) {
    // Clock skew: a future stamp yields a negative lull that can never exceed the
    // threshold, which would pin this verb to `queued` every midnight while the
    // heartbeat drain (same comparison) never fires. Treat it as an invalid clock
    // and take the same fail-open branch, with a reason that names the anomaly.
    return { ok: true, decision: 'close-now', reason: 'last-operator-action is in the future (clock skew)' };
  }

  const lullMin = (now.getTime() - atMs) / 60_000;
  if (lullMin > AUTO_CLOSE_LULL_MINUTES) {
    return { ok: true, decision: 'close-now', reason: `lull ${Math.round(lullMin)}min` };
  }

  try {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    writeFileAtomic(pendingPath, JSON.stringify({ queued_at: localISOStamp(now), queued_by: 'daily-auto-close' }, null, 2) + '\n');
  } catch (e: any) {
    return { ok: false, reason: 'pending-close-write-error: ' + e.message };
  }
  return { ok: true, decision: 'queued', reason: `operator active ${Math.round(lullMin)}min ago` };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function emit(obj: Json): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(0);
}

function main(): void {
  const { verb, flags } = parseArgs(process.argv);
  const stdin = verb === 'archive' || verb === 'open' ? readStdinSync() : '';

  if (verb === 'archive') return emit(verbArchive(flags, stdin));
  if (verb === 'open') return emit(verbOpen(flags, stdin));
  if (verb === 'recover') return emit(verbRecover(flags));
  if (verb === 'auto-close-decision') return emit(verbAutoCloseDecision(flags));

  return emit({ ok: false, reason: `unknown verb: ${verb || '(none)'}. Valid verbs: archive, open, recover, auto-close-decision` });
}

if (import.meta.main) {
  try {
    main();
  } catch (e: any) {
    emit({ ok: false, reason: 'error: ' + e.message });
  }
}

export { parsePayload, normalizeStatus, resolveCost, extractProposalIds, compactSection, nextSessionId, readRuntime, updateRuntime };
