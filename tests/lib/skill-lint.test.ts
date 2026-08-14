import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter, lintSkills } from './skill-lint';

// ── parseFrontmatter ────────────────────────────────────────────────────────

test('returns null without a frontmatter block', () => {
  expect(parseFrontmatter('# just a heading\n')).toBeNull();
});

test('parses plain scalars and strips surrounding quotes', () => {
  const fm = parseFrontmatter('---\nname: dev-pr\ntitle: "quoted"\n---\nbody text\n');
  expect(fm?.fields.name).toBe('dev-pr');
  expect(fm?.fields.title).toBe('quoted');
  expect(fm?.body).toBe('body text\n');
});

test('folds YAML block scalars into a single-line value', () => {
  // The stranded-parser bug this module exists to fix: three of the four plugin
  // lints read `>-` literally and then reported the description as too short.
  const md = [
    '---',
    'name: feed-brief',
    'description: >-',
    '  Fetches every registered source, scores the items,',
    '  and writes the brief.',
    'model: haiku',
    '---',
    'body',
    '',
  ].join('\n');
  const fm = parseFrontmatter(md);
  expect(fm?.fields.description).toBe(
    'Fetches every registered source, scores the items, and writes the brief.',
  );
  expect(fm?.fields.model).toBe('haiku');
});

// ── lintSkills ──────────────────────────────────────────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-lint-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function writeSkill(name: string, body: string) {
  const dir = path.join(root, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

writeSkill(
  'good-gated',
  '---\nname: good-gated\ndescription: A description comfortably longer than twenty characters.\n---\n' +
    '### Gate 0 — first\n### Gate 1 — second\n[ref](SKILL.md)\n',
);
writeSkill(
  'good-flat',
  '---\nname: good-flat\ndescription: >-\n  A block-scalar description that is also long enough.\n---\nprose\n',
);
writeSkill(
  'broken',
  '---\nname: mismatched\ndescription: short\n---\n### Gate 0 — only one\n[dead](nope.md)\n',
);

test('passes skills that meet every structural expectation', () => {
  expect(
    lintSkills(root, [
      { name: 'good-gated', gates: 2 },
      { name: 'good-flat', gates: 0 },
    ]),
  ).toEqual([]);
});

test('reports each structural violation on a broken skill', () => {
  const failures = lintSkills(root, [{ name: 'broken', gates: 0 }]);
  expect(failures).toEqual([
    'broken: frontmatter name is mismatched',
    'broken: frontmatter description missing or too short',
    'broken: expected 0 Gate headers, found 1',
    expect.stringContaining('broken: bad link nope.md'),
  ]);
});

test('reports a missing SKILL.md without throwing', () => {
  const failures = lintSkills(root, [{ name: 'absent', gates: 0 }]);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain('absent: SKILL.md missing');
});
