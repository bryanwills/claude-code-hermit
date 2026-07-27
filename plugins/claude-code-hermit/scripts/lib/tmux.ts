/**
 * Shared tmux helpers for the lifecycle scripts
 * (hermit-start, hermit-stop, hermit-watchdog), the harness-command drain, and
 * `channel-pair.ts`, which drives the REPL inside the hermit container.
 *
 * Two transports, one implementation. `docker` prefixes the same tmux argv with
 * `docker compose … exec -T <service>`; nothing else differs, because tmux
 * send-keys talks to the tmux server socket rather than the exec's TTY, so
 * `-T` (no TTY allocation) is irrelevant to delivery. Every call builds an argv
 * array — never a shell string — so a session name or message body can't be
 * read as shell syntax.
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';

type Json = any;

export type Transport =
  | { kind: 'host' }
  | { kind: 'docker'; composeFile: string; service: string };

export const HOST: Transport = { kind: 'host' };

/** Build the full argv for a tmux invocation under the given transport. */
export function tmuxArgv(transport: Transport, args: string[]): { cmd: string; argv: string[] } {
  if (transport.kind === 'host') return { cmd: 'tmux', argv: args };
  return {
    cmd: 'docker',
    argv: ['compose', '-f', transport.composeFile, 'exec', '-T', transport.service, 'tmux', ...args],
  };
}

function runTmux(transport: Transport, args: string[]): { status: number | null; error: unknown } {
  const { cmd, argv } = tmuxArgv(transport, args);
  const r = spawnSync(cmd, argv, { stdio: 'ignore' });
  return { status: r.status, error: r.error };
}

/** Return true when the named tmux session exists. */
export function tmuxSessionAlive(name: string, transport: Transport = HOST): boolean {
  return runTmux(transport, ['has-session', '-t', name]).status === 0;
}

/** Capture the visible pane as text, or null when tmux cannot read it. */
export function capturePane(name: string, transport: Transport = HOST): string | null {
  if (!name) return null;
  const { cmd, argv } = tmuxArgv(transport, ['capture-pane', '-p', '-t', name]);
  try {
    const r = spawnSync(cmd, argv, { encoding: 'utf-8', timeout: 5000 });
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout;
  } catch {
    return null;
  }
}

/**
 * Return a bounded pane window only when its required footer is the final
 * nonblank row.
 *
 * tmux preserves unused blank renderer rows below short dialogs. Ignoring those
 * rows is safe only when the dialog footer still terminates the visible content;
 * otherwise a matching dialog may be stale scrollback above a newer prompt.
 */
export function anchoredPaneTail(
  paneContent: string,
  maxLines: number,
  terminalAnchor: string,
): string | null {
  if (maxLines < 1 || !terminalAnchor) return null;

  const lines = paneContent.split('\n');
  let lastContentLine = lines.length - 1;
  while (lastContentLine >= 0 && lines[lastContentLine].trim() === '') {
    lastContentLine--;
  }
  if (lastContentLine < 0 || !lines[lastContentLine].includes(terminalAnchor)) {
    return null;
  }

  const firstLine = Math.max(0, lastContentLine - maxLines + 1);
  return lines.slice(firstLine, lastContentLine + 1).join('\n');
}

/** Send a single Enter key, returning whether tmux accepted it. */
export function sendEnter(sessionName: string, transport: Transport = HOST): boolean {
  if (!sessionName) return false;
  const submitted = runTmux(transport, ['send-keys', '-t', sessionName, 'Enter']);
  return !submitted.error && submitted.status === 0;
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
 * punctuation — existing callers send prose (the watchdog's `/compact` steering
 * messages, and localized operator-facing restart/wedge/pause text: commas, hyphens,
 * accents, no control chars) and an allow-list would silently break them. Callers
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
export function sendKeys(sessionName: string, text: string, transport: Transport = HOST): boolean {
  if (!sessionName || !text || hasControlChars(text)) return false;
  const typed = runTmux(transport, ['send-keys', '-t', sessionName, '-l', '--', text]);
  if (typed.error || typed.status !== 0) return false;
  Bun.sleepSync(500);
  return sendEnter(sessionName, transport);
}
