// Contract: /claude-code-hermit:simplify emits its totals line in the canonical
// format that downstream consumers parse.
// (bun test port of test-simplify-totals-contract.sh)
//
// The skill is a markdown prompt read by the LLM at runtime, so the only way to
// pin the format is a string check. Core owns the emitter half only — it must
// not assert on any sibling plugin, or its suite stops running standalone.
// The consumer half (dev-hermit's /dev-quality parses this line) is asserted in
// plugins/claude-code-dev-hermit/tests/simplify-totals-contract.test.ts, which
// reads both files; dependent-on-core is the allowed direction.
//
// Usage: bun test tests/simplify-totals-contract.test.ts   (from the plugin root)

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const SIMPLIFY_PATH = path.join(PLUGIN_ROOT, 'skills', 'simplify', 'SKILL.md');

// Canonical totals line as authored in simplify/SKILL.md Phase 3e.
// Changing it here is a cross-plugin break: update the dev-hermit test too.
const CANONICAL =
  'Totals: applied N · deduped M · principle-rejected K · stale-anchor skips L · parse failures P';

test('simplify SKILL.md exists', () => {
  expect(fs.existsSync(SIMPLIFY_PATH)).toBe(true);
});

test('simplify SKILL.md emits canonical totals line', () => {
  expect(fs.readFileSync(SIMPLIFY_PATH, 'utf-8')).toContain(CANONICAL);
});
