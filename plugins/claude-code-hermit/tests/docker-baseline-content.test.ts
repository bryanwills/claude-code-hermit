// Content-assertion tests for the Docker baseline templates.
// (bun test port of test-docker-baseline-content.sh)
//
// Guards against accidental removal or layer-splitting of the gh install
// added in v1.0.40 (PROP-028, GH #82). No Docker daemon required — pure
// file inspection.
//
// Usage: bun test tests/docker-baseline-content.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const dockerfile = fs.readFileSync(
  path.join(PLUGIN_ROOT, 'state-templates', 'docker', 'Dockerfile.hermit.template'), 'utf-8');
const compose = fs.readFileSync(
  path.join(PLUGIN_ROOT, 'state-templates', 'docker', 'docker-compose.hermit.yml.template'), 'utf-8');
const entrypoint = fs.readFileSync(
  path.join(PLUGIN_ROOT, 'state-templates', 'docker', 'docker-entrypoint.hermit.sh.template'), 'utf-8');

const dockerfileLines = dockerfile.split('\n');
const rmLine = dockerfileLines.findIndex((l) => l.includes('rm -rf /var/lib/apt/lists'));

// -------------------------------------------------------
// Dockerfile: gh apt source present
// -------------------------------------------------------
describe('Dockerfile: gh apt source', () => {
  test('Dockerfile: cli.github.com apt source present', () => {
    expect(dockerfile).toContain('cli.github.com/packages');
  });

  test('Dockerfile: githubcli-archive-keyring.gpg fetched', () => {
    expect(dockerfile).toContain('githubcli-archive-keyring.gpg');
  });

  test('Dockerfile: gh installed via apt-get', () => {
    expect(dockerfile).toMatch(/apt-get install.*--no-install-recommends gh/);
  });
});

// -------------------------------------------------------
// Dockerfile: gh install is in the same layer as the cleanup
// (regression guard: no accidental RUN split that produces a
// dangling apt-get update without a matching rm -rf)
// -------------------------------------------------------
describe('Dockerfile: layer integrity', () => {
  test('Dockerfile: exactly one rm -rf /var/lib/apt/lists/ in base section (no layer split)', () => {
    const count = dockerfileLines.filter((l) => l.includes('rm -rf /var/lib/apt/lists')).length;
    expect(count).toBe(1);
  });

  test('Dockerfile: gh line appears before rm -rf (same layer ordering)', () => {
    const ghLine = dockerfileLines.findIndex((l) => /apt-get install.*--no-install-recommends gh/.test(l));
    expect(ghLine).toBeGreaterThanOrEqual(0);
    expect(rmLine).toBeGreaterThanOrEqual(0);
    expect(ghLine).toBeLessThan(rmLine);
  });
});

// -------------------------------------------------------
// Compose: HERMIT_GH_TOKEN mapped to GH_TOKEN
// -------------------------------------------------------
describe('Compose: GH_TOKEN mapping', () => {
  test('Compose: GH_TOKEN env var present', () => {
    expect(compose).toContain('GH_TOKEN=');
  });

  test('Compose: GH_TOKEN uses HERMIT_GH_TOKEN source with empty-safe default', () => {
    expect(compose).toContain('GH_TOKEN=${HERMIT_GH_TOKEN:-}');
  });

  test('Compose: GH_TOKEN entry is in the environment block (indented with spaces)', () => {
    expect(compose).toMatch(/^ {6}- GH_TOKEN=/m);
  });
});

// -------------------------------------------------------
// Dockerfile: sandbox deps (bubblewrap + socat) present
// Added in v1.1.2 — required for Claude Code sandbox inside
// unprivileged containers.
// -------------------------------------------------------
describe('Dockerfile: sandbox deps', () => {
  test('Dockerfile: bubblewrap present in apt-get install', () => {
    expect(dockerfile).toContain('bubblewrap');
  });

  test('Dockerfile: socat present in apt-get install', () => {
    expect(dockerfile).toContain('socat');
  });

  test('Dockerfile: bubblewrap and socat in same RUN layer as cleanup', () => {
    const bwrapLine = dockerfileLines.findIndex((l) => l.includes('bubblewrap'));
    expect(bwrapLine).toBeGreaterThanOrEqual(0);
    expect(rmLine).toBeGreaterThanOrEqual(0);
    expect(bwrapLine).toBeLessThan(rmLine);
  });
});

// -------------------------------------------------------
// Python retired from the Docker layer (bun migration WP9).
// Bun is the hermit runtime; Node/npm stay solely for the
// Claude Code CLI and its self-update path.
// -------------------------------------------------------
describe('Dockerfile: Python retired, bun pinned', () => {
  test('Dockerfile: no python3 packages remain', () => {
    expect(dockerfile).not.toContain('python3');
  });

  test('Dockerfile: bun installed via native installer with BUN_VERSION pin', () => {
    expect(dockerfile).toContain('curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"');
  });

  test('Dockerfile: BUN_VERSION build arg pinned to a concrete version', () => {
    expect(dockerfile).toMatch(/^ARG BUN_VERSION=\d+\.\d+\.\d+$/m);
  });

  test('Dockerfile: .bun/bin on ENV PATH', () => {
    expect(dockerfile).toMatch(/^ENV PATH=\/home\/claude\/\.bun\/bin:\$PATH$/m);
  });

  test('Dockerfile: Node layer kept for the Claude Code CLI', () => {
    expect(dockerfile).toContain('deb.nodesource.com');
    expect(dockerfile).toContain('npm install -g @anthropic-ai/claude-code');
  });
});

describe('Entrypoint: Python retired, PATH covers bun', () => {
  test('entrypoint: no python3 invocations remain', () => {
    expect(entrypoint).not.toContain('python3');
  });

  test('entrypoint: explicit PATH line includes both .npm-global/bin and .bun/bin', () => {
    const pathLine = entrypoint.split('\n').find((l) => l.startsWith('export PATH='));
    expect(pathLine).toBeDefined();
    expect(pathLine).toContain('/home/claude/.npm-global/bin');
    expect(pathLine).toContain('/home/claude/.bun/bin');
  });

  test('entrypoint: npm self-heal for the claude binary kept', () => {
    expect(entrypoint).toContain('npm install -g @anthropic-ai/claude-code');
  });
});
