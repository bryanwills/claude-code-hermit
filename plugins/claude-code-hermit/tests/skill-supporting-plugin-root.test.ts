// Supporting markdown under skills/ is Read after skill load, where
// `${CLAUDE_PLUGIN_ROOT}` is not substituted. Executable paths must use
// `<plugin_root>/`, defined in the owning SKILL.md. A plain
// `${CLAUDE_PLUGIN_ROOT}` mention (warning lines) is allowed; only the
// path form `${CLAUDE_PLUGIN_ROOT}/` is forbidden.
//
// Usage: bun test tests/skill-supporting-plugin-root.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT, walkFiles } from './helpers/run';

const SKILLS = path.join(PLUGIN_ROOT, 'skills');
const DEFINING_SKILLS = [
  'reflect', 'proposal-act', 'channel-responder', 'channel-setup',
  // Read channel-setup's group questionnaire and reflect's queuing procedure.
  'hermit-settings', 'docker-setup',
] as const;
const FORBIDDEN = '${CLAUDE_PLUGIN_ROOT}/';
const DEFINITION = '`<plugin_root>` in this skill\'s supporting files means `${CLAUDE_PLUGIN_ROOT}`.';

describe('skill supporting files plugin-root contract', () => {
  const supporting = walkFiles(SKILLS, (name) => name.endsWith('.md') && name !== 'SKILL.md');

  test('at least one supporting markdown file exists', () => {
    expect(supporting.length).toBeGreaterThan(0);
  });

  test('no supporting markdown uses ${CLAUDE_PLUGIN_ROOT}/', () => {
    const offenders = supporting
      .filter((file) => fs.readFileSync(file, 'utf8').includes(FORBIDDEN))
      .map((file) => path.relative(SKILLS, file));
    expect(offenders).toEqual([]);
  });

  for (const skill of DEFINING_SKILLS) {
    test(`${skill}/SKILL.md defines <plugin_root> for supporting files`, () => {
      const body = fs.readFileSync(path.join(SKILLS, skill, 'SKILL.md'), 'utf8');
      expect(body).toContain(DEFINITION);
    });
  }
});
