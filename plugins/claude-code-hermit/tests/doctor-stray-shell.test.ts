// The doctor's `state` check and a stray root-level SHELL.md. The wrong-path write
// is silent by construction — the appends land in a real file, just not the one the
// session archives — so the doctor is the only place it can surface.

import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { checkStateFiles, resolvePaths } from '../scripts/doctor-check';
import { PLUGIN_ROOT } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-doctor-stray-');
afterAll(cleanup);

const SHA = 'a'.repeat(64);

/** A hatched hermit whose state check would otherwise read `ok`. */
function fixture(opts: { stray?: boolean } = {}) {
  const hermit = path.join(freshDir(), '.claude-code-hermit');
  const state = path.join(hermit, 'state');
  fs.mkdirSync(path.join(hermit, 'sessions'), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(hermit, 'sessions', 'SHELL.md'), '# Session\n\n## Progress Log\n');
  for (const f of ['alert-state.json', 'reflection-state.json', 'runtime.json', 'monitors.runtime.json']) {
    fs.writeFileSync(path.join(state, f), '{}');
  }
  fs.writeFileSync(path.join(state, 'template-manifest.json'),
    JSON.stringify({ files: { 'HEARTBEAT.md.template': { sha256: SHA } } }));
  if (opts.stray) fs.writeFileSync(path.join(hermit, 'SHELL.md'), '## Progress Log\n- [09:00] misrouted\n');
  return checkStateFiles(resolvePaths(hermit, PLUGIN_ROOT));
}

describe('doctor: stray root SHELL.md', () => {
  test('a healthy hatch is unchanged', () => {
    const r = fixture();
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('parse cleanly');
  });

  test('a stray root SHELL.md warns and names both paths', () => {
    const r = fixture({ stray: true });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('SHELL.md');
    expect(r.detail).toContain('sessions/SHELL.md');
  });
});
