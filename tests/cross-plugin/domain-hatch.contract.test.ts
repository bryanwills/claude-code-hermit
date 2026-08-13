// Cross-plugin guard: every domain hatch runs the shared protocol, and none of
// them carries a second copy of it.
//
// Lives at the repo root rather than in any plugin's suite because it spans
// plugins — a core-owned copy would never run on a domain-only PR under the
// per-plugin path filters, and a per-plugin copy would have to be remembered
// five times.
//
// Discovery is derived from the filesystem. The two hardcoded lists this
// replaces (hatch-resume-contract's DOMAIN_SLUGS, hatch-options-contract's
// single dev-hermit check) both went stale when a fifth plugin shipped, so a
// sixth must be covered the day it lands, without anyone updating a list.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { extractSiblingMarker, closingMarkerFor } from '../../plugins/claude-code-hermit/scripts/evolve-plan';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');

interface DomainHatch {
  slug: string;
  file: string;
  text: string;
  templateText: string;
}

// A plugin is in scope when it has a hatch, declares a core dependency, and
// that hatch actually does target routing. The first two conditions alone would
// pull in hermit-scribe, which declares the dependency but carries none of the
// protocol prose (it only reads the target, never resolves or stamps it), so a
// rewrite loop over that set would try to edit a file with nothing to edit.
function pluginSlugs(): string[] {
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'claude-code-hermit')
    .map((d) => d.name);
}

function discover(): DomainHatch[] {
  return pluginSlugs()
    .map((slug) => ({
      slug,
      file: path.join(PLUGINS_DIR, slug, 'skills', 'hatch', 'SKILL.md'),
      meta: path.join(PLUGINS_DIR, slug, '.claude-plugin', 'hermit-meta.json'),
    }))
    .filter((p) => fs.existsSync(p.file) && fs.existsSync(p.meta))
    .map((p) => {
      const meta = (() => { try { return JSON.parse(fs.readFileSync(p.meta, 'utf-8')); } catch { return null; } })();
      return { slug: p.slug, file: p.file, meta, text: fs.readFileSync(p.file, 'utf-8') };
    })
    .filter((p) => Boolean(p.meta?.required_core_version) && p.text.includes('domain-hatch'))
    .map(({ slug, file, text }) => ({
      slug,
      file,
      text,
      templateText: fs.readFileSync(
        path.join(PLUGINS_DIR, slug, 'state-templates', 'CLAUDE-APPEND.md'),
        'utf-8',
      ),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

const HATCHES = discover();

describe('discovery', () => {
  test('finds the domain hatches that run the shared protocol', () => {
    expect(HATCHES.length).toBeGreaterThanOrEqual(5);
  });

  test('never includes core, which is not a consumer of its own protocol', () => {
    expect(HATCHES.map((h) => h.slug)).not.toContain('claude-code-hermit');
  });
});

for (const { slug, text, templateText } of HATCHES) {
  describe(`${slug}:hatch`, () => {
    test('reaches core through bin/hermit-run, not a relative path', () => {
      expect(text).toContain('.claude-code-hermit/bin/hermit-run domain-hatch');
      // A domain plugin's ${CLAUDE_PLUGIN_ROOT} is <cache>/<mp>/<plugin>/<version>/,
      // so no static ../claude-code-hermit/... path resolves from one.
      expect(text).not.toContain('../claude-code-hermit/scripts');
    });

    // The live bug this whole change exists for: four hatches checked a floor
    // in prose that was 1 to 14 minor versions below what their own manifest
    // declared, so they proceeded against a core too old for them.
    // Scoped to the CORE floor: a hatch may legitimately state a version
    // requirement for something else (forge checks PHP >= 8.5.0). What must
    // never come back is a core-hermit floor written into skill prose, where
    // it drifts from the manifest that actually declares it.
    test('states no hardcoded core version floor', () => {
      const lines = text.split('\n').filter((l) =>
        /(?:base hermit|core hermit|claude-code-hermit|_hermit_versions)/i.test(l),
      );
      for (const line of lines) {
        expect(line).not.toMatch(/(?:requires|earlier than|less than|below)\s+`?≥?>?=?\s*\d+\.\d+\.\d+/i);
      }
    });

    test('does not restate the install-scope precedence rules', () => {
      expect(text).not.toContain('claude plugin list --json');
      expect(text).not.toMatch(/precedence\s+`?local`?\s*>/);
    });

    test('does not restate the hatch-options stamp schema', () => {
      expect(text).not.toMatch(/"stamped_by":\s*"/);
      expect(text).not.toMatch(/"core_install_scope":\s*"/);
    });

    // Top-level `Stop.` sat outside the version-check branch in three hatches;
    // read literally it ends the skill unconditionally after step 1.
    test('has no bare top-level Stop. line', () => {
      expect(text.split('\n').some((l) => l.trim() === 'Stop.')).toBe(false);
    });

    // The slug-parameterized half of the contract. These lived as per-plugin
    // clones in three plugins' tests/hatch-skill.test.ts (and were unasserted
    // for dev and feed) before being folded in here.
    test('runs preflight keyed to its own plugin id', () => {
      expect(text).toContain(`domain-hatch preflight ${slug}`);
    });

    test('records the operator choice via ensure-target', () => {
      expect(text).toContain(`domain-hatch ensure-target ${slug} --target`);
    });

    test('writes the block via sync-block', () => {
      expect(text).toContain(`domain-hatch sync-block ${slug}`);
    });

    test('stamps its own version into _hermit_versions, sourced from the preflight verdict', () => {
      expect(text).toContain(`_hermit_versions["${slug}"]`);
      expect(
        new RegExp(`_hermit_versions\\["${slug}"\\][\\s\\S]{0,60}self_version`).test(text),
      ).toBe(true);
    });

    test('branches on every preflight action value', () => {
      for (const action of ['upgrade-core-package', 'upgrade-core-applied', '`verify`', '`full`']) {
        expect(text).toContain(action);
      }
    });

    test('consumes the preflight verdict fields instead of re-deriving them', () => {
      expect(
        /`target`[\s\S]{0,60}`target_file`[\s\S]{0,60}`target_default`[\s\S]{0,60}`needs_target_question`/.test(
          text,
        ),
      ).toBe(true);
    });

    test('Visibility prompt still offers .local vs committed', () => {
      expect(/Visibility[\s\S]{0,240}`\.local` files[\s\S]{0,120}Committed files/.test(text)).toBe(
        true,
      );
    });

    test('does not read hatch-options.json directly', () => {
      expect(text).not.toContain('hatch-options.json');
    });

    // sync-block replaces between the markers, so the template must carry both.
    // The open marker is read from the template itself, never hardcoded — dev's
    // SKILL.md legitimately never names its marker (render-append generates it).
    // Reuses evolve-plan's own marker resolver instead of a second regex: that
    // heuristic has a documented bug history (unrelated leading comments
    // mistaken for the block marker) a from-scratch regex would re-expose.
    test('CLAUDE-APPEND template carries a matched marker pair', () => {
      const open = extractSiblingMarker(templateText, slug);
      expect(open).toBeTruthy();
      expect(templateText).toContain(closingMarkerFor(open!));
    });
  });
}

// The three places a plugin declares its core floor: `required_core_version`
// and `requires["claude-code-hermit"]` in hermit-meta.json, and the resolver's
// `dependencies` entry in plugin.json. Until now only the /bump-core-req skill
// kept the copies aligned. Scope is wider than HATCHES — scribe declares the
// dependency without running the hatch protocol.
describe('core-floor version triple', () => {
  const declaring = pluginSlugs()
    .filter((slug) =>
      fs.existsSync(path.join(PLUGINS_DIR, slug, '.claude-plugin', 'hermit-meta.json')),
    )
    .sort();

  test('every domain plugin declares the floor', () => {
    expect(declaring.length).toBeGreaterThanOrEqual(6);
  });

  for (const slug of declaring) {
    test(`${slug}: required_core_version, requires, and dependencies agree`, () => {
      const dir = path.join(PLUGINS_DIR, slug, '.claude-plugin');
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'hermit-meta.json'), 'utf-8'));
      const pj = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8'));

      const floor = meta.required_core_version as string;
      expect(floor).toMatch(/^>=\d+\.\d+\.\d+$/);
      expect(meta.requires?.['claude-code-hermit']).toBe(floor);

      const dep = (pj.dependencies ?? []).find(
        (d: { name: string; version: string }) => d.name === 'claude-code-hermit',
      );
      // ">=X.Y.Z" in hermit-meta ⇔ "^X.Y.Z" in the native resolver field.
      expect(dep?.version).toBe(floor.replace(/^>=/, '^'));
    });
  }
});

describe('core side of the contract', () => {
  const coreScripts = path.join(PLUGINS_DIR, 'claude-code-hermit', 'scripts');

  test('the script the hatches invoke exists', () => {
    expect(fs.existsSync(path.join(coreScripts, 'domain-hatch.ts'))).toBe(true);
  });

  test('each verb is granted separately, never as one wildcard', () => {
    const applySettings = fs.readFileSync(path.join(coreScripts, 'apply-settings.ts'), 'utf-8');
    for (const verb of ['preflight', 'ensure-target', 'sync-block']) {
      expect(applySettings).toContain(`bin/hermit-run domain-hatch ${verb} *`);
    }
    // A bare `domain-hatch *` would hand every caller the two mutating verbs.
    expect(applySettings).not.toContain('bin/hermit-run domain-hatch *');
  });

  // apply-settings.ts is the single owner of the literal entries; hatch carries
  // only the rationale for why they exist. Asserting the entries twice would
  // reintroduce the duplication the permissions single-owner change removed.
  test('hatch SKILL.md explains the domain-hatch route without re-listing it', () => {
    const hatch = fs.readFileSync(path.join(PLUGINS_DIR, 'claude-code-hermit', 'skills', 'hatch', 'SKILL.md'), 'utf-8');
    expect(hatch).toContain('hermit-run domain-hatch');
    expect(hatch).not.toContain('"Bash(.claude-code-hermit/bin/hermit-run domain-hatch');
  });

  test('the marker parser stays single-sourced in evolve-plan', () => {
    const block = fs.readFileSync(path.join(coreScripts, 'lib', 'domain-hatch', 'block.ts'), 'utf-8');
    expect(block).toContain("from '../../evolve-plan'");
    const evolvePlan = fs.readFileSync(path.join(coreScripts, 'evolve-plan.ts'), 'utf-8');
    expect(evolvePlan).toMatch(/export \{[^}]*isAmbiguousBlock/);
  });
});
