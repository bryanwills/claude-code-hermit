// Subprocess runner for hook contract tests.
// Spawning is intentional here — these tests exercise the process boundary
// Claude Code sees (stdin in, exit code/stdout/stderr out, fail-open).
// Do not convert callers to in-process imports.

import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_ROOT = path.resolve(import.meta.dir, '../..');
export const SCRIPTS_DIR = path.join(PLUGIN_ROOT, 'scripts');
export const MONOREPO_ROOT = path.resolve(PLUGIN_ROOT, '../..');

// Recursively collect file paths under `root` whose name satisfies `match`.
// Entries (file or directory) named in `skipDirs` are pruned entirely.
// Missing `root` returns [].
export function walkFiles(
  root: string,
  match: (name: string) => boolean,
  skipDirs: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (match(entry.name)) out.push(full);
    }
  }
  return out;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string;
  args?: string[];
}

export async function runScript(script: string, opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, path.join(SCRIPTS_DIR, script), ...(opts.args ?? [])],
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdin: Buffer.from(opts.stdin ?? ''),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
