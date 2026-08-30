/**
 * Claude Code's own session registry, read as a liveness oracle.
 *
 * Every session writes `<config dir>/sessions/<pid>.json` describing itself, and
 * rewrites `status` as it moves between states. Probed live: `busy` = a model
 * turn is running, `shell` = a Bash tool is executing (a backgrounded one too),
 * `waiting` = the session is blocked on a permission dialog, `idle` ~3s after a
 * turn ends. The file is deleted on a clean exit and survives only an unclean
 * kill.
 *
 * `statusUpdatedAt` moves ONLY on a transition — a 95s turn keeps its
 * turn-start stamp — so it dates the CURRENT state, never the last sign of
 * life. That is what it is used for here (how long the session has been idle
 * since a wake was posted), and it is why it cannot stand in for a heartbeat.
 *
 * The format is undocumented: the cross-session-messaging docs describe the
 * socket but never this file. So every consumer must degrade to its existing
 * behavior when a read returns null, and none may depend on a field being
 * present. Validation is deliberately strict for the same reason — a stale
 * entry at a reused pid is the failure mode this exists to avoid, observed on
 * a live host (a 7h-old `shell` entry whose pid had been recycled).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfigDir } from './setup-token';
import { pidAlive } from './lockfile';
import { readRuntimeJson } from './runtime';

export type SessionStatus = 'idle' | 'busy' | 'shell' | 'waiting';

export interface SessionEntry {
  pid: number;
  kind: 'interactive' | 'bg';
  status: SessionStatus;
  /** ms epoch; stamps the START of `status`, not the last sign of life. */
  statusUpdatedAt: number;
  cwd: string;
  name: string;
  messagingSocketPath: string;
  procStart: string;
  pidDomain: string;
}

/** Field 22 of /proc/<pid>/stat — the kernel's process start time in clock
 *  ticks. The registry records it so an entry can be told apart from a
 *  different process that later inherited the same pid. Parsed from the last
 *  ')' because a process name can itself contain spaces and parentheses. */
function procStartOf(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/** This machine's pid domain, in the registry's own spelling, read off a live
 *  entry: `linux:<contents of /etc/machine-id>:<the /proc/self/ns/pid link
 *  target>`. Distinguishes a container's pid namespace from the host's when both
 *  share a config dir. Null on any platform that doesn't publish these.
 *
 *  The spelling can only be confirmed against a real registry file — a test that
 *  builds the fixture from this same function agrees with itself no matter what
 *  it computes, so a mismatch here reads as "no live sessions" and silently
 *  disables every consumer. */
function localPidDomain(): string | null {
  if (os.platform() !== 'linux') return null;
  try {
    const machineId = fs.readFileSync('/etc/machine-id', 'utf-8').trim();
    const ns = fs.readlinkSync('/proc/self/ns/pid');
    return `linux:${machineId}:${ns}`;
  } catch {
    return null;
  }
}

const STATUSES = new Set(['idle', 'busy', 'shell', 'waiting']);

function parseEntry(raw: string): SessionEntry | null {
  let e: any;
  try {
    e = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!e || typeof e !== 'object') return null;
  if (typeof e.pid !== 'number' || !Number.isInteger(e.pid) || e.pid <= 0) return null;
  if (typeof e.status !== 'string' || !STATUSES.has(e.status)) return null;
  if (typeof e.statusUpdatedAt !== 'number') return null;
  return e as SessionEntry;
}

/**
 * Validated live sessions from the registry.
 *
 * An entry survives only if it parses, its pid is alive, and — where the
 * platform publishes them — its `procStart` matches `/proc/<pid>/stat` and its
 * `pidDomain` matches ours. Both extra checks are SKIPPED, never failed, when
 * the source is unreadable: a macOS host has no `/proc`, and refusing every
 * entry there would silently disable the consumers instead of degrading them.
 *
 * Returns [] for an absent or unreadable registry dir — "nothing validated",
 * which every caller must read as "unknown", not "no sessions".
 */
export function readRegistry(configDir?: string): SessionEntry[] {
  const dir = path.join(configDir ?? defaultConfigDir(), 'sessions');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const domain = localPidDomain();
  const out: SessionEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // sibling <pid>.<sha>.key files
    let entry: SessionEntry | null;
    try {
      entry = parseEntry(fs.readFileSync(path.join(dir, name), 'utf-8'));
    } catch {
      continue;
    }
    if (!entry) continue;
    if (!pidAlive(entry.pid)) continue;
    const start = procStartOf(entry.pid);
    // Asymmetric with pidDomain below on purpose. An entry carrying no `procStart`
    // can't be told apart from a stale one at a reused pid, so it is dropped, not
    // skipped: if a future release stops writing the field the registry reads empty
    // and every consumer degrades, which is the safe direction. A missing pidDomain
    // only risks a cross-container collision, so that one skips.
    if (start !== null && entry.procStart !== start) continue;
    if (domain !== null && typeof entry.pidDomain === 'string' && entry.pidDomain !== domain) continue;
    out.push(entry);
  }
  return out;
}

/**
 * The managed session's own registry entry, or null.
 *
 * Keyed on `runtime.session_pid`, which the resident's SessionStart hook
 * stamps from its own ppid (startup-context.ts stampSessionEnv). Nothing else
 * identifies it: guest sessions share the hermit's `cwd`, and the tmux pane pid
 * is the wrapper shell, not claude. Null is normal — a session that booted
 * before the stamp existed has no `session_pid`, and every caller falls back to
 * the behavior it had before this file.
 */
export function findResident(runtime: any, configDir?: string): SessionEntry | null {
  const pid = runtime?.session_pid;
  if (typeof pid !== 'number') return null;
  return readRegistry(configDir).find((e) => e.pid === pid) ?? null;
}

/**
 * The hermit record governing `cwd`, or null when none does.
 *
 * The same bounded walk-up cc-compat.ts's hermitDir() does, reimplemented here
 * rather than imported: this module is read by hooks and must stay free of
 * cc-compat's git spawn. A single `<cwd>/.claude-code-hermit` probe would miss
 * a resident whose session was launched from a subdirectory of its project and
 * hand a notice to another hermit instead of a person.
 */
function hermitMarkerFor(cwd: string): any | null {
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    const marker = readRuntimeJson(path.join(dir, '.claude-code-hermit', 'state'));
    if (marker) return marker;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The freshest recently-transitioned interactive session that is not managed
 * by this or another hermit, if one can be validated.
 */
export function findPeerTargets(
  runtime: any,
  { maxIdleMs }: { maxIdleMs: number },
  configDir?: string,
): SessionEntry[] {
  // Without our own pid there is no way to rule ourselves out: the caller's own
  // runtime.json IS the marker read below, so a missing `session_pid` makes the
  // sender its own freshest peer and the notice loops back into this session.
  // A session that booted before the stamp existed is the documented case.
  if (typeof runtime?.session_pid !== 'number') return [];
  const cutoff = Date.now() - maxIdleMs;
  const candidates = readRegistry(configDir)
    .filter((entry) => entry.kind === 'interactive')
    .filter((entry) => entry.pid !== runtime.session_pid)
    .filter((entry) => entry.statusUpdatedAt >= cutoff)
    // parseEntry validates only the fields it keys on, and the registry format
    // is undocumented — an entry missing either of these would throw out of the
    // walk below (or out of net.connect), taking every other candidate with it.
    .filter((entry) => typeof entry.cwd === 'string' && !!entry.messagingSocketPath
      && typeof entry.messagingSocketPath === 'string')
    .sort((a, b) => b.statusUpdatedAt - a.statusUpdatedAt);
  // Sorted first so this stops at the freshest survivor instead of reading
  // every candidate's resident marker only to discard all but the top one.
  const winner = candidates.find((entry) => hermitMarkerFor(entry.cwd)?.session_pid !== entry.pid);
  return winner ? [winner] : [];
}
