// Tests for the tool-name routing added to mcp-safety-gate.ts when the matcher
// widened from `mcp__homeassistant__Hass.*` to `mcp__homeassistant__.*`.
//
// These exercise behavior that has NO Python counterpart (the retired gate never
// read tool_name), so they live here rather than in the golden corpus — keeping
// gate-corpus.test.ts byte-equal with the Python gate and free of divergence
// markers. PreToolUse exit semantics: 0 = allow (empty stdout) / ask (JSON
// stdout); 2 = block.

import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MCP_HOOK = join(import.meta.dir, '..', 'hooks', 'mcp-safety-gate.ts');

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

function runGate(stdin: string, cwd: string = import.meta.dir) {
  const r = Bun.spawnSync([process.execPath, MCP_HOOK], {
    stdin: Buffer.from(stdin, 'utf8'),
    env: cleanEnv(),
    cwd, // no .claude-code-hermit/config.json -> strict mode by default
    timeout: 10_000,
  });
  return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/** A temp project dir carrying a given ha_safety_mode in config.json. */
function askModeCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ha-gate-'));
  mkdirSync(join(dir, '.claude-code-hermit'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-code-hermit', 'config.json'),
    JSON.stringify({ ha_safety_mode: 'ask' }),
  );
  return dir;
}

test('read-only tool with no entity is allowed', () => {
  const r = runGate(JSON.stringify({ tool_name: 'mcp__homeassistant__GetLiveContext', tool_input: {} }));
  expect(r.exit).toBe(0);
  expect(r.stdout).toBe('');
});

test('GetDateTime read-only tool is allowed', () => {
  const r = runGate(JSON.stringify({ tool_name: 'mcp__homeassistant__GetDateTime', tool_input: {} }));
  expect(r.exit).toBe(0);
  expect(r.stdout).toBe('');
});

test('read-only allow is mode-independent (still allows under ask mode)', () => {
  const dir = askModeCwd();
  try {
    const r = runGate(
      JSON.stringify({ tool_name: 'mcp__homeassistant__GetLiveContext', tool_input: {} }),
      dir,
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown non-entity tool fails closed (blocks)', () => {
  // A script-style actuation tool that carries no entity_id — e.g. an exposed
  // HA script tool. The widened matcher now routes it here; with no resolvable
  // target it must block, not slip through.
  const r = runGate(JSON.stringify({ tool_name: 'mcp__homeassistant__armar_alarme', tool_input: {} }));
  expect(r.exit).toBe(2);
  expect(r.stdout).toBe('');
  expect(r.stderr).not.toBe('');
});

test('unknown tool carrying a sensitive entity still blocks under strict', () => {
  const r = runGate(
    JSON.stringify({
      tool_name: 'mcp__homeassistant__SomeActuator',
      tool_input: { entity_id: 'lock.front_door' },
    }),
  );
  expect(r.exit).toBe(2);
  expect(r.stdout).toBe('');
});

test('non-read-only tool with a safe concrete entity is allowed', () => {
  const r = runGate(
    JSON.stringify({
      tool_name: 'mcp__homeassistant__HassTurnOn',
      tool_input: { entity_id: 'light.living_room' },
    }),
  );
  expect(r.exit).toBe(0);
  expect(r.stdout).toBe('');
});

test('a non-string tool_name does not bypass the gate (falls through to fail-closed)', () => {
  const r = runGate(JSON.stringify({ tool_name: 123, tool_input: {} }));
  expect(r.exit).toBe(2);
  expect(r.stdout).toBe('');
});

// --- Channel-confirmation token bridge (Phase 3 / G3) ---

const SENSITIVE_CALL = JSON.stringify({
  tool_name: 'mcp__homeassistant__HassTurnOn',
  tool_input: { entity_id: 'lock.front_door' },
});

function writeToken(dir: string, token: unknown): void {
  const stateDir = join(dir, '.claude-code-hermit', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'ha-confirm-token.json'), JSON.stringify(token));
}

function freshToken(overrides: Record<string, unknown> = {}) {
  return {
    tool: 'mcp__homeassistant__HassTurnOn',
    tool_input: { entity_id: 'lock.front_door' },
    expiry: Date.now() + 30_000,
    nonce: 'probe-nonce',
    ...overrides,
  };
}

const TOKEN_PATH = join('.claude-code-hermit', 'state', 'ha-confirm-token.json');

test('ask mode + no token: sensitive entity asks', () => {
  const dir = askModeCwd();
  try {
    const r = runGate(SENSITIVE_CALL, dir);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain('"permissionDecision": "ask"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ask mode + valid one-shot token: allowed and token consumed', () => {
  const dir = askModeCwd();
  try {
    writeToken(dir, freshToken());
    const r = runGate(SENSITIVE_CALL, dir);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe('');
    // single-use: consumed by atomic rename
    expect(existsSync(join(dir, TOKEN_PATH))).toBe(false);
    expect(existsSync(join(dir, TOKEN_PATH + '.consumed'))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ask mode + second call after consume: asks (token is single-use)', () => {
  const dir = askModeCwd();
  try {
    writeToken(dir, freshToken());
    const first = runGate(SENSITIVE_CALL, dir);
    expect(first.exit).toBe(0);
    expect(first.stdout).toBe('');
    const second = runGate(SENSITIVE_CALL, dir);
    expect(second.exit).toBe(0);
    expect(second.stdout).toContain('"permissionDecision": "ask"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ask mode + expired token: asks', () => {
  const dir = askModeCwd();
  try {
    writeToken(dir, freshToken({ expiry: Date.now() - 1_000 }));
    const r = runGate(SENSITIVE_CALL, dir);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain('"permissionDecision": "ask"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ask mode + entity-mismatch token: asks', () => {
  const dir = askModeCwd();
  try {
    writeToken(dir, freshToken({ tool_input: { entity_id: 'lock.back_door' } }));
    const r = runGate(SENSITIVE_CALL, dir);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain('"permissionDecision": "ask"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Full tool_input binding (a token cannot authorize a different param value) ---

const GARAGE_50 = JSON.stringify({
  tool_name: 'mcp__homeassistant__HassSetPosition',
  tool_input: { entity_id: 'cover.garage_door', position: 50 },
});
const GARAGE_100 = JSON.stringify({
  tool_name: 'mcp__homeassistant__HassSetPosition',
  tool_input: { entity_id: 'cover.garage_door', position: 100 },
});

function positionToken(position: number) {
  return {
    tool: 'mcp__homeassistant__HassSetPosition',
    tool_input: { entity_id: 'cover.garage_door', position },
    expiry: Date.now() + 30_000,
    nonce: 'probe-nonce',
  };
}

test('ask mode + token bound to the full input allows the exact matching call', () => {
  const dir = askModeCwd();
  try {
    writeToken(dir, positionToken(50));
    const r = runGate(GARAGE_50, dir);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe('');
    expect(existsSync(join(dir, TOKEN_PATH))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ask mode + token bound to position=50 does NOT authorize position=100 (asks, token kept)', () => {
  const dir = askModeCwd();
  try {
    writeToken(dir, positionToken(50));
    const r = runGate(GARAGE_100, dir);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain('"permissionDecision": "ask"');
    // a non-matching call must NOT consume the token meant for a different call
    expect(existsSync(join(dir, TOKEN_PATH))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ask mode + an unrelated ask-tier call does not drop a pending matching token', () => {
  const dir = askModeCwd();
  try {
    writeToken(dir, freshToken()); // confirmed for lock.front_door / HassTurnOn
    // A different sensitive ask-tier call arrives first.
    const other = JSON.stringify({
      tool_name: 'mcp__homeassistant__HassTurnOn',
      tool_input: { entity_id: 'lock.back_door' },
    });
    const r1 = runGate(other, dir);
    expect(r1.exit).toBe(0);
    expect(r1.stdout).toContain('"permissionDecision": "ask"');
    expect(existsSync(join(dir, TOKEN_PATH))).toBe(true); // token survived
    // The intended call still consumes it and is allowed.
    const r2 = runGate(SENSITIVE_CALL, dir);
    expect(r2.exit).toBe(0);
    expect(r2.stdout).toBe('');
    expect(existsSync(join(dir, TOKEN_PATH))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ask mode + tool-mismatch token: asks', () => {
  const dir = askModeCwd();
  try {
    writeToken(dir, freshToken({ tool: 'mcp__homeassistant__HassTurnOff' }));
    const r = runGate(SENSITIVE_CALL, dir);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain('"permissionDecision": "ask"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strict mode + valid token: still blocks (token never upgrades a block)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ha-gate-'));
  mkdirSync(join(dir, '.claude-code-hermit'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-code-hermit', 'config.json'),
    JSON.stringify({ ha_safety_mode: 'strict' }),
  );
  try {
    writeToken(dir, freshToken());
    const r = runGate(SENSITIVE_CALL, dir);
    expect(r.exit).toBe(2);
    expect(r.stdout).toBe('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
