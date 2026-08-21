import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-output-style-');
afterAll(cleanup);

function seedSettings(dir: string, settings: any): string {
  const claude = path.join(dir, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const file = path.join(claude, 'settings.local.json');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

const readRaw = (file: string) => fs.readFileSync(file, 'utf8');

// The voice carrier is a settings key the operator can also set themselves via
// /config. This op therefore has to be strictly one-way: it seeds the key when
// nothing owns it, and otherwise keeps its hands off — including leaving the
// file's bytes (and mtime) alone, since hermit-start runs it on every boot.
describe('apply-settings.ts output-style', () => {
  test('seeds outputStyle when the key is absent', async () => {
    const file = seedSettings(freshDir(), { permissions: { allow: ['Bash(ls:*)'] } });
    const r = await runScript('apply-settings.ts', { args: [file, 'output-style'] });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('applied');
    const after = JSON.parse(readRaw(file));
    expect(after.outputStyle).toBe('hermit-voice');
    // Additive: unrelated keys survive untouched.
    expect(after.permissions.allow).toEqual(['Bash(ls:*)']);
  });

  test("preserves an operator's own style and rewrites nothing", async () => {
    const file = seedSettings(freshDir(), { outputStyle: 'Concise' });
    const before = readRaw(file);
    const r = await runScript('apply-settings.ts', { args: [file, 'output-style'] });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('kept:Concise');
    expect(readRaw(file)).toBe(before);
  });

  test('is idempotent when the key is already the hermit style', async () => {
    const file = seedSettings(freshDir(), { outputStyle: 'hermit-voice' });
    const before = readRaw(file);
    const r = await runScript('apply-settings.ts', { args: [file, 'output-style'] });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('kept:hermit-voice');
    expect(readRaw(file)).toBe(before);
  });

  test('the op is advertised in the unknown-operation error', async () => {
    const file = seedSettings(freshDir(), {});
    const r = await runScript('apply-settings.ts', { args: [file, 'no-such-op'] });

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('output-style');
  });
});
