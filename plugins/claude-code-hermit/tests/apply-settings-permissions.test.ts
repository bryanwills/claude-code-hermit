// Contract tests for apply-settings.ts's permissions-plan / permissions-sync verbs.
//
// These two verbs are the single owner of an operator's hermit permissions: hatch
// and hermit-evolve call them instead of carrying their own copies of the list.
// The property that makes that safe is narrow removal — sync deletes only entries
// named in the sealed HERMIT_OBSOLETE registry, never anything the operator wrote.
// Spawning is intentional (see tests/helpers/run.ts): the process boundary is what
// the skills actually invoke.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';

const SCRIPT_SRC = fs.readFileSync(
  path.join(import.meta.dir, '..', 'scripts', 'apply-settings.ts'),
  'utf-8',
);

function sealedArray(name: string): string[] {
  const m = SCRIPT_SRC.match(new RegExp(`const ${name}\\s*=\\s*(\\[[\\s\\S]*?\\]);`));
  if (!m) throw new Error(`${name} not found in apply-settings.ts`);
  return eval(m[1]) as string[];
}

const HERMIT_ALLOW = sealedArray('HERMIT_ALLOW');
const HERMIT_OBSOLETE = sealedArray('HERMIT_OBSOLETE');

function withTarget(fn: (target: string) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-settings-'));
    try {
      await fn(path.join(dir, 'settings.json'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function seed(target: string, settings: unknown) {
  fs.writeFileSync(target, JSON.stringify(settings, null, 2));
}

function readAllow(target: string): string[] {
  return JSON.parse(fs.readFileSync(target, 'utf-8')).permissions.allow;
}

async function run(target: string, op: string) {
  const r = await runScript('apply-settings.ts', { args: [target, op] });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout.trim());
}

describe('apply-settings permissions-plan', () => {
  test('reports every canonical entry as missing for an absent target', withTarget(async (target) => {
    const plan = await run(target, 'permissions-plan');
    expect(plan.missing).toEqual(HERMIT_ALLOW);
    expect(plan.obsolete).toEqual([]);
  }));

  test('writes nothing — the target stays absent', withTarget(async (target) => {
    await run(target, 'permissions-plan');
    expect(fs.existsSync(target)).toBe(false);
  }));

  test('reports an empty plan once the target is in sync', withTarget(async (target) => {
    seed(target, { permissions: { allow: HERMIT_ALLOW } });
    const plan = await run(target, 'permissions-plan');
    expect(plan).toEqual({ missing: [], obsolete: [] });
  }));

  test('names retired entries the target still carries', withTarget(async (target) => {
    const stale = HERMIT_OBSOLETE[0];
    seed(target, { permissions: { allow: [...HERMIT_ALLOW, stale] } });
    const plan = await run(target, 'permissions-plan');
    expect(plan.obsolete).toEqual([stale]);
    expect(plan.missing).toEqual([]);
  }));
});

describe('apply-settings permissions-sync', () => {
  test('adds every missing canonical entry', withTarget(async (target) => {
    seed(target, {});
    await run(target, 'permissions-sync');
    expect(readAllow(target)).toEqual(HERMIT_ALLOW);
  }));

  test('removes retired entries and keeps the operator\'s own', withTarget(async (target) => {
    const custom = 'Bash(my-own-tool:*)';
    seed(target, { permissions: { allow: [custom, ...HERMIT_OBSOLETE] } });

    const plan = await run(target, 'permissions-sync');
    const allow = readAllow(target);

    expect(plan.obsolete).toEqual(HERMIT_OBSOLETE);
    expect(allow).toContain(custom);
    for (const stale of HERMIT_OBSOLETE) expect(allow).not.toContain(stale);
    for (const entry of HERMIT_ALLOW) expect(allow).toContain(entry);
  }));

  test('leaves unrelated settings untouched', withTarget(async (target) => {
    seed(target, { env: { FOO: 'bar' }, permissions: { deny: ['Bash(rm:*)'] } });
    await run(target, 'permissions-sync');

    const settings = JSON.parse(fs.readFileSync(target, 'utf-8'));
    expect(settings.env).toEqual({ FOO: 'bar' });
    expect(settings.permissions.deny).toEqual(['Bash(rm:*)']);
  }));

  test('is idempotent — a second run reports nothing to do', withTarget(async (target) => {
    seed(target, {});
    await run(target, 'permissions-sync');
    const second = await run(target, 'permissions-sync');
    expect(second).toEqual({ missing: [], obsolete: [] });
  }));

  test('a no-op sync does not rewrite the file', withTarget(async (target) => {
    // Deliberately hand-formatted: hermit-evolve runs sync on every upgrade, so a
    // target that is already current must come back untouched, not reformatted.
    const original = JSON.stringify({ permissions: { allow: HERMIT_ALLOW } }, null, 4);
    fs.writeFileSync(target, original);

    const plan = await run(target, 'permissions-sync');

    expect(plan).toEqual({ missing: [], obsolete: [] });
    expect(fs.readFileSync(target, 'utf-8')).toBe(original);
  }));

  test('refuses to overwrite a malformed target', withTarget(async (target) => {
    fs.writeFileSync(target, '{ not json');
    const r = await runScript('apply-settings.ts', { args: [target, 'permissions-sync'] });
    expect(r.exitCode).toBe(1);
    expect(fs.readFileSync(target, 'utf-8')).toBe('{ not json');
  }));
});

describe('sealed registries', () => {
  test('no entry is both canonical and retired', () => {
    const canonical = new Set(HERMIT_ALLOW);
    for (const stale of HERMIT_OBSOLETE) expect(canonical.has(stale)).toBe(false);
  });
});
