// proposals-index.ts — derived cache of every proposal's frontmatter.
// Usage: bun proposals-index.ts <hermit-state-dir>
// Output (stdout, one line): OK|<n> proposals  |  SKIP|no proposals dir
// Exit 0 always. Writes state/proposals-index.json (full rebuild — never
// incremental, so it cannot drift). Also exported as rebuildIndex() for the
// generate-summary PostToolUse hook to call on every proposal write.
//
// Why this exists: proposal-list and heartbeat's default scan otherwise read
// every PROP-*.md body in full (~22K tokens for a dozen proposals) just to
// render a table from frontmatter. The index is the single source of proposal
// counts, killing the state-summary/reflection-state/disk three-way drift.

import fs from 'node:fs';
import path from 'node:path';
import { readFileWithFrontmatter, globDir } from './lib/frontmatter';

type Json = any;

export interface ProposalRow {
  id: string;
  file: string;
  status: string | null;
  source: string | null;
  category: string | null;
  title: string | null;
  created: string | null;
  session: string | null;
  responded: boolean;
  accepted_date: string | null;
  resolved_date: string | null;
  tags: string[];
  self_eval_key: string | null;
  legacy: boolean;
}

export interface ProposalsIndex {
  updated: string;
  count: number;
  counts: Record<string, number>;
  proposals: ProposalRow[];
}

// Title comes from frontmatter `title` when set, else the H1 heading
// `# Proposal: PROP-NNN — [Title]`.
function extractTitle(fm: Json | null, body: string): string | null {
  if (fm && typeof fm.title === 'string' && fm.title.trim()) return fm.title.trim();
  const m = body.match(/^#\s+Proposal:\s+\S+\s+[—-]\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

// Legacy (pre-frontmatter) fallback: parse `**Status:**`-style bullet metadata.
function parseLegacy(idFromFile: string, body: string): ProposalRow {
  const grab = (label: string): string | null => {
    const m = body.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`));
    return m ? m[1].trim() : null;
  };
  const heading = body.match(/^#\s+Proposal:\s+\S+\s+[—-]\s+(.+)$/m);
  return {
    id: idFromFile,
    file: '',
    status: grab('Status'),
    source: grab('Source') ?? 'manual',
    category: grab('Category'),
    title: heading ? heading[1].trim() : null,
    created: grab('Created'),
    session: grab('Session'),
    responded: false,
    accepted_date: null,
    resolved_date: null,
    tags: [],
    self_eval_key: null,
    legacy: true,
  };
}

export function rebuildIndex(stateDir: string): ProposalsIndex | null {
  const proposalsDir = path.join(stateDir, 'proposals');
  if (!fs.existsSync(proposalsDir)) return null;

  const files = globDir(proposalsDir, /^PROP-.*\.md$/);
  const proposals: ProposalRow[] = [];

  for (const file of files) {
    const base = path.basename(file);
    const idMatch = base.match(/^(PROP-\d+(?:-[a-z0-9-]+-\d+)?)/i);
    const idStem = base.replace(/\.md$/, '');
    const parsed = readFileWithFrontmatter(file);
    if (!parsed) continue; // unreadable — skip rather than crash the whole rebuild

    if (parsed.fm && typeof parsed.fm === 'object') {
      const fm = parsed.fm;
      proposals.push({
        id: typeof fm.id === 'string' && fm.id.trim() ? fm.id.trim() : idStem,
        file: base,
        status: typeof fm.status === 'string' ? fm.status : null,
        source: typeof fm.source === 'string' ? fm.source : null,
        category: typeof fm.category === 'string' ? fm.category : null,
        title: extractTitle(fm, parsed.body),
        created: typeof fm.created === 'string' ? fm.created : null,
        session: typeof fm.session === 'string' ? fm.session : null,
        responded: fm.responded === true,
        accepted_date: typeof fm.accepted_date === 'string' ? fm.accepted_date : null,
        resolved_date: typeof fm.resolved_date === 'string' ? fm.resolved_date : null,
        tags: Array.isArray(fm.tags) ? fm.tags.filter((t: unknown) => typeof t === 'string') : [],
        self_eval_key: typeof fm.self_eval_key === 'string' ? fm.self_eval_key : null,
        legacy: false,
      });
    } else {
      const row = parseLegacy(idMatch ? idMatch[1] : idStem, parsed.body);
      row.file = base;
      proposals.push(row);
    }
  }

  const counts: Record<string, number> = {};
  for (const p of proposals) {
    const k = p.status ?? 'unknown';
    counts[k] = (counts[k] ?? 0) + 1;
  }

  const index: ProposalsIndex = {
    updated: new Date().toISOString(),
    count: proposals.length,
    counts,
    proposals,
  };

  try {
    fs.writeFileSync(
      path.join(stateDir, 'state', 'proposals-index.json'),
      JSON.stringify(index, null, 2) + '\n',
      'utf8',
    );
  } catch { /* fail-open: a failed write just means a reader rebuilds next time */ }

  return index;
}

// CLI mode
if (import.meta.main) {
  const stateDir = process.argv[2];
  if (!stateDir) { process.stdout.write('SKIP|no state dir\n'); process.exit(0); }
  const index = rebuildIndex(stateDir);
  process.stdout.write(index ? `OK|${index.count} proposals\n` : 'SKIP|no proposals dir\n');
  process.exit(0);
}
