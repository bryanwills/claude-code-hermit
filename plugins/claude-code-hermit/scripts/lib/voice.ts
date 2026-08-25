// The hermit's voice carrier: a native Claude Code output style.
//
// Claude Code builds `.claude/output-styles/<outputStyle>.md` into the SYSTEM
// PROMPT at session start, which is why tone lives here rather than in
// session-start context — the system prompt is re-read on every API call and
// survives compaction, while injected context ages and is dropped.
//
// Three surfaces need these values (apply-settings' sealed op, hermit-start's
// boot repair, and the hermit-doctor check), so they are defined once here.

import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './cli';
import { defaultConfigDir } from './setup-token';

/** The style name, and therefore the basename of the file Claude Code loads. */
export const HERMIT_OUTPUT_STYLE = 'hermit-voice';

/**
 * Claude Code's built-in output styles, exactly as the installed CLI persists them
 * (extracted from the shipped binary's style registry, not the docs — the docs never
 * state the persisted value for Default). Every literal here matches its display name
 * except "default": the picker shows "Default" but writes the lowercase key.
 */
export const BUILTIN_OUTPUT_STYLES = ['default', 'Concise', 'Explanatory', 'Learning', 'Proactive'] as const;

/** Every outputStyle value this plugin's tooling accepts as caller input. */
export const SEALED_OUTPUT_STYLES = [...BUILTIN_OUTPUT_STYLES, HERMIT_OUTPUT_STYLE] as const;

/** Type guard: is `style` one of SEALED_OUTPUT_STYLES? Centralizes the readonly-tuple cast. */
export function isSealedOutputStyle(style: string): style is typeof SEALED_OUTPUT_STYLES[number] {
  return (SEALED_OUTPUT_STYLES as readonly string[]).includes(style);
}

/** Project-relative path of the style file hatch renders. */
export const VOICE_FILE_REL = path.join(
  '.claude',
  'output-styles',
  `${HERMIT_OUTPUT_STYLE}.md`,
);

/** Does this project carry the hermit's voice file? */
export function voiceFileExists(projectRoot = '.'): boolean {
  return fs.existsSync(path.join(projectRoot, VOICE_FILE_REL));
}

/** Persisted-settings scopes that can set outputStyle, in Claude Code's precedence order. */
const PROJECT_SETTINGS_SCOPES = ['.claude/settings.local.json', '.claude/settings.json'] as const;
const USER_SETTINGS_SCOPE = 'user' as const;
const SETTINGS_SCOPES = [...PROJECT_SETTINGS_SCOPES, USER_SETTINGS_SCOPE] as const;

export type PersistedStyle = {
  /** The winning outputStyle value, or null when no persisted scope sets one. */
  value: string | null;
  /** Which scope supplied it. */
  source: typeof SETTINGS_SCOPES[number] | null;
};

// readJson returns null for a missing, unreadable or malformed file, so a broken
// settings file falls through to the next scope rather than taking the whole
// check down.
function readOutputStyle(settingsFile: string): string | null {
  const value = readJson(settingsFile)?.outputStyle;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Resolve the outputStyle set in the two project scopes, local over project.
 *
 * This is the seed question — "would writing the key here actually take effect?" —
 * so it deliberately stops at project scope. Both scopes here outrank user scope,
 * so a user-scope value cannot shadow a write to either and must not veto one.
 *
 * Checking only the hermit's own hatch target would miss the case that matters:
 * a hermit that wrote the key to committed settings.json while the operator's
 * /config pick sits in settings.local.json and silently outranks it.
 */
export function resolveProjectStyle(projectRoot = '.'): PersistedStyle {
  for (const rel of PROJECT_SETTINGS_SCOPES) {
    const value = readOutputStyle(path.join(projectRoot, rel));
    if (value !== null) return { value, source: rel };
  }
  return { value: null, source: null };
}

/**
 * Resolve the outputStyle a session in `projectRoot` reads from disk, across every
 * persisted scope in Claude Code's precedence order: local, then project, then user.
 *
 * This is the reporting question — "what is this install actually going to use?" —
 * and is for hermit-doctor, not for deciding whether to write. It does NOT see
 * managed settings or a launch-time `--settings` overlay; both outrank every scope
 * here, and hermit-start ships such an overlay for the classifier, so this reports
 * what is persisted, not necessarily what a given session's system prompt ends up
 * using.
 */
export function resolvePersistedStyle(projectRoot = '.'): PersistedStyle {
  const project = resolveProjectStyle(projectRoot);
  if (project.value !== null) return project;
  const userValue = readOutputStyle(path.join(defaultConfigDir(), 'settings.json'));
  if (userValue !== null) return { value: userValue, source: USER_SETTINGS_SCOPE };
  return { value: null, source: null };
}
