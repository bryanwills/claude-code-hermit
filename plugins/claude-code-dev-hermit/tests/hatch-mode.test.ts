// Structural lint for the hatch-mode feature (v0.3.2).
// Verifies template shape, preamble presence, and skill references.
// These are grep-level checks — no runtime skill execution.

import fs from 'node:fs';
import path from 'node:path';
import { makeReporter } from './test-utils';
import { render } from '../scripts/render-append';

const PLUGIN_ROOT = path.join(import.meta.dir, '..');
const TEMPLATES = path.join(PLUGIN_ROOT, 'state-templates');
const STANDARD = path.join(TEMPLATES, 'CLAUDE-APPEND.md');
const HATCH_SKILL = path.join(PLUGIN_ROOT, 'skills', 'hatch', 'SKILL.md');

const { ok, summary } = makeReporter();

// ── Safety rendering shape ───────────────────────────────────────────────────
// Safety mode is now generated from the single-source template, not a file.

console.log('\nrender("safety") shape:');

ok('standard template exists', fs.existsSync(STANDARD), STANDARD);

if (fs.existsSync(STANDARD)) {
  const text = render('safety', fs.readFileSync(STANDARD, 'utf-8'));
  const marker = '<!-- claude-code-dev-hermit: Development Workflow -->';

  ok('marker present', text.includes(marker));
  ok('marker is near top (within first 10 lines)',
    text.split('\n').slice(0, 10).some(l => l.includes(marker)));

  // /dev-pr is the universal sanctioned push primitive — allowed in safety template.
  // Workflow-chain skills (/dev-quality, /dev-test) and workflow sections stay out.
  ok('no /dev-quality reference', !text.includes('/dev-quality'));
  ok('no /dev-test reference', !text.includes('/dev-test'));
  ok('safety: §Git Safety push rule names /dev-pr',
    /Never `git push`[\s\S]{0,200}\/claude-code-dev-hermit:dev-pr/.test(text));
  ok("safety: §Git Safety blesses /dev-pr's own push (carve-out present)",
    text.includes("run it, don't stop to ask"));
  ok('safety: no short-form /dev-pr in injected rules',
    !/\/dev-pr\b/.test(text));
  ok('no commands.test reference', !text.includes('commands.test'));
  ok('no §Implementation Flow section', !text.includes('## Implementation Flow'));
  ok('no §Tests Before PR section', !text.includes('## Tests Before PR'));

  // Mode-independent sections MUST appear.
  ok('§Git Safety present', text.includes('## Git Safety'));
  ok('§Branch Discipline present', text.includes('## Branch Discipline'));
  ok('§Technical Constraints present', text.includes('## Technical Constraints'));
  ok('§Dev Proposal Categories present', text.includes('## Dev Proposal Categories'));
}

// ── Standard template preambles + required sections ─────────────────────────

console.log('\nCLAUDE-APPEND.md preambles and sections:');

ok('file exists', fs.existsSync(STANDARD), STANDARD);

if (fs.existsSync(STANDARD)) {
  const text = fs.readFileSync(STANDARD, 'utf-8');

  // Mode-independent sections must be present in the standard template too.
  ok('§Git Safety present', text.includes('## Git Safety'));
  ok('§Branch Discipline present', text.includes('## Branch Discipline'));
  ok('§Technical Constraints present', text.includes('## Technical Constraints'));
  ok('§Dev Proposal Categories present', text.includes('## Dev Proposal Categories'));
  ok('standard: §Git Safety push rule names /dev-pr',
    /Never `git push`[\s\S]{0,200}\/claude-code-dev-hermit:dev-pr/.test(text));
  ok("standard: §Git Safety blesses /dev-pr's own push (carve-out present)",
    text.includes("run it, don't stop to ask"));
  ok('standard: no short-form /dev-pr in injected rules',
    !/\/dev-pr\b/.test(text));

  // Each preamble ends with "fallback for projects without one" or "fallback."
  const branchSection = text.match(/## Branch Discipline[\s\S]*?## Implementation Flow/);
  ok('§Branch Discipline has precedence preamble',
    branchSection !== null && branchSection[0].includes('fallback for projects without one'));

  // §Tests Before PR was folded into §Implementation Flow (the two restated one
  // ordering); the merged section keeps the precedence preamble and the ordering.
  const implSection = text.match(/## Implementation Flow[\s\S]*?## Technical Constraints/);
  ok('§Implementation Flow has precedence preamble',
    implSection !== null && implSection[0].includes('follow that') && implSection[0].includes('fallback'));
  ok('§Implementation Flow keeps the quality-gate-before-commit ordering',
    implSection !== null && /dev-quality[\s\S]{0,120}commit[\s\S]{0,120}dev-pr/.test(implSection[0]));
  ok('§Implementation Flow defers test freshness to dev-pr Gate 0',
    implSection !== null && implSection[0].includes('Gate 0'));
  ok('no standalone §Tests Before PR section', !text.includes('## Tests Before PR'));

  // Budgets are measured on the rendered outputs, not the marker-annotated source:
  // the source carries mode markers an operator never sees.
  const stdBytes = Buffer.byteLength(render('standard', text), 'utf-8');
  const safeBytes = Buffer.byteLength(render('safety', text), 'utf-8');
  // Pre-trim: standard 9,330 B / safety 6,338 B. Post-trim ~6,158 / ~4,703.
  ok('rendered standard block under ceiling', stdBytes <= 6600, `${stdBytes} B`);
  ok('rendered safety block under ceiling', safeBytes <= 5100, `${safeBytes} B`);
}

// ── Hatch SKILL.md references ────────────────────────────────────────────────

console.log('\nskills/hatch/SKILL.md mode references:');

ok('file exists', fs.existsSync(HATCH_SKILL), HATCH_SKILL);

if (fs.existsSync(HATCH_SKILL)) {
  const text = fs.readFileSync(HATCH_SKILL, 'utf-8');

  ok('references hatch_mode', text.includes('hatch_mode'));
  ok('references safety mode', text.includes('"safety"') || text.includes("'safety'") || text.includes('`safety`'));
  ok('references standard mode', text.includes('"standard"') || text.includes("'standard'") || text.includes('`standard`'));
  ok('renders block via render-append.ts', text.includes('render-append.ts'));
  ok('references capability scan slugs', text.includes('create-pr') && text.includes('release'));

  console.log('\nskills/hatch/SKILL.md target routing + schema stamping:');

  ok('references hatch-options.json', text.includes('hatch-options.json'));
  ok('reads "target" field from hatch-options.json',
    /hatch-options\.json[\s\S]{0,200}["`]target["`]/.test(text));
  ok('local target routes to CLAUDE.local.md',
    /["`]local["`][\s\S]{0,80}target_file = CLAUDE\.local\.md/.test(text));
  ok('committed target routes to CLAUDE.md',
    /["`]committed["`][\s\S]{0,120}target_file = CLAUDE\.md/.test(text));

  ok('schema stamps "target" field', /"target":\s*"/.test(text));
  ok('schema stamps "core_install_scope" field', /"core_install_scope":\s*"/.test(text));
  ok('schema stamps "stamped_at" field', /"stamped_at":\s*"/.test(text));
  ok('schema stamps "stamped_by" field', /"stamped_by":\s*"claude-code-dev-hermit:hatch"/.test(text));
  ok('schema stamps "version" field', /"version":\s*"/.test(text));

  ok('detects core_install_scope from `claude plugin list --json`',
    /core_install_scope[\s\S]{0,120}claude plugin list --json/.test(text));
  ok('documents `project` → `committed` scope mapping',
    /`project`[^\n]{0,20}`committed`/.test(text));
  ok('documents `local`/`user`/`null` → `local` scope mapping',
    /`local`\/`user`\/`null`[^\n]{0,40}`local`/.test(text));

  ok('Step 1 captures `prior_hatch_mode`',
    /Capture `prior_hatch_mode`/.test(text));
  ok('Step 3 compares against `prior_hatch_mode`',
    /Step 2's mode equals `prior_hatch_mode`/.test(text));

  ok('delegates stray-block migration to hermit-evolve Step 7',
    /hermit-evolve[\s\S]{0,20}Step 7/.test(text));

  // Regression: the version gate used to say "extract the stamped version from
  // the existing block", but no template or renderer ever wrote a version into
  // the block, so the gate degenerated to marker-present-only. The stamp lives
  // in config.json (Step 5 writes it every run) — the gate must read from there.
  ok('no longer reads a phantom version stamp "from the existing block"',
    !text.includes('extract the stamped version from the existing block'));
  ok('reads the stamped version from _hermit_versions in config.json',
    /_hermit_versions\["claude-code-dev-hermit"\]/.test(text));
}

process.exit(summary() === 0 ? 0 : 1);
