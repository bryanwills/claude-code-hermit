import fs from 'node:fs';
import path from 'node:path';

/** Find the closest named process, including startPid, without trusting older ancestors. */
export function residentAncestorPid(startPid: number, procRoot: string, comm = 'claude'): number | null {
  const visited = new Set<number>();
  let pid = startPid;
  while (Number.isSafeInteger(pid) && pid > 0 && !visited.has(pid)) {
    visited.add(pid);
    try {
      const dir = path.join(procRoot, String(pid));
      if (fs.readFileSync(path.join(dir, 'comm'), 'utf8').trim() === comm) return pid;
      const stat = fs.readFileSync(path.join(dir, 'stat'), 'utf8');
      // The parenthesized comm may contain spaces or closing parentheses.
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      pid = Number(fields[1]);
    } catch {
      return null;
    }
  }
  return null;
}

if (import.meta.main) {
  try {
    const runtime = JSON.parse(fs.readFileSync(path.join(process.argv[2], 'state/runtime.json'), 'utf8'));
    const ancestor = residentAncestorPid(process.ppid, '/proc');
    process.exit(ancestor !== null && ancestor === runtime.session_pid ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
