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
//     OLD_TASK:<id>                         TaskStop this before registering
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
import { readBootId } from '../routines/registry';
import { currentHHMM, resolveHermitNowMs } from '../time';
import { heartbeatCommand, heartbeatHealth, heartbeatInterval } from './monitor-cmd';

type Json = any;

/** `<pluginRoot>` — this file sits at `<pluginRoot>/scripts/lib/heartbeat/`. */
const PLUGIN_ROOT = path.resolve(import.meta.dir, '..', '..', '..');

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

function cmdCheck(hermitDir: string, config: Json): void {
  const interval = heartbeatInterval(config);
  const health = heartbeatHealth(hermitDir, PLUGIN_ROOT, config, resolveHermitNowMs());
  // `disabled` is healthy to the daily anchor, which must leave a deliberately-off
  // heartbeat alone. Reaching `start` at all is an explicit act, so re-arm instead.
  if (health.healthy && health.reason !== 'disabled') {
    process.stdout.write(`FRESH|interval=${interval}\n`);
    return;
  }

  const runtime = readJson(runtimePath(hermitDir));
  process.stdout.write(`REARM|${health.reason}\n`);
  // Same reason as the routine leg: `start-commit` waits for a liveness file to
  // appear, so the outgoing monitor's last tick has to go before the new one spawns
  // — otherwise a monitor blocked by seccomp reads as alive, and the doctor flags
  // stale data from the prior session during the startup window.
  try { fs.rmSync(livenessPath(hermitDir), { force: true }); } catch {}
  if (typeof runtime?.task_id === 'string' && runtime.task_id) {
    process.stdout.write(`OLD_TASK:${runtime.task_id}\n`);
  }
  if (!runtime || typeof runtime.started_at !== 'string') process.stdout.write('FIRST_START:1\n');
  process.stdout.write(`INTERVAL:${interval}\n`);
  process.stdout.write(`CMD:${heartbeatCommand(PLUGIN_ROOT, hermitDir, config)}\n`);
}

/** A healthy monitor writes liveness on its first loop iteration, before any sleep. */
async function waitForLiveness(file: string): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() <= deadline) {
    if (typeof readJson(file)?.last_peek_at === 'string') return true;
    await Bun.sleep(100);
  }
  return false;
}

async function cmdCommit(hermitDir: string, config: Json, taskId: string): Promise<void> {
  const interval = heartbeatInterval(config);
  const nowMs = resolveHermitNowMs();
  const live = await waitForLiveness(livenessPath(hermitDir));

  writeJson(runtimePath(hermitDir), {
    description: 'heartbeat-monitor',
    task_id: taskId,
    command: heartbeatCommand(PLUGIN_ROOT, hermitDir, config),
    interval,
    started_at: new Date(nowMs).toISOString(),
    boot_id: readBootId(hermitDir),
  });

  if (!live) {
    process.stdout.write('DEAD|liveness-absent\n');
    return;
  }
  const hhmm = currentHHMM(config?.timezone ?? 'UTC', new Date(nowMs)) ?? new Date(nowMs).toISOString().slice(11, 16);
  appendShellLine(
    path.join(hermitDir, 'sessions'),
    'Monitoring',
    `[${hhmm}] Heartbeat: monitor registered (interval: ${config?.heartbeat?.every ?? `${interval}s`}) — liveness confirmed by /hermit-doctor heartbeat check`,
  );
  process.stdout.write(`OK|registered|interval=${interval}\n`);
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
