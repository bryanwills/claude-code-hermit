#!/usr/bin/env bun
// GitHub issue/PR activity digest for the brief skill. Uses gh api search's
// total_count (bounded — no issue/PR bodies ever reach context).
//
//   bun repo-activity.ts <since-iso>
//
// Prints one line: "UNAVAILABLE" (no gh, no GitHub remote, or any query
// failed — fail-open, exit 0) or a JSON object:
//   {"open_issues":N,"open_prs":N,"new_issues":N,"closed_issues":N,"new_prs":N,"closed_prs":N}

import { spawnSync } from 'node:child_process';

function gh(args: string[]): string | null {
  const r = spawnSync('gh', args, { encoding: 'utf-8', timeout: 20_000 });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout;
}

function searchCount(nameWithOwner: string, query: string): number | null {
  // -X GET is required: gh api defaults to POST whenever -f is present, and
  // search/issues only accepts GET (a POST 404s instead of 405).
  const out = gh(['api', '-X', 'GET', 'search/issues', '-f', `q=repo:${nameWithOwner} ${query}`, '-q', '.total_count']);
  if (out === null) return null;
  const n = Number(out.trim());
  return Number.isFinite(n) ? n : null;
}

const since = process.argv[2];
if (!since) {
  console.error('usage: repo-activity.ts <since-iso>');
  process.exit(2);
}

const repoOut = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
if (!repoOut) {
  console.log('UNAVAILABLE');
  process.exit(0);
}
const nameWithOwner = repoOut.trim();

const openIssues = searchCount(nameWithOwner, 'is:issue is:open');
const openPrs = searchCount(nameWithOwner, 'is:pr is:open');
const newIssues = searchCount(nameWithOwner, `is:issue created:>=${since}`);
const closedIssues = searchCount(nameWithOwner, `is:issue is:closed closed:>=${since}`);
const newPrs = searchCount(nameWithOwner, `is:pr created:>=${since}`);
const closedPrs = searchCount(nameWithOwner, `is:pr is:closed closed:>=${since}`);

const counts = { openIssues, openPrs, newIssues, closedIssues, newPrs, closedPrs };
if (Object.values(counts).some((v) => v === null)) {
  console.log('UNAVAILABLE');
  process.exit(0);
}

console.log(JSON.stringify({
  open_issues: openIssues,
  open_prs: openPrs,
  new_issues: newIssues,
  closed_issues: closedIssues,
  new_prs: newPrs,
  closed_prs: closedPrs,
}));
