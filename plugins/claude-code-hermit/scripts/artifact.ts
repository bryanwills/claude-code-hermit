// artifact.ts — single CLI for the Artifact-page renderers and the
// artifact-strings scaffold. One script per page was three copies of the same
// twelve lines: resolve an out path, render, mkdir -p, write, print the
// {path,bytes,hash} receipt, exit 1 on anything thrown.
//
// Usage:
//   bun artifact.ts render <dashboard|proposals|weekly> <hermit-state-dir> [outPath]
//     Renders the page to disk. Prints {"path":…,"bytes":…,"hash":…} on success;
//     exits 1 on failure. The refresh protocols in docs/artifacts.md treat any
//     failure as "skip silently", so the stderr text is diagnostic only — the
//     exit code is the contract.
//
//   bun artifact.ts scaffold-strings <language> [generatedISO]
//     Prints the artifact-strings.json scaffold with every chrome key at its
//     English default, for a language-set skill (hatch / hermit-settings) to
//     translate the *values* in place and write to state/artifact-strings.json.
//     Keeps DEFAULT_STRINGS the single source of keys — the model never
//     hand-transcribes the key set.

import fs from 'node:fs';
import path from 'node:path';
import { loadDashboardState, renderDashboard } from './lib/dashboard';
import { loadProposalsPageState, renderProposalsPage } from './lib/proposals-page';
import { renderWeeklyArtifact } from './lib/weekly-artifact';
import { DEFAULT_STRINGS } from './lib/artifact-strings';

interface Rendered { content: string; hash: string }

// Each page contributes only what actually differs between them: where it lands
// by default, and how its bytes are produced.
const PAGES: Record<string, { defaultOut: (dir: string) => string; render: (dir: string) => Rendered }> = {
  dashboard: {
    defaultOut: dir => path.join(dir, 'state', 'dashboard.html'),
    render: dir => {
      const { html, hash } = renderDashboard(loadDashboardState(dir));
      return { content: html, hash };
    },
  },
  proposals: {
    defaultOut: dir => path.join(dir, 'state', 'proposals-page.html'),
    render: dir => {
      const { html, hash } = renderProposalsPage(loadProposalsPageState(dir));
      return { content: html, hash };
    },
  },
  weekly: {
    defaultOut: dir => path.join(dir, 'state', 'weekly-review-artifact.md'),
    render: renderWeeklyArtifact,
  },
};

const PAGE_NAMES = Object.keys(PAGES).join('|');
const USAGE = `Usage: bun artifact.ts render <${PAGE_NAMES}> <hermit-state-dir> [outPath]\n` +
              `       bun artifact.ts scaffold-strings <language> [generatedISO]`;

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

function verbRender(page: string | undefined, hermitDir: string | undefined, outArg: string | undefined): void {
  if (!page || !hermitDir) usage();
  const spec = PAGES[page];
  if (!spec) {
    console.error(`artifact render: unknown page "${page}" (expected ${PAGE_NAMES})`);
    process.exit(1);
  }
  const outPath = outArg || spec.defaultOut(hermitDir);
  try {
    const { content, hash } = spec.render(hermitDir);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content, 'utf8');
    process.stdout.write(JSON.stringify({ path: outPath, bytes: Buffer.byteLength(content), hash }) + '\n');
  } catch (err: any) {
    console.error(`artifact render ${page}: failed: ${err?.message ?? err}`);
    process.exit(1);
  }
}

function verbScaffoldStrings(language: string | undefined, generated: string | undefined): void {
  process.stdout.write(
    JSON.stringify({ language: language || 'en', generated: generated || '', strings: DEFAULT_STRINGS }, null, 2) + '\n',
  );
}

const verb = process.argv[2];
const rest = process.argv.slice(3);
switch (verb) {
  case 'render': verbRender(rest[0], rest[1], rest[2]); break;
  case 'scaffold-strings': verbScaffoldStrings(rest[0], rest[1]); break;
  default: usage();
}
