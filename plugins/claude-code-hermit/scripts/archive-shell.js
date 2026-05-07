'use strict';

// link() is atomic and fails with EEXIST if the target exists, so it doubles
// as the per-minute concurrency lock. A crash before link leaves only the tmp
// behind, never a partial final snapshot.

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
    return emit({ archived: false, reason: 'shell-empty' });
  }
  if (!shell || !shell.trim()) {
    return emit({ archived: false, reason: 'shell-empty' });
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

  const snapshotTmp = snapshotPath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(snapshotTmp, snapshotContent, 'utf-8');
  } catch (e) {
    return emit({ archived: false, reason: 'write-error: ' + e.message });
  }
  try {
    fs.linkSync(snapshotTmp, snapshotPath);
  } catch (e) {
    try { fs.unlinkSync(snapshotTmp); } catch { /* ignore */ }
    if (e.code === 'EEXIST') {
      return emit({ archived: false, reason: 'concurrent' });
    }
    return emit({ archived: false, reason: 'link-error: ' + e.message });
  }
  try { fs.unlinkSync(snapshotTmp); } catch { /* tmp already gone */ }

  const progressLogRe = /^## Progress Log[ \t]*$/m;
  const startMatch = progressLogRe.exec(shell);

  let updatedShell = shell;
  let keptLineCount = archivedLineCount;
  let compacted = false;

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
    compacted = true;

    const shellTmp = shellPath + '.tmp.' + process.pid;
    fs.writeFileSync(shellTmp, updatedShell, 'utf-8');
    fs.renameSync(shellTmp, shellPath);
  } else {
    // 24h gate would otherwise mask this until tomorrow.
    console.error(
      `[archive-shell] WARNING: SHELL.md has no '## Progress Log' heading — ` +
      `snapshot taken but SHELL.md not compacted. ` +
      `Restore the heading to enable compaction.`
    );
  }

  // Single-writer: archive fires only inside reflect-precheck, after
  // hermit-start has settled — so RMW here doesn't race other writers.
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
  return emit({
    archived: true,
    snapshot_path: snapshotPath,
    session_id: `SHELL-${stamp}`,
    shell_lines_archived: archivedLineCount,
    shell_lines_kept: keptLineCount,
    compacted,
  });
}

try {
  main();
} catch (e) {
  console.error(`[archive-shell] error: ${e.message}`);
  emit({ archived: false, reason: 'error: ' + e.message });
}
