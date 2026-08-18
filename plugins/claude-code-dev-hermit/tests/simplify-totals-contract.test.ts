// Contract: the totals line /dev-quality parses must match verbatim the one
// /claude-code-hermit:simplify emits.
//
// Both skills are markdown prompts read by the LLM at runtime, so the only way
// to keep them in sync is a string check. If the canonical format changes in
// one SKILL.md, this fails until the other is updated — otherwise /dev-quality
// silently falls into the "totals unavailable" branch and Gate 1 goes blank.
//
// This assertion lives here, not in core: dev-hermit depends on core, so it
// owns the cross-plugin seam. Core asserts only that it emits the line.
// test-dev.yml lists core's simplify/SKILL.md in its paths filter so a
// core-side format change still trips this suite.

import fs from 'node:fs';
import path from 'node:path';
import { makeReporter } from '../../../tests/lib/skill-lint';

const PLUGIN_ROOT = path.join(import.meta.dir, '..');
const DEV_QUALITY = path.join(PLUGIN_ROOT, 'skills', 'dev-quality', 'SKILL.md');
const CORE_SIMPLIFY = path.join(
  PLUGIN_ROOT, '..', 'claude-code-hermit', 'skills', 'simplify', 'SKILL.md');

// Canonical totals line as authored in core's simplify/SKILL.md Phase 3e.
const CANONICAL =
  'Totals: applied N · deduped M · principle-rejected K · stale-anchor skips L · parse failures P';

const { ok, summary } = makeReporter();

console.log('\nSimplify totals contract — files present:');

const devQualityExists = fs.existsSync(DEV_QUALITY);
const coreSimplifyExists = fs.existsSync(CORE_SIMPLIFY);

ok('dev-quality SKILL.md exists', devQualityExists, DEV_QUALITY);
ok('core simplify SKILL.md exists', coreSimplifyExists, CORE_SIMPLIFY);

const devQuality = devQualityExists ? fs.readFileSync(DEV_QUALITY, 'utf-8') : '';
const coreSimplify = coreSimplifyExists ? fs.readFileSync(CORE_SIMPLIFY, 'utf-8') : '';

console.log('\nSimplify totals contract — emitter and parser agree:');

ok('core simplify emits canonical totals line', coreSimplify.includes(CANONICAL));
ok('dev-quality references same canonical totals line', devQuality.includes(CANONICAL));

// Spot-check the parser hook: dev-quality must describe capturing content after
// the `Totals:` label. Guards against the parser drifting away from a `Totals:`
// prefix while the emitter still uses one.
ok('dev-quality references the Totals: label as the parse anchor',
   /after the .?Totals:.? label/.test(devQuality));

process.exit(summary() === 0 ? 0 : 1);
