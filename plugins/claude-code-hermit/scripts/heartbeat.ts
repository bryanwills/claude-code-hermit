// heartbeat.ts — single CLI for the heartbeat mechanics, over
// lib/heartbeat/{precheck,alert-update}.ts.
//
// Usage:
//   bun heartbeat.ts precheck [--peek] <hermit-state-dir>
//     The monitor's poll and /heartbeat run's mutating tick. --peek is
//     read-only. Prints one verdict line: OK | EVALUATE | AUTO_CLOSE | ALERT |
//     SKIP|<reason>. The monitor greps these, so the grammar is load-bearing.
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

const USAGE = 'Usage: bun heartbeat.ts <precheck [--peek] <dir> | alert-state <state-file>>';

const verb = process.argv[2];
process.argv.splice(2, 1);

switch (verb) {
  case 'precheck':
    await import('./lib/heartbeat/precheck');
    break;
  case 'alert-state':
    await import('./lib/heartbeat/alert-update');
    break;
  default:
    console.error(USAGE);
    process.exit(1);
}
