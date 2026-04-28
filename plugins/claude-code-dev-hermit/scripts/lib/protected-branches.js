'use strict';

// Shared protected-branch helpers extracted from git-push-guard.js.
// All skills and agents that need to check protected branches shell out to
// scripts/check-protected-branch.js (which wraps this module) rather than
// restating the glob logic inline.

const fs = require('fs');
const path = require('path');

function loadProtectedBranches(configDir) {
  try {
    const dir = configDir || process.cwd();
    const configPath = path.join(dir, '.claude-code-hermit', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    const branches = cfg?.['claude-code-dev-hermit']?.protected_branches;
    if (Array.isArray(branches) && branches.length > 0) {
      return { branches, source: 'config' };
    }
  } catch (_) {}
  return { branches: ['main', 'master'], source: 'default' };
}

function normalizeBranch(name) {
  return name
    .replace(/^refs\/remotes\/[^/]+\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^[^/]+\//, (m) => {
      return ['origin/', 'upstream/', 'fork/'].includes(m) ? '' : m;
    });
}

function globMatch(pattern, str) {
  const reStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*');
  return new RegExp('^' + reStr + '$').test(str);
}

// Returns the matching pattern string if protected, null otherwise.
function isProtected(branchName, protectedList) {
  const normalized = normalizeBranch(branchName);
  return protectedList.find((pattern) => globMatch(pattern, normalized)) || null;
}

module.exports = { loadProtectedBranches, normalizeBranch, globMatch, isProtected };
