// Structural lint for the /hatch skill: that it runs the shared domain-hatch
// protocol rather than carrying its own copy of target resolution and stamping.
// Grep-level checks against the skill markdown. No runtime skill execution.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(import.meta.dir, '..');
const skillText = readFileSync(join(PLUGIN_ROOT, 'skills', 'hatch', 'SKILL.md'), 'utf8');
const templateText = readFileSync(
  join(PLUGIN_ROOT, 'state-templates', 'CLAUDE-APPEND.md'),
  'utf8',
);

// --- Shared domain-hatch protocol ---
// Target resolution, install-scope detection, and the hatch-options stamp
// schema live in core's `domain-hatch.ts`. This hatch's obligation is to call
// the verbs with its own plugin id and restate none of those rules.

test('runs preflight through core, keyed to its own plugin id', () => {
  expect(skillText).toContain('domain-hatch preflight claude-code-homeassistant-hermit');
});

test('reaches core via bin/hermit-run, not a relative path', () => {
  expect(skillText).toContain('.claude-code-hermit/bin/hermit-run domain-hatch');
  expect(skillText).not.toContain('../claude-code-hermit/scripts');
});

test('branches on every preflight action value', () => {
  for (const action of ['upgrade-core-package', 'upgrade-core-applied', '`verify`', '`full`']) {
    expect(skillText).toContain(action);
  }
});

test('consumes the preflight verdict fields instead of re-deriving them', () => {
  expect(
    /`target`[\s\S]{0,60}`target_file`[\s\S]{0,60}`target_default`[\s\S]{0,60}`needs_target_question`/.test(
      skillText,
    ),
  ).toBe(true);
});

test('records the operator choice via ensure-target', () => {
  expect(skillText).toContain(
    'domain-hatch ensure-target claude-code-homeassistant-hermit --target',
  );
});

test('Visibility prompt still offers .local vs committed', () => {
  expect(/Visibility[\s\S]{0,240}`\.local` files[\s\S]{0,120}Committed files/.test(skillText)).toBe(
    true,
  );
});

test('writes the block via sync-block', () => {
  expect(skillText).toContain('domain-hatch sync-block claude-code-homeassistant-hermit');
});

test('defers version-driven block refresh to hermit-evolve', () => {
  // The old hatch re-rendered the block whenever the stamped version differed.
  // hermit-evolve owns that now; hatch appends when absent and skips otherwise.
  expect(/Refreshing an existing block on a version bump is `hermit-evolve`'s job/.test(skillText)).toBe(
    true,
  );
});

test('does not read hatch-options.json directly', () => {
  expect(skillText).not.toContain('hatch-options.json');
});

test('does not restate install-scope detection', () => {
  expect(skillText).not.toContain('claude plugin list --json');
});

test('does not restate the hatch-options stamp schema', () => {
  expect(/"stamped_by":\s*"/.test(skillText)).toBe(false);
  expect(/"core_install_scope":\s*"/.test(skillText)).toBe(false);
});

test('states no hardcoded core version floor', () => {
  // The floor lives in .claude-plugin/hermit-meta.json; prose copies drifted.
  const lines = skillText
    .split('\n')
    .filter((l) => /(?:base hermit|core hermit|claude-code-hermit|_hermit_versions)/i.test(l));
  for (const line of lines) {
    expect(line).not.toMatch(/(?:requires|earlier than|less than|below)\s+`?≥?>?=?\s*\d+\.\d+\.\d+/i);
  }
});

test('stamped version source is _hermit_versions', () => {
  // Pin the version-comparison source so a future prose edit can't silently
  // change where "stamped version" reads from.
  expect(skillText).toContain('_hermit_versions["claude-code-homeassistant-hermit"]');
});

test('the synced block is marker-delimited on both ends', () => {
  // sync-block replaces between the markers, so the template must carry both.
  // The opening marker is named in the skill; the closing one is the template's.
  expect(skillText).toContain('<!-- claude-code-homeassistant-hermit: Home Assistant Workflow -->');
  expect(templateText).toContain('<!-- claude-code-homeassistant-hermit: Home Assistant Workflow -->');
  expect(templateText).toContain('<!-- /claude-code-homeassistant-hermit: Home Assistant Workflow -->');
});

test('delegates stray-block migration to hermit-evolve', () => {
  expect(/hermit-evolve[\s\S]{0,20}Step 7/.test(skillText)).toBe(true);
});

// --- Knowledge-schema extension (Step 6.6) ---

test('has knowledge-schema extension step', () => {
  expect(skillText).toContain('Knowledge-schema extension');
});

test('knowledge-schema idempotency sentinel', () => {
  // The sentinel must appear as the actual typed bullet in the appended block,
  // not just as a backtick-quoted example in the prose description.
  expect(skillText).toContain('- analysis: HA pattern analysis');
});

test('knowledge-schema declares context', () => {
  expect(skillText).toContain('- context:');
});

test('knowledge-schema declares brief', () => {
  expect(skillText).toContain('- brief:');
});

test('knowledge-schema declares presence-report', () => {
  expect(skillText).toContain('- presence-report:');
});

test('knowledge-schema declares audit', () => {
  expect(skillText).toContain('- audit:');
});

test('knowledge-schema declares simulation', () => {
  expect(skillText).toContain('- simulation:');
});

test('knowledge-schema declares apply', () => {
  expect(skillText).toContain('- apply:');
});

test('knowledge-schema declares remove', () => {
  expect(skillText).toContain('- remove:');
});

test('knowledge-schema extension uses Edit tool', () => {
  expect(skillText).toContain('Use Edit to make the changes.');
});

test('knowledge-schema final report line', () => {
  expect(skillText).toContain('knowledge-schema.md: HA types added');
});
