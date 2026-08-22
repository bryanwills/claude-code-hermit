// automode-seed is retired: Claude Code 2.1.207 stopped reading autoMode from
// any project settings file, so every write this verb made was silently
// ignored. It now fails loudly instead, because old CHANGELOG upgrade
// instructions still call it and a silent success would hide that the policy
// never landed. The sealed entries ship in the boot-time classifier overlay
// (see renderClassifierOverlay in tests/hermit-start.test.ts).
import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-automode-seed-');
afterAll(cleanup);

function seedFile(dir: string, name: string, settings: any): string {
  const claude = path.join(dir, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const file = path.join(claude, name);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

describe('apply-settings.ts automode-seed (retired)', () => {
  test('exits 1 with a pointer to the launch overlay', async () => {
    const dir = freshDir();
    const file = seedFile(dir, 'settings.local.json', {});
    const r = await runScript('apply-settings.ts', { args: [file, 'automode-seed'] });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('retired');
    expect(r.stderr).toContain('--settings');
  });

  test('writes nothing, whatever the target', async () => {
    const dir = freshDir();
    for (const name of ['settings.local.json', 'settings.json']) {
      const file = seedFile(dir, name, { existing: 'value' });
      const before = fs.readFileSync(file, 'utf8');
      const r = await runScript('apply-settings.ts', { args: [file, 'automode-seed'] });
      expect(r.exitCode).toBe(1);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    }
  });

  test('sibling verbs still work — the retirement is scoped to this op', async () => {
    const dir = freshDir();
    const file = seedFile(dir, 'settings.local.json', {});
    const r = await runScript('apply-settings.ts', { args: [file, 'artifact-allow'] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).permissions.allow).toContain('Artifact');
  });
});
