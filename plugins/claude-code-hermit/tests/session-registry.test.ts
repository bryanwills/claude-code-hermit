import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRegistry, findResident, findPeerTargets } from '../scripts/lib/session-registry';
import { procStartOf, localPidDomain } from './helpers/registry-fixture';

const dirs: string[] = [];
const children: Bun.Subprocess[] = [];

function registryDir(): string {
  const configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-registry-')));
  dirs.push(configDir);
  fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
  return configDir;
}

function writeEntry(configDir: string, pid: number, patch: Record<string, unknown> = {}): void {
  const entry = {
    // Not localIdentity(): these cases build entries for pids OTHER than this
    // process (a dead one, a reused one), so the identity is per-pid here.
    pid,
    procStart: procStartOf(pid) ?? '1',
    pidDomain: localPidDomain(),
    sessionId: `sess-${pid}`,
    kind: 'interactive',
    status: 'idle',
    statusUpdatedAt: Date.now(),
    cwd: '/tmp/project',
    name: `session-${pid}`,
    messagingSocketPath: `/run/user/1000/cc-socks/${pid}.sock`,
    ...patch,
  };
  fs.writeFileSync(path.join(configDir, 'sessions', `${pid}.json`), JSON.stringify(entry));
}

function liveChild(): Bun.Subprocess {
  const child = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 60_000)']);
  children.push(child);
  return child;
}

// afterAll, not afterEach: bunfig.toml runs these tests concurrently, so a
// per-test teardown of a shared list would rm a fixture another in-flight test
// is still reading. Each test builds its own dir; they all die together here.
afterAll(() => {
  for (const child of children) child.kill();
  while (dirs.length) {
    try { fs.rmSync(dirs.pop()!, { recursive: true, force: true }); } catch {}
  }
});

describe('readRegistry validation', () => {
  test('a live entry for this process resolves', () => {
    const c = registryDir();
    writeEntry(c, process.pid);
    const entries = readRegistry(c);
    expect(entries.map((e) => e.pid)).toEqual([process.pid]);
    expect(entries[0].status).toBe('idle');
  });

  test('a same-pid entry with a different procStart is dropped (pid reuse)', () => {
    const c = registryDir();
    writeEntry(c, process.pid, { procStart: '1' });
    // Off Linux there is no /proc to contradict the entry, so the check is
    // skipped by design and the entry survives — assert the platform's rule.
    const expected = procStartOf(process.pid) === null ? 1 : 0;
    expect(readRegistry(c).length).toBe(expected);
  });

  test('an entry from another pid domain is dropped', () => {
    const c = registryDir();
    writeEntry(c, process.pid, { pidDomain: 'linux:0000:pid:[4026999999]' });
    const expected = os.platform() === 'linux' ? 0 : 1;
    expect(readRegistry(c).length).toBe(expected);
  });

  test('a dead pid is dropped', () => {
    const c = registryDir();
    // Reserved, never-allocated pid: 0 is rejected by the shape check, so use a
    // pid above the system max, which cannot be alive.
    writeEntry(c, 4_194_304, { procStart: '1' });
    expect(readRegistry(c)).toEqual([]);
  });

  test('an unparseable file is skipped without throwing', () => {
    const c = registryDir();
    fs.writeFileSync(path.join(c, 'sessions', '999999.json'), '{not json');
    writeEntry(c, process.pid);
    expect(readRegistry(c).map((e) => e.pid)).toEqual([process.pid]);
  });

  test('an entry with an unknown status is dropped', () => {
    const c = registryDir();
    writeEntry(c, process.pid, { status: 'compacting' });
    expect(readRegistry(c)).toEqual([]);
  });

  test('sibling .key files are ignored', () => {
    const c = registryDir();
    fs.writeFileSync(path.join(c, 'sessions', `${process.pid}.abc123.key`), 'secret');
    writeEntry(c, process.pid);
    expect(readRegistry(c).length).toBe(1);
  });

  test('an absent registry dir reads as unknown, not as an error', () => {
    expect(readRegistry(path.join(os.tmpdir(), 'hermit-registry-does-not-exist'))).toEqual([]);
  });
});

describe('findResident', () => {
  test('resolves the entry named by runtime.session_pid', () => {
    const c = registryDir();
    writeEntry(c, process.pid, { status: 'waiting' });
    expect(findResident({ session_pid: process.pid }, c)?.status).toBe('waiting');
  });

  test('null when the runtime carries no session_pid stamp', () => {
    const c = registryDir();
    writeEntry(c, process.pid);
    expect(findResident({ session_pid: null }, c)).toBeNull();
    expect(findResident({}, c)).toBeNull();
    expect(findResident(null, c)).toBeNull();
  });

  test('null when the stamped pid has no validated entry', () => {
    const c = registryDir();
    writeEntry(c, process.pid);
    expect(findResident({ session_pid: 4_194_304 }, c)).toBeNull();
  });
});

describe('findPeerTargets', () => {
  test('selects only the freshest recent non-resident interactive session', () => {
    const c = registryDir();
    const interactiveOld = liveChild();
    const interactiveFresh = liveChild();
    const background = liveChild();
    const stale = liveChild();
    const now = Date.now();
    writeEntry(c, process.pid, { statusUpdatedAt: now + 10_000 });
    writeEntry(c, interactiveOld.pid, { statusUpdatedAt: now - 2_000 });
    writeEntry(c, interactiveFresh.pid, { statusUpdatedAt: now - 1_000 });
    writeEntry(c, background.pid, { kind: 'bg', statusUpdatedAt: now });
    writeEntry(c, stale.pid, { statusUpdatedAt: now - 60_000 });

    expect(findPeerTargets(
      { session_pid: process.pid },
      { maxIdleMs: 30_000 },
      c,
    ).map((entry) => entry.pid)).toEqual([interactiveFresh.pid]);
  });

  test('skips an interactive entry managed by another hermit', () => {
    const c = registryDir();
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-peer-cwd-')));
    dirs.push(cwd);
    fs.mkdirSync(path.join(cwd, '.claude-code-hermit', 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.claude-code-hermit', 'state', 'runtime.json'),
      JSON.stringify({ session_pid: process.pid }),
    );
    writeEntry(c, process.pid, { cwd });

    expect(findPeerTargets(
      { session_pid: 4_194_304 },
      { maxIdleMs: 30_000 },
      c,
    )).toEqual([]);
  });

  test('skips a hermit resident whose session cwd is a subdirectory of its project', () => {
    const c = registryDir();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-peer-cwd-')));
    dirs.push(root);
    fs.mkdirSync(path.join(root, '.claude-code-hermit', 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude-code-hermit', 'state', 'runtime.json'),
      JSON.stringify({ session_pid: process.pid }),
    );
    const cwd = path.join(root, 'packages', 'api');
    fs.mkdirSync(cwd, { recursive: true });
    writeEntry(c, process.pid, { cwd });

    expect(findPeerTargets({ session_pid: 4_194_304 }, { maxIdleMs: 30_000 }, c)).toEqual([]);
  });

  test('no own session_pid means no target — the sender cannot rule itself out', () => {
    const c = registryDir();
    writeEntry(c, process.pid, { statusUpdatedAt: Date.now() });

    expect(findPeerTargets({}, { maxIdleMs: 30_000 }, c)).toEqual([]);
    expect(findPeerTargets(null, { maxIdleMs: 30_000 }, c)).toEqual([]);
  });

  test('an entry missing cwd or messagingSocketPath is skipped, not thrown on', () => {
    const c = registryDir();
    const other = liveChild();
    const now = Date.now();
    writeEntry(c, process.pid, { statusUpdatedAt: now, cwd: undefined });
    writeEntry(c, other.pid, { statusUpdatedAt: now - 1_000 });

    expect(findPeerTargets(
      { session_pid: 4_194_304 },
      { maxIdleMs: 30_000 },
      c,
    ).map((entry) => entry.pid)).toEqual([other.pid]);
  });

  test('an empty registry directory reads as unknown', () => {
    expect(findPeerTargets(
      { session_pid: process.pid },
      { maxIdleMs: 30_000 },
      registryDir(),
    )).toEqual([]);
  });
});
