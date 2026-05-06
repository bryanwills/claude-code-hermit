'use strict';

// archive-shell.js — snapshot live SHELL.md and compact ## Progress Log.
// Lives in a separate namespace from S-NNN-REPORT.md (session-mgr's territory).
// Concurrent invocations: 'wx' (O_EXCL) on the snapshot path serializes to one
// winner; the other returns { archived: false, reason: 'concurrent' }.
// Exit 0 always (hook fail-open contract).

const fs = require('fs');
const path = require('path');

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(0);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function getNow() {
  const env = process.env.HERMIT_NOW;
  if (env) {
    const d = new Date(env);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

function snapshotStamp(date) {
  // UTC matches the marker's toISOString() so filename and marker refer to
  // the same moment regardless of DST shifts or machine clock skew.
  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
  ].join('') + '-' + [
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
  ].join('');
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const source = args.source || 'manual';

  const stateDir = path.resolve(
    args['state-dir'] ||
    process.env.HERMIT_STATE_DIR ||
    '.claude-code-hermit'
  );
  const sessionsDir = path.join(stateDir, 'sessions');
  const snapshotsDir = path.join(sessionsDir, 'snapshots');
  const shellPath = path.join(sessionsDir, 'SHELL.md');
  const runtimePath = path.join(stateDir, 'state', 'runtime.json');

  let shell;
  try {
    shell = fs.readFileSync(shellPath, 'utf-8');
  } catch {
    emit({ archived: false, reason: 'shell-empty' });
  }
  if (!shell || !shell.trim()) {
    emit({ archived: false, reason: 'shell-empty' });
  }

  fs.mkdirSync(snapshotsDir, { recursive: true });

  const now = getNow();
  const nowIso = now.toISOString();
  const stamp = snapshotStamp(now);
  const snapshotName = `SHELL-${stamp}.md`;
  const snapshotPath = path.join(snapshotsDir, snapshotName);

  const archivedLineCount = shell.split('\n').length;
  const snapshotContent =
    shell.replace(/\s*$/, '\n') +
    `<!-- snapshot @ ${nowIso} -->\n`;

  let fd;
  try {
    fd = fs.openSync(snapshotPath, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') emit({ archived: false, reason: 'concurrent' });
    emit({ archived: false, reason: 'open-error: ' + e.message });
  }
  try {
    fs.writeSync(fd, snapshotContent);
  } finally {
    fs.closeSync(fd);
  }

  // Replace pre-marker body of ## Progress Log with a one-line pointer; leave
  // other sections (## Task, ## Findings, etc.) intact.
  const progressLogRe = /^## Progress Log[ \t]*$/m;
  const startMatch = progressLogRe.exec(shell);

  let updatedShell = shell;
  let keptLineCount = archivedLineCount;

  if (startMatch) {
    const bodyStart = startMatch.index + startMatch[0].length;
    const after = shell.slice(bodyStart);
    const nextHeadingMatch = /\n## /.exec(after);
    const bodyEnd = nextHeadingMatch
      ? bodyStart + nextHeadingMatch.index
      : shell.length;

    const before = shell.slice(0, bodyStart);
    const tail = shell.slice(bodyEnd);

    const newBody =
      `\n` +
      `<!-- snapshot @ ${nowIso} → snapshots/${snapshotName} (${archivedLineCount} lines) -->\n` +
      `- [archived] previous entries → snapshots/${snapshotName}\n`;

    updatedShell = before + newBody + tail;
    keptLineCount = updatedShell.split('\n').length;

    const shellTmp = shellPath + '.tmp.' + process.pid;
    fs.writeFileSync(shellTmp, updatedShell, 'utf-8');
    fs.renameSync(shellTmp, shellPath);
  }

  // Single-writer for last_shell_snapshot_at: archive only fires inside an
  // active reflect-precheck, and hermit-start runs before any precheck hook —
  // so read-modify-write here doesn't race other writers in practice.
  try {
    const runtimeRaw = fs.readFileSync(runtimePath, 'utf-8');
    const runtime = JSON.parse(runtimeRaw);
    runtime.last_shell_snapshot_at = nowIso;
    const runtimeTmp = runtimePath + '.tmp.' + process.pid;
    fs.writeFileSync(runtimeTmp, JSON.stringify(runtime, null, 2) + '\n', 'utf-8');
    fs.renameSync(runtimeTmp, runtimePath);
  } catch {
    // Fail-open.
  }

  console.error(`[archive-shell] ${source} archived ${archivedLineCount} lines → snapshots/${snapshotName}`);
  emit({
    archived: true,
    snapshot_path: snapshotPath,
    session_id: `SHELL-${stamp}`,
    shell_lines_archived: archivedLineCount,
    shell_lines_kept: keptLineCount,
  });
}

try {
  main();
} catch (e) {
  console.error(`[archive-shell] error: ${e.message}`);
  emit({ archived: false, reason: 'error: ' + e.message });
}
