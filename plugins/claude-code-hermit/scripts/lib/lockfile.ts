/**
 * Lifecycle lockfile — O_EXCL + PID-liveness replacement for fcntl.flock.
 *
 * Semantics: lock held ⇔ the file exists AND contains a live PID AND its mtime
 * is fresh. flock's auto-release-on-death is replaced by the liveness check;
 * the mtime staleness window covers PID reuse after a reboot. Legacy installs
 * have an empty .lifecycle.lock left behind by the old Python flock holders
 * (which created but never unlinked it) — an empty/unparseable file is treated
 * as stale and taken over.
 */

import fs from 'node:fs';

const DEFAULT_STALE_MS = 15 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means the pid exists but belongs to another user — still alive.
    return e && e.code === 'EPERM';
  }
}

// Atomic create-with-content: write the PID to a private temp file, then
// link() it into place — link fails with EEXIST if the lock exists, and the
// lock is never observable in a half-written (empty) state, which a plain
// open('wx')+write would expose to concurrent acquirers.
function tryCreate(lockPath: string): boolean {
  const tmp = `${lockPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, String(process.pid));
    fs.linkSync(tmp, lockPath);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

/**
 * Try to acquire the lock. Returns true on success, false on live contention.
 * Stale locks (dead PID, empty/unparseable content, or mtime older than
 * staleMs) are removed and re-acquired.
 */
function acquireLock(lockPath: string, staleMs: number = DEFAULT_STALE_MS): boolean {
  if (tryCreate(lockPath)) return true;

  let holderPid: number | null = null;
  let mtimeMs = 0;
  try {
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    holderPid = /^\d+$/.test(content) ? parseInt(content, 10) : null;
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    // Vanished between create-attempt and read — retry once.
    return tryCreate(lockPath);
  }

  const fresh = Date.now() - mtimeMs < staleMs;
  if (holderPid !== null && holderPid !== process.pid && pidAlive(holderPid) && fresh) {
    return false; // genuinely held
  }

  // Stale: dead holder, no/garbage PID (legacy empty flock file), or expired
  // mtime. Re-stat before unlinking — if the file changed since we judged it
  // stale, another process took over in the meantime; back off.
  try {
    if (fs.statSync(lockPath).mtimeMs !== mtimeMs) return false;
    fs.unlinkSync(lockPath);
  } catch {}
  return tryCreate(lockPath);
}

/** Release the lock if this process holds it. */
function releaseLock(lockPath: string): void {
  try {
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    if (content === String(process.pid)) fs.unlinkSync(lockPath);
  } catch {}
}

export { acquireLock, releaseLock, pidAlive, DEFAULT_STALE_MS };
