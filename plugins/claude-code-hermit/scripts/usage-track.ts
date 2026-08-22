import { hermitDir } from './lib/cc-compat';
import { appendUsageEvent } from './lib/usage-ledger';

type Json = any;

/**
 * PostToolUse hook — appends a usage event to state/usage-metrics.jsonl when a
 * skill is invoked via the Skill tool or a compiled/ artifact is read.
 *
 * Feeds weekly-review's "no tracked use" section, which auto-archives on this
 * evidence. Subagent reads ARE captured: PostToolUse fires for sidechain tool
 * calls, with the parent session_id in the payload (probed on CC 2.1.239).
 * Coverage gaps that remain: startup-context injection, user-typed slash
 * commands (which bypass the Skill tool entirely — see
 * scripts/record-operator-action.ts for that capture path), and Reads whose
 * PostToolUse payload (tool_response carries the full file body) exceeds
 * MAX_STDIN.
 *
 * Fails open on every error path — never blocks Claude Code. Zero stdout.
 */

// tool_response carries the full file body, so a tight cap drops exactly the
// reads the ledger exists to record — a large doc looked permanently unused.
const MAX_STDIN = 1024 * 1024;
const COMPILED_RE = /(?:^|\/)\.claude-code-hermit\/compiled\/([^/]+)\.md$/;

function readEvent(callback: (event: Json) => void): void {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    raw += chunk;
    if (raw.length > MAX_STDIN) process.exit(0);
  });
  process.stdin.on('end', () => {
    try {
      callback(JSON.parse(raw));
    } catch (_e) {
      process.exit(0);
    }
  });
  process.stdin.on('error', () => process.exit(0));
}

function main() {
  readEvent(event => {
    const name = event && event.tool_name;
    const input = (event && event.tool_input) || {};

    let usageEvent: Json | null = null;

    if (name === 'Skill') {
      const skill = input.skill;
      if (typeof skill === 'string' && skill) {
        usageEvent = { ts: new Date().toISOString(), kind: 'skill', name: skill, source: 'skill-tool' };
      }
    } else if (name === 'Read') {
      const filePath = input.file_path || '';
      const m = typeof filePath === 'string' ? filePath.match(COMPILED_RE) : null;
      if (m) {
        usageEvent = { ts: new Date().toISOString(), kind: 'compiled', name: m[1], source: 'read' };
      }
    }

    if (!usageEvent) process.exit(0);

    try {
      appendUsageEvent(hermitDir(), usageEvent);
    } catch (_e) {
      // fail open
    }
    process.exit(0);
  });
}

main();
