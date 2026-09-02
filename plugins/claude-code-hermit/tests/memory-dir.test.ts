// `hermit-run memory-dir` — the one place the auto-memory directory is derived.
//
// Claude Code keys the directory off the absolute project root with every
// non-alphanumeric character replaced by '-' (dots included) and honours
// CLAUDE_CONFIG_DIR. These pin both, so a consumer that used to derive the path
// in prose can point here instead.
//
// Usage: bun test tests/memory-dir.test.ts   (from the plugin root)

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
import { transcriptPathKey } from '../scripts/lib/cc-compat';

const { freshDir, cleanup } = freshDirFactory('hermit-memdir-');
afterAll(cleanup);

// CLAUDE_CONFIG_DIR is pinned to a scratch dir: runScript merges process.env, so a
// maintainer whose own config dir is set would otherwise resolve somewhere else.
async function run(args: string[], configDir: string, cwd?: string) {
  const r = await runScript('memory-dir.ts', { args, cwd, env: { CLAUDE_CONFIG_DIR: configDir } });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout);
}

describe('memory-dir.ts', () => {
  test('a dotted root keys every non-alphanumeric character to "-"', async () => {
    const configDir = freshDir();
    const root = path.join(freshDir(), 'my.project');
    fs.mkdirSync(root, { recursive: true });

    const out = await run([root], configDir);
    expect(out.dir).toBe(path.join(configDir, 'projects', transcriptPathKey(root), 'memory'));
    expect(path.basename(path.dirname(out.dir))).not.toContain('.');
  });

  test('exists flips false → true once the directory is created', async () => {
    const configDir = freshDir();
    const root = freshDir();

    const before = await run([root], configDir);
    expect(before.exists).toBe(false);

    fs.mkdirSync(before.dir, { recursive: true });
    const after = await run([root], configDir);
    expect(after).toEqual({ dir: before.dir, exists: true });
  });

  test('no argument keys on the current working directory', async () => {
    const configDir = freshDir();
    const root = freshDir();

    const out = await run([], configDir, root);
    expect(out.dir).toBe(path.join(configDir, 'projects', transcriptPathKey(fs.realpathSync(root)), 'memory'));
  });
});
