// heartbeat.ts — single CLI for the heartbeat mechanics, over
// lib/heartbeat/{precheck,alert-update}.ts.
//
// Usage:
//   bun heartbeat.ts precheck [--peek] <hermit-state-dir>
//     The monitor's poll and /heartbeat run's mutating tick. --peek is
//     read-only. Prints one verdict line: OK | EVALUATE | AUTO_CLOSE | ALERT |
//     SKIP|<reason>. The monitor greps these, so the grammar is load-bearing.
//
//   bun heartbeat.ts tick <hermit-dir>
//     One deterministic tick: the mutating precheck plus the bookkeeping the run
//     handler used to narrate (waiting timeout, budget composition, the
//     auto-close Monitoring line). Prints one JSON line the skill branches on.
//
//   bun heartbeat.ts ack-next-task <hermit-dir> <token>
//     Park an unchanged queued task after its notice was delivered.
//
//   bun heartbeat.ts start-check <hermit-dir>
//   bun heartbeat.ts start-commit <hermit-dir> <task-id>
//     The two halves of `heartbeat start`: is a re-arm needed, and record the
//     Monitor the skill registered in between.
//
//   bun heartbeat.ts alert-state <state-file>
//     Applies one alert-state update from stdin.
//
// The verb is spliced out of process.argv before the module loads, so each
// module keeps the argv indices it used as a standalone script — 550-odd lines
// of alert derivation and lull arithmetic stay byte-for-byte unchanged rather
// than being rethreaded through a parameter. Loading is lazy for the same
// reason it is in routines.ts: a precheck poll runs every interval and has no
// business parsing the alert-update graph.

export {}; // module scope: every import here is dynamic, and top-level await needs it

const USAGE = 'Usage: bun heartbeat.ts <precheck [--peek] <dir> | tick <dir> | ack-next-task <dir> <token> | start-check <dir> | start-commit <dir> <task-id> | alert-state <state-file>>';

const verb = process.argv[2];
process.argv.splice(2, 1);

switch (verb) {
  case 'precheck': {
    const { main } = await import('./lib/heartbeat/precheck');
    main();
    break;
  }
  case 'tick': {
    const { run } = await import('./lib/heartbeat/tick');
    await run(process.argv.slice(2));
    break;
  }
  case 'ack-next-task': {
    const { acknowledgeNextTask } = await import('./lib/heartbeat/tick');
    const { pinStateDirOrExit } = await import('./lib/cc-compat');
    const dir = pinStateDirOrExit(process.argv[2], 'heartbeat ack-next-task');
    console.log(JSON.stringify(acknowledgeNextTask(dir, process.argv[3])));
    break;
  }
  case 'start-check':
  case 'start-commit': {
    const { run } = await import('./lib/heartbeat/start');
    await run(verb, process.argv.slice(2));
    break;
  }
  case 'alert-state':
    await import('./lib/heartbeat/alert-update');
    break;
  default:
    console.error(USAGE);
    process.exit(1);
}
