#!/usr/bin/env bun
// domain-hatch.ts — the shared protocol every domain hatch runs, over
// lib/domain-hatch/.
//
// Reached from a domain plugin as:
//   .claude-code-hermit/bin/hermit-run domain-hatch <verb> <plugin-id> [args]
// A domain plugin's own ${CLAUDE_PLUGIN_ROOT} is
// <cache>/<marketplace>/<plugin>/<version>/ and cannot resolve core's, so the
// project-resident bin/hermit-run dispatcher is the route in.
//
// Usage:
//   bun domain-hatch.ts preflight <plugin-id> [--project-root <p>] [--state-dir <d>]
//     Read-only. Prints one JSON verdict: which of the two stale-core cases
//     applies (if any), whether this is a full run or a re-verify, the resolved
//     CLAUDE target, and what the CLAUDE-APPEND block needs. Always exits 0 —
//     callers read the fields, not the code.
//
//   bun domain-hatch.ts ensure-target <plugin-id> --target <local|committed>
//     Creates or repairs state/hatch-options.json. Core owns this file; the
//     verb exists so domain hatches stop carrying their own copy of the
//     detection and stamping rules.
//
//   bun domain-hatch.ts sync-block <plugin-id> [--rendered-stdin]
//     Appends the plugin's CLAUDE-APPEND block when absent, replaces it only
//     when rendered content is piped in and differs, refuses on a duplicated
//     marker. Version-driven refresh stays hermit-evolve's.
//
// Verb dispatch is lazy: preflight is the hot path (every hatch run, including
// the re-verify that changes nothing) and has no business loading the block
// writer to do its job.
//
// Mutating verbs exit 1 on failure, matching micro-proposal.ts /
// apply-settings.ts / hatch-config.ts. preflight is inspection and exits 0.

import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { flagValue } from './lib/cli';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');

function out(o: unknown): void {
  process.stdout.write(JSON.stringify(o) + '\n');
}

function die(code: string, message: string): never {
  out({ ok: false, error: code, message });
  process.exit(1);
}

const argv = process.argv.slice(2);
const verb = argv[0];
const pluginId = argv[1];

if (!verb || !pluginId) {
  process.stderr.write('Usage: domain-hatch.ts <preflight|ensure-target|sync-block> <plugin-id> [args]\n');
  process.exit(1);
}

// A plugin id is a bare plugin name — reject anything that could be read as a
// path. hermit-exec.sh checks the script name but forwards the rest of argv
// untouched, so this is the only place the identity argument is validated.
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pluginId)) {
  die('invalid_plugin_id', `not a plugin id: ${pluginId}`);
}

const stateDir = flagValue(argv, '--state-dir') ?? hermitDir();
const projectRoot = flagValue(argv, '--project-root') ?? path.resolve(stateDir, '..');
const stdinJsonFile = flagValue(argv, '--plugin-list-file');

async function readStdinIfFlagged(flag: string): Promise<string | undefined> {
  if (!argv.includes(flag)) return undefined;
  let buf = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

// Test seam shared by all three verbs: read the plugin list from a file so
// tests never shell out to a live `claude`.
async function readPluginListFile(): Promise<string | undefined> {
  if (!stdinJsonFile) return undefined;
  const fs = await import('node:fs');
  try { return fs.readFileSync(stdinJsonFile, 'utf8'); } catch { return undefined; }
}

if (verb === 'preflight') {
  const { preflight } = await import('./lib/domain-hatch/preflight');
  const stdinJson = await readPluginListFile();
  out(preflight({ pluginId, hermitDir: stateDir, projectRoot, corePluginRoot: PLUGIN_ROOT, stdinJson }));
  process.exit(0);
}

if (verb === 'ensure-target') {
  const target = flagValue(argv, '--target');
  if (target !== 'local' && target !== 'committed') {
    die('bad_target', '--target must be local or committed');
  }
  const [{ ensureHatchTarget }, { resolvePlugin, isResolveError, pluginList }, { coreScope }] = await Promise.all([
    import('./lib/domain-hatch/target'),
    import('./lib/domain-hatch/resolve'),
    import('./resolve-siblings'),
  ]);
  const stdinJson = await readPluginListFile();
  const list = pluginList(stdinJson);
  const resolved = resolvePlugin(list, pluginId, projectRoot);
  if (isResolveError(resolved)) die(resolved.error, resolved.message);
  const scope = coreScope(list as any, projectRoot);
  const res = ensureHatchTarget(stateDir, {
    target,
    core_scope: scope.core_scope,
    stampedBy: `${pluginId}:hatch`,
    version: resolved.version ?? '0.0.0',
  });
  out(res);
  process.exit(res.ok ? 0 : 1);
}

if (verb === 'sync-block') {
  const [{ planBlock, applyBlock }, { readTargetState, targetFile }, { resolvePlugin, isResolveError, pluginList }, { coreScope }] =
    await Promise.all([
      import('./lib/domain-hatch/block'),
      import('./lib/domain-hatch/target'),
      import('./lib/domain-hatch/resolve'),
      import('./resolve-siblings'),
    ]);
  const stdinJson = await readPluginListFile();
  const list = pluginList(stdinJson);
  const resolved = resolvePlugin(list, pluginId, projectRoot);
  if (isResolveError(resolved)) die(resolved.error, resolved.message);

  const state = readTargetState(stateDir, coreScope(list as any, projectRoot), projectRoot);
  if (!state.target) {
    die('no_target', 'hatch-options.json has no usable target; run ensure-target first');
  }

  const rendered = await readStdinIfFlagged('--rendered-stdin');
  const foreign = list
    .map((e: any) => String(e?.id ?? '').split('@')[0])
    .filter((n: string) => n && n !== pluginId);

  const result = applyBlock(
    planBlock(resolved.installPath, pluginId, path.join(projectRoot, targetFile(state.target)), foreign, rendered),
  );
  out(result);
  process.exit(result.ok ? 0 : 1);
}

process.stderr.write(`domain-hatch.ts: unknown verb "${verb}"\n`);
process.exit(1);
