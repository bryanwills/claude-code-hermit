// Walk up from startDir (max 8 levels) to the nearest .claude-code-hermit dir
// that has a config.json; return that dir, or null when none is found.
//
// Returning null (rather than a fail-open default path) is load-bearing:
// git-push-guard falls back to the built-in protected-branch list on null instead
// of blocking, and record-test-result / dev-pr-transforms skip their hermit-state
// writes. Do NOT change this to core's fail-open hermitDir() default.
//
// INVARIANT: mirrors core's cc-compat.ts hermitDir() shape (same 8-level cap,
// same config.json sentinel) — if you change the walk here, check that file too.

import fs from 'node:fs';
import path from 'node:path';

export function findHermitDir(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.claude-code-hermit', 'config.json'))) return path.join(dir, '.claude-code-hermit');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
