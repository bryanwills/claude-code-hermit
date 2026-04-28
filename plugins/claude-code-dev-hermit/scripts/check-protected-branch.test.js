'use strict';

// Tests for check-protected-branch.js
// Run with: node scripts/check-protected-branch.test.js

const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SCRIPT = path.join(__dirname, 'check-protected-branch.js');

let passed = 0;
let failed = 0;

function run(branch, { configDir, extraEnv } = {}) {
  const args = ['--branch', branch];
  if (configDir) args.push('--config-dir', configDir);
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, ...extraEnv },
    encoding: 'utf-8',
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function withConfig(protectedBranches) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpb-test-'));
  const hermitDir = path.join(tmpDir, '.claude-code-hermit');
  fs.mkdirSync(hermitDir);
  fs.writeFileSync(
    path.join(hermitDir, 'config.json'),
    JSON.stringify({ 'claude-code-dev-hermit': { protected_branches: protectedBranches } })
  );
  return tmpDir;
}

function assert(description, actual, expected, detail) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    const detailStr = detail ? ` (${detail})` : '';
    console.error(`  ✗ ${description}${detailStr} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

// --- Default fallback (no config) ---
console.log('\nDefault fallback (no config file):');

{
  const r = run('main');
  assert('main is protected', r.status, 1);
  assert('stdout names the pattern', r.stdout.includes("matches protected pattern 'main'"), true);
  assert('stdout includes source: default', r.stdout.includes('source: default'), true);
}

{
  const r = run('master');
  assert('master is protected', r.status, 1);
  assert('stdout names the pattern', r.stdout.includes("matches protected pattern 'master'"), true);
}

{
  const r = run('feature/add-auth');
  assert('feature branch is not protected', r.status, 0);
  assert('stdout says not protected', r.stdout.includes('is not protected'), true);
  assert('stdout is non-empty', r.stdout.trim().length > 0, true);
}

// --- Config-driven literal match ---
console.log('\nConfig-driven literal match:');

{
  const dir = withConfig(['main', 'develop']);
  const r = run('develop', { configDir: dir });
  assert('develop is protected', r.status, 1);
  assert('stdout names the pattern', r.stdout.includes("matches protected pattern 'develop'"), true);
  assert('stdout includes source: config', r.stdout.includes('source: config'), true);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = withConfig(['main']);
  const r = run('feature/foo', { configDir: dir });
  assert('feature/foo is not protected', r.status, 0);
  assert('stdout is non-empty', r.stdout.trim().length > 0, true);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Glob match ---
console.log('\nGlob match:');

{
  const dir = withConfig(['main', 'release/*']);
  const r = run('release/v1.2.3', { configDir: dir });
  assert('release/v1.2.3 matches release/*', r.status, 1);
  assert('stdout names the glob pattern', r.stdout.includes("matches protected pattern 'release/*'"), true);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = withConfig(['release/*']);
  const r = run('release', { configDir: dir });
  assert('bare "release" does not match release/* (no slash)', r.status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = withConfig(['**']);
  const r = run('anything/nested/deep', { configDir: dir });
  assert('** matches across segments', r.status, 1);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- refs/heads/ prefix stripping ---
console.log('\nrefs/heads/ prefix stripping:');

{
  const r = run('refs/heads/main');
  assert('refs/heads/main normalized to main', r.status, 1);
  assert('stdout names the pattern as main', r.stdout.includes("matches protected pattern 'main'"), true);
}

// --- Usage error ---
console.log('\nUsage error:');

{
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf-8' });
  assert('no --branch arg exits 2', result.status, 2);
}

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
