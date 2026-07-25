/**
 * Shared tmux helpers for the lifecycle scripts
 * (hermit-start, hermit-stop, hermit-watchdog) and the harness-command drain.
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';

type Json = any;

/** Return true when the named tmux session exists. */
export function tmuxSessionAlive(name: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }).status === 0;
}

/** Derive the tmux session name from config (CWD-relative project name). */
export function getSessionName(config: Json): string {
  const name = config.tmux_session_name ?? 'hermit-{project_name}';
  return String(name).replaceAll('{project_name}', path.basename(process.cwd()));
}

/**
 * True when the string contains a C0/C7F control character.
 *
 * Last-resort barrier before text reaches a pane. A newline is the dangerous one:
 * send-keys would submit early and the remainder would land as its own prompt.
 * Deliberately a deny-list of control characters rather than an allow-list of
 * punctuation — existing callers send prose /compact steering messages (commas and
 * hyphens, no control chars) and an allow-list would silently break them. Callers
 * handling UNTRUSTED input apply their own strict grammar on top (see
 * lib/prompt-stages/harness-command.ts).
 */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Send text then Enter as two separate calls, returning whether tmux accepted both.
 *
 * The split with a pause between is a workaround for Claude Code's TUI treating
 * text+Enter in one burst as a bracketed paste, which turns Enter into a literal
 * newline instead of a submit (same fix as bin/hermit-docker).
 *
 * The boolean means "tmux accepted the keystrokes", NOT "Claude Code applied the
 * command" — nothing here can observe whether the harness accepted or rejected it.
 * Callers keeping retry state must read false as "not delivered" and true as
 * "delivered, outcome unknown".
 */
export function sendKeys(sessionName: string, text: string): boolean {
  if (!sessionName || !text || hasControlChars(text)) return false;
  const typed = spawnSync('tmux', ['send-keys', '-t', sessionName, '-l', '--', text], { stdio: 'ignore' });
  if (typed.error || typed.status !== 0) return false;
  Bun.sleepSync(500);
  const submitted = spawnSync('tmux', ['send-keys', '-t', sessionName, 'Enter'], { stdio: 'ignore' });
  return !submitted.error && submitted.status === 0;
}
