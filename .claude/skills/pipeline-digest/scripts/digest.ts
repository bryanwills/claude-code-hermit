#!/usr/bin/env bun
// Release-pipeline digest with a change gate. Collects per-plugin release state,
// main-branch CI health, stale branches, and GitHub issue/PR activity; prints a
// bounded digest only when those facts differ from the last committed hash.
//
//   bun digest.ts <hermit-dir>                 -> "CHANGED|<sha256>" + digest, or "NOCHANGE"
//   bun digest.ts <hermit-dir> commit <hash>   -> persist the hash
//
// The caller commits the hash only after the digest actually reached the
// operator, so an undelivered send retries on the next run (same contract as
// reflect-precheck's RUN|<hash>).
//
// Runs from the repo root. Works without a hatched hermit: a missing state dir
// just means every run reports CHANGED and commit is a no-op.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const STALE_BRANCH_DAYS = 14;

function git(args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function lastTagVersion(slug: string): string | null {
  const tags = git(['tag', '--list', `${slug}--v*`]).split('\n').filter(Boolean);
  const versions = tags
    .map((t) => t.slice(`${slug}--v`.length))
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort(compareVersions);
  return versions.length ? versions[versions.length - 1] : null;
}

// Non-empty [Unreleased] section (any content line before the next ## heading).
function hasUnreleased(changelogPath: string): boolean {
  let text: string;
  try { text = fs.readFileSync(changelogPath, 'utf-8'); } catch { return false; }
  const lines = text.split('\n');
  let inSection = false;
  for (const line of lines) {
    if (/^## \[Unreleased\]/.test(line)) { inSection = true; continue; }
    if (inSection && /^## \[/.test(line)) break;
    if (inSection && line.trim()) return true;
  }
  return false;
}

type Plugin = {
  slug: string;
  version: string | null;
  tag: string | null;
  ahead: number;
  unreleased: boolean;
  status: 'awaiting-tag' | 'prep-needed' | 'up-to-date' | 'unstructured';
};

function collectPlugins(): Plugin[] {
  const dirs = fs.readdirSync('plugins', { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const out: Plugin[] = [];
  for (const slug of dirs) {
    const manifest = path.join('plugins', slug, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifest)) continue;

    let version: string | null = null;
    try { version = JSON.parse(fs.readFileSync(manifest, 'utf-8'))?.version ?? null; } catch {}

    const tag = lastTagVersion(slug);
    const base = tag ? `${slug}--v${tag}` : 'HEAD';
    const ahead = Number(git(['rev-list', `${base}..HEAD`, '--count', '--', `plugins/${slug}/`]) || '0');
    const unreleased = hasUnreleased(path.join('plugins', slug, 'CHANGELOG.md'));

    let status: Plugin['status'];
    if (!version || !tag) status = 'unstructured';
    else if (compareVersions(version, tag) > 0) status = 'awaiting-tag';
    else if (unreleased) status = 'prep-needed';
    else status = 'up-to-date';

    out.push({ slug, version, tag, ahead, unreleased, status });
  }
  return out;
}

// null = gh unavailable (distinct from "no failures").
function collectFailingCI(): string[] | null {
  const r = spawnSync('gh', [
    'run', 'list', '--branch', 'main', '--limit', '10',
    '--json', 'workflowName,conclusion',
  ], { encoding: 'utf-8', timeout: 30_000 });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const runs = JSON.parse(r.stdout) as Array<{ workflowName: string; conclusion: string }>;
    return [...new Set(runs.filter((x) => x.conclusion === 'failure').map((x) => x.workflowName))].sort();
  } catch { return null; }
}

// Stale AND unmerged — abandoned work. Branches already merged into main are
// cleanup debris, not pipeline state.
function collectStaleBranches(): string[] {
  const unmerged = new Set(
    git(['branch', '--no-merged', 'main', '--format=%(refname:short)']).split('\n').filter(Boolean),
  );
  if (!unmerged.size) return [];
  const raw = git(['for-each-ref', 'refs/heads/', '--format=%(refname:short) %(committerdate:unix)']);
  const cutoff = Date.now() / 1000 - STALE_BRANCH_DAYS * 86400;
  return raw.split('\n').filter(Boolean).reduce<string[]>((acc, line) => {
    const idx = line.lastIndexOf(' ');
    const name = line.slice(0, idx);
    const when = Number(line.slice(idx + 1));
    if (unmerged.has(name) && when && when < cutoff) acc.push(name);
    return acc;
  }, []).sort();
}

function ghApi(args: string[]): string | null {
  const r = spawnSync('gh', args, { encoding: 'utf-8', timeout: 20_000 });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout;
}

function searchCount(nameWithOwner: string, query: string): number | null {
  // -X GET is required: gh api defaults to POST whenever -f is present, and
  // search/issues only accepts GET (a POST 404s instead of 405).
  const out = ghApi(['api', '-X', 'GET', 'search/issues', '-f', `q=repo:${nameWithOwner} ${query}`, '-q', '.total_count']);
  if (out === null) return null;
  const n = Number(out.trim());
  return Number.isFinite(n) ? n : null;
}

type Activity = {
  open_issues: number;
  open_prs: number;
  new_issues: number;
  closed_issues: number;
  new_prs: number;
  closed_prs: number;
} | null; // null = gh unavailable, no GitHub remote, or any query failed

function collectActivity(sinceIso: string): Activity {
  const repoOut = ghApi(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  if (!repoOut) return null;
  const nameWithOwner = repoOut.trim();

  const openIssues = searchCount(nameWithOwner, 'is:issue is:open');
  const openPrs = searchCount(nameWithOwner, 'is:pr is:open');
  const newIssues = searchCount(nameWithOwner, `is:issue created:>=${sinceIso}`);
  const closedIssues = searchCount(nameWithOwner, `is:issue is:closed closed:>=${sinceIso}`);
  const newPrs = searchCount(nameWithOwner, `is:pr created:>=${sinceIso}`);
  const closedPrs = searchCount(nameWithOwner, `is:pr is:closed closed:>=${sinceIso}`);

  const counts = { openIssues, openPrs, newIssues, closedIssues, newPrs, closedPrs };
  if (Object.values(counts).some((v) => v === null)) return null;

  return {
    open_issues: openIssues!, open_prs: openPrs!,
    new_issues: newIssues!, closed_issues: closedIssues!,
    new_prs: newPrs!, closed_prs: closedPrs!,
  };
}

function statePath(hermitDir: string): string {
  return path.join(hermitDir, 'state', 'pipeline-digest.json');
}

function readCommittedHash(hermitDir: string): string | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(hermitDir), 'utf-8'))?.hash ?? null;
  } catch { return null; }
}

function readCommittedTs(hermitDir: string): string | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(hermitDir), 'utf-8'))?.ts ?? null;
  } catch { return null; }
}

function commitHash(hermitDir: string, hash: string): void {
  const p = statePath(hermitDir);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ hash, ts: new Date().toISOString() }, null, 2) + '\n');
    fs.renameSync(tmp, p);
  } catch {
    // No hermit state dir (plain contributor checkout) — nothing to remember.
  }
}

function render(plugins: Plugin[], failingCI: string[] | null, stale: string[], activity: Activity): string {
  const lines: string[] = [];

  const pending = plugins.filter((p) => p.status === 'awaiting-tag' || p.status === 'prep-needed');
  if (pending.length) {
    lines.push('Pending release:');
    for (const p of pending) {
      const detail = p.status === 'awaiting-tag'
        ? `version ${p.version} ahead of tag ${p.tag}`
        : `${p.ahead} commit(s) since ${p.tag}, unreleased entries`;
      lines.push(`  ${p.slug} — ${detail}`);
    }
  } else {
    lines.push('Pending release: nothing — every plugin is tagged and clean.');
  }

  const unstructured = plugins.filter((p) => p.status === 'unstructured');
  if (unstructured.length) lines.push(`Unstructured (no version or no tag): ${unstructured.map((p) => p.slug).join(', ')}`);

  if (failingCI === null) lines.push('CI on main: status unavailable (gh query failed)');
  else if (failingCI.length) lines.push(`CI on main: FAILING — ${failingCI.join(', ')}`);
  else lines.push('CI on main: green');

  if (stale.length) lines.push(`Stale branches (>${STALE_BRANCH_DAYS}d): ${stale.join(', ')}`);

  if (activity) {
    const moved = activity.new_issues || activity.closed_issues || activity.new_prs || activity.closed_prs;
    const change = moved
      ? `${activity.new_issues} new issue(s), ${activity.closed_issues} closed; ${activity.new_prs} new PR(s), ${activity.closed_prs} merged/closed`
      : 'quiet';
    lines.push(`GitHub activity: ${change} (open: ${activity.open_issues} issues, ${activity.open_prs} PRs)`);
  }

  return lines.join('\n');
}

const hermitDir = process.argv[2];
if (!hermitDir) {
  console.error('usage: digest.ts <hermit-dir> [commit <hash>]');
  process.exit(2);
}

if (process.argv[3] === 'commit') {
  const hash = process.argv[4];
  if (!/^[0-9a-f]{64}$/.test(hash || '')) {
    console.error('commit: expected a sha256 hash');
    process.exit(2);
  }
  commitHash(hermitDir, hash);
  process.exit(0);
}

const plugins = collectPlugins();
const failingCI = collectFailingCI();
const stale = collectStaleBranches();
const since = readCommittedTs(hermitDir) ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const activity = collectActivity(since);

// Stable facts only — no dates or ages, so an unchanged pipeline hashes equal
// day after day. new_issues/new_prs/closed_issues/closed_prs are windowed by
// `since` (the last committed run), so they naturally return to 0 — and drop
// back out of the hash — once reported once.
const hash = crypto.createHash('sha256').update(JSON.stringify({
  plugins: plugins.map((p) => [p.slug, p.version, p.tag, p.ahead, p.unreleased]),
  failingCI,
  stale,
  activity,
})).digest('hex');

if (hash === readCommittedHash(hermitDir)) {
  console.log('NOCHANGE');
  process.exit(0);
}

console.log(`CHANGED|${hash}`);
console.log(render(plugins, failingCI, stale, activity));
