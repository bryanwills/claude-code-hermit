// Structural lint for skills/hatch/SKILL.md: that it runs core's shared
// domain-hatch protocol and carries no second copy of it.
// Run with: bun tests/hatch-skill.test.ts
//
// Grep-level checks only — no runtime skill execution.

import fs from 'node:fs';
import path from 'node:path';
import { makeReporter } from './test-utils';

const PLUGIN_ROOT = path.join(import.meta.dir, '..');
const SKILL = path.join(PLUGIN_ROOT, 'skills', 'hatch', 'SKILL.md');
const TEMPLATE = path.join(PLUGIN_ROOT, 'state-templates', 'CLAUDE-APPEND.md');

const { ok, summary } = makeReporter();

console.log('\nskills/hatch/SKILL.md shared domain-hatch protocol:');

ok('file exists', fs.existsSync(SKILL), SKILL);

if (fs.existsSync(SKILL)) {
  const text = fs.readFileSync(SKILL, 'utf-8');

  ok('runs preflight through core, keyed to its own plugin id',
    text.includes('domain-hatch preflight claude-code-fitness-hermit'));
  ok('reaches core via bin/hermit-run, not a relative path',
    text.includes('.claude-code-hermit/bin/hermit-run domain-hatch')
    && !text.includes('../claude-code-hermit/scripts'));
  ok('branches on every preflight `action` value',
    ['upgrade-core-package', 'upgrade-core-applied', '`verify`', '`full`'].every(a => text.includes(a)));
  ok('consumes the preflight verdict fields instead of re-deriving them',
    /`target`[\s\S]{0,60}`target_file`[\s\S]{0,60}`target_default`[\s\S]{0,60}`needs_target_question`/.test(text));

  ok('records the operator\'s choice via ensure-target',
    text.includes('domain-hatch ensure-target claude-code-fitness-hermit --target'));
  ok('Visibility prompt still offers .local vs committed',
    /Visibility[\s\S]{0,240}`\.local` files[\s\S]{0,120}Committed files/.test(text));
  ok('writes the block via sync-block',
    text.includes('domain-hatch sync-block claude-code-fitness-hermit'));

  // Prose surfaces that drifted from the manifest and from core's resolver
  // before the protocol was centralised. None of them may come back.
  ok('does not read hatch-options.json directly', !text.includes('hatch-options.json'));
  ok('does not restate install-scope detection', !text.includes('claude plugin list --json'));
  ok('does not restate the hatch-options stamp schema',
    !/"stamped_by":\s*"/.test(text) && !/"core_install_scope":\s*"/.test(text));
  ok('states no hardcoded core version floor',
    text.split('\n')
      .filter(l => /(?:base hermit|core hermit|claude-code-hermit|_hermit_versions)/i.test(l))
      .every(l => !/(?:requires|earlier than|less than|below)\s+`?≥?>?=?\s*\d+\.\d+\.\d+/i.test(l)));

  ok('stamps its own version into _hermit_versions',
    text.includes('_hermit_versions["claude-code-fitness-hermit"]'));
  ok('the stamped value comes from the preflight verdict, not a literal',
    /_hermit_versions\["claude-code-fitness-hermit"\][\s\S]{0,60}self_version/.test(text));

  ok('names the block marker it hands to sync-block',
    text.includes('<!-- claude-code-fitness-hermit: Fitness Workflow -->'));
}

console.log('\nstate-templates/CLAUDE-APPEND.md:');

ok('file exists', fs.existsSync(TEMPLATE), TEMPLATE);

if (fs.existsSync(TEMPLATE)) {
  const tpl = fs.readFileSync(TEMPLATE, 'utf-8');
  // sync-block replaces between the markers, so the template must carry both.
  ok('opening marker present',
    tpl.includes('<!-- claude-code-fitness-hermit: Fitness Workflow -->'));
  ok('closing marker present',
    tpl.includes('<!-- /claude-code-fitness-hermit: Fitness Workflow -->'));
}

process.exit(summary() === 0 ? 0 : 1);
