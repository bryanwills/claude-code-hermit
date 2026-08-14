// Deterministic writer for _hermit_versions in .claude-code-hermit/config.json.
// Moves the step-9 version bump out of LLM prose into code, so a dropped bump
// surfaces as a blocked report instead of a silent mismatch (issue #426).
//
// NOTE: this is a runner-invoked script, NOT a fail-open hook. It exits non-zero
// on any write/verify failure so the evolve-runner can report `blocked` rather
// than claiming success. Do not apply the hook fail-open (exit 0) pattern here.
//
// Usage:
//   bun evolve-finalize.ts [hermit-dir] --core=<version> --plugin-root=<abs>
//                          [--sibling=<name>=<version> ...]
//
// hermit-dir defaults to .claude-code-hermit (like evolve-plan.ts).
// --plugin-root cross-checks --core against plugin.json.version, so the stamp written
// here is always the loaded plugin's real version — check-upgrade.sh compares that stamp
// against plugin.json on every session start. Omit only in tests.
//
// The stamp only ever moves forward: see the monotonicity guard in finalize().
//
// Stdout: one JSON object matching FinalizeResult.
// Exit 0: ok:true and core confirmed on-disk.
// Exit 1: any error (no_core_target, no_config, config_json_invalid,
//          config_unreadable, plugin_json_unreadable, core_version_mismatch,
//          core_version_regression, bad_sibling_arg, write_failed, verify_failed,
//          fatal).

import fs from 'node:fs';
import path from 'node:path';
import { pinStateDirOrExit } from './lib/cc-compat';
import { cmpSemver } from './lib/semver';

type Json = any;

export interface FinalizeResult {
  ok: boolean;
  core: { requested: string; confirmed: string | null; matched: boolean };
  siblings_confirmed: Record<string, string>;
  siblings_skipped: string[];
  errors: { code: string; message: string }[];
}

function parseArgs(argv: string[]): {
  hermitDir: string;
  core: string | null;
  pluginRoot: string | null;
  siblings: { name: string; version: string }[];
} {
  let hermitDir = '.claude-code-hermit';
  let core: string | null = null;
  let pluginRoot: string | null = null;
  const siblings: { name: string; version: string }[] = [];

  for (const a of argv) {
    if (a.startsWith('--core=')) {
      core = a.slice('--core='.length);
    } else if (a.startsWith('--plugin-root=')) {
      pluginRoot = a.slice('--plugin-root='.length);
    } else if (a.startsWith('--sibling=')) {
      const rest = a.slice('--sibling='.length);
      const eq = rest.indexOf('=');
      siblings.push(
        eq === -1
          ? { name: rest, version: '' }                           // malformed — caught in finalize
          : { name: rest.slice(0, eq), version: rest.slice(eq + 1) },
      );
    } else if (!a.startsWith('--') && a !== '') {
      hermitDir = a;
    }
  }
  return { hermitDir, core, pluginRoot, siblings };
}

function isPlainObject(v: any): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function finalize(opts: {
  hermitDir: string;
  core: string | null;
  pluginRoot: string | null;
  siblings: { name: string; version: string }[];
}): FinalizeResult {
  const errors: { code: string; message: string }[] = [];
  const siblingsSkipped: string[] = [];

  if (!opts.core || opts.core.trim() === '') {
    errors.push({ code: 'no_core_target', message: '--core=<version> is required' });
    return { ok: false, core: { requested: opts.core ?? '', confirmed: null, matched: false }, siblings_confirmed: {}, siblings_skipped: [], errors };
  }

  // Validate sibling args. Malformed entries go to siblings_skipped (not errors) —
  // the runner always constructs valid args so a bad arg is a programming fault, not
  // a bump failure. It does not affect ok or block reporting.
  const validSiblings: { name: string; version: string }[] = [];
  for (const s of opts.siblings) {
    if (!s.name || s.version === '') {
      siblingsSkipped.push(`[bad-arg:${s.name || ''}]`);
    } else {
      validSiblings.push(s);
    }
  }

  // Cross-check --core against plugin.json.version: the stamp must be the loaded plugin's
  // real version, which is what check-upgrade.sh compares against at session start.
  // (Direction is a separate invariant — see the monotonicity guard below.)
  if (opts.pluginRoot) {
    let pluginVer: string | null = null;
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(opts.pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
      pluginVer = typeof pj.version === 'string' ? pj.version : null;
    } catch (e: any) {
      errors.push({ code: 'plugin_json_unreadable', message: e.message });
      return { ok: false, core: { requested: opts.core, confirmed: null, matched: false }, siblings_confirmed: {}, siblings_skipped: siblingsSkipped, errors };
    }
    if (pluginVer === null) {
      errors.push({ code: 'plugin_json_unreadable', message: 'plugin.json missing .version field' });
      return { ok: false, core: { requested: opts.core, confirmed: null, matched: false }, siblings_confirmed: {}, siblings_skipped: siblingsSkipped, errors };
    }
    if (pluginVer !== opts.core) {
      errors.push({ code: 'core_version_mismatch', message: `--core="${opts.core}" does not match plugin.json version="${pluginVer}"` });
      return { ok: false, core: { requested: opts.core, confirmed: null, matched: false }, siblings_confirmed: {}, siblings_skipped: siblingsSkipped, errors };
    }
  }

  // Read live config from disk (after step 9's new_config_keys merge is already written)
  const configPath = path.join(opts.hermitDir, 'config.json');
  let config: Json;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e: any) {
    const code = e && e.code === 'ENOENT' ? 'no_config'
      : e && e.name === 'SyntaxError' ? 'config_json_invalid'
      : 'config_unreadable';
    errors.push({ code, message: e.message });
    return { ok: false, core: { requested: opts.core, confirmed: null, matched: false }, siblings_confirmed: {}, siblings_skipped: siblingsSkipped, errors };
  }

  // Monotonicity guard. The stamp records which migrations have been APPLIED, so moving
  // it backwards claims migrations were reversed when nothing reversed them. That state
  // is reachable without this guard: when the session loads a stale (older) plugin copy,
  // the cross-check above passes (--core does equal that copy's plugin.json) and evolve
  // can still be running for sibling work, so step 9 would stamp the older version.
  // evolve-plan's `loaded_core_older_than_applied` blocks this upstream; this is the
  // backstop for any caller that skips the planner. Rejecting BEFORE any mutation is what
  // leaves config.json byte-identical and the sibling writes below unreached.
  //
  // Strictly-older only. Equal must pass: the documented sibling-only run re-stamps the
  // same version by design, and so does a re-run after a crash. An absent or unparseable
  // on-disk stamp also passes — absent is bootstrap (the object is created below), and
  // cmpSemver reads garbage as equal, which lets this sole writer REPAIR a hand-mangled
  // stamp instead of wedging evolve with no in-band recovery.
  const onDiskCore = isPlainObject(config._hermit_versions)
    ? config._hermit_versions['claude-code-hermit']
    : undefined;
  if (typeof onDiskCore === 'string' && cmpSemver(opts.core, onDiskCore) < 0) {
    errors.push({
      code: 'core_version_regression',
      message: `--core="${opts.core}" is older than the applied version "${onDiskCore}" in _hermit_versions — refusing to downgrade the stamp (migrations are not reversed by lowering it). The loaded plugin is likely a stale install copy.`,
    });
    return { ok: false, core: { requested: opts.core, confirmed: null, matched: false }, siblings_confirmed: {}, siblings_skipped: siblingsSkipped, errors };
  }

  // Core is the install marker so it's safe to create the object if absent.
  // Unconditional bump covers the step-10 deferred-migration caveat (always forward or
  // equal — the guard above has already rejected the backward direction).
  if (!isPlainObject(config._hermit_versions)) {
    config._hermit_versions = {};
  }
  config._hermit_versions['claude-code-hermit'] = opts.core;

  // Never add a new sibling key — only update keys already present.
  // Sibling versions arrive from a runner-assembled command line and get no plugin.json
  // cross-check, so apply the same no-downgrade rule here. A bad sibling arg is a skip,
  // never a failure: the file's existing posture (see [bad-arg:…] above) is that one
  // malformed sibling must not report an otherwise-good core bump as blocked.
  const appliedSiblingNames: string[] = [];
  for (const s of validSiblings) {
    if (Object.prototype.hasOwnProperty.call(config._hermit_versions, s.name)) {
      const existing = config._hermit_versions[s.name];
      if (typeof existing === 'string' && cmpSemver(s.version, existing) < 0) {
        siblingsSkipped.push(`[regression:${s.name}]`);
        continue;
      }
      config._hermit_versions[s.name] = s.version;
      appliedSiblingNames.push(s.name);
    } else {
      siblingsSkipped.push(s.name);
    }
  }

  // Atomic write: serialize → .tmp → rename (mirrors lib/cost-log.ts:60-62)
  const tmp = configPath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, configPath);
  } catch (e: any) {
    try { fs.unlinkSync(tmp); } catch {}
    errors.push({ code: 'write_failed', message: e.message });
    return { ok: false, core: { requested: opts.core, confirmed: null, matched: false }, siblings_confirmed: {}, siblings_skipped: siblingsSkipped, errors };
  }

  // Re-read from disk to confirm (the fix's whole point — catches a write that didn't land)
  let onDisk: Json;
  try {
    onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e: any) {
    errors.push({ code: 'verify_failed', message: `re-read after write failed: ${e.message}` });
    return { ok: false, core: { requested: opts.core, confirmed: null, matched: false }, siblings_confirmed: {}, siblings_skipped: siblingsSkipped, errors };
  }

  const coreOnDisk: string = (isPlainObject(onDisk._hermit_versions) ? onDisk._hermit_versions['claude-code-hermit'] : null) ?? '';
  const coreMatched = coreOnDisk === opts.core;
  if (!coreMatched) {
    errors.push({ code: 'verify_failed', message: `on-disk _hermit_versions["claude-code-hermit"]="${coreOnDisk}" but expected "${opts.core}"` });
  }

  const siblingsConfirmed: Record<string, string> = {};
  for (const name of appliedSiblingNames) {
    siblingsConfirmed[name] = onDisk._hermit_versions[name] ?? '';
  }

  return {
    ok: errors.length === 0 && coreMatched,
    core: { requested: opts.core, confirmed: coreOnDisk, matched: coreMatched },
    siblings_confirmed: siblingsConfirmed,
    siblings_skipped: siblingsSkipped,
    errors,
  };
}

if (import.meta.main) {
  const { hermitDir, core, pluginRoot, siblings } = parseArgs(process.argv.slice(2));
  let result: FinalizeResult;
  try {
    // The hermit dir is not caller-chosen. Reachable through a pre-approved
    // `Bash(bun */scripts/evolve-finalize.ts*)` grant that covers every
    // argument, and this script rewrites config.json wholesale — an
    // unvalidated root let one such call stamp _hermit_versions into another
    // project's config. See lib/cc-compat.ts assertStateDir().
    result = finalize({ hermitDir: pinStateDirOrExit(hermitDir, 'evolve-finalize'), core, pluginRoot, siblings });
  } catch (e: any) {
    result = {
      ok: false,
      core: { requested: core ?? '', confirmed: null, matched: false },
      siblings_confirmed: {},
      siblings_skipped: [],
      errors: [{ code: 'fatal', message: e.message }],
    };
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}
