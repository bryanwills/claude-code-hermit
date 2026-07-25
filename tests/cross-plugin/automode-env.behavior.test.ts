// Cross-plugin behavior guard for the automode-env.ts skeleton, which is
// duplicated (deliberately — the entry payload differs per domain) across
// fitness / scribe / HA. Instead of comparing source text, this runs each
// plugin's script against the same fixture matrix and asserts the SHARED
// behaviors stay in lockstep: the settings.local.json basename guard, $defaults
// seeding, idempotent merge, sibling-key preservation, and the invalid-JSON
// refusal (which none of the per-plugin suites cover today).
//
// Lives at the repo root (outside every plugin's `bun test` / run-all.sh
// discovery) so it never blocks a plugin release; a dedicated path-scoped
// workflow runs it when any automode-env.ts changes.

import { test, expect, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../..');

interface Spec {
  name: string;
  script: string;
  env: Record<string, string>;
  entrySubstr: string;
}

const SPECS: Spec[] = [
  {
    name: 'fitness',
    script: path.join(ROOT, 'plugins/claude-code-fitness-hermit/scripts/automode-env.ts'),
    env: {},
    entrySubstr: 'www.strava.com',
  },
  {
    name: 'scribe',
    script: path.join(ROOT, 'plugins/hermit-scribe/scripts/automode-env.ts'),
    env: { HERMIT_GH_REPO: 'octo/widget' },
    entrySubstr: 'octo/widget',
  },
  {
    name: 'ha',
    script: path.join(ROOT, 'plugins/claude-code-homeassistant-hermit/scripts/automode-env.ts'),
    env: { HOMEASSISTANT_URL: 'http://ha.example:8123' },
    entrySubstr: 'ha.example:8123',
  },
];

// Clean env: only PATH/HOME plus the spec's extras, so an ambient HOMEASSISTANT_*
// on the dev box can't leak into HA's resolution.
async function run(script: string, target: string, extra: Record<string, string>) {
  const proc = Bun.spawn({
    cmd: ['bun', script, target],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'automode-env-'));
}

for (const spec of SPECS) {
  describe(`automode-env shared behavior — ${spec.name}`, () => {
    test('fresh file seeds $defaults + the domain entry', async () => {
      const target = path.join(tmp(), 'settings.local.json');
      const r = await run(spec.script, target, spec.env);
      expect(r.exitCode).toBe(0);
      const written = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(written.autoMode.environment[0]).toBe('$defaults');
      expect(written.autoMode.environment.some((e: string) => e.includes(spec.entrySubstr))).toBe(true);
    });

    test('is idempotent (no duplicate entry on a second run)', async () => {
      const target = path.join(tmp(), 'settings.local.json');
      await run(spec.script, target, spec.env);
      await run(spec.script, target, spec.env);
      const written = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(written.autoMode.environment).toHaveLength(2); // $defaults + one entry
    });

    test('refuses a target that is not settings.local.json', async () => {
      const target = path.join(tmp(), 'settings.json');
      const r = await run(spec.script, target, spec.env);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('settings.local.json');
      expect(fs.existsSync(target)).toBe(false);
    });

    test('refuses invalid JSON without overwriting it', async () => {
      const target = path.join(tmp(), 'settings.local.json');
      fs.writeFileSync(target, '{ not: valid json,');
      const before = fs.readFileSync(target, 'utf8');
      const r = await run(spec.script, target, spec.env);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('Refusing to overwrite');
      expect(fs.readFileSync(target, 'utf8')).toBe(before);
    });

    test('preserves unrelated sibling keys', async () => {
      const target = path.join(tmp(), 'settings.local.json');
      fs.writeFileSync(target, JSON.stringify({ env: { KEEP: 'me' } }));
      const r = await run(spec.script, target, spec.env);
      expect(r.exitCode).toBe(0);
      const written = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(written.env.KEEP).toBe('me');
      expect(written.autoMode.environment.some((e: string) => e.includes(spec.entrySubstr))).toBe(true);
    });
  });
}

describe('automode-env HA-specific: SKIP with no configured HA URL', () => {
  test('emits SKIP and writes nothing when no host resolves', async () => {
    const target = path.join(tmp(), 'settings.local.json');
    // Empty CLAUDE_PROJECT_DIR (no .env) + no HOMEASSISTANT_* in env.
    const r = await run(SPECS[2].script, target, { CLAUDE_PROJECT_DIR: tmp() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('SKIP|no HA URL configured');
    expect(fs.existsSync(target)).toBe(false);
  });
});
