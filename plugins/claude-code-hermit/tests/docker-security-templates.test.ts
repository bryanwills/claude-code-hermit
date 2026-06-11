// Contract tests for the docker-security templates.
// (bun test port of test-docker-security-templates.sh)
//
// These bugs (1.0.27 → 1.0.28) escaped because template content has no
// automated assertions: tee-vs-dnsmasq PID capture, missing capabilities,
// host bind mount under rootless Docker, slow healthcheck. This suite
// pattern-matches the templates and SKILL.md to lock those regressions
// down. No Docker daemon required — pure file inspection.
//
// Usage: bun test tests/docker-security-templates.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const read = (...p: string[]) => fs.readFileSync(path.join(PLUGIN_ROOT, ...p), 'utf-8');

const entrypoint = read('state-templates', 'docker', 'security', 'netguard-entrypoint.sh.template');
const skill = read('skills', 'docker-security', 'SKILL.md');
const allowlist = read('state-templates', 'docker', 'security', 'dnsmasq.allowlist.template');
const docs = read('docs', 'docker-security.md');

// -------------------------------------------------------
// Entrypoint: no tee-piping, no DNSMASQ_PID=$! capture
// -------------------------------------------------------
describe('netguard-entrypoint.sh.template', () => {
  test("entrypoint: no 'tee -a' (regression: bug #1 + #2 cascade)", () => {
    expect(entrypoint).not.toContain('tee -a');
  });

  test("entrypoint: no 'DNSMASQ_PID=' assignment (regression: $! captures tee)", () => {
    expect(entrypoint).not.toContain('DNSMASQ_PID=');
  });

  test("entrypoint: no '/var/log/netguard' references (regression: rootless bind mount)", () => {
    expect(entrypoint).not.toContain('/var/log/netguard');
  });

  // -------------------------------------------------------
  // Entrypoint: positive assertions
  // -------------------------------------------------------
  test('entrypoint: --log-facility=- on log-only dnsmasq line', () => {
    expect(entrypoint).toContain('dnsmasq -k --log-queries --log-facility=-');
  });

  test('entrypoint: --log-facility=- on enforce dnsmasq line', () => {
    expect(entrypoint).toContain('dnsmasq -k --log-facility=- --conf-file');
  });

  test('entrypoint: pgrep dnsmasq used for liveness check', () => {
    expect(entrypoint).toContain('pgrep dnsmasq');
  });
});

// -------------------------------------------------------
// SKILL.md contract assertions
// -------------------------------------------------------
describe('docker-security SKILL.md', () => {
  // cap_add list (exact match — fails loud if any cap is missing,
  // reordered, or extras are added without test coverage)
  test('SKILL.md: cap_add list is [NET_ADMIN, NET_BIND_SERVICE, SETUID, SETGID]', () => {
    expect(skill).toContain('cap_add: [NET_ADMIN, NET_BIND_SERVICE, SETUID, SETGID]');
  });

  test('SKILL.md: healthcheck has start_period', () => {
    expect(skill).toContain('start_period:');
  });

  test("SKILL.md: no 'state:/var/log/netguard' bind mount (regression: rootless)", () => {
    expect(skill).not.toContain('state:/var/log/netguard');
  });

  // Hardened DNS-block verifier
  test("SKILL.md: DNS-block check uses 'timeout 2s' (catches timeout vs NXDOMAIN)", () => {
    expect(skill).toContain('timeout 2s bun -e');
  });

  test('SKILL.md: DNS-block check classifies timeout explicitly (not just grep-on-stderr)', () => {
    expect(skill).toContain('query timed out');
  });

  // Python retired from the Docker layer (bun migration WP9) — the base image
  // no longer ships python3, so no verification snippet may invoke it.
  test('SKILL.md: no python3 invocations (only the "image has no python3" note)', () => {
    const invocations = skill.split('\n').filter((l) => l.includes('python3') && !l.includes('no `python3`'));
    expect(invocations).toEqual([]);
  });

  test('SKILL.md: verification block uses bun for LAN/DNS checks', () => {
    expect(skill).toContain('require("net").connect');
    expect(skill).toContain('require("dns").lookup');
    expect(skill).toContain('require("dgram").createSocket');
  });

  // --no-cache netguard rebuild
  test('SKILL.md: step 6c forces --no-cache netguard build (prevents stale image on upgrade)', () => {
    expect(skill).toContain('build --no-cache hermit-netguard');
  });
});

// -------------------------------------------------------
// dnsmasq.allowlist.template: no-resolv + core domains
// -------------------------------------------------------
describe('dnsmasq.allowlist.template', () => {
  test('allowlist: no-resolv directive present (prevents DNS leak to resolv.conf)', () => {
    expect(allowlist).toMatch(/^no-resolv$/m);
  });

  test('allowlist: server=/claude.ai/ present (OAuth login flow)', () => {
    expect(allowlist).toContain('server=/claude.ai/');
  });

  test('allowlist: server=/claude.com/ present (OAuth login flow)', () => {
    expect(allowlist).toContain('server=/claude.com/');
  });
});

// -------------------------------------------------------
// SKILL.md + docs: tune instruction says down && up, not restart hermit-netguard
// -------------------------------------------------------
describe('tune instruction (SKILL.md + docs)', () => {
  test("SKILL.md: tune instruction uses 'hermit-docker down && hermit-docker up' not restart", () => {
    expect(skill).toContain('hermit-docker down && hermit-docker up');
  });

  test('docs/docker-security.md: tune instruction uses down && up', () => {
    expect(docs).toContain('hermit-docker down && hermit-docker up');
  });

  test("docs/docker-security.md: no stale 'restart hermit-netguard' instruction in tune section", () => {
    expect(docs).not.toContain('restart hermit-netguard');
  });

  test('docs/docker-security.md: no python3 in the verify block (Python retired from image)', () => {
    expect(docs).not.toContain('python3');
  });
});
