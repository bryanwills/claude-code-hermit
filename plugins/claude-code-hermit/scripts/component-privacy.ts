import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readHookInput, OVERSIZE } from './lib/hook-input';
import { hermitDir } from './lib/cc-compat';
import { acquireLock, releaseLock } from './lib/lockfile';
import { readJson } from './lib/cli';

/**
 * PostToolUse hook — keep a hermit-created skill or agent private to this
 * install when the operator chose gitignored hatch outputs.
 *
 * The always-on hermit sometimes writes `.claude/skills/<name>/SKILL.md` or
 * `.claude/agents/<name>.md` directly (procedure capture, or a conversational
 * "make me a skill" request) with no proposal in between. In a `hatch_target:
 * local` project those files are ordinary project files: git would track them,
 * and the next commit ships them to every clone. This hook excludes the path
 * via `$GIT_COMMON_DIR/info/exclude` — never `.gitignore`, which is itself
 * tracked and would leak the private skill's name to every clone.
 *
 * Safety invariant: a path that is ALREADY tracked by git is never touched.
 * This is what protects an operator's own hand-authored skills even if
 * HERMIT_MANAGED leaks into a session by inheritance — only a brand-new
 * untracked path can ever be privatized.
 *
 * Scoped to the managed always-on session only (HERMIT_MANAGED=1); an
 * operator's own terminal session in the same project never privatizes.
 * `hatch_target: committed` projects, non-git projects, and non-Edit/Write
 * tool calls are all a silent no-op. Fails open on every error.
 */

const COMPONENT_RE = /^\.claude\/(skills\/[^/]+\/.+|agents\/[^/]+\.md)$/;

function gitCommonDir(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

function isTracked(cwd: string, relPath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', relPath], { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** The path to privatize: the skill's containing dir, or the exact agent file. */
function componentPath(rel: string): string {
  const m = rel.match(COMPONENT_RE);
  if (!m) return rel;
  if (rel.startsWith('.claude/skills/')) {
    const name = rel.split('/')[2];
    return `.claude/skills/${name}/`;
  }
  return rel; // agent file — already the full path
}

function appendExcludeLine(commonDir: string, line: string): void {
  const excludePath = path.join(commonDir, 'info', 'exclude');
  const lockPath = `${excludePath}.lock`;
  let held = false;
  try {
    held = acquireLock(lockPath);
    if (!held) return; // contended — a concurrent writer owns this; the next Edit/Write retries
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf-8') : '';
    const lines = existing.split('\n').map(l => l.trim());
    if (lines.includes(line)) return; // already present — idempotent
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(excludePath, `${sep}${line}\n`);
  } finally {
    if (held) releaseLock(lockPath);
  }
}

async function main() {
  const event = await readHookInput();
  if (!event || event === OVERSIZE) process.exit(0);

  if (event.tool_name !== 'Edit' && event.tool_name !== 'Write') process.exit(0);
  if (process.env.HERMIT_MANAGED !== '1') process.exit(0);

  const filePath: string = event.tool_input?.file_path || event.tool_input?.path || '';
  if (!filePath) process.exit(0);

  // Cheap string filter before any filesystem walk-up: this hook fires on
  // EVERY Edit/Write in the managed session, and the overwhelming majority
  // never touch a skill/agent path. Reject those without calling hermitDir()
  // (fs.existsSync walk, up to 8 levels). Any path COMPONENT_RE can later
  // match must contain one of these substrings, so this can't false-negative.
  if (!/(^|[/\\])\.claude[/\\](skills|agents)[/\\]/.test(filePath)) process.exit(0);

  const hermit = hermitDir();
  const projectRoot = path.dirname(hermit);
  const absPath = path.resolve(projectRoot, filePath);
  const rel = path.relative(projectRoot, absPath).split(path.sep).join('/');
  if (!COMPONENT_RE.test(rel)) process.exit(0);

  const hatchOptions = readJson(path.join(hermit, 'state', 'hatch-options.json'));
  if (hatchOptions?.target !== 'local') process.exit(0);

  const commonDir = gitCommonDir(projectRoot);
  if (!commonDir) process.exit(0);
  const absCommonDir = path.isAbsolute(commonDir) ? commonDir : path.resolve(projectRoot, commonDir);

  if (isTracked(projectRoot, rel)) process.exit(0); // safety invariant

  appendExcludeLine(absCommonDir, componentPath(rel));
  process.exit(0);
}

main().catch(() => process.exit(0));
