// hatch-resume.json contract test.
//
// Asserts the domain-hatch auto-resume protocol stays consistent across the
// five SKILL.md files that implement it:
// 1. Every domain hatch (writer) references the canonical marker path AND the
//    "skill" field. Catches a path typo or a renamed field in one writer.
// 2. Core hatch (consumer) references the path and keeps delete-BEFORE-invoke
//    ordering in its terminus — reordering would re-resume forever on a failed
//    invoke.
// 3. Core Step 1 keys "already initialized" on config.json, not on bare
//    directory content — the regression that let a pre-core marker trip the
//    reinit prompt.
// 4. The marker stays minimal: no writer reintroduces the dead `requested_at`
//    field (there is no consumer for it; staleness is not tracked).
//
// Scope: monorepo-internal. Reads core hatch + the four sibling domain hatches.
//
// Usage: bun test tests/hatch-resume-contract.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const CANONICAL_PATH = '.claude-code-hermit/state/hatch-resume.json';
const SKILL_KEY = '"skill"';

const CORE_HATCH = path.join(PLUGIN_ROOT, 'skills', 'hatch', 'SKILL.md');

const DOMAIN_SLUGS = [
  'claude-code-dev-hermit',
  'claude-code-fitness-hermit',
  'claude-code-homeassistant-hermit',
  'laravel-forge-hermit',
];

function domainHatch(slug: string): string {
  return path.join(PLUGIN_ROOT, '..', slug, 'skills', 'hatch', 'SKILL.md');
}

for (const slug of DOMAIN_SLUGS) {
  describe(`${slug}:hatch (writer)`, () => {
    const file = domainHatch(slug);

    test(`${slug}:hatch skill exists`, () => {
      expect(fs.existsSync(file)).toBe(true);
    });

    const content = fs.readFileSync(file, 'utf-8');

    test(`references ${CANONICAL_PATH}`, () => {
      expect(content).toContain(CANONICAL_PATH);
    });

    test(`references ${SKILL_KEY} field`, () => {
      expect(content).toContain(SKILL_KEY);
    });

    test('does not reintroduce the dead requested_at field', () => {
      expect(content).not.toContain('requested_at');
    });
  });
}

// Consumer: core hatch.
describe('claude-code-hermit:hatch (consumer + init gate)', () => {
  test('core hatch skill exists', () => {
    expect(fs.existsSync(CORE_HATCH)).toBe(true);
  });

  const content = fs.readFileSync(CORE_HATCH, 'utf-8');

  test(`terminus references ${CANONICAL_PATH}`, () => {
    expect(content).toContain(CANONICAL_PATH);
  });

  test('terminus deletes the marker before invoking (no re-resume loop)', () => {
    const deleteIdx = content.lastIndexOf('Immediately delete');
    const invokeIdx = content.lastIndexOf('Invoke the named skill');
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(invokeIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeLessThan(invokeIdx);
  });

  test('Step 1 keys "already initialized" on config.json, not directory content', () => {
    expect(content).toContain('.claude-code-hermit/config.json');
    expect(content).toContain('already initialized');
  });

  test('core hatch does not reintroduce the dead requested_at field', () => {
    expect(content).not.toContain('requested_at');
  });
});
