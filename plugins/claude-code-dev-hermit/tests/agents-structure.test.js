'use strict';

// Structural invariants for agents/*.md files.
// Run with: node tests/agents-structure.test.js
//
// Checks:
//   ✓ Frontmatter present; required fields set.
//   ✓ isolation: worktree is ABSENT (regression guard — runtime must not auto-create worktrees).
//   ✓ Step 0a refusal language present and references the Worktree: token.
//   ✓ Step 0b refusal language present and references the protected branch.
//   ✓ The two refusal blocks are DISTINCT (operator can tell which gate fired).

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./test-utils');

const AGENT_DIR = path.join(__dirname, '..', 'agents');

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed += 1;
  } else {
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    failed += 1;
  }
}

// --- implementer agent ---

console.log('\nimplementer.md:');
const implFile = path.join(AGENT_DIR, 'implementer.md');
ok('file exists', fs.existsSync(implFile), implFile);

if (fs.existsSync(implFile)) {
  const text = fs.readFileSync(implFile, 'utf-8');
  const fm = parseFrontmatter(text);

  ok('frontmatter parseable', fm !== null);
  if (fm) {
    ok('frontmatter has name', !!fm.fields.name);
    ok('frontmatter has description', !!fm.fields.description && fm.fields.description.length > 10);
    ok('isolation: worktree is ABSENT', !fm.raw.includes('isolation:'),
      'isolation: worktree was removed — never re-add (caller now owns worktree setup)');

    // Step 0a: must mention the Worktree: token and distinguish from Step 0b
    const has0a = /missing the .?Worktree:.? line/i.test(text);
    ok('Step 0a refusal mentions missing Worktree: line', has0a,
      'Step 0a refusal must reference the Worktree: token so operators know what to copy');

    // Step 0b: must mention protected branch
    const has0b = /protected branch/i.test(text);
    ok('Step 0b refusal mentions protected branch', has0b);

    // Distinct refusal phrases — the two identifying phrases must not be the same string
    const step0aPhrase = 'missing the';
    const step0bPhrase = 'protected branch';
    ok('Step 0a and Step 0b refusal phrases are distinct',
      step0aPhrase !== step0bPhrase && text.includes(step0aPhrase) && text.includes(step0bPhrase));

    // Must reference check-protected-branch.js
    ok('references check-protected-branch.js in Step 0b', text.includes('check-protected-branch.js'));
  }
}

// --- summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
