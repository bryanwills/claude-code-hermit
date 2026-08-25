import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-output-style-');
afterAll(cleanup);

function seedSettings(dir: string, name: string, settings: any): string {
  const claude = path.join(dir, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const file = path.join(claude, name);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

const readRaw = (file: string) => fs.readFileSync(file, 'utf8');

// runScript's subprocess inherits this test runner's full environment, so every call
// here pins CLAUDE_CONFIG_DIR to an empty scratch dir rather than letting the host
// machine's user scope reach the script. The seed op ignores user scope by design,
// but the tests below assert exactly that, and they can only do so against a scope
// they control.
function emptyConfigDir(): string {
  return freshDir();
}

// The voice carrier is a settings key the operator can also set themselves via
// /config, in any persisted scope. output-style therefore has to be strictly
// one-way: it seeds the key when no scope owns it, and otherwise keeps its hands
// off the target file — including leaving its bytes (and mtime) alone, since
// hermit-start runs it on every boot. output-style-set is the separate, explicit
// replacement op for hermit-settings voice.
describe('apply-settings.ts output-style (seed)', () => {
  test('seeds outputStyle when the key is absent everywhere', async () => {
    const file = seedSettings(freshDir(), 'settings.local.json', { permissions: { allow: ['Bash(ls:*)'] } });
    const r = await runScript('apply-settings.ts', {
      args: [file, 'output-style'],
      env: { CLAUDE_CONFIG_DIR: emptyConfigDir() },
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('applied');
    const after = JSON.parse(readRaw(file));
    expect(after.outputStyle).toBe('hermit-voice');
    // Additive: unrelated keys survive untouched.
    expect(after.permissions.allow).toEqual(['Bash(ls:*)']);
  });

  test('seeds an explicit sealed built-in style', async () => {
    const file = seedSettings(freshDir(), 'settings.local.json', {});
    const r = await runScript('apply-settings.ts', {
      args: [file, 'output-style', 'Concise'],
      env: { CLAUDE_CONFIG_DIR: emptyConfigDir() },
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('applied');
    expect(JSON.parse(readRaw(file)).outputStyle).toBe('Concise');
  });

  test('seeds the lowercase Default literal, not the display label', async () => {
    const file = seedSettings(freshDir(), 'settings.local.json', {});
    const r = await runScript('apply-settings.ts', {
      args: [file, 'output-style', 'default'],
      env: { CLAUDE_CONFIG_DIR: emptyConfigDir() },
    });

    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readRaw(file)).outputStyle).toBe('default');
  });

  test('rejects an unsealed style and writes nothing', async () => {
    const file = seedSettings(freshDir(), 'settings.local.json', { permissions: { allow: ['Bash(ls:*)'] } });
    const before = readRaw(file);
    const r = await runScript('apply-settings.ts', {
      args: [file, 'output-style', 'Bogus'],
      env: { CLAUDE_CONFIG_DIR: emptyConfigDir() },
    });

    expect(r.exitCode).toBe(1);
    expect(readRaw(file)).toBe(before);
  });

  test("preserves an operator's own style in the target file and rewrites nothing", async () => {
    const file = seedSettings(freshDir(), 'settings.local.json', { outputStyle: 'Concise' });
    const before = readRaw(file);
    const r = await runScript('apply-settings.ts', {
      args: [file, 'output-style'],
      env: { CLAUDE_CONFIG_DIR: emptyConfigDir() },
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('kept:Concise');
    expect(readRaw(file)).toBe(before);
  });

  test('is idempotent when the key is already the hermit style', async () => {
    const file = seedSettings(freshDir(), 'settings.local.json', { outputStyle: 'hermit-voice' });
    const before = readRaw(file);
    const r = await runScript('apply-settings.ts', {
      args: [file, 'output-style'],
      env: { CLAUDE_CONFIG_DIR: emptyConfigDir() },
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('kept:hermit-voice');
    expect(readRaw(file)).toBe(before);
  });

  test("won't seed local scope over a style already set in the project's shared settings.json", async () => {
    const dir = freshDir();
    seedSettings(dir, 'settings.json', { outputStyle: 'Explanatory' });
    const localFile = seedSettings(dir, 'settings.local.json', {});
    const before = readRaw(localFile);
    const r = await runScript('apply-settings.ts', {
      args: [localFile, 'output-style'],
      env: { CLAUDE_CONFIG_DIR: emptyConfigDir() },
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('kept:Explanatory');
    expect(readRaw(localFile)).toBe(before);
  });

  // User scope ranks below both project scopes, so a value there cannot shadow this
  // write. Treating it as ownership would refuse a seed that would have won, leaving
  // a freshly-rendered voice file inert on every install whose operator ever picked a
  // style in /config at user scope.
  test('seeds over a style set only in a relocated CLAUDE_CONFIG_DIR user scope', async () => {
    const projectFile = seedSettings(freshDir(), 'settings.local.json', {});
    const userConfigDir = freshDir();
    fs.writeFileSync(
      path.join(userConfigDir, 'settings.json'),
      JSON.stringify({ outputStyle: 'Learning' }, null, 2) + '\n',
    );
    const r = await runScript('apply-settings.ts', {
      args: [projectFile, 'output-style'],
      env: { CLAUDE_CONFIG_DIR: userConfigDir },
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('applied');
    expect(JSON.parse(readRaw(projectFile)).outputStyle).toBe('hermit-voice');
  });

  test('the op is advertised in the unknown-operation error', async () => {
    const file = seedSettings(freshDir(), 'settings.local.json', {});
    const r = await runScript('apply-settings.ts', {
      args: [file, 'no-such-op'],
      env: { CLAUDE_CONFIG_DIR: emptyConfigDir() },
    });

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('output-style');
    expect(r.stderr).toContain('output-style-set');
  });
});

describe('apply-settings.ts output-style-set (explicit replacement)', () => {
  test('replaces an already-set style', async () => {
    const file = seedSettings(freshDir(), 'settings.local.json', {
      outputStyle: 'hermit-voice',
      permissions: { allow: ['Bash(ls:*)'] },
    });
    const r = await runScript('apply-settings.ts', {
      args: [file, 'output-style-set', 'Concise'],
      env: { CLAUDE_CONFIG_DIR: emptyConfigDir() },
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('applied');
    const after = JSON.parse(readRaw(file));
    expect(after.outputStyle).toBe('Concise');
    // Additive elsewhere: unrelated keys survive untouched.
    expect(after.permissions.allow).toEqual(['Bash(ls:*)']);
  });

  test('sets when the key was absent', async () => {
    const file = seedSettings(freshDir(), 'settings.local.json', {});
    const r = await runScript('apply-settings.ts', {
      args: [file, 'output-style-set', 'Explanatory'],
      env: { CLAUDE_CONFIG_DIR: emptyConfigDir() },
    });

    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readRaw(file)).outputStyle).toBe('Explanatory');
  });

  test('rejects an unsealed style and writes nothing', async () => {
    const file = seedSettings(freshDir(), 'settings.local.json', { outputStyle: 'hermit-voice' });
    const before = readRaw(file);
    const r = await runScript('apply-settings.ts', {
      args: [file, 'output-style-set', 'Bogus'],
      env: { CLAUDE_CONFIG_DIR: emptyConfigDir() },
    });

    expect(r.exitCode).toBe(1);
    expect(readRaw(file)).toBe(before);
  });

  test('requires a style argument', async () => {
    const file = seedSettings(freshDir(), 'settings.local.json', { outputStyle: 'hermit-voice' });
    const before = readRaw(file);
    const r = await runScript('apply-settings.ts', {
      args: [file, 'output-style-set'],
      env: { CLAUDE_CONFIG_DIR: emptyConfigDir() },
    });

    expect(r.exitCode).toBe(1);
    expect(readRaw(file)).toBe(before);
  });
});
