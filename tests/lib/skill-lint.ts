// Shared structural lint for plugin SKILL.md files. Monorepo dev tooling only —
// never shipped to operators, which is why it may live at the repo root and be
// imported across plugin boundaries (same territory as tests/cross-plugin/).
//
// What lintSkills checks (and what it does NOT):
//   ✓ Frontmatter present and parseable; `name` and `description` set.
//   ✓ Frontmatter `name` matches the parent directory name.
//   ✓ Expected gate count (and Gate 0/Gate N-1 markers visible).
//   ✓ Internal markdown links resolve to existing on-disk files.
// We do NOT execute the skill or assert on its prose semantics — that's the
// LLM's job at runtime. This is structural lint only.
//
// lintSkills is pure: it returns failure messages and never prints or exits, so
// both the console-reporter suites (dev/fitness/forge, which run each lint as
// its own `bun` process) and feed's `bun test` suite can consume it.

import fs from 'node:fs';
import path from 'node:path';

type Frontmatter = { raw: string; fields: Record<string, string>; body: string };

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns { raw, fields, body }, or null when no frontmatter block is present.
 * Block scalars (`>`, `>-`, `|`, `|-`) are folded into a single-line value —
 * several shipped skills write their `description:` that way.
 */
function parseFrontmatter(text: string): Frontmatter | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const folded: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        folded.push(lines[++i].trim());
      }
      value = folded.join(' ');
    }
    fields[kv[1]] = value.replace(/^["']|["']$/g, '');
  }
  return { raw: m[1], fields, body: text.slice(m[0].length) };
}

function makeReporter() {
  let passed = 0;
  let failed = 0;
  function ok(name: string, cond: boolean, detail?: string) {
    if (cond) {
      console.log(`  ✓ ${name}`);
      passed += 1;
    } else {
      console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
      failed += 1;
    }
  }
  function summary(): number {
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    return failed;
  }
  return { ok, summary };
}

type SkillExpectation = {
  name: string;
  /** Number of `### Gate N —` headers. 0 → the skill is not gate-shaped. */
  gates: number;
};

/**
 * Lint every expected SKILL.md under `<pluginRoot>/skills/`.
 * Returns one message per failed check; an empty array means the lint passed.
 */
function lintSkills(pluginRoot: string, skills: SkillExpectation[]): string[] {
  const failures: string[] = [];
  const skillDir = path.join(pluginRoot, 'skills');

  for (const { name, gates } of skills) {
    const file = path.join(skillDir, name, 'SKILL.md');
    if (!fs.existsSync(file)) {
      failures.push(`${name}: SKILL.md missing at ${file}`);
      continue;
    }

    const fm = parseFrontmatter(fs.readFileSync(file, 'utf-8'));
    if (!fm) {
      failures.push(`${name}: frontmatter not parseable`);
      continue;
    }

    if (!fm.fields.name) failures.push(`${name}: frontmatter has no name`);
    else if (fm.fields.name !== name) failures.push(`${name}: frontmatter name is ${fm.fields.name}`);
    if (!fm.fields.description || fm.fields.description.length <= 20) {
      failures.push(`${name}: frontmatter description missing or too short`);
    }

    const gateMatches = fm.body.match(/^### Gate \d+ —/gm) || [];
    if (gateMatches.length !== gates) {
      failures.push(`${name}: expected ${gates} Gate headers, found ${gateMatches.length}`);
    }
    if (gates > 0) {
      if (!/^### Gate 0 —/m.test(fm.body)) failures.push(`${name}: Gate 0 missing`);
      if (!new RegExp(`^### Gate ${gates - 1} —`, 'm').test(fm.body)) {
        failures.push(`${name}: Gate ${gates - 1} missing`);
      }
    }

    // Internal links: resolve [text](relative/path) and verify the target exists.
    // Skip absolute URLs (http://, mailto:) and same-document anchors (#section).
    const linkRe = /\[[^\]]+\]\(([^)]+)\)/g;
    const skillBaseDir = path.dirname(file);
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRe.exec(fm.body)) !== null) {
      const target = linkMatch[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      // Strip any anchor suffix.
      const cleanTarget = target.split('#')[0];
      if (!cleanTarget) continue;
      const resolved = path.resolve(skillBaseDir, cleanTarget);
      if (!fs.existsSync(resolved)) failures.push(`${name}: bad link ${target} → ${resolved}`);
    }
  }

  return failures;
}

export { parseFrontmatter, makeReporter, lintSkills };
export type { Frontmatter, SkillExpectation };
