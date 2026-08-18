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
//
//   bun artifact.ts state dashboard <hermit-state-dir>
//     Prints the dashboard's render inputs as JSON, for a hermit-local renderer
//     (see docs/artifacts.md § Custom renderer) to compose its own page from:
//     {state, themeCss, coreSections, updatedToken}. Read-only; writes nothing.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadDashboardState, renderDashboard, renderCoreSections, UPDATED_TOKEN } from './lib/dashboard';
import { loadProposalsPageState, renderProposalsPage } from './lib/proposals-page';
import { renderWeeklyArtifact } from './lib/weekly-artifact';
import { DEFAULT_STRINGS } from './lib/artifact-strings';
import { CSS } from './lib/artifact-theme';

interface Rendered { content: string; hash: string }

/** A hermit that has run `/hermit-dashboard-design` owns its dashboard render: this
 *  script hands off to that script and passes its receipt through untouched. Presence
 *  of the file is the switch — no config gate. */
const CUSTOM_RENDERER = 'dashboard-render.ts';

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
              `       bun artifact.ts state dashboard <hermit-state-dir>\n` +
              `       bun artifact.ts scaffold-strings <language> [generatedISO]`;

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

/** Runs the hermit's own dashboard renderer and relays its receipt verbatim. The
 *  child owns the whole render — layout, data, hash — so nothing here inspects or
 *  rewrites its output; a non-zero exit propagates as this script's exit 1, which the
 *  refresh protocol already treats as "skip silently". */
function renderCustomDashboard(rendererPath: string, hermitDir: string): never {
  const r = spawnSync(process.execPath, [rendererPath, hermitDir], { encoding: 'utf8', timeout: 60_000 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) {
    console.error(`artifact render dashboard: custom renderer failed to start: ${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status === 0 ? 0 : 1);
}

function verbRender(page: string | undefined, hermitDir: string | undefined, outArg: string | undefined): void {
  if (!page || !hermitDir) usage();
  const spec = PAGES[page];
  if (!spec) {
    console.error(`artifact render: unknown page "${page}" (expected ${PAGE_NAMES})`);
    process.exit(1);
  }
  if (page === 'dashboard') {
    const custom = path.join(hermitDir, CUSTOM_RENDERER);
    if (fs.existsSync(custom)) renderCustomDashboard(custom, hermitDir);
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

/** Render inputs for a hermit-local dashboard renderer. `coreSections` lets a custom
 *  page keep any default card verbatim, and `themeCss` comes from the live stylesheet
 *  so core-side theme fixes reach custom pages without them being rebuilt. */
function verbState(page: string | undefined, hermitDir: string | undefined): void {
  if (page !== 'dashboard' || !hermitDir) usage();
  try {
    const state = loadDashboardState(hermitDir);
    process.stdout.write(JSON.stringify({
      state,
      themeCss: CSS,
      coreSections: renderCoreSections(state),
      updatedToken: UPDATED_TOKEN,
    }) + '\n');
  } catch (err: any) {
    console.error(`artifact state dashboard: failed: ${err?.message ?? err}`);
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
  case 'state': verbState(rest[0], rest[1]); break;
  case 'scaffold-strings': verbScaffoldStrings(rest[0], rest[1]); break;
  default: usage();
}
