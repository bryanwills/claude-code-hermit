// Resolve the nearest .claude-code-hermit dir that has a config.json:
// CLAUDE_PROJECT_DIR when it names one, else a walk up from startDir (max 8
// levels). Returns that dir, or null when none is found.
//
// Returning null (rather than a fail-open default path) is load-bearing:
// git-push-guard falls back to the built-in protected-branch list on null instead
// of blocking, and record-test-result / dev-pr-transforms skip their hermit-state
// writes. Do NOT change this to core's fail-open hermitDir() default.
//
// The env check is sentinel-gated and falls through on a miss, so a stale
// CLAUDE_PROJECT_DIR degrades to the walk (today's behavior) rather than to null
// or to some unrelated project's store. Hook stdin carries a `cwd`, but it is the
// session's drifted shell cwd — identical to this process's own — so it anchors
// nothing and is deliberately not consulted.
//
// INVARIANT: mirrors core's cc-compat.ts hermitDir() shape (same 8-level cap,
// same config.json sentinel, env checked before the walk) — if you change the walk
// or the precedence here, check that file too. One deliberate difference: core's
// CLAUDE_PROJECT_DIR branch accepts a bare `.claude-code-hermit/` while this one
// requires the config.json sentinel, so a CLAUDE_PROJECT_DIR naming a scaffolded-
// but-unhatched project resolves there for core and falls through to the walk
// here. Not a worktree difference: `.worktreeinclude`'s managed block copies
// config.json into the worktree, so both resolvers land on the worktree's copy.

import fs from 'node:fs';
import path from 'node:path';

export function findHermitDir(startDir: string): string | null {
  const proj = process.env.CLAUDE_PROJECT_DIR;
  if (proj && fs.existsSync(path.join(proj, '.claude-code-hermit', 'config.json'))) {
    return path.join(proj, '.claude-code-hermit');
  }
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.claude-code-hermit', 'config.json'))) return path.join(dir, '.claude-code-hermit');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
