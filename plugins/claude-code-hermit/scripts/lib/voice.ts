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

/** The style name, and therefore the basename of the file Claude Code loads. */
export const HERMIT_OUTPUT_STYLE = 'hermit-voice';

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

/** Settings scopes that can set outputStyle, in Claude Code's precedence order. */
const SETTINGS_SCOPES = ['.claude/settings.local.json', '.claude/settings.json'] as const;

export type EffectiveStyle = {
  /** The winning outputStyle value, or null when no settings file sets one. */
  value: string | null;
  /** Which settings file supplied it. */
  source: typeof SETTINGS_SCOPES[number] | null;
};

/**
 * Resolve the outputStyle a session in `projectRoot` will actually get.
 *
 * Local scope wins over project scope, matching Claude Code's own precedence.
 * Checking only the hermit's own hatch target would miss the case that matters
 * most: a hermit that wrote the key to committed settings.json while the
 * operator's /config pick sits in settings.local.json and silently outranks it.
 */
export function resolveEffectiveStyle(projectRoot = '.'): EffectiveStyle {
  for (const rel of SETTINGS_SCOPES) {
    // readJson returns null for a missing, unreadable or malformed file, so a
    // broken local settings file falls through to project scope rather than
    // taking the whole check down.
    const value = readJson(path.join(projectRoot, rel))?.outputStyle;
    if (typeof value === 'string' && value.trim() !== '') {
      return { value: value.trim(), source: rel };
    }
  }
  return { value: null, source: null };
}
