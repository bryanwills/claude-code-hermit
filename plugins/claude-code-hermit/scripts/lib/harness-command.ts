// Pending harness-command marker — written by the UserPromptSubmit hook
// (lib/prompt-stages/harness-command.ts), consumed by the Stop hook (stop-pipeline.ts).
//
// Singleton by design, matching the existing marker files in state/. Two commands
// arriving inside one turn therefore collapse to the last one; that is accepted rather
// than queued, because an operator sending two harness commands back to back almost
// always means the second one.

import fs from 'node:fs';
import path from 'node:path';

// Args are NOT validated against a fixed value list: Claude Code rejects an unknown
// model or effort level itself, and any list hard-coded here would go stale on the next
// model release (Fable already breaks the repo's VALID_ROUTINE_MODEL). What IS enforced
// is shape — no whitespace, no control characters, bounded length — because the arg is
// typed into a live pane and a newline would submit early, turning the remainder into
// its own prompt. Brackets are allowed: `opus[1m]` is a valid alias.
const ARG_RE = /^[A-Za-z0-9._[\]-]{1,64}$/;

/** Commands taking no argument. */
const BARE_COMMANDS = new Set(['/compact', '/clear']);
/** Commands requiring exactly one argument. */
const ARG_COMMANDS = new Set(['/model', '/effort']);

export type ParsedCommand = { command: string; arg: string | null };

/**
 * Strict slash grammar, exact whole-body match.
 *
 * Deliberately does NOT accept a bare `compact`/`clear`, and does not strip a Telegram
 * group's `@botname` suffix — an operator decision: the slash makes the intent explicit.
 * Consequence, accepted: in a group chat where the client rewrites `/clear` to
 * `/clear@thebot`, the command silently no-ops.
 */
export function parseHarnessCommand(body: string): ParsedCommand | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.split(' ');
  const command = parts[0].toLowerCase();

  if (BARE_COMMANDS.has(command)) {
    return parts.length === 1 ? { command, arg: null } : null;
  }
  if (ARG_COMMANDS.has(command)) {
    if (parts.length !== 2) return null;
    const arg = parts[1];
    return ARG_RE.test(arg) ? { command, arg } : null;
  }
  return null;
}

export type PendingCommand = {
  command: string;
  arg: string | null;
  by: string;
  requested_at: string;
};

/**
 * A marker older than this is dropped unconsumed. Mirrors COMPACT_MARKER_TTL_SECS in
 * hermit-watchdog.ts: a request is a moment, not a standing order, and a hermit that was
 * wedged for an hour should not suddenly clear its context when it recovers.
 */
export const COMMAND_MARKER_TTL_SECS = 3600;
/** One render beat after submitting a confirmable harness switch before inspecting the pane. */
export const HARNESS_CONFIRM_RENDER_MS = 500;
const HARNESS_CONFIRM_TAIL_LINES = 20;

const SWITCH_CONFIRMATION_ANCHORS: Record<string, readonly string[]> = {
  '/model': [
    'Switch model?',
    'This conversation is cached for the current model.',
  ],
  '/effort': [
    'Change effort level?',
    'This conversation is cached for the current effort level.',
  ],
};

/**
 * Match only Claude Code's cached-context confirmation for the delivered switch.
 *
 * Whitespace is collapsed because the warning wraps according to pane width. The
 * target label is deliberately not matched: a stable model alias such as `opus`
 * renders as a release display name such as "Opus 5", and effort levels may expand.
 */
export function isHarnessSwitchConfirmation(command: string, paneContent: string): boolean {
  const commandAnchors = SWITCH_CONFIRMATION_ANCHORS[command];
  if (!commandAnchors) return false;

  const tail = paneContent
    .split('\n')
    .slice(-HARNESS_CONFIRM_TAIL_LINES)
    .join(' ')
    .replace(/\s+/g, ' ');

  return commandAnchors.every((anchor) => tail.includes(anchor))
    && tail.includes('Your next response will be slower and use more tokens')
    && tail.includes('Yes, switch to')
    && tail.includes('No, go back');
}

function markerPath(hermitRoot: string): string {
  return path.join(hermitRoot, 'state', 'pending-harness-command.json');
}

/** Atomic tmp+rename write. Returns false on any failure — callers must not ack a failed write. */
export function writePendingCommand(hermitRoot: string, entry: PendingCommand): boolean {
  const target = markerPath(hermitRoot);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

/** Read the marker, or null when absent, malformed, or past its TTL. */
export function readPendingCommand(hermitRoot: string): PendingCommand | null {
  try {
    const raw = fs.readFileSync(markerPath(hermitRoot), 'utf-8');
    const parsed = JSON.parse(raw) as PendingCommand;
    if (!parsed || typeof parsed.command !== 'string') return null;

    const ts = Date.parse(parsed.requested_at);
    if (Number.isNaN(ts)) return null;
    if ((Date.now() - ts) / 1000 > COMMAND_MARKER_TTL_SECS) return null;

    return parsed;
  } catch {
    return null;
  }
}

/** Delete the marker. Call ONLY after a confirmed send — a failed send must leave it. */
export function clearPendingCommand(hermitRoot: string): void {
  try { fs.unlinkSync(markerPath(hermitRoot)); } catch {}
}

/** Render a marker back to the literal text typed into the pane. */
export function renderCommand(entry: { command: string; arg: string | null }): string {
  return entry.arg ? `${entry.command} ${entry.arg}` : entry.command;
}
