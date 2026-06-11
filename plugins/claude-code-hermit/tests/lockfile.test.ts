import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, releaseLock } from '../scripts/lib/lockfile';

let dir: string;
let lock: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-lock-'));
  lock = path.join(dir, '.lifecycle.lock');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('lockfile', () => {
  test('acquire on clean state succeeds and records our pid', () => {
    expect(acquireLock(lock)).toBe(true);
    expect(fs.readFileSync(lock, 'utf-8')).toBe(String(process.pid));
  });

  test('live contention: fresh lock held by a running pid is not stolen', () => {
    // PID 1 is always alive (init) and never us.
    fs.writeFileSync(lock, '1');
    expect(acquireLock(lock)).toBe(false);
    expect(fs.readFileSync(lock, 'utf-8')).toBe('1');
  });

  test('dead-pid takeover: crashed holder is replaced', () => {
    // Spawn-and-reap a process so its pid is known-dead.
    const proc = Bun.spawnSync(['true']);
    const deadPid = proc.pid ?? 99999;
    fs.writeFileSync(lock, String(deadPid));
    expect(acquireLock(lock)).toBe(true);
    expect(fs.readFileSync(lock, 'utf-8')).toBe(String(process.pid));
  });

  test('legacy empty flock file is treated as stale (python holders never wrote pids)', () => {
    fs.writeFileSync(lock, '');
    expect(acquireLock(lock)).toBe(true);
    expect(fs.readFileSync(lock, 'utf-8')).toBe(String(process.pid));
  });

  test('garbage content is treated as stale', () => {
    fs.writeFileSync(lock, 'not-a-pid\n');
    expect(acquireLock(lock)).toBe(true);
  });

  test('mtime staleness overrides liveness (pid-reuse-after-reboot guard)', () => {
    fs.writeFileSync(lock, '1'); // alive pid...
    const old = new Date(Date.now() - 60 * 60 * 1000); // ...but lock is an hour old
    fs.utimesSync(lock, old, old);
    expect(acquireLock(lock, 15 * 60 * 1000)).toBe(true);
    expect(fs.readFileSync(lock, 'utf-8')).toBe(String(process.pid));
  });

  test('reentrant: our own pid in the lock is not contention', () => {
    expect(acquireLock(lock)).toBe(true);
    expect(acquireLock(lock)).toBe(true);
  });

  test('release removes only our own lock', () => {
    fs.writeFileSync(lock, '1');
    releaseLock(lock);
    expect(fs.existsSync(lock)).toBe(true); // not ours — untouched
    fs.unlinkSync(lock);
    acquireLock(lock);
    releaseLock(lock);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test('concurrent acquisition race: exactly one of N parallel processes wins', async () => {
    // Winners must stay alive while the others contend — a dead winner's lock
    // is legitimately taken over (that IS the design, mirroring flock's
    // release-on-exit). Each winner holds the lock for 2s, far longer than
    // the contention window.
    const script = `
      import { acquireLock } from '${path.join(import.meta.dir, '../scripts/lib/lockfile.ts')}';
      if (acquireLock('${lock}')) {
        console.log('WON');
        await Bun.sleep(2000);
      } else {
        console.log('LOST');
      }
    `;
    const procs = Array.from({ length: 8 }, () =>
      Bun.spawn(['bun', '-e', script], { stdout: 'pipe' })
    );
    const outs = await Promise.all(procs.map(async (p) => {
      await p.exited;
      return (await new Response(p.stdout).text()).trim();
    }));
    const winners = outs.filter((o) => o === 'WON');
    expect(winners.length).toBe(1);
    expect(outs.length).toBe(8);
  });
});
