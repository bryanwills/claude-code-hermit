// The doctor's watchdog check reads the systemd unit's own last-run outcome.
//
// A unit whose ExecStart cannot resolve bun exits 127 before the watchdog stamps
// last_run, so staleness alone eventually notices — after ~20 minutes, and only
// to say "enabled but not firing", which points at the wrong remedy. Asking
// systemd directly names the case immediately.
//
// Spawned, not imported: the check shells out to systemctl, and a fake
// executable only takes effect across a process boundary (Bun snapshots PATH for
// in-process spawns).

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';

let dir: string;
let hermit: string;
let fakeBin: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-wd-'));
  hermit = path.join(dir, '.claude-code-hermit');
  fs.mkdirSync(path.join(hermit, 'state'), { recursive: true });
  fakeBin = path.join(dir, 'fake-bin');
  fs.mkdirSync(fakeBin);

  fs.writeFileSync(
    path.join(hermit, 'config.json'),
    JSON.stringify({ timezone: 'UTC', watchdog: { enabled: true } }),
  );
  fs.writeFileSync(
    path.join(hermit, 'state', 'runtime.json'),
    JSON.stringify({ version: 1, session_state: 'in_progress', runtime_mode: 'tmux' }),
  );
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

/**
 * Fake systemctl that answers `show` for exactly one unit name and mimics
 * systemd's behaviour for every other: a unit that does not exist reports
 * ExecMainStatus=0 / Result=success, indistinguishable from a healthy one. That
 * synthesis is what makes a wrong unit name silently lose the diagnosis, so the
 * stub reproduces it rather than erroring.
 */
function writeFakeSystemctl(unitName: string, props: Record<string, string>): void {
  const answers = Object.entries(props).map(([k, v]) => `echo "${k}=${v}"`).join('\n  ');
  fs.writeFileSync(
    path.join(fakeBin, 'systemctl'),
    `#!/usr/bin/env bash
unit=""
for a in "$@"; do case "$a" in *.service) unit="$a" ;; esac; done
if [ "$unit" = "${unitName}.service" ]; then
  ${answers}
else
  echo "ExecMainStatus=0"
  echo "Result=success"
fi
exit 0
`,
  );
  fs.chmodSync(path.join(fakeBin, 'systemctl'), 0o755);
}

/** Run the doctor and return its watchdog check. `cwd` defaults to the project. */
async function watchdogCheck(cwd = dir): Promise<{ status: string; detail: string }> {
  const r = await runScript('doctor-check.ts', {
    args: [hermit],
    cwd,
    env: { PATH: `${fakeBin}:${process.env.PATH}` },
  });
  const checks = JSON.parse(r.stdout).checks;
  return checks.find((c: any) => c.id === 'watchdog');
}

// The unit hermit-watchdog install generated for this project: the default
// tmux_session_name with {project_name} expanded to the project dir's basename.
const unitFor = (projectDir: string) => `hermit-watchdog@hermit-${path.basename(projectDir)}`;

const isLinux = process.platform === 'linux';

describe('watchdog unit status', () => {
  test.if(isLinux)('exit 127 → fail naming the PATH remedy', async () => {
    writeFakeSystemctl(unitFor(dir), { ExecMainStatus: '127', Result: 'exit-code' });
    const check = await watchdogCheck();
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('127');
    expect(check.detail).toContain('hermit-watchdog install');
  });

  test.if(isLinux)('a non-127 failure points at the journal, not at re-installing', async () => {
    writeFakeSystemctl(unitFor(dir), { ExecMainStatus: '0', Result: 'timeout' });
    const check = await watchdogCheck();
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('journalctl');
    expect(check.detail).not.toContain('hermit-watchdog install');
  });

  test.if(isLinux)('a healthy unit falls through to the existing staleness logic', async () => {
    writeFakeSystemctl(unitFor(dir), { ExecMainStatus: '0', Result: 'success' });
    const check = await watchdogCheck();
    expect(check.status).not.toBe('fail');
    // No last_run was ever stamped in this fixture, so staleness still reports.
    expect(check.detail).toContain('not firing');
  });

  test.if(isLinux)('the unit name comes from the hermit dir, not the working directory', async () => {
    // The stub only answers for the project's real unit; anything else gets
    // systemd's healthy-looking synthesis. Running the doctor from an unrelated
    // cwd must therefore still produce the failure.
    writeFakeSystemctl(unitFor(dir), { ExecMainStatus: '127', Result: 'exit-code' });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-wd-cwd-'));
    try {
      const check = await watchdogCheck(elsewhere);
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('127');
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
