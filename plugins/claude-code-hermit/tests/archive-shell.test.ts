// Tests for archive-shell.ts — mechanical SHELL.md snapshot helper.
// (bun test port of test-archive-shell.sh)
//
// archive-shell.ts is genuinely executed, so it runs as a subprocess via runScript.
//
// Usage: bun test tests/archive-shell.test.ts   (from the plugin root)

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, type RunResult } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const sessions = (dir: string, ...p: string[]) => hermit(dir, 'sessions', ...p);
const snapshots = (dir: string) => sessions(dir, 'snapshots');
const shellPath = (dir: string) => sessions(dir, 'SHELL.md');
const runtimePath = (dir: string) => hermit(dir, 'state', 'runtime.json');
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

// Bare workdir without the SHELL.md fixture (bash cases 1 and 2 used raw mktemp).
function bareWorkdir(): Workdir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-archive-shell-'));
  fs.mkdirSync(sessions(dir), { recursive: true });
  fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
  return {
    dir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

function runArchive(dir: string, source: string, now?: string): Promise<RunResult> {
  return runScript('archive-shell.ts', {
    args: [`--source=${source}`],
    cwd: dir,
    env: now ? { HERMIT_NOW: now } : {},
  });
}

// -------------------------------------------------------
// 1. Missing SHELL.md → shell-empty, no snapshot, no runtime write
// -------------------------------------------------------
describe('missing SHELL.md', () => {
  let wd: Workdir;
  let out: string;
  beforeAll(async () => {
    wd = bareWorkdir();
    fs.writeFileSync(runtimePath(wd.dir), '{"session_state":"idle"}\n');
    out = (await runArchive(wd.dir, 'manual')).stdout;
  });
  afterAll(() => wd.cleanup());

  test('shell-empty (no SHELL.md)', () => {
    expect(out).toContain('"archived":false');
  });

  test('shell-empty reason', () => {
    expect(out).toContain('"reason":"shell-empty"');
  });

  test('no snapshots dir created on empty', () => {
    expect(fs.existsSync(snapshots(wd.dir))).toBe(false);
  });

  test('runtime.json untouched on empty', () => {
    const d = readJson(runtimePath(wd.dir));
    expect(d.last_shell_snapshot_at ?? null).toBeNull();
  });
});

// -------------------------------------------------------
// 2. Empty (whitespace-only) SHELL.md → shell-empty
// -------------------------------------------------------
test('shell-empty (whitespace only)', async () => {
  const wd = bareWorkdir();
  try {
    fs.writeFileSync(runtimePath(wd.dir), '{"session_state":"idle","last_shell_snapshot_at":null}\n');
    fs.writeFileSync(shellPath(wd.dir), '   \n  \n');
    const out = (await runArchive(wd.dir, 'manual')).stdout;
    expect(out).toContain('"archived":false');
  } finally {
    wd.cleanup();
  }
});

// -------------------------------------------------------
// 3. Content SHELL.md → snapshot created, marker inserted, runtime updated
// -------------------------------------------------------
describe('content SHELL.md', () => {
  let wd: Workdir;
  let out: string;
  let shell: string;
  let snapshotFiles: string[];
  beforeAll(async () => {
    wd = setupWorkdir();
    fs.writeFileSync(runtimePath(wd.dir), '{"session_state":"in_progress","last_shell_snapshot_at":null}\n');
    out = (await runArchive(wd.dir, 'routine', '2026-05-06T22:00:00Z')).stdout;
    shell = fs.readFileSync(shellPath(wd.dir), 'utf-8');
    snapshotFiles = fs.existsSync(snapshots(wd.dir)) ? fs.readdirSync(snapshots(wd.dir)) : [];
  });
  afterAll(() => wd.cleanup());

  test('content: archived true', () => {
    expect(out).toContain('"archived":true');
  });

  test('content: snapshots dir exists', () => {
    expect(fs.existsSync(snapshots(wd.dir))).toBe(true);
  });

  test('content: exactly one snapshot', () => {
    expect(snapshotFiles.length).toBe(1);
  });

  test('content: snapshot filename matches SHELL-YYYYMMDD-HHMM.md', () => {
    expect(snapshotFiles.some((f) => /^SHELL-[0-9]{8}-[0-9]{4}\.md$/.test(f))).toBe(true);
  });

  test('content: no S-NNN-REPORT.md created', () => {
    const reports = fs.readdirSync(sessions(wd.dir)).filter((f) => /^S-[0-9]+-REPORT\.md$/.test(f));
    expect(reports.length).toBe(0);
  });

  test('content: SHELL.md still has Task section', () => {
    expect(shell).toMatch(/^## Task/m);
  });

  test('content: SHELL.md still has Findings section', () => {
    expect(shell).toMatch(/^## Findings/m);
  });

  test('content: SHELL.md has snapshot marker', () => {
    expect(shell).toContain('snapshot @');
  });

  test('content: SHELL.md has archived pointer', () => {
    expect(shell).toContain('[archived] previous entries');
  });

  test('content: runtime.json updated', () => {
    const d = readJson(runtimePath(wd.dir));
    expect(d.last_shell_snapshot_at ?? null).not.toBeNull();
  });

  test('content: pre-marker entries compacted', () => {
    expect(shell).not.toContain('Started test session');
  });

  test('snapshot file: contains original entry', () => {
    const snap = fs.readFileSync(path.join(snapshots(wd.dir), snapshotFiles[0]), 'utf-8');
    expect(snap).toContain('Started test session');
  });

  test('snapshot file: has trailing boundary marker', () => {
    const snap = fs.readFileSync(path.join(snapshots(wd.dir), snapshotFiles[0]), 'utf-8');
    expect(snap).toContain('snapshot @');
  });
});

// -------------------------------------------------------
// 4. Concurrent invocation: two calls in same minute → only one snapshot
// -------------------------------------------------------
describe('concurrent invocation (same minute)', () => {
  let wd: Workdir;
  let firstOut: string;
  let secondOut: string;
  beforeAll(async () => {
    wd = setupWorkdir();
    fs.writeFileSync(runtimePath(wd.dir), '{"session_state":"in_progress","last_shell_snapshot_at":null}\n');
    firstOut = (await runArchive(wd.dir, 'routine', '2026-05-06T22:00:00Z')).stdout;
    // Same minute → same filename → EEXIST → concurrent.
    secondOut = (await runArchive(wd.dir, 'routine', '2026-05-06T22:00:00Z')).stdout;
  });
  afterAll(() => wd.cleanup());

  test('concurrent: first archived', () => {
    expect(firstOut).toContain('"archived":true');
  });

  test('concurrent: second archived false', () => {
    expect(secondOut).toContain('"archived":false');
  });

  test('concurrent: second reason', () => {
    expect(secondOut).toContain('"reason":"concurrent"');
  });

  test('concurrent: exactly one snapshot file', () => {
    expect(fs.readdirSync(snapshots(wd.dir)).length).toBe(1);
  });
});

// -------------------------------------------------------
// 5. Idempotency across minutes: two calls in different minutes → two snapshots
// -------------------------------------------------------
describe('idempotency across minutes', () => {
  let wd: Workdir;
  beforeAll(async () => {
    wd = setupWorkdir();
    fs.writeFileSync(runtimePath(wd.dir), '{"session_state":"in_progress","last_shell_snapshot_at":null}\n');
    await runArchive(wd.dir, 'routine', '2026-05-06T22:00:00Z');
    fs.appendFileSync(shellPath(wd.dir), '\n## Active Work\nfresh content\n');
    await runArchive(wd.dir, 'routine', '2026-05-06T23:00:00Z');
  });
  afterAll(() => wd.cleanup());

  test('idempotency: two distinct snapshots created', () => {
    expect(fs.readdirSync(snapshots(wd.dir)).length).toBe(2);
  });

  test('idempotency: SHELL.md still has live sections', () => {
    expect(fs.readFileSync(shellPath(wd.dir), 'utf-8')).toMatch(/^## Task/m);
  });
});

// -------------------------------------------------------
// 6. Namespace separation: never creates S-NNN-REPORT.md
// -------------------------------------------------------
describe('namespace separation', () => {
  let wd: Workdir;
  beforeAll(async () => {
    wd = setupWorkdir();
    fs.writeFileSync(runtimePath(wd.dir), '{"session_state":"in_progress","last_shell_snapshot_at":null}\n');
    await runArchive(wd.dir, 'routine', '2026-05-06T22:00:00Z');
  });
  afterAll(() => wd.cleanup());

  test('namespace: no S-NNN-REPORT.md in sessions/', () => {
    const reports = fs.readdirSync(sessions(wd.dir)).filter((f) => /^S-.*-REPORT\.md$/.test(f));
    expect(reports.length).toBe(0);
  });

  test('namespace: snapshot lives under sessions/snapshots/', () => {
    expect(fs.existsSync(snapshots(wd.dir))).toBe(true);
  });
});

// -------------------------------------------------------
// 7. Exit code is always 0 (fail-open)
// -------------------------------------------------------
test('fail-open: exit 0 with no state dir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-archive-shell-'));
  try {
    const r = await runScript('archive-shell.ts', { cwd: dir });
    expect(r.exitCode).toBe(0);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// -------------------------------------------------------
// 8. Missing runtime.json → snapshot still happens (fail-open on runtime write)
// -------------------------------------------------------
describe('missing runtime.json', () => {
  let wd: Workdir;
  let out: string;
  beforeAll(async () => {
    wd = setupWorkdir();
    // setupWorkdir does not create runtime.json — nothing to remove.
    out = (await runArchive(wd.dir, 'routine', '2026-05-06T22:00:00Z')).stdout;
  });
  afterAll(() => wd.cleanup());

  test('no-runtime: archived true', () => {
    expect(out).toContain('"archived":true');
  });

  test('no-runtime: snapshot file written', () => {
    expect(fs.readdirSync(snapshots(wd.dir)).length).toBe(1);
  });

  test('no-runtime: SHELL.md still compacted', () => {
    expect(fs.readFileSync(shellPath(wd.dir), 'utf-8')).toContain('[archived] previous entries');
  });
});

// -------------------------------------------------------
// 9. SHELL.md without ## Progress Log → snapshot taken, warning surfaced,
//    compacted:false in JSON, SHELL.md left untouched
// -------------------------------------------------------
describe('SHELL.md without ## Progress Log', () => {
  let wd: Workdir;
  let r: RunResult;
  let shellBefore: string;
  beforeAll(async () => {
    wd = setupWorkdir();
    fs.writeFileSync(runtimePath(wd.dir), '{"session_state":"in_progress","last_shell_snapshot_at":null}\n');
    // Replace SHELL.md with content that lacks the Progress Log heading.
    fs.writeFileSync(shellPath(wd.dir),
      '# Active Session\n\n## Task\nDrift test — Progress Log heading deliberately absent.\n\n## Findings\nSome content here.\n');
    shellBefore = fs.readFileSync(shellPath(wd.dir), 'utf-8');
    r = await runArchive(wd.dir, 'routine', '2026-05-06T22:00:00Z');
  });
  afterAll(() => wd.cleanup());

  test('no-progress-log: archived true', () => {
    expect(r.stdout).toContain('"archived":true');
  });

  test('no-progress-log: compacted:false in JSON', () => {
    expect(r.stdout).toContain('"compacted":false');
  });

  test('no-progress-log: warning on stderr', () => {
    expect(r.stderr).toMatch(/no .* Progress Log/);
  });

  test('no-progress-log: SHELL.md unchanged', () => {
    expect(fs.readFileSync(shellPath(wd.dir), 'utf-8')).toBe(shellBefore);
  });

  test('no-progress-log: snapshot file written', () => {
    expect(fs.readdirSync(snapshots(wd.dir)).length).toBe(1);
  });
});

// -------------------------------------------------------
// 10. No partial snapshots left behind (no .tmp.<pid> file after run)
// -------------------------------------------------------
test('no-tmp: no .tmp.<pid> snapshot leftover', async () => {
  const wd = setupWorkdir();
  try {
    fs.writeFileSync(runtimePath(wd.dir), '{"session_state":"in_progress","last_shell_snapshot_at":null}\n');
    await runArchive(wd.dir, 'routine', '2026-05-06T22:00:00Z');
    const leftovers = fs.readdirSync(snapshots(wd.dir)).filter((f) => f.includes('.tmp.'));
    expect(leftovers.length).toBe(0);
  } finally {
    wd.cleanup();
  }
});

// -------------------------------------------------------
// 11. State-dir pin: archive-shell.ts has its own
// `Bash(bun */scripts/archive-shell.ts*)` grant, so reflect-precheck.ts's pin
// does NOT cover this route. A direct pre-approved call with a foreign
// --state-dir would snapshot and truncate another project's SHELL.md and
// rewrite its runtime.json (see docs/security.md § Script Argument Trust).
// Only argv is pinned: HERMIT_STATE_DIR needs an env prefix, which falls
// outside the grant and re-prompts.
// -------------------------------------------------------
describe('archive-shell: state-dir pin', () => {
  test('refuses a --state-dir belonging to another project, writing nothing', async () => {
    const mine = setupWorkdir();
    const victim = setupWorkdir();
    try {
      const shellBefore = fs.readFileSync(shellPath(victim.dir), 'utf-8');
      // AGENT_DIR pins hermitDir() to `mine`; argv still names `victim`.
      const r = await runScript('archive-shell.ts', {
        args: ['--source=routine', `--state-dir=${hermit(victim.dir)}`],
        env: { AGENT_DIR: hermit(mine.dir), HERMIT_NOW: '2026-05-06T22:00:00Z' },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('state dir must be');
      expect(fs.readFileSync(shellPath(victim.dir), 'utf-8')).toBe(shellBefore);
      expect(fs.existsSync(snapshots(victim.dir))).toBe(false);
    } finally {
      mine.cleanup();
      victim.cleanup();
    }
  });

  test('HERMIT_STATE_DIR is untouched by the pin — it is the sanctioned env override', async () => {
    const wd = setupWorkdir();
    try {
      fs.writeFileSync(runtimePath(wd.dir), '{"session_state":"in_progress","last_shell_snapshot_at":null}\n');
      const r = await runScript('archive-shell.ts', {
        args: ['--source=routine'],
        env: { HERMIT_STATE_DIR: hermit(wd.dir), HERMIT_NOW: '2026-05-06T22:00:00Z' },
      });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim()).archived).toBe(true);
    } finally {
      wd.cleanup();
    }
  });
});
