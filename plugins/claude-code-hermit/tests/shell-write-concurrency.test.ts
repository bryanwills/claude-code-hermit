import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock, releaseLock } from '../scripts/lib/lockfile';
import { appendShellLine } from '../scripts/lib/md-write';
import { freshDirFactory, setupWorkdir } from './helpers/workdir';
import { runPinnedScript } from './helpers/run';

const { freshDir, cleanup } = freshDirFactory('hermit-shell-write-');
afterAll(cleanup);
const mdLib = path.resolve(import.meta.dir, '../scripts/lib/md-write.ts');
const progressLib = path.resolve(import.meta.dir, '../scripts/lib/progress-log.ts');
const initial = '## Progress Log\n\n## Monitoring\n\n## Findings\n\n## Custom\nOperator-authored content.\n';

async function result(proc: ReturnType<typeof spawnWriter>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function spawnWriter(dir: string, script: string, args: string[] = []) {
  return Bun.spawn({ cmd: [process.execPath, script, ...args], cwd: dir, stdout: 'pipe', stderr: 'pipe' });
}

describe('mechanical SHELL writes share a lock', () => {
  test('mixed concurrent appends retain every fact and custom section', async () => {
    const dir = freshDir();
    const shell = path.join(dir, 'SHELL.md');
    fs.writeFileSync(shell, initial);
    const script = path.join(dir, 'writer.ts');
    fs.writeFileSync(script, `
import fs from 'node:fs';
import { appendShellLine } from ${JSON.stringify(mdLib)};
import { appendToProgressLog } from ${JSON.stringify(progressLib)};
const id = Number(process.argv[2]);
fs.writeFileSync('ready-' + id, '');
while (!fs.existsSync('start')) Bun.sleepSync(5);
for (let i = 0; i < 20; i++) {
  const line = '- writer-' + id + '-fact-' + i + '.';
  const error = id % 2 ? appendToProgressLog('SHELL.md', line) : appendShellLine('.', 'Findings', line);
  if (error) throw new Error(error);
}
`);
    const writers = Array.from({ length: 8 }, (_, i) => spawnWriter(dir, script, [String(i)]));
    try {
      const deadline = Date.now() + 5000;
      while (fs.readdirSync(dir).filter(n => n.startsWith('ready-')).length < writers.length && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      fs.writeFileSync(path.join(dir, 'start'), '');
      for (const out of await Promise.all(writers.map(result))) expect(out.exitCode).toBe(0);
      const text = fs.readFileSync(shell, 'utf-8');
      for (let id = 0; id < writers.length; id++) {
        for (let i = 0; i < 20; i++) expect(text).toContain(`- writer-${id}-fact-${i}.`);
      }
      expect(text).toContain('## Custom\nOperator-authored content.');
    } finally { for (const writer of writers) if (writer.exitCode === null) writer.kill(); }
  }, 15000);

  for (const kind of ['section', 'progress']) {
    test(`${kind} lock timeout reports failure and can be retried`, async () => {
      const dir = freshDir();
      const shell = path.join(dir, 'SHELL.md');
      fs.writeFileSync(shell, initial);
      const script = path.join(dir, 'append.ts');
      fs.writeFileSync(script, `
import { appendShellLine } from ${JSON.stringify(mdLib)};
import { appendToProgressLog } from ${JSON.stringify(progressLib)};
const error = ${kind === 'section' ? "appendShellLine('.', 'Findings', '- retained fact')" : "appendToProgressLog('SHELL.md', '- retained fact')"};
console.log(JSON.stringify({ error: error ?? null }));
`);
      expect(acquireLock(shell + '.lock')).toBe(true);
      try {
        const blocked = await result(spawnWriter(dir, script));
        expect(JSON.parse(blocked.stdout).error).toContain('lock');
        if (kind === 'progress') expect(blocked.stderr).toContain('lock');
        expect(fs.readFileSync(shell, 'utf-8')).toBe(initial);
      } finally { releaseLock(shell + '.lock'); }
      expect(JSON.parse((await result(spawnWriter(dir, script))).stdout).error).toBeNull();
      expect(fs.readFileSync(shell, 'utf-8')).toContain('- retained fact');
    }, 10000);
  }

  test('a dead holder is reclaimed and the successful append releases the lock', () => {
    const dir = freshDir();
    const shell = path.join(dir, 'SHELL.md');
    fs.writeFileSync(shell, initial);
    fs.writeFileSync(shell + '.lock', '4194304');
    expect(appendShellLine(dir, 'Findings', '- recovered')).toBeNull();
    expect(fs.existsSync(shell + '.lock')).toBe(false);
  });

  for (const script of ['session-archive.ts', 'archive-shell.ts']) {
    test(`${script} cannot reset a SHELL held by an append`, async () => {
      const wd = setupWorkdir();
      const hermit = path.join(wd.dir, '.claude-code-hermit');
      const shell = path.join(hermit, 'sessions', 'SHELL.md');
      const before = fs.readFileSync(shell, 'utf-8');
      const args = script === 'session-archive.ts'
        ? ['archive', '--mode=idle', `--state-dir=${hermit}`] : [`--state-dir=${hermit}`];
      expect(acquireLock(shell + '.lock')).toBe(true);
      try {
        const blocked = await runPinnedScript(script, hermit, args, { stdin: 'Status: completed\nSummary: Complete.\n' });
        const out = JSON.parse(blocked.stdout);
        expect(out.ok ?? out.archived).toBe(false);
        expect(out.reason).toContain('lock');
        expect(fs.readFileSync(shell, 'utf-8')).toBe(before);
        releaseLock(shell + '.lock');
        expect(appendShellLine(path.dirname(shell), 'Progress Log', '- late retained fact')).toBeNull();
        const retried = JSON.parse((await runPinnedScript(script, hermit, args, { stdin: 'Status: completed\nSummary: Complete.\n' })).stdout);
        expect(retried.ok ?? retried.archived).toBe(true);
        expect(fs.readFileSync(retried.report_path ?? retried.snapshot_path, 'utf-8')).toContain('late retained fact');
        expect(fs.existsSync(shell + '.lock')).toBe(false);
      } finally { releaseLock(shell + '.lock'); wd.cleanup(); }
    }, 10000);
  }
});
