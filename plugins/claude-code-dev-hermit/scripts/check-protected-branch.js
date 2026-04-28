#!/usr/bin/env node
'use strict';

// CLI wrapper around lib/protected-branches.js.
// Exit 0 = not protected. Exit 1 = protected (stdout names the matched pattern).
// Exit 2 = usage error.
//
// Usage:
//   node check-protected-branch.js --branch <name> [--config-dir <path>]
//
// Stdout on protected:
//   branch '<name>' matches protected pattern '<pat>' (source: config|default)
// Stdout on not protected:
//   branch '<name>' is not protected

const { loadProtectedBranches, isProtected } = require('./lib/protected-branches');

const args = process.argv.slice(2);
let branchArg = null;
let configDirArg = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--branch' && args[i + 1]) {
    branchArg = args[++i];
  } else if (args[i] === '--config-dir' && args[i + 1]) {
    configDirArg = args[++i];
  }
}

if (!branchArg) {
  process.stderr.write('Usage: check-protected-branch.js --branch <name> [--config-dir <path>]\n');
  process.exit(2);
}

const { branches, source } = loadProtectedBranches(configDirArg || undefined);
const matched = isProtected(branchArg, branches);

if (matched) {
  process.stdout.write(`branch '${branchArg}' matches protected pattern '${matched}' (source: ${source})\n`);
  process.exit(1);
} else {
  process.stdout.write(`branch '${branchArg}' is not protected\n`);
  process.exit(0);
}
