// Plugin-identity resolution for the domain-hatch verbs.
//
// Every verb takes a plugin ID, never a filesystem root. `hermit-exec.sh`
// validates only the script name and forwards the rest of argv verbatim, so a
// path supplied through skill prose would be an unchecked trust boundary — an
// ID is checked here against the installed, enabled plugin list instead.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson } from '../cli';

type Json = any;

export interface ResolvedPlugin {
  plugin: string;
  installPath: string;
  version: string | null;
  required_core_version: string | null;
}

export interface ResolveError {
  error: string;
  message: string;
}

// The plugin list, or [] when `claude` is unavailable. Callers treat an empty
// list as "cannot resolve" rather than "plugin absent" — the two produce
// different operator advice.
export function pluginList(stdinJson?: string): Json[] {
  if (stdinJson !== undefined) {
    const parsed = (() => { try { return JSON.parse(stdinJson); } catch { return null; } })();
    return Array.isArray(parsed) ? parsed : [];
  }
  try {
    const r = spawnSync('claude', ['plugin', 'list', '--json'], { timeout: 15000, encoding: 'utf8' });
    const parsed = r.stdout ? JSON.parse(r.stdout) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function splitId(id: string): string {
  const at = id.indexOf('@');
  return at < 0 ? id : id.slice(0, at);
}

// Resolve one plugin ID to the install that would actually load in this
// project. Precedence mirrors coreScope()'s: `local` > `project` (both require
// `projectPath == project root`) > `user` (any `projectPath` — a user-scope
// install is live in every project, which is why coreScope's user branch
// ignores projectPath too). Dropping the user tier here would make every
// user-scope install unresolvable, and `core_install_scope: "user"` is a value
// hatch-options.json is explicitly allowed to carry.
// Ambiguity across marketplaces is an error, not a silent first-match:
// picking wrong here writes a hermit block sourced from the wrong template.
export function resolvePlugin(
  list: Json[],
  pluginId: string,
  projectRoot: string,
): ResolvedPlugin | ResolveError {
  const enabled = list.filter((e) => splitId(e?.id ?? '') === pluginId && e?.enabled === true);
  const here = enabled.filter((e) => e?.projectPath === projectRoot);
  const byScope = (pool: Json[], s: string) => pool.filter((e) => e?.scope === s);
  const local = byScope(here, 'local');
  const project = byScope(here, 'project');
  const user = byScope(enabled, 'user');
  const candidates = local.length ? local : project.length ? project : user;

  if (!candidates.length) {
    return list.length
      ? { error: 'plugin_not_installed', message: `${pluginId} is not installed and enabled for this project` }
      : { error: 'plugin_list_unavailable', message: 'could not read `claude plugin list --json`' };
  }
  if (candidates.length > 1) {
    return {
      error: 'plugin_ambiguous',
      message: `${pluginId} is provided by more than one marketplace at the same scope: ${candidates.map((e) => e.id).join(', ')}`,
    };
  }

  const installPath = candidates[0]?.installPath ?? '';
  if (!installPath || !fs.existsSync(installPath)) {
    return { error: 'plugin_path_missing', message: `${pluginId} resolved to a path that does not exist: ${installPath || '(empty)'}` };
  }

  const manifest = readJson(path.join(installPath, '.claude-plugin', 'plugin.json'));
  const meta = readJson(path.join(installPath, '.claude-plugin', 'hermit-meta.json'));
  return {
    plugin: pluginId,
    installPath,
    version: manifest?.version ?? null,
    required_core_version: meta?.required_core_version ?? null,
  };
}

export function isResolveError(r: ResolvedPlugin | ResolveError): r is ResolveError {
  return (r as ResolveError).error !== undefined;
}
