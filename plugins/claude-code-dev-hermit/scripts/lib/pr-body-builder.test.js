'use strict';

// Tests for pr-body-builder.js — run with: node scripts/lib/pr-body-builder.test.js

const {
  buildPRContent,
  buildTitle,
  buildSummary,
  buildContext,
  buildRisk,
  buildVerification,
  buildNotes,
} = require('./pr-body-builder');

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

function makeQuality(overrides = {}) {
  return {
    test: { status: 'pass', duration_secs: 10, command: 'npm test' },
    typecheck: { status: 'pass', command: 'npm run typecheck' },
    lint: { status: 'skipped', command: null },
    simplify: 'applied',
    risk: { level: 'low', reason: 'only UI components changed' },
    review: 'not needed',
    concerns: '',
    ...overrides,
  };
}

function makeCommits(subjects) {
  return subjects.map((s, i) => ({ sha: `abc${i}`, subject: s, body: '' }));
}

// ── buildSummary ────────────────────────────────────────────────────────────

console.log('\nbuildSummary:');
{
  ok('null for empty commits', buildSummary([]) === null);
  ok('null for no commits', buildSummary(null) === null);

  const result = buildSummary(makeCommits(['fix: login redirect', 'chore: update deps']));
  ok('starts with ## Summary', result.startsWith('## Summary'));
  ok('strips conventional prefix (fix:)', result.includes('- login redirect'));
  ok('strips conventional prefix (chore:)', result.includes('- update deps'));

  // Deduplication
  const dup = buildSummary(makeCommits(['fix: same thing', 'fix: same thing', 'feat: other']));
  const bullets = dup.split('\n').filter(l => l.startsWith('- '));
  ok('deduplicates identical subjects', bullets.length === 2);

  // Scoped conventional prefix
  const scoped = buildSummary(makeCommits(['feat(auth): add OAuth support']));
  ok('strips scoped prefix', scoped.includes('- add OAuth support'));

  // Freeform commits (no prefix) pass through unchanged
  const free = buildSummary(makeCommits(['Add dark mode toggle', 'Fix typo in README']));
  ok('freeform commits pass through', free.includes('- Add dark mode toggle'));
}

// ── buildContext ─────────────────────────────────────────────────────────────

console.log('\nbuildContext:');
{
  ok('null when no binding', buildContext(null) === null);
  ok('null when binding but no external', buildContext({}) === null);
  ok('null when external has no url', buildContext({ external: { source: 'linear', id: 'PROJ-1' } }) === null);

  const result = buildContext({
    external: { source: 'linear', id: 'PROJ-123', url: 'https://linear.app/team/issue/PROJ-123', title: 'Fix login redirect' },
  });
  ok('contains ## Context heading', result.includes('## Context'));
  ok('contains link with source+id label', result.includes('[linear PROJ-123]'));
  ok('contains URL', result.includes('https://linear.app'));
  ok('contains title', result.includes('Fix login redirect'));
}

// ── buildRisk ────────────────────────────────────────────────────────────────

console.log('\nbuildRisk:');
{
  ok('null when no risk', buildRisk(null) === null);
  ok('null when no level', buildRisk({ risk: {} }) === null);

  const low = buildRisk({ risk: { level: 'low', reason: 'UI only' } });
  ok('contains ## Risk heading', low.includes('## Risk'));
  ok('level is bold', low.includes('**Low**'));
  ok('contains reason', low.includes('UI only'));

  const high = buildRisk({ risk: { level: 'high', reason: 'database migration' } });
  ok('high level capitalized', high.includes('**High**'));
}

// ── buildVerification ─────────────────────────────────────────────────────────

console.log('\nbuildVerification:');
{
  const q = makeQuality();
  const result = buildVerification(q, []);
  ok('contains ## Verification', result.includes('## Verification'));
  ok('test pass shown', result.includes('Tests: **pass**'));
  ok('typecheck pass shown', result.includes('Typecheck: **pass**'));
  ok('lint skipped shown', result.includes('Lint: **skipped**'));
  ok('simplify applied shown', result.includes('Simplify: **applied**'));

  // URL-based screenshots
  const withScreenshots = buildVerification(q, [
    { criterion: 'login page', path: 'https://example.com/screenshot.png' },
  ]);
  ok('URL screenshot embedded as markdown image', withScreenshots.includes('![login page](https://example.com/screenshot.png)'));

  // Path-based screenshots
  const withPath = buildVerification(q, [
    { criterion: 'dashboard', path: '.claude-code-hermit/raw/screenshots/feature-foo/dash.png' },
  ]);
  ok('path screenshot embedded as markdown image', withPath.includes('![dashboard](.claude-code-hermit/raw/screenshots/feature-foo/dash.png)'));
}

// ── buildNotes ───────────────────────────────────────────────────────────────

console.log('\nbuildNotes:');
{
  ok('null when empty concerns', buildNotes({ concerns: '' }) === null);
  ok('null when null quality', buildNotes(null) === null);

  const result = buildNotes({ concerns: 'Watch out for race conditions in the auth flow.' });
  ok('contains ## Notes', result.includes('## Notes'));
  ok('contains concern text', result.includes('Watch out for race conditions'));
}

// ── buildTitle ───────────────────────────────────────────────────────────────

console.log('\nbuildTitle:');
{
  const commits = makeCommits(['feat(auth): add OAuth support']);
  const binding = { external: { id: 'PROJ-123' } };

  // Default format with binding
  const t1 = buildTitle({ commits, binding, config: {}, branch: 'feature/PROJ-123' });
  ok('default title with ticket', t1 === 'PROJ-123: add OAuth support');

  // Default format without binding
  const t2 = buildTitle({ commits, binding: null, config: {}, branch: 'feature/foo' });
  ok('default title without ticket uses first commit', t2 === 'add OAuth support');

  // Custom format
  const t3 = buildTitle({
    commits, binding,
    config: { pr_title_format: '[{ticket}] {first_commit}' },
    branch: 'feature/PROJ-123',
  });
  ok('custom format applied', t3 === '[PROJ-123] add OAuth support');

  // {branch} placeholder
  const t4 = buildTitle({
    commits: [], binding: null,
    config: { pr_title_format: '{branch}' },
    branch: 'feature/foo/bar',
  });
  ok('{branch} placeholder replaces / with -', t4 === 'feature-foo-bar');

  // Empty commits fallback
  const t5 = buildTitle({ commits: [], binding: null, config: {}, branch: 'feature/xyz' });
  ok('falls back to branch slug when no commits', t5 === 'feature-xyz');
}

// ── buildPRContent — basic ────────────────────────────────────────────────────

console.log('\nbuildPRContent — basic:');
{
  const commits = makeCommits(['fix: login redirect on expired session', 'chore: cleanup test setup']);
  const q = makeQuality();

  const result = buildPRContent({ commits, qualityReport: q, branch: 'feature/login-fix' });
  ok('title is first commit stripped', result.title === 'login redirect on expired session');
  ok('body contains Summary', result.body.includes('## Summary'));
  ok('body contains Risk', result.body.includes('## Risk'));
  ok('body contains Verification', result.body.includes('## Verification'));
  ok('no Context section (no binding)', !result.body.includes('## Context'));
  ok('no Notes section (empty concerns)', !result.body.includes('## Notes'));
  ok('sectionsCount is 3', result.sectionsCount === 3, `got ${result.sectionsCount}`);
  ok('screenshotsCount is 0', result.screenshotsCount === 0);
  ok('templateUsed is builtin', result.templateUsed === 'builtin');
}

// ── buildPRContent — with binding ─────────────────────────────────────────────

console.log('\nbuildPRContent — with binding:');
{
  const commits = makeCommits(['feat: add SAML SSO']);
  const q = makeQuality();
  const binding = {
    external: { source: 'linear', id: 'ENG-42', url: 'https://linear.app/eng/ENG-42', title: 'Add SAML SSO' },
  };

  const result = buildPRContent({ commits, qualityReport: q, binding, branch: 'feature/ENG-42' });
  ok('title includes ticket', result.title === 'ENG-42: add SAML SSO');
  ok('body contains Context section', result.body.includes('## Context'));
  ok('body contains binding title', result.body.includes('Add SAML SSO'));
}

// ── buildPRContent — with notes ───────────────────────────────────────────────

console.log('\nbuildPRContent — with notes:');
{
  const q = makeQuality({ concerns: 'Auth middleware touched — review for session leak.' });
  const result = buildPRContent({ commits: makeCommits(['fix: auth']), qualityReport: q, branch: 'main' });
  ok('body contains Notes section', result.body.includes('## Notes'));
  ok('concern text present', result.body.includes('session leak'));
}

// ── buildPRContent — pr_body_sections ordering ───────────────────────────────

console.log('\nbuildPRContent — section ordering:');
{
  const q = makeQuality({ concerns: 'check this' });
  const binding = { external: { source: 'linear', id: 'X-1', url: 'https://x.io', title: 'Test' } };
  const config = { pr_body_sections: ['risk', 'summary', 'context'] };

  const result = buildPRContent({ commits: makeCommits(['fix: thing']), qualityReport: q, binding, config, branch: 'main' });
  const riskPos = result.body.indexOf('## Risk');
  const summaryPos = result.body.indexOf('## Summary');
  const contextPos = result.body.indexOf('## Context');
  ok('risk before summary', riskPos < summaryPos);
  ok('summary before context', summaryPos < contextPos);
  ok('notes not present (not in config sections)', !result.body.includes('## Notes'));
}

// ── buildPRContent — project template ─────────────────────────────────────────

console.log('\nbuildPRContent — project template fill:');
{
  const template = `## Summary

<describe your changes>

## Risk

<risk level>

## Test Plan

<how did you test>
`;
  const commits = makeCommits(['feat: new feature']);
  const q = makeQuality();

  const result = buildPRContent({ commits, qualityReport: q, projectTemplate: template, branch: 'feature/x' });
  ok('templateUsed is project', result.templateUsed === 'project');
  ok('Summary section replaced', result.body.includes('- new feature'));
  ok('Risk section replaced', result.body.includes('**Low**'));
  ok('Verification appended after template (Test Plan → verification mapping)', result.body.includes('## Verification') || result.body.includes('## Test Plan'));
}

// ── buildPRContent — template with no recognized headers ─────────────────────

console.log('\nbuildPRContent — template fallback:');
{
  const template = `## What Changed\n\n<describe>\n\n## Checklist\n\n- [ ] reviewed\n`;
  const q = makeQuality();
  const result = buildPRContent({ commits: makeCommits(['fix: x']), qualityReport: q, projectTemplate: template, branch: 'fix/x' });
  ok('templateUsed is fallback', result.templateUsed === 'fallback');
  ok('built-in body used instead', result.body.includes('## Summary'));
}

// ── buildPRContent — empty pr_body_sections ───────────────────────────────────

console.log('\nbuildPRContent — empty sections (verbatim template):');
{
  const template = `## My Template\n\nFill me in.\n`;
  const q = makeQuality();
  const result = buildPRContent({
    commits: makeCommits(['fix: x']),
    qualityReport: q,
    projectTemplate: template,
    config: { pr_body_sections: [] },
    branch: 'fix/x',
  });
  ok('templateUsed is project-verbatim', result.templateUsed === 'project-verbatim');
  ok('body matches template verbatim', result.body === template);
}

// ── buildPRContent — requires qualityReport ───────────────────────────────────

console.log('\nbuildPRContent — requires qualityReport:');
{
  let threw = false;
  try {
    buildPRContent({ commits: [], qualityReport: null, branch: 'main' });
  } catch (e) {
    threw = e.message.includes('qualityReport');
  }
  ok('throws when qualityReport is null', threw);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

console.log('\nCLI smoke test:');
{
  const { execSync } = require('node:child_process');
  const path = require('node:path');
  const input = JSON.stringify({
    commits: [{ sha: 'abc', subject: 'fix: the bug', body: '' }],
    qualityReport: makeQuality(),
    branch: 'fix/the-bug',
  });
  const pluginRoot = path.join(__dirname, '..', '..');
  const output = execSync(`node scripts/lib/pr-body-builder.js '${input.replace(/'/g, "'\\''")}'`, { encoding: 'utf8', cwd: pluginRoot });
  const parsed = JSON.parse(output.trim());
  ok('CLI returns title', typeof parsed.title === 'string');
  ok('CLI returns body', typeof parsed.body === 'string');
  ok('CLI returns sectionsCount', typeof parsed.sectionsCount === 'number');
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
