// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code)
// Original: scripts/hooks/evaluate-session.js — MIT License
// Changes: Replaced ECC quality criteria with session-specific criteria
//          (task status, SHELL.md current, blockers documented, next-start-point clear).
//          Outputs structured quality score for session reports.
//          Plan tracking criterion reads Progress Log granularity from SHELL.md.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hermitDir } from './lib/cc-compat';
import { currentHHMM, elapsedSinceHHMM, resolveHermitNowMs } from './lib/time';
import { readSettledConfig } from './lib/config-read';
import { extractSection, stripPlaceholders } from './lib/md-write';

type Json = any;

const now = resolveHermitNowMs();
const HERMIT_DIR = hermitDir();
const SHELL_SESSION = path.join(HERMIT_DIR, 'sessions', 'SHELL.md');
const HASH_FILE = path.join(HERMIT_DIR, 'sessions', '.eval-hash');
const RUNTIME_JSON = path.join(HERMIT_DIR, 'state', 'runtime.json');

// Progress Log [HH:MM] stamps in append order. Single parser shared by the plan-tracking
// criterion and the staleness nudge in _evaluate.
function progressStamps(content: Json): string[] {
  const text = (extractSection(content, 'Progress Log') ?? '').trim();
  return (text.match(/\[(\d{1,2}:\d{2})\]/g) ?? []).map(s => s.replace(/[\[\]]/g, ''));
}

function evaluateSession(content: Json): Json {
  const results: Json = {
    criteria: [],
    overall: 'pass',
  };

  if (content === null) {
    results.criteria.push({
      name: 'SHELL.md exists',
      status: 'fail',
      detail: 'No sessions/SHELL.md found',
    });
    results.overall = 'fail';
    return results;
  }

  // Criterion 1: Session state is valid (reads runtime.json — authoritative lifecycle source)
  let sessionState: string | null = null;
  try {
    const rt = JSON.parse(fs.readFileSync(RUNTIME_JSON, 'utf-8'));
    sessionState = rt.session_state || null;
  } catch {}
  const hasState = sessionState && /^(in_progress|waiting|idle|dead_process)$/.test(sessionState);
  results.criteria.push({
    name: 'Session state valid',
    status: hasState ? 'pass' : 'warn',
    detail: hasState ? `session_state: ${sessionState}` : 'runtime.json session_state missing or invalid',
  });
  results.status = sessionState;

  // Criterion 2: Plan tracked. The native task store was withdrawn on newer models, so
  // decomposition is only observable as Progress Log granularity.
  // Count entries, not distinct clock values — two steps landing in the same minute
  // are still two steps, and deduping them would warn on a correctly tracked session.
  const stamped = progressStamps(content).length;
  const hasSteps = stamped >= 2;
  const stampLabel = `${stamped} timestamped Progress Log ${stamped === 1 ? 'entry' : 'entries'}`;
  results.criteria.push({
    name: 'Plan tracked',
    status: hasSteps ? 'pass' : 'warn',
    detail: hasSteps ? stampLabel : `${stampLabel} (OK for quick single-step work)`,
  });

  // Helper: check if a markdown section exists and has non-comment content
  function checkSection(sectionName: string): { exists: boolean; hasContent: Json } {
    const section = extractSection(content, sectionName);
    // stripPlaceholders, not startsWith('<!--') — see its doc comment in md-write.ts.
    return { exists: section !== null, hasContent: stripPlaceholders(section ?? '').length > 0 };
  }

  // Criterion 3: Blockers section
  const blockers = checkSection('Blockers');
  results.criteria.push({
    name: 'Blockers documented',
    status: blockers.exists ? 'pass' : 'warn',
    detail: blockers.exists
      ? blockers.hasContent
        ? 'Blockers section has content'
        : 'Blockers section exists (no blockers reported)'
      : 'No Blockers section found',
  });

  // Criterion 4: Progress log has entries
  const progress = checkSection('Progress Log');
  results.criteria.push({
    name: 'Progress logged',
    status: progress.hasContent ? 'pass' : 'warn',
    detail: progress.hasContent ? 'Progress log has entries' : 'Progress log is empty',
  });

  // Criterion 5: Changed files listed (for closed sessions)
  const changed = checkSection('Changed');
  results.criteria.push({
    name: 'Changed files listed',
    status: changed.hasContent ? 'pass' : 'info',
    detail: changed.hasContent ? 'Changed files are documented' : 'No changed files listed (may be in progress)',
  });

  // Determine overall score
  const failCount = results.criteria.filter((c: Json) => c.status === 'fail').length;
  const warnCount = results.criteria.filter((c: Json) => c.status === 'warn').length;

  if (failCount > 0) {
    results.overall = 'fail';
  } else if (warnCount >= 3) {
    results.overall = 'warn';
  } else {
    results.overall = 'pass';
  }

  return results;
}

// Core evaluation logic extracted for use by both run() and standalone main().
async function _evaluate(): Promise<string | null> {
  // Profile gating — run on "standard" and "strict" only
  const profile = (process.env.AGENT_HOOK_PROFILE || 'standard').trim().toLowerCase();
  if (profile === 'minimal') {
    return null;
  }

  // Read SHELL.md once — used for hash check and passed to evaluateSession
  let content: string | null;
  try {
    content = fs.readFileSync(SHELL_SESSION, 'utf-8');
  } catch {
    content = null;
  }

  const hash = content !== null
    ? crypto.createHash('md5').update(content).digest('hex')
    : null;

  // Short-circuit if SHELL.md hasn't changed since last eval
  if (hash !== null) {
    try {
      const cached = fs.readFileSync(HASH_FILE, 'utf-8').trim();
      if (cached === hash) {
        return null;
      }
    } catch {
      // No cache file — first run, continue to eval
    }
  }

  const results = evaluateSession(content);

  // Write hash after successful eval
  if (hash !== null) {
    try { fs.writeFileSync(HASH_FILE, hash + '\n'); } catch {}
  }

  // Active nudges — output to stderr so they surface as hook feedback
  if (content !== null) {
    const status = results.status || 'unknown';

    // Only nudge during in_progress — not waiting (intentionally paused) or idle
    if (status === 'in_progress') {
      // >24h elapsed is unknowable from date-less stamps — use SHELL.md mtime for
      // the "may be complete" nudge (nothing, not even Monitoring appends, wrote for 48h).
      let sessionMayBeComplete = false;
      try { sessionMayBeComplete = (now - fs.statSync(SHELL_SESSION).mtime.getTime()) / 3600000 > 48; }
      catch { /* fail-open */ }

      if (sessionMayBeComplete) {
        console.error('Session may be complete. Consider /session-close or idle transition.');
      } else {
        // Progress Log timestamps are date-less [HH:MM]. Use the bottom-most entry
        // (append-ordered) and resolve it as its most recent past occurrence, so a
        // session spanning midnight doesn't backdate today's entries.
        const timeEntries = progressStamps(content);
        if (timeEntries.length > 0) {
          const lastTime = timeEntries[timeEntries.length - 1];
          const nowDate = new Date(now);
          // config.timezone is the zone Progress Log [HH:MM] stamps are written in.
          const nowHHMM = currentHHMM(readSettledConfig(HERMIT_DIR).timezone ?? 'UTC', nowDate) ?? nowDate.toISOString().slice(11, 16);
          const hoursAgo = elapsedSinceHHMM(nowHHMM, lastTime) / 3600000;
          if (hoursAgo > 4) {
            console.error(`No progress logged in ${Math.round(hoursAgo)}h. Update Progress Log or Blockers.`);
          }
        }
      }
    }

    // Monitoring bloat check (any status)
    const monitoringSection = extractSection(content, 'Monitoring');
    if (monitoringSection !== null) {
      const monitoringLines = (monitoringSection.match(/\n/g) || []).length;
      if (monitoringLines > 40) {
        console.error('Monitoring section too large. Alert dedup should prevent this — check if dedup is working.');
      }
    }
  }

  // Human-readable summary to stderr
  const icon: Record<string, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', info: 'INFO' };
  console.error(`\n[session-eval] Overall: ${icon[results.overall]}`);
  for (const c of results.criteria) {
    console.error(`  [${icon[c.status]}] ${c.name}: ${c.detail}`);
  }

  return JSON.stringify(results, null, 2);
}

// Exported run() function for use by stop-pipeline.ts.
// Returns the JSON results string, or null if skipped/cached.
// process.exit() calls become returns so the pipeline is not killed.
async function run(_payload: Json): Promise<string | null> {
  try {
    return await _evaluate();
  } catch (err: any) {
    console.error(`[session-eval] Error: ${err.message}`);
    return null;
  }
}

export { run };

if (import.meta.main) {
  (async () => {
    try {
      // Profile gating — run on "standard" and "strict" only
      const profile = (process.env.AGENT_HOOK_PROFILE || 'standard').trim().toLowerCase();
      if (profile === 'minimal') {
        process.exit(0);
      }

      // Consume stdin to avoid broken pipe (content not used for evaluation)
      let totalSize = 0;
      for await (const chunk of process.stdin) {
        totalSize += chunk.length;
        if (totalSize > 1024 * 1024) break;
      }

      const result = await _evaluate();
      if (result) console.log(result);
    } catch (err: any) {
      console.error(`[session-eval] Error: ${err.message}`);
      process.exit(0);
    }
  })();
}
