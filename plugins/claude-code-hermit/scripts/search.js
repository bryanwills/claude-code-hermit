#!/usr/bin/env node
// search.js — full-text search over sessions/, compiled/, and proposals/ in a hermit state dir
// Zero npm dependencies. Node stdlib only.
//
// Usage as CLI:   node search.js <hermit-state-dir> [options] <query...>
//   Options:
//     --type=<type>          filter by artifact type
//     --since=<YYYY-MM-DD>   exclude files older than this date
//     --limit=<n>            max results (default 10)
//
// Usage as lib:   require('./lib/search').search(hermitDir, query, opts) => results[]

'use strict';

const path = require('path');
const { search } = require('./lib/search');

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write(
      'Usage: node search.js <hermit-state-dir> [--type=<t>] [--since=<date>] [--limit=<n>] <query...>\n'
    );
    process.exit(1);
  }

  const hermitDir = path.resolve(args[0]);
  const opts = {};
  const queryParts = [];

  for (const arg of args.slice(1)) {
    if (arg.startsWith('--type=')) {
      opts.type = arg.slice('--type='.length);
    } else if (arg.startsWith('--since=')) {
      opts.since = arg.slice('--since='.length);
    } else if (arg.startsWith('--limit=')) {
      const n = parseInt(arg.slice('--limit='.length), 10);
      if (!isNaN(n)) opts.limit = n;
    } else {
      queryParts.push(arg);
    }
  }

  const query = queryParts.join(' ').trim();
  if (!query) {
    process.stderr.write('Error: no query provided\n');
    process.exit(1);
  }

  let results;
  try {
    results = search(hermitDir, query, opts);
  } catch (e) {
    process.stderr.write(`Search error: ${e.message}\n`);
    process.exit(1);
  }

  if (results.length === 0) {
    process.stdout.write(`No results found for "${query}".\n`);
    process.exit(0);
  }

  process.stdout.write(`Found ${results.length} result${results.length === 1 ? '' : 's'} for "${query}":\n\n`);
  for (const r of results) {
    const dateStr = r.date ? `  (${r.date})` : '';
    process.stdout.write(`── ${r.relPath}${dateStr}\n`);
    if (r.title && r.title !== path.basename(r.relPath, '.md')) {
      process.stdout.write(`   ${r.title}\n`);
    }
    for (const s of r.snippets) {
      // Number every line from its file-relative start so each printed :line matches the real file.
      s.text.split('\n').forEach((line, idx) => {
        process.stdout.write(`   :${s.startLine + idx}  ${line.trimEnd()}\n`);
      });
    }
    process.stdout.write('\n');
  }
}
