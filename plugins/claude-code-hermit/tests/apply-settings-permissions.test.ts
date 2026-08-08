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

  // The narrowed metrics-writer grant. The old entry allowed writing arbitrary
  // JSON to an arbitrary path, so it has to be actively retired from existing
  // installs, not merely dropped from the canonical list.
  test('the observations writer is granted and its arbitrary-path predecessor retired', () => {
    expect(HERMIT_ALLOW).toContain('Bash(bun */scripts/observations.ts observe *)');
    expect(HERMIT_OBSOLETE).toContain('Bash(bun */scripts/append-metrics.ts*)');
  });

  test('the routine Monitor subprocess is granted without widening to arbitrary shell scripts', () => {
    expect(HERMIT_ALLOW).toContain('Bash(bash */scripts/routine-monitor.sh *)');
    expect(HERMIT_ALLOW).not.toContain('Bash(bash */scripts/*.sh *)');
  });

  test('the routine Monitor command uses an absolute state path without shell expansion', () => {
    const skill = fs.readFileSync(path.join(import.meta.dir, '..', 'skills', 'hermit-routines', 'SKILL.md'), 'utf8');
    expect(skill).toContain('routine-monitor.sh 60 <abs-project-dir>/.claude-code-hermit');
    expect(skill).not.toContain('routine-monitor.sh 60 $PWD/.claude-code-hermit');
  });

  // finish resolves the hermit dir itself. A state-dir argument under a wildcard
  // grant would be a caller-selected root — the cross-project boundary
  // lib/cc-compat.ts exists to close.
  test('the routine finalizer is granted verb-pinned and takes no state-dir argument', () => {
    expect(HERMIT_ALLOW).toContain('Bash(bun */scripts/routines.ts finish*)');
    expect(HERMIT_ALLOW).not.toContain('Bash(bun */scripts/routines.ts*)');
    const skill = fs.readFileSync(path.join(import.meta.dir, '..', 'skills', 'hermit-routines', 'SKILL.md'), 'utf8');
    expect(skill).toContain('routines.ts finish <id> <delivery>');
    expect(skill).not.toContain('routines.ts finish <id> .claude-code-hermit');
  });

  // The whole point of #689: the fire path must not log success on its own say-so.
  test('the shared execution semantics call finish, never a bare fired stamp', () => {
    const skill = fs.readFileSync(path.join(import.meta.dir, '..', 'skills', 'hermit-routines', 'SKILL.md'), 'utf8');
    expect(skill).not.toContain('log-event <id> fired');
  });
});
