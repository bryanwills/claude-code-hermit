// Structural invariants for SKILL.md files in laravel-forge-hermit.
// Run with: bun test tests/skill-structure.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, makeReporter } from './test-utils';

const SKILL_DIR = path.join(import.meta.dir, '..', 'skills');

const SKILLS = [
  { name: 'hatch', gates: 0 },
  { name: 'forge-servers', gates: 0 },
  { name: 'forge-sites', gates: 0 },
  { name: 'forge-deploy', gates: 0 },
  { name: 'forge-logs', gates: 0 },
  { name: 'forge-failed-deploys', gates: 0 },
];

const { ok, summary } = makeReporter();

for (const { name, gates } of SKILLS) {
  console.log(`\n${name}/SKILL.md:`);
  const file = path.join(SKILL_DIR, name, 'SKILL.md');
  ok('file exists', fs.existsSync(file), file);
  if (!fs.existsSync(file)) continue;

  const text = fs.readFileSync(file, 'utf-8');
  const fm = parseFrontmatter(text);
  ok('frontmatter parseable', fm !== null);
  if (!fm) continue;

  ok('frontmatter has name', !!fm.fields.name, JSON.stringify(fm.fields));
  ok('frontmatter name matches dir', fm.fields.name === name, `${fm.fields.name} vs ${name}`);
  ok('frontmatter has description', !!fm.fields.description && fm.fields.description.length > 20);

  const gateMatches = fm.body.match(/^### Gate \d+ —/gm) || [];
  ok(`expected ${gates} Gate headers`, gateMatches.length === gates, `found ${gateMatches.length}`);

  if (gates > 0) {
    ok('Gate 0 present', /^### Gate 0 —/m.test(fm.body));
    ok(`Gate ${gates - 1} present`, new RegExp(`^### Gate ${gates - 1} —`, 'm').test(fm.body));
  }

  // Internal links: resolve [text](relative/path) and verify the target exists.
  const linkRe = /\[[^\]]+\]\(([^)]+)\)/g;
  const skillBaseDir = path.dirname(file);
  let linkMatch: RegExpExecArray | null;
  let linksChecked = 0;
  let linksBad = 0;
  while ((linkMatch = linkRe.exec(fm.body)) !== null) {
    const target = linkMatch[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const cleanTarget = target.split('#')[0];
    if (!cleanTarget) continue;
    const resolved = path.resolve(skillBaseDir, cleanTarget);
    linksChecked += 1;
    if (!fs.existsSync(resolved)) {
      linksBad += 1;
      console.error(`    bad link: ${target} → ${resolved}`);
    }
  }
  ok(`internal links resolve (${linksChecked} checked)`, linksBad === 0, `${linksBad} bad`);
}

// CLAUDE-APPEND token-efficiency guard. The block is re-paid on every session
// load and every subagent dispatch, so the trim that removed the restated 4-step
// walk, the two extra dispatch examples, the scheduled-check contract, and the
// two producerless proposal prefixes must not creep back — and the safety rules
// it was not allowed to touch must stay.
console.log('\nstate-templates/CLAUDE-APPEND.md:');
const appendPath = path.join(import.meta.dir, '..', 'state-templates', 'CLAUDE-APPEND.md');
ok('CLAUDE-APPEND exists', fs.existsSync(appendPath), appendPath);
if (fs.existsSync(appendPath)) {
  const append = fs.readFileSync(appendPath, 'utf-8');
  // Pre-trim 2,993 B → ~2,265 B.
  ok('under post-trim ceiling (~2265 B)', Buffer.byteLength(append, 'utf-8') <= 2600, `${Buffer.byteLength(append, 'utf-8')} B`);

  ok('keeps surface-then-approve', append.includes('preview → relay → approve → confirm'));
  ok('keeps the outage consequence', append.includes('A wrong reboot causes an outage'));
  // The two gates are defence in depth, and the PHP gate is the authoritative
  // one — the block must not claim blanket un-bypassable enforcement.
  ok('states the real enforcement boundary', append.includes('PHP gate authoritative'));
  // Replaced the closed-allowlist assertion: reads no longer use an allowlist,
  // so asserting it would keep the template documenting a guarantee the code
  // does not make. The plan hash is the guarantee that took its place.
  ok('keeps the plan-bound write fact', append.includes('hash-checked plan'));
  ok('keeps the typed-int ID gotcha', append.includes('strict_types'));
  ok('keeps the credential-check command', append.includes('forge.php check'));
  ok('keeps secret hygiene', append.includes('[REDACTED]'));

  ok('keeps the one live proposal prefix', append.includes('[reliability]'));
  ok('drops the producerless prefixes',
    !append.includes('[hygiene]') && !append.includes('[deploy-safety]'));
}

process.exit(summary() === 0 ? 0 : 1);
