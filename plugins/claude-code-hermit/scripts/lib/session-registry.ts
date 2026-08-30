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

/** This machine's pid domain, in the registry's own spelling:
 *  `linux:<boot-id, dashes stripped>:<the /proc/self/ns/pid link target>`.
 *  Distinguishes a container's pid namespace from the host's when both share a
 *  config dir. Null on any platform that doesn't publish these. */
function localPidDomain(): string | null {
  if (os.platform() !== 'linux') return null;
  try {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim().replace(/-/g, '');
    const ns = fs.readlinkSync('/proc/self/ns/pid');
    return `linux:${bootId}:${ns}`;
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
