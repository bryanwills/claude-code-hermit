// `heartbeat.ts start-check` / `start-commit` — the two halves of `heartbeat start`.
//
// Between them the skill does the only things a script cannot: TaskStop the old
// monitor and register the new one. Everything else — deciding whether a re-arm is
// needed at all, resolving the interval and command, waiting for the first tick,
// recording the registration — is deterministic and lives here.
//
// Ownership: `start` alone. Teardown stays skill-side (`stop` clears the runtime
// file and deletes the liveness record), because a stop is one TaskStop plus two
// file operations with no decision in it.
//
// start-check <hermit-dir>
//   FRESH|interval=<s>                      nothing to do; the live monitor matches config
//   REARM|<reason>                          followed by, as applicable:
//     OLD_TASK:<id>                         TaskStop this before registering; omitted
//                                           when the record belongs to a previous boot
//     FIRST_START:1                         no prior registration
//     INTERVAL:<s>
//     CMD:bash <abs>/heartbeat-monitor.sh <s> <abs hermit dir>
//
// start-commit <hermit-dir> <task-id>
//   OK|registered|interval=<s>              liveness confirmed within 10s
//   DEAD|liveness-absent                    subprocess never ticked (seccomp / nested-userns)

import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../cli';
import { readConfigRaw } from '../config-read';
import { appendShellLine } from '../md-write';
import { bootMismatch, waitForFirstTick } from '../monitor-health';
import { readBootId } from '../routines/registry';
import { currentHHMMOrUTC, resolveHermitNowMs } from '../time';
import { hasStartedRegistration, heartbeatCommand, heartbeatHealth, heartbeatInterval } from './monitor-cmd';

type Json = any;

function writeJson(file: string, value: Json): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

const runtimePath = (hermitDir: string) =>
  path.join(hermitDir, 'state', 'heartbeat-monitor.runtime.json');
const livenessPath = (hermitDir: string) =>
  path.join(hermitDir, 'state', 'heartbeat-liveness.json');

/**
 * Side effects and plan lines for one heartbeat re-arm, without the leading
 * `REARM|<reason>` line. Shared by `start-check` and by `routines.ts arm begin`,
 * which prefixes each line with `HB_` — so the two callers can never drift into
 * planning different registrations.
 */
export function prepareHeartbeatArm(hermitDir: string, config: Json): string[] {
  const runtime = readJson(runtimePath(hermitDir));
  // Same reason as the routine leg: the commit waits for a liveness file to
  // appear, so the outgoing monitor's last tick has to go before the new one spawns
  // — otherwise a monitor blocked by seccomp reads as alive, and the doctor flags
  // stale data from the prior session during the startup window.
  try { fs.rmSync(livenessPath(hermitDir), { force: true }); } catch {}

  const lines: string[] = [];
  // A task id from a previous boot is already dead — stopping it would hit a
  // stranger's task. Same boot rule the routine leg applies to its OLD_TASK.
  if (typeof runtime?.task_id === 'string' && runtime.task_id
    && !bootMismatch(runtime.boot_id, readBootId(hermitDir))) {
    lines.push(`OLD_TASK:${runtime.task_id}`);
  }
  if (!hasStartedRegistration(runtime)) lines.push('FIRST_START:1');
  lines.push(`INTERVAL:${heartbeatInterval(config)}`);
  lines.push(`CMD:${heartbeatCommand(hermitDir, config)}`);
  return lines;
}

/**
 * Records a heartbeat Monitor registration: waits for the first liveness tick,
 * writes `state/heartbeat-monitor.runtime.json`, appends the SHELL.md Monitoring
 * line, and returns the result line for the caller to print. This module stays the
 * sole writer of that runtime file — `arm commit --heartbeat` calls in here rather
 * than writing it itself.
 */
export async function commitHeartbeatArm(
  hermitDir: string,
  config: Json,
  taskId: string,
): Promise<string> {
  const interval = heartbeatInterval(config);
  const nowMs = resolveHermitNowMs();
  const live = await waitForFirstTick(livenessPath(hermitDir));

  // The monitor's first tick lands before this commit, so started_at postdates it and
  // readers see it untrusted. That is what the predates-grace in monitorFreshness rides
  // out — adopting the tick instead cannot work, because no timestamp proves which
  // process wrote it, and the outgoing monitor is still alive when the arm is planned.
  // Written even on the DEAD path below: without a started_at the readers report
  // `unregistered`, which counts as fresh, and doctor would call a spawn-blocked
  // monitor "warming up" forever.
  writeJson(runtimePath(hermitDir), {
    description: 'heartbeat-monitor',
    task_id: taskId,
    command: heartbeatCommand(hermitDir, config),
    interval,
    started_at: new Date(nowMs).toISOString(),
    boot_id: readBootId(hermitDir),
  });

  if (!live) return 'DEAD|liveness-absent';
  const hhmm = currentHHMMOrUTC(config?.timezone ?? 'UTC', new Date(nowMs));
  const appendError = appendShellLine(
    path.join(hermitDir, 'sessions'),
    'Monitoring',
    `[${hhmm}] Heartbeat: monitor registered (interval: ${config?.heartbeat?.every ?? `${interval}s`}) — liveness confirmed by /hermit-doctor heartbeat check`,
  );
  if (appendError) console.error(`[heartbeat] ${appendError}`);
  return `OK|registered|interval=${interval}`;
}

function cmdCheck(hermitDir: string, config: Json): void {
  const health = heartbeatHealth(hermitDir, config, resolveHermitNowMs());
  // `disabled` is healthy to the daily anchor, which must leave a deliberately-off
  // heartbeat alone. Reaching `start` at all is an explicit act, so re-arm instead.
  if (health.healthy && health.reason !== 'disabled') {
    process.stdout.write(`FRESH|interval=${heartbeatInterval(config)}\n`);
    return;
  }
  process.stdout.write(`REARM|${health.reason}\n`);
  for (const line of prepareHeartbeatArm(hermitDir, config)) {
    process.stdout.write(`${line}\n`);
  }
}

async function cmdCommit(hermitDir: string, config: Json, taskId: string): Promise<void> {
  process.stdout.write(`${await commitHeartbeatArm(hermitDir, config, taskId)}\n`);
}

export async function run(verb: string, args: string[]): Promise<void> {
  const hermitDir = args[0] ? path.resolve(args[0]) : null;
  if (!hermitDir) {
    // Fail-open in the same direction the rest of the arming path does: claim
    // nothing is fresh, so the caller re-arms rather than trusting a stale monitor.
    process.stdout.write('REARM|usage\n');
    return;
  }
  const config = readConfigRaw(hermitDir) ?? {};
  if (verb === 'start-check') cmdCheck(hermitDir, config);
  else await cmdCommit(hermitDir, config, args[1] ?? '');
}
