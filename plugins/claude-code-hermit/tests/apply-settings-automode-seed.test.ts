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
import { SEALED_SETTINGS_OPS, TERMINAL_ONLY_SETTINGS_OPS } from '../scripts/lib/settings/automode-entries';

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

// The classifier's allow entry names the ops it covers, so an op added to the
// dispatch without reaching SEALED_SETTINGS_OPS (or being declared terminal-only
// or retired) would run unattended under a policy that never mentioned it.
// RETIRED_OPS are dispatched only to exit 1. TERMINAL_ONLY_SETTINGS_OPS are real
// but deliberately outside the classifier grant — reachable only from an
// explicit terminal choice.
describe('apply-settings.ts op registry', () => {
  const RETIRED_OPS = ['automode-seed'];

  test('every dispatched op is sealed, terminal-only, or retired', () => {
    const src = fs.readFileSync(
      path.join(import.meta.dir, '..', 'scripts', 'apply-settings.ts'),
      'utf8',
    );
    const dispatched = [...src.matchAll(/^  case '([a-z-]+)':/gm)].map((m) => m[1]);
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched.sort()).toEqual(
      [...SEALED_SETTINGS_OPS, ...TERMINAL_ONLY_SETTINGS_OPS, ...RETIRED_OPS].sort(),
    );
  });

  test('the usage message advertises exactly the sealed ops', async () => {
    const dir = freshDir();
    const file = seedFile(dir, 'settings.local.json', {});
    const r = await runScript('apply-settings.ts', { args: [file, 'no-such-op'] });
    expect(r.exitCode).toBe(1);
    for (const op of SEALED_SETTINGS_OPS) expect(r.stderr).toContain(op);
    for (const op of RETIRED_OPS) expect(r.stderr).not.toContain(op);
  });
});
