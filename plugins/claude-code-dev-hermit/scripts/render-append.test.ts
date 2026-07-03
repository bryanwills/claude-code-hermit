// Golden test: proves the single-source collapse preserves behavior byte-for-byte.
// render('standard', <annotated template>) must equal the pre-collapse standard file,
// render('safety',  <annotated template>) must equal the pre-collapse safety file.
// The template fed to render() is the LIVE annotated CLAUDE-APPEND.md — if it had no
// markers the transform would be identity and both assertions would pass vacuously,
// so reading the real template is what makes this test meaningful.

import fs from 'node:fs';
import path from 'node:path';
import { render } from './render-append';
import { makeReporter } from '../tests/test-utils';

const PLUGIN_ROOT = path.join(import.meta.dir, '..');
const TEMPLATE = path.join(PLUGIN_ROOT, 'state-templates', 'CLAUDE-APPEND.md');
const STANDARD_GOLDEN = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'append-standard.golden.md');
const SAFETY_GOLDEN = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'append-safety.golden.md');

const { ok, summary } = makeReporter();

const template = fs.readFileSync(TEMPLATE, 'utf-8');
const standardGolden = fs.readFileSync(STANDARD_GOLDEN, 'utf-8');
const safetyGolden = fs.readFileSync(SAFETY_GOLDEN, 'utf-8');

console.log('\nrender-append golden test:');

// Sanity: the template must actually carry markers, else the test proves nothing.
ok('template is annotated with mode markers', /<!-- mode:(standard|safety)-only -->/.test(template));

const standardOut = render('standard', template);
const safetyOut = render('safety', template);

ok('render("standard") === standard golden (byte-exact)', standardOut === standardGolden,
  `len ${standardOut.length} vs ${standardGolden.length}`);
ok('render("safety") === safety golden (byte-exact)', safetyOut === safetyGolden,
  `len ${safetyOut.length} vs ${safetyGolden.length}`);

// No mode markers may survive in either rendering.
ok('no markers leak into standard output', !/<!-- \/?mode:/.test(standardOut));
ok('no markers leak into safety output', !/<!-- \/?mode:/.test(safetyOut));

process.exit(summary() === 0 ? 0 : 1);
