// Routine wake gate — the subprocess-side decision that keeps a due routine from
// waking the model when there is nothing to do.
//
// `routines.ts due` runs this at fire time, after the pause/waiting/turn-open gates
// and before the cursor is consumed. A `skip` verdict consumes the cursor, stamps
// `skipped-precheck`, and emits nothing: the routine counts as having run, at zero
// token cost. Anything else wakes the session exactly as before, so a broken gate
// costs no more than having no gate at all.
//
// Two providers:
//   "reflect"      — the shipped reflect cadence check (scripts/reflect-precheck.ts),
//                    which already decides EMPTY vs RUN|<phases> from state on disk.
//                    Its RUN phases are cached in state/reflect-gate.json so the
//                    awake skill does not re-run it (that would double the script's
//                    observation-ledger append).
//   "<path>"       — a project-relative executable the operator owns. Verdict-only:
//                    the first stdout line must be SKIP or WAKE. Nothing it prints
//                    reaches the wake prompt — gate output is untrusted text, and
//                    lib/trigger-source.ts classifies a turn by scanning the whole
//                    prompt, so a payload there could both inject and misattribute.
//
// Trust class: an operator-declared executable run unattended by the monitor is the
// same class as `monitors[].command`, and carries the same protection (nonce tier
// from chat, see channel-settings-gate.ts). No approval registry beyond that.
//
// Every failure mode is fail-open: the verdict is `error`, the routine wakes, and the
// reason lands on the ledger row so `routines.ts health` and the doctor can show an
// operator that they are paying for wakes they meant to skip.

import fs from 'node:fs';
import path from 'node:path';
import { lastRoutineFire } from './history';

type Json = any;

export type GateVerdict = {
  verdict: 'skip' | 'wake' | 'error';
  /** Present on `error`: timeout | exit:<code> | bad-verdict | spawn | <config reason>. */
  detail?: string;
  /** Present on a reflect `wake`: the RUN|<phases-json> line for the skill. */
  phases?: string;
};

export const BUILTIN_REFLECT = 'reflect';
export const DEFAULT_GATE_TIMEOUT_S = 30;
export const MAX_GATE_TIMEOUT_S = 300;
/** Verdict is one short line; anything past this is a misbehaving gate, not a payload. */
const MAX_GATE_STDOUT = 4096;

/**
 * Shape check for `routines[].precheck`, shared with validate-config.ts.
 * Containment against the project root is re-checked at fire time by resolveGate()
 * — this half only needs the config to be well-formed, and runs where the project
 * root is not necessarily known.
 */
export function validatePrecheckValue(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be a string ("reflect" or a project-relative script path)';
  const raw = value.trim();
  if (!raw) return 'must not be empty';
  if (raw === BUILTIN_REFLECT) return null;
  if (path.isAbsolute(raw)) return 'must be project-relative, not an absolute path';
  if (raw.split(path.sep).includes('..')) return 'must not contain ".." segments';
  return null;
}

export function validatePrecheckTimeout(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'must be an integer (seconds)';
  if (value < 1 || value > MAX_GATE_TIMEOUT_S) {
    // The cap is not arbitrary: the routine monitor polls sequentially and the doctor
    // calls it stale after max(10 x interval, 10min), so one gate must stay well inside
    // that. A check that needs longer than five minutes is a /watch, not a gate.
    return `must be between 1 and ${MAX_GATE_TIMEOUT_S}`;
  }
  return null;
}

export function gateTimeoutMs(routine: Json): number {
  const configured = routine?.precheck_timeout_s;
  const seconds = validatePrecheckTimeout(configured) === null ? configured : DEFAULT_GATE_TIMEOUT_S;
  return seconds * 1000;
}

/** `.claude-code-hermit/` lives directly under the project root. */
export function projectRootOf(hermitDir: string): string {
  return path.dirname(path.resolve(hermitDir));
}

/**
 * Resolve a routine's `precheck` to something runnable, or say why not.
 * Containment is checked against the resolved real project root so a symlink
 * inside the project cannot point the monitor outside it.
 */
export function resolveGate(
  precheck: unknown,
  projectRoot: string,
): { kind: 'reflect' } | { kind: 'script'; abs: string } | { kind: 'invalid'; detail: string } {
  const shapeError = validatePrecheckValue(precheck);
  if (shapeError) return { kind: 'invalid', detail: 'bad-config' };
  const raw = String(precheck).trim();
  if (raw === BUILTIN_REFLECT) return { kind: 'reflect' };

  const root = path.resolve(projectRoot);
  const abs = path.resolve(root, raw);
  if (abs !== root && !abs.startsWith(root + path.sep)) return { kind: 'invalid', detail: 'outside-project' };
  try {
    const real = fs.realpathSync(abs);
    if (real !== root && !real.startsWith(root + path.sep)) return { kind: 'invalid', detail: 'outside-project' };
    if (!fs.statSync(real).isFile()) return { kind: 'invalid', detail: 'not-a-file' };
    fs.accessSync(real, fs.constants.X_OK);
    return { kind: 'script', abs: real };
  } catch {
    return { kind: 'invalid', detail: 'not-executable' };
  }
}

/**
 * Environment handed to an operator gate. Deliberately built up, never spread from
 * `process.env`: the monitor inherits the session's environment, which carries auth
 * material an unattended third-party script has no business seeing.
 */
function gateEnv(routineId: string, hermitDir: string, lastFired: string | null): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HERMIT_DIR: path.resolve(hermitDir),
    ROUTINE_ID: routineId,
    // Empty on a routine's first ever fire: the gate should read that as
    // "everything is new". Deliberately the last `fired`, not the last `started`
    // — a fire that died mid-run must re-report its items, not lose them.
    ROUTINE_LAST_FIRED: lastFired || '',
  };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.LANG) env.LANG = process.env.LANG;
  return env;
}

/**
 * Run one command and return its first stdout line plus how it ended.
 *
 * stdout goes to a file, never a pipe. A gate that forks a background helper
 * leaves that child holding the write end, and a pipe read would then block until
 * the grandchild exits — turning a 2ms gate into a hung poll. Verified live:
 * with an fd, a script that backgrounds `sleep 30` and exits returns in ~2ms.
 */
function spawnGate(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  scratchDir: string,
): { firstLine: string; ok: boolean; detail?: string } {
  const outPath = path.join(scratchDir, `.gate-${process.pid}-${Date.now()}.out`);
  let fd: number | null = null;
  try {
    fs.mkdirSync(scratchDir, { recursive: true });
    fd = fs.openSync(outPath, 'w');
    const result: Json = Bun.spawnSync({
      cmd,
      cwd,
      env,
      stdio: ['ignore', fd, 'ignore'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_GATE_STDOUT,
    });
    fs.closeSync(fd);
    fd = null;

    let firstLine = '';
    try {
      firstLine = fs.readFileSync(outPath, 'utf-8').slice(0, MAX_GATE_STDOUT).split('\n')[0].trim();
    } catch { /* no output is not an error by itself — the verdict check below decides */ }

    if (result.exitedDueToTimeout) return { firstLine, ok: false, detail: 'timeout' };
    if (result.signalCode) return { firstLine, ok: false, detail: `signal:${result.signalCode}` };
    if (result.exitCode !== 0) return { firstLine, ok: false, detail: `exit:${result.exitCode}` };
    return { firstLine, ok: true };
  } catch {
    return { firstLine: '', ok: false, detail: 'spawn' };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(outPath); } catch { /* best effort */ }
  }
}

/** Where the reflect provider parks its RUN phases for the awake skill. */
export function reflectGatePath(hermitDir: string): string {
  return path.join(hermitDir, 'state', 'reflect-gate.json');
}

export function readReflectGate(hermitDir: string): { mark?: string; phases?: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(reflectGatePath(hermitDir), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeReflectGate(hermitDir: string, mark: string, phases: string): void {
  try {
    const p = reflectGatePath(hermitDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ mark, phases }, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, p);
  } catch { /* the wake still happens; the skill falls back to running the precheck itself */ }
}

function runReflectGate(hermitDir: string, timeoutMs: number, mark: string): GateVerdict {
  const pluginRoot = path.resolve(import.meta.dir, '../../..');
  const script = path.join(pluginRoot, 'scripts', 'reflect-precheck.ts');
  const projectRoot = projectRootOf(hermitDir);
  // reflect-precheck.ts pins its state-dir argv against the hermit dir it resolves
  // from cwd, so it must run from the project root with the absolute dir.
  const { firstLine, ok, detail } = spawnGate(
    [process.execPath, script, path.resolve(hermitDir), pluginRoot],
    projectRoot,
    // The builtin is plugin code, not third-party: it shells out to the archive
    // scripts and needs the ambient environment the monitor already has.
    { ...(process.env as Record<string, string>) },
    timeoutMs,
    path.join(hermitDir, 'state'),
  );
  if (!ok) return { verdict: 'error', detail: detail || 'spawn' };
  if (firstLine === 'EMPTY') return { verdict: 'skip' };
  if (firstLine.startsWith('RUN|')) {
    writeReflectGate(hermitDir, mark, firstLine);
    return { verdict: 'wake', phases: firstLine };
  }
  return { verdict: 'error', detail: 'bad-verdict' };
}

/**
 * The gate decision for one due routine.
 *
 * `mark` is the cron minute this fire is for (the value `due` is about to write as
 * `last_consumed_mark`), which is what ties a cached reflect verdict to its fire.
 * Callers must only reach here for routines that actually declare `precheck`.
 */
export function runGate(routine: Json, hermitDir: string, mark: string): GateVerdict {
  const projectRoot = projectRootOf(hermitDir);
  const resolved = resolveGate(routine?.precheck, projectRoot);
  if (resolved.kind === 'invalid') return { verdict: 'error', detail: resolved.detail };

  const timeoutMs = gateTimeoutMs(routine);
  if (resolved.kind === 'reflect') return runReflectGate(hermitDir, timeoutMs, mark);

  const lastFired = (() => {
    try {
      return lastRoutineFire(path.join(hermitDir, 'state', 'routine-metrics.jsonl'), routine.id);
    } catch {
      return null;
    }
  })();

  const { firstLine, ok, detail } = spawnGate(
    [resolved.abs],
    projectRoot,
    gateEnv(routine.id, hermitDir, lastFired),
    timeoutMs,
    path.join(hermitDir, 'state'),
  );
  if (!ok) return { verdict: 'error', detail: detail || 'spawn' };
  if (firstLine === 'SKIP') return { verdict: 'skip' };
  if (firstLine === 'WAKE') return { verdict: 'wake' };
  return { verdict: 'error', detail: 'bad-verdict' };
}
