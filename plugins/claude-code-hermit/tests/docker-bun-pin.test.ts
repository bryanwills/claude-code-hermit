// Classification matrix for docker-bun-pin.ts — every Dockerfile.hermit shape
// the fleet actually carries, from the v1.0.0 npm-globals line through the
// current ARG pin. The 1.2.45 migration assumed one shape and deferred on most
// deployed hermits; these cases are what stops that recurring.
//
// Usage: bun test tests/docker-bun-pin.test.ts   (from the plugin root)

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-dbp-');
afterAll(cleanup);

const LEGACY = fs.readFileSync(path.join(PLUGIN_ROOT, 'tests/fixtures/Dockerfile.hermit.legacy'), 'utf8');
const TEMPLATE = fs.readFileSync(
  path.join(PLUGIN_ROOT, 'state-templates/docker/Dockerfile.hermit.template'),
  'utf8',
);

// Lays out a project root with a Dockerfile.hermit and a hermit state dir.
function project(contents: string | null, manifest?: object): string {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, '.claude-code-hermit', 'state'), { recursive: true });
  if (contents !== null) fs.writeFileSync(path.join(dir, 'Dockerfile.hermit'), contents);
  if (manifest) {
    fs.writeFileSync(
      path.join(dir, '.claude-code-hermit', 'state', 'template-manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
  }
  return dir;
}

async function pin(dir: string, bunVersion = '1.4.0', pluginVersion = '1.2.46') {
  const stateDir = path.join(dir, '.claude-code-hermit');
  const r = await runScript('docker-bun-pin.ts', {
    args: [stateDir, bunVersion, pluginVersion],
    cwd: dir,
    env: { AGENT_DIR: stateDir },
  });
  return { ...r, verdict: r.stdout.trim() };
}

const dockerfile = (dir: string) => fs.readFileSync(path.join(dir, 'Dockerfile.hermit'), 'utf8');
const manifest = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, '.claude-code-hermit/state/template-manifest.json'), 'utf8'));

describe('docker-bun-pin.ts', () => {
  test('converges the deployed pre-1.2.0 npm-globals shape', async () => {
    const dir = project(LEGACY);
    const r = await pin(dir);
    expect(r.exitCode).toBe(0);
    expect(r.verdict).toBe('OK|converged');

    const out = dockerfile(dir);
    // bun leaves the npm line; Claude Code stays on it.
    expect(out).not.toMatch(/npm install -g bun/);
    expect(out).toContain('RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}');
    expect(out).toContain('ARG BUN_VERSION=1.4.0');
    expect(out).toContain('RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"');
    expect(out).toContain('ENV BUN_INSTALL=/home/claude/.bun');
    expect(out).toContain('ENV PATH=/home/claude/.bun/bin:$PATH');
  });

  test.each([
    // The v1.0.0 template had no CLAUDE_CODE_VERSION arg — same bun problem.
    [
      'the earliest unversioned npm-globals line',
      LEGACY.replace(/^RUN npm install -g bun .*$/m, 'RUN npm install -g bun @anthropic-ai/claude-code'),
      'RUN npm install -g @anthropic-ai/claude-code',
    ],
    // An operator who followed the 1.2.45 manual note by hand gets converged
    // onto the canonical shape, not re-nagged for the fleet's lifetime.
    [
      'a hand-applied npm version pin',
      LEGACY.replace('npm install -g bun ', 'npm install -g bun@1.3.11 '),
      'ARG BUN_VERSION=1.4.0',
    ],
  ])('converges %s', async (_label, contents, expectedLine) => {
    const dir = project(contents);
    const r = await pin(dir);
    expect(r.verdict).toBe('OK|converged');
    expect(dockerfile(dir)).not.toMatch(/npm install -g bun/);
    expect(dockerfile(dir)).toContain(expectedLine);
  });

  test('the inserted block appears exactly once', async () => {
    const dir = project(LEGACY);
    await pin(dir);
    const out = dockerfile(dir);
    expect(out.split('ENV BUN_INSTALL=').length - 1).toBe(1);
    expect(out.split('ARG BUN_VERSION=').length - 1).toBe(1);
  });

  test('repins an older ARG pin, matching on the key not the value', async () => {
    const dir = project(TEMPLATE.replace('ARG BUN_VERSION=1.4.0', 'ARG BUN_VERSION=1.3.11'));
    const r = await pin(dir);
    expect(r.verdict).toBe('OK|repinned 1.3.11->1.4.0');
    expect(dockerfile(dir)).toContain('ARG BUN_VERSION=1.4.0');
  });

  test('leaves an already-pinned file untouched', async () => {
    const dir = project(TEMPLATE);
    const r = await pin(dir);
    expect(r.verdict).toBe('OK|already-pinned');
    expect(dockerfile(dir)).toBe(TEMPLATE);
  });

  test('is idempotent — a second run reports already-pinned and changes nothing', async () => {
    const dir = project(LEGACY);
    await pin(dir);
    const once = dockerfile(dir);
    const r = await pin(dir);
    expect(r.verdict).toBe('OK|already-pinned');
    expect(dockerfile(dir)).toBe(once);
  });

  test('skips when Docker was never set up', async () => {
    const dir = project(null);
    const r = await pin(dir);
    expect(r.exitCode).toBe(0);
    expect(r.verdict).toBe('SKIP|absent');
  });

  // The genuine "operator restructured how bun is installed" case the 1.2.45
  // fallback was written for — defer, never guess at a rewrite.
  test('defers on an unrecognized install shape, leaving the file byte-identical', async () => {
    const custom = LEGACY.replace(
      /^RUN npm install -g bun .*$/m,
      'COPY --from=oven/bun:1.3.11 /usr/local/bin/bun /usr/local/bin/bun',
    );
    const dir = project(custom);
    const r = await pin(dir);
    expect(r.exitCode).toBe(0);
    expect(r.verdict).toBe('DEFER|unrecognized bun install shape');
    expect(dockerfile(dir)).toBe(custom);
  });

  test('re-records the template baseline, preserving foreign keys', async () => {
    const dir = project(LEGACY, {
      version: 1,
      files: {
        'templates/SHELL.md.template': { sha256: 'a'.repeat(64), plugin_version: '1.2.40' },
        'docker/Dockerfile.hermit.template': { sha256: 'b'.repeat(64), plugin_version: '1.2.40' },
      },
    });
    await pin(dir);
    const m = manifest(dir);
    expect(m.files['templates/SHELL.md.template'].plugin_version).toBe('1.2.40');
    const entry = m.files['docker/Dockerfile.hermit.template'];
    expect(entry.plugin_version).toBe('1.2.46');
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.sha256).not.toBe('b'.repeat(64));
  });

  // Recording the baseline says "this deployment matches the shipped template".
  // After a defer it does not, so the drift detector has to keep nagging.
  test('leaves the baseline alone when it defers', async () => {
    const stale = { sha256: 'b'.repeat(64), plugin_version: '1.2.40' };
    const dir = project(LEGACY.replace(/^RUN npm install -g bun .*$/m, 'COPY --from=oven/bun:1.3.11 /usr/local/bin/bun /usr/local/bin/bun'), {
      version: 1,
      files: { 'docker/Dockerfile.hermit.template': stale },
    });
    const r = await pin(dir);
    expect(r.verdict).toBe('DEFER|unrecognized bun install shape');
    expect(manifest(dir).files['docker/Dockerfile.hermit.template']).toEqual(stale);
  });

  test('does not create a manifest when docker-setup never wrote one', async () => {
    const dir = project(LEGACY);
    await pin(dir);
    expect(fs.existsSync(path.join(dir, '.claude-code-hermit/state/template-manifest.json'))).toBe(false);
  });

  // A corrupt manifest is fatal in evolve-plan; failing before the patch keeps
  // the deployed Dockerfile exactly as it was.
  test('fails loud on a corrupt manifest without touching the Dockerfile', async () => {
    const dir = project(LEGACY);
    fs.writeFileSync(path.join(dir, '.claude-code-hermit/state/template-manifest.json'), '{ not json');
    const r = await pin(dir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('not valid JSON');
    expect(dockerfile(dir)).toBe(LEGACY);
  });

  test('rejects a foreign state dir', async () => {
    const dir = project(LEGACY);
    const other = freshDir();
    fs.mkdirSync(path.join(other, '.claude-code-hermit', 'state'), { recursive: true });
    const r = await runScript('docker-bun-pin.ts', {
      args: [path.join(other, '.claude-code-hermit'), '1.4.0', '1.2.46'],
      cwd: dir,
      env: { AGENT_DIR: path.join(dir, '.claude-code-hermit') },
    });
    expect(r.exitCode).toBe(1);
    expect(dockerfile(dir)).toBe(LEGACY);
  });

  test('requires all three arguments', async () => {
    const dir = project(LEGACY);
    const r = await runScript('docker-bun-pin.ts', {
      args: [path.join(dir, '.claude-code-hermit'), '1.4.0'],
      cwd: dir,
      env: { AGENT_DIR: path.join(dir, '.claude-code-hermit') },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('usage:');
  });
});
