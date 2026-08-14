// Structural and behavioral tests for write-confirm-gate.ts
// Run with: bun test tests/hook.test.ts
//
// Classification is tested as a function (classify); spawns are kept only for
// the process edges the function cannot cover — stdin parsing, exit codes and
// the stderr message.

import { test, expect, describe } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { classify, SAFE_SUBCOMMANDS, WRITE_SUBCOMMANDS } from '../hooks/write-confirm-gate';

const HOOK = path.join(import.meta.dir, '..', 'hooks', 'write-confirm-gate.ts');
const FORGE_PHP = path.join(import.meta.dir, '..', 'php', 'forge.php');

function runHook(payload: unknown): { exitCode: number; stderr: string; stdout: string } {
  const input = JSON.stringify(payload);
  const result = spawnSync('bun', [HOOK], {
    input,
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

describe('classify: the subcommand inventories', () => {
  test('every safe subcommand passes', () => {
    for (const sub of SAFE_SUBCOMMANDS) {
      expect(classify(`php /plugin/php/forge.php ${sub}`).gate).toBe('pass');
    }
  });

  // The inventory-sync test below pushes new forge.php subcommands into one of
  // these lists; a write landing in SAFE_SUBCOMMANDS would satisfy it while
  // silently disarming the gate.
  test('no subcommand is both safe and a write', () => {
    const writes = Object.keys(WRITE_SUBCOMMANDS);
    expect(SAFE_SUBCOMMANDS.filter(sub => writes.includes(sub))).toEqual([]);
  });
});

describe('classify: pass-through cases', () => {
  const PASS_CASES: Array<[string, string]> = [
    ['a command not involving forge.php', 'ls -la'],
    ['forge.php with no subcommand token', 'php /plugin/php/forge.php'],
    ['a read command with arguments', 'php /plugin/php/forge.php site-log web-1 example.com application'],
    ['deploy-status — a read-only poll, not a write', 'php /plugin/php/forge.php deploy-status 12 34 8821'],
    ['deploy-watch — a read-only poll loop, not a write', 'php /plugin/php/forge.php deploy-watch 12 34 8821'],
    ['a piped generic-dispatch read', 'echo \'["s1"]\' | php /plugin/php/forge.php call servers'],
    // `execute` does mutate. It is deliberately not gated here: its authority is
    // the plan hash and the operator's channel approval, and neither is visible
    // in a Bash command string. A hook that documents itself as fail-open must
    // not pretend to own that decision.
    ['execute — the PHP hash check owns this gate, not the hook', 'php /plugin/php/forge.php execute fp-3f9a1c7b'],
    ['an unknown subcommand — the in-PHP gate handles it', 'php /plugin/php/forge.php delete-site prod-web myapp.com'],
    ['deploy with --confirm', 'php /plugin/php/forge.php deploy prod-web myapp.com --confirm'],
    ['deploy with --confirm after another flag', 'php /plugin/php/forge.php deploy prod-web myapp.com --json --confirm'],
    ['server-reboot with --confirm', 'php /plugin/php/forge.php server-reboot prod-web --confirm'],
    ['${CLAUDE_PLUGIN_ROOT} deploy with --confirm', 'php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy srv site --confirm'],
    ['an env-var prefix before a safe subcommand', 'FOO=bar php ${CLAUDE_PLUGIN_ROOT}/php/forge.php preview createMonitor'],
  ];

  for (const [label, command] of PASS_CASES) {
    test(label, () => {
      expect(classify(command).gate).toBe('pass');
    });
  }
});

describe('classify: writes lacking --confirm need confirmation', () => {
  const BLOCK_CASES: Array<[string, string, string, string]> = [
    ['deploy without --confirm', 'php /plugin/php/forge.php deploy prod-web myapp.com', 'deploy', 'preview-deploy'],
    ['deploy with an unrelated trailing flag', 'php /plugin/php/forge.php deploy prod-web myapp.com --json', 'deploy', 'preview-deploy'],
    // --confirm is matched as an exact token, mirroring the in-PHP in_array().
    ['deploy with a --confirm substring flag', 'php /plugin/php/forge.php deploy prod-web myapp.com --confirm-later', 'deploy', 'preview-deploy'],
    ['server-reboot without --confirm', 'php /plugin/php/forge.php server-reboot prod-web', 'server-reboot', 'preview-reboot'],
    ['an env-var prefix does not confuse tokenization', 'FORGE_ORG=myorg php /plugin/php/forge.php deploy srv site', 'deploy', 'preview-deploy'],
    // Under --plugin-dir the harness does not substitute ${CLAUDE_PLUGIN_ROOT},
    // so the literal reaches the hook and must still resolve to forge.php.
    ['${CLAUDE_PLUGIN_ROOT} as a literal path', 'php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy srv site', 'deploy', 'preview-deploy'],
  ];

  for (const [label, command, subcommand, preview] of BLOCK_CASES) {
    test(label, () => {
      expect(classify(command)).toEqual({ gate: 'needs-confirm', subcommand, preview });
    });
  }
});

describe('inventory sync: forge.php dispatch vs the hook classifier', () => {
  // A subcommand added to forge.php but not classified here would fall through
  // the hook's unknown-subcommand branch, silently reducing the documented
  // two-layer write gate to the in-PHP check alone.
  test('every forge.php subcommand is classified', () => {
    const source = readFileSync(FORGE_PHP, 'utf8');
    // Any non-empty quoted literal, so a subcommand with a digit or underscore
    // is not silently invisible to this check.
    const dispatched = [...source.matchAll(/\$cmd === '([^']+)'/g)].map(m => m[1]!);
    const unique = [...new Set(dispatched)];

    // Guards against the regex silently rotting into a vacuous pass if the
    // dispatch style in forge.php ever changes.
    expect(unique.length).toBeGreaterThanOrEqual(24);

    const known = new Set([...SAFE_SUBCOMMANDS, ...Object.keys(WRITE_SUBCOMMANDS)]);
    const unclassified = unique.filter(sub => !known.has(sub));
    expect(unclassified).toEqual([]);
  });
});

describe('write-confirm-gate: process contract', () => {
  test('a write lacking --confirm exits 2 and names the preview command', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php /plugin/php/forge.php deploy prod-web myapp.com' } });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--confirm');
    expect(r.stderr).toContain('preview-deploy');
  });

  test('a write with --confirm exits 0', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php /plugin/php/forge.php deploy prod-web myapp.com --confirm' } });
    expect(r.exitCode).toBe(0);
  });

  test('non-Bash tool calls are never classified', () => {
    const r = runHook({ tool_name: 'Read', tool_input: { file_path: '/some/file' } });
    expect(r.exitCode).toBe(0);
  });

  test('a Bash payload without a command string passes through', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: {} });
    expect(r.exitCode).toBe(0);
  });
});

describe('write-confirm-gate: fail-open on bad input', () => {
  // A hook must never block Claude Code on a parse glitch — unparseable or
  // empty stdin passes through; the authoritative in-PHP --confirm gate remains.
  test('malformed JSON input passes through', () => {
    const result = spawnSync('bun', [HOOK], {
      input: 'not json',
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(0);
  });

  test('empty stdin passes through', () => {
    const result = spawnSync('bun', [HOOK], {
      input: '',
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(0);
  });
});
