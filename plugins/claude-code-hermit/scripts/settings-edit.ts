/**
 * settings-edit.ts — read-modify-write helper for .claude-code-hermit/config.json scalar/enum edits.
 *
 * Usage: bun settings-edit.ts <config-file> <op> [args...]
 *
 * Operations:
 *   get [dotted.path]        Print the JSON value at path (whole config if path omitted)
 *   set <dotted.path> <val>  Set a nested leaf, creating parent objects as needed
 *   toggle <dotted.path>     Boolean flip (absent → true; errors if current isn't boolean)
 *   show                     Render the operator-facing settings summary from live values
 *   apply-known <arg> <val>  Write one registry-backed setting, validated by kind/enum
 *
 * Value parsing for `set`: 'none'/'clear' → null; otherwise JSON.parse first
 * (so true, 42, "x", {...} work), falling back to the raw string on parse failure.
 *
 * Rules:
 * - Changes only the target leaf; all sibling keys are preserved (read-modify-write).
 * - Refuses to overwrite an existing-but-malformed config.json (never falls through to {}).
 * - Safe under AGENT_HOOK_PROFILE=strict: writes via fs, not the Edit/Write tools.
 * - Zero runtime deps.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS, READ_ONLY, byArg, type Setting } from './lib/settings/registry';

type Json = any;

// Strict read: an existing-but-malformed file must abort, never fall through to {},
// otherwise the write below would clobber the operator's config with our subset.
function readTargetJson(filePath: string): Json {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(
      `Refusing to overwrite ${filePath}: file exists but is not valid JSON ` +
        `(${(err as Error).message}). Fix or remove it, then re-run.`,
    );
    process.exit(1);
  }
}

function writeJson(filePath: string, data: Json): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic write: a torn config.json would make readTargetJson (strict) exit(1)
  // on every later run, locking the operator out of config edits.
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function parseValue(raw: string): Json {
  if (raw === 'none' || raw === 'clear') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// --- Pure path helpers (exported for unit tests) ---

export function getPath(obj: Json, dotted?: string): Json {
  if (!dotted) return obj;
  let cur = obj;
  for (const key of dotted.split('.')) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function setPath(obj: Json, dotted: string, value: Json): Json {
  const keys = dotted.split('.');
  const leaf = keys.pop()!;
  let cur = obj;
  for (const key of keys) {
    if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {};
    cur = cur[key];
  }
  cur[leaf] = value;
  return obj;
}

export function togglePath(obj: Json, dotted: string): Json {
  const current = getPath(obj, dotted);
  if (current !== undefined && typeof current !== 'boolean') {
    throw new Error(`toggle: value at '${dotted}' is not a boolean (got ${JSON.stringify(current)})`);
  }
  return setPath(obj, dotted, current === undefined ? true : !current);
}

// --- show: render the settings summary from live values ---
//
// This replaces a hand-written *example* dump in hermit-settings/SKILL.md — a
// ~45-line block of invented values whose field list drifted every release and
// which showed the operator someone else's configuration. Rendering the real
// file is both accurate and strictly more useful.

/** Present a config value the way an operator reads it, not the way JSON stores it. */
export function renderValue(v: Json, s?: Setting): string {
  if (v === undefined) return s?.nullable ? 'not set' : 'default';
  if (v === null) return 'none';
  if (typeof v === 'boolean') return v ? 'enabled' : 'disabled';
  if (Array.isArray(v)) return v.length ? `${v.length} configured` : 'none';
  if (typeof v === 'object') return 'configured';
  return String(v);
}

/** Rows for the stateful sections `show` summarizes but the registry doesn't own. */
function statefulRows(config: Json): Array<[string, string, string]> {
  const channels = config.channels ?? {};
  const channelNames = Object.keys(channels).filter(k => k !== 'primary');
  const enabled = channelNames.filter(n => channels[n]?.enabled);
  const routines = Array.isArray(config.routines) ? config.routines : [];
  const checks = Array.isArray(config.scheduled_checks) ? config.scheduled_checks : [];
  const envKeys = Object.keys(config.env ?? {});
  const packages = config.docker?.packages ?? [];
  const hb = config.heartbeat ?? {};
  const wd = config.watchdog ?? {};
  const compact = config.compact ?? {};
  // The brief lives per-channel (`channels.<name>.morning_brief`), so it has no
  // registry row — but `/hermit-settings brief` is a real argument and the view
  // it replaced showed the brief's state, so it belongs here.
  const briefOn = channelNames.filter(n => channels[n]?.morning_brief?.enabled);
  const brief = briefOn.length
    ? briefOn.map(n => `${n} ${channels[n].morning_brief.time ?? '?'}`).join(', ')
    : 'disabled';

  return [
    ['Channels', enabled.length ? `${enabled.join(', ')} enabled` : channelNames.length ? 'configured, none enabled' : 'none', 'channels'],
    ['Morning brief', brief, 'brief'],
    ['Heartbeat', hb.enabled ? `every ${hb.every ?? '?'}` : 'disabled', 'heartbeat'],
    ['Watchdog', wd.enabled ? 'enabled' : 'disabled', 'watchdog'],
    ['Routines', routines.length ? `${routines.filter((r: Json) => r?.enabled).length} of ${routines.length} enabled` : 'none', 'routines'],
    ['Scheduled checks', checks.length ? `${checks.filter((c: Json) => c?.enabled).length} of ${checks.length} enabled` : 'none', 'scheduled-checks'],
    ['Environment', envKeys.length ? envKeys.join(', ') : 'none', 'env'],
    ['Compaction', `monitoring ${compact.monitoring_threshold ?? '?'}/${compact.monitoring_keep ?? '?'}, summary ${compact.summary_threshold ?? '?'}/${compact.summary_keep ?? '?'}`, 'compact'],
    ['Docker packages', Array.isArray(packages) && packages.length ? packages.join(', ') : 'none', 'docker'],
  ];
}

export function renderShow(config: Json, configPath: string): string {
  const out: string[] = [`Hermit Settings (${configPath})`, ''];
  // Math.max(1, …) — an over-long value (a long env-var list) must still leave a
  // space before the arrow rather than butting up against it.
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(1, n - s.length));

  for (const group of ['Identity', 'Operational', 'Artifacts'] as const) {
    const rows = SETTINGS.filter(s => s.group === group);
    const ro = READ_ONLY.filter(r => r.group === group);
    if (!rows.length && !ro.length) continue;
    out.push(`${group}:`);
    for (const s of rows) {
      const value = renderValue(getPath(config, s.path), s);
      const applies = s.applies ? `  (${s.applies})` : '';
      out.push(`  ${pad(s.label + ':', 22)}${pad(value, 22)}→ ${s.arg}${applies}`);
    }
    for (const r of ro) {
      out.push(`  ${pad(r.label + ':', 22)}${pad(renderValue(getPath(config, r.path)), 22)}→ read-only`);
    }
    out.push('');
  }

  out.push('Stateful (each has its own wizard):');
  for (const [label, value, arg] of statefulRows(config)) {
    out.push(`  ${pad(label + ':', 22)}${pad(value, 22)}→ ${arg}`);
  }
  return out.join('\n');
}

// --- apply-known: write one registry-backed setting, validated ---
//
// `set` takes any dotted path and any JSON value, which is right for the
// stateful branches that compose their own writes. For the table-driven
// arguments it is too loose: this script writes through `fs`, so the
// `validate-config.ts` PostToolUse hook never sees the write, and a typo'd enum
// or a mistyped path would land silently. `apply-known` takes the *argument
// name* the operator typed, so neither the path nor the value can be invented.

export interface ApplyResult {
  ok: boolean;
  /** Human-readable outcome or refusal reason. */
  message: string;
  path?: string;
  value?: Json;
}

export function coerce(setting: Setting, raw: string): { ok: true; value: Json } | { ok: false; message: string } {
  if ((raw === 'none' || raw === 'clear')) {
    if (!setting.nullable) return { ok: false, message: `${setting.arg} cannot be cleared` };
    return { ok: true, value: null };
  }
  // On a nullable row, "default" means "inherit Claude Code's default", not a
  // value: storing the literal string would send `--model default` on the next
  // `hermit-start`. Only nullable rows — `permission_mode` has a real `default`.
  if (setting.nullable && raw === 'default') return { ok: true, value: null };
  switch (setting.kind) {
    case 'boolean': {
      const truthy = ['true', 'yes', 'on', 'enable', 'enabled'];
      const falsy = ['false', 'no', 'off', 'disable', 'disabled'];
      const v = raw.toLowerCase();
      if (truthy.includes(v)) return { ok: true, value: true };
      if (falsy.includes(v)) return { ok: true, value: false };
      return { ok: false, message: `${setting.arg} expects on/off (got "${raw}")` };
    }
    case 'enum': {
      const values = setting.values ?? [];
      if (!values.includes(raw)) {
        return { ok: false, message: `${setting.arg}: "${raw}" not in [${values.join(', ')}]` };
      }
      return { ok: true, value: raw };
    }
    case 'int': {
      if (!/^\d+$/.test(raw)) return { ok: false, message: `${setting.arg} expects a positive integer (got "${raw}")` };
      const n = parseInt(raw, 10);
      if (n < 1) return { ok: false, message: `${setting.arg} expects a positive integer (got "${raw}")` };
      return { ok: true, value: n };
    }
    default:
      // Free-text rows store the operator's value verbatim, so refuse an empty one
      // here — this is the point of the write. Clearing goes through none/clear above
      // (nullable rows only); an empty string is not a value any string row wants.
      if (raw.trim() === '') return { ok: false, message: `${setting.arg} expects a non-empty value` };
      return { ok: true, value: raw };
  }
}

export function applyKnown(config: Json, arg: string, raw: string): ApplyResult {
  const setting = byArg(arg);
  if (!setting) {
    return { ok: false, message: `unknown setting "${arg}" — see the argument table in /hermit-settings` };
  }
  const coerced = coerce(setting, raw);
  if (!coerced.ok) return { ok: false, message: coerced.message };
  setPath(config, setting.path, coerced.value);
  return {
    ok: true,
    message: `${setting.label} → ${coerced.value === null ? 'none' : coerced.value}` +
      (setting.applies ? ` (applies: ${setting.applies})` : ''),
    path: setting.path,
    value: coerced.value,
  };
}

// --- CLI dispatch ---

if (import.meta.main) {
  const [, , targetFile, op, ...rest] = process.argv;

  if (!targetFile || !op) {
    console.error('Usage: settings-edit.ts <config-file> <op> [args...]');
    process.exit(1);
  }

  const config = readTargetJson(targetFile);

  switch (op) {
    case 'get': {
      const value = getPath(config, rest[0]);
      console.log(JSON.stringify(value, null, 2));
      break;
    }

    case 'show': {
      console.log(renderShow(config, targetFile));
      break;
    }

    case 'apply-known': {
      const [arg, value] = rest;
      if (!arg || value === undefined) {
        console.error('apply-known requires <setting-argument> <value>');
        process.exit(1);
      }
      const result = applyKnown(config, arg, value);
      if (!result.ok) { console.error(result.message); process.exit(1); }
      writeJson(targetFile, config);
      console.log(result.message);
      break;
    }

    case 'set': {
      const dotted = rest[0];
      if (!dotted) { console.error('set requires a dotted.path argument'); process.exit(1); }
      if (rest.length < 2) { console.error('set requires a value argument'); process.exit(1); }
      setPath(config, dotted, parseValue(rest[1]));
      writeJson(targetFile, config);
      break;
    }

    case 'toggle': {
      const dotted = rest[0];
      if (!dotted) { console.error('toggle requires a dotted.path argument'); process.exit(1); }
      try {
        togglePath(config, dotted);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      writeJson(targetFile, config);
      break;
    }

    default: {
      console.error(`Unknown operation: ${op}. Valid ops: get, set, toggle, show, apply-known`);
      process.exit(1);
    }
  }
}
