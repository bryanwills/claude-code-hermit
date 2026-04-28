'use strict';

// watchdog-health.js
// Long-running health probe for /dev-up Gate 5b (always-on mode).
// Polls dev_health_url on a configurable interval; emits health-degraded /
// health-recovered events to state/alerts.json on state transitions.
//
// CLI:
//   node watchdog-health.js --config <path> --state-dir <path> --binding <branch>
//
// Library API (for tests):
//   const { createWatchdog } = require('./watchdog-health');
//   const wd = createWatchdog({ configPath, stateDir, binding, _probe, _sleep });
//   await wd.tick(); // run one probe cycle

const fs = require('node:fs');
const { probeOnce } = require('./lib/health-poll');
const { isDuped, emitAlert } = require('./lib/alerts-store');

function readConfig(configPath) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    return cfg['claude-code-dev-hermit'] || {};
  } catch (e) {
    return {};
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Factory — separates the probe/sleep I/O from the loop logic so tests can
// inject mocks without spawning a real process.
function createWatchdog({ configPath, stateDir, binding, _probe, _sleep }) {
  const probe = _probe || ((url, timeoutMs) => probeOnce(url, timeoutMs));
  const sleep = _sleep || defaultSleep;

  let consecutiveFailures = 0;
  let state = 'healthy'; // 'healthy' | 'degraded'

  async function tick() {
    const cfg = readConfig(configPath);

    if (cfg.dev_watchdog?.enabled === false) {
      await sleep(5000);
      return;
    }

    const url = cfg.dev_health_url;
    if (!url) {
      // No health URL — nothing to monitor. Exit cleanly so the Monitor entry
      // stops rather than spinning in a tight loop.
      return { exit: true, reason: 'no dev_health_url' };
    }

    const intervalSecs = cfg.dev_watchdog?.health_interval_secs ?? 30;
    const threshold = cfg.dev_watchdog?.consecutive_failures_to_alert ?? 3;

    const result = await probe(url, 2000);

    if (result.ok) {
      if (state === 'degraded') {
        emitAlert(stateDir, 'health-recovered', binding, { url }, intervalSecs);
        state = 'healthy';
      }
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
      if (state === 'healthy' && consecutiveFailures >= threshold) {
        emitAlert(stateDir, 'health-degraded', binding, {
          consecutive_failures: consecutiveFailures,
          last_status: result.status,
          last_error: result.error,
          url,
        }, intervalSecs);
        state = 'degraded';
      }
    }

    await sleep(intervalSecs * 1000);
    return { state, consecutiveFailures };
  }

  async function run() {
    while (true) {
      const result = await tick();
      if (result?.exit) break;
    }
  }

  return { tick, run, getState: () => state, getFailures: () => consecutiveFailures };
}

module.exports = { createWatchdog, readConfig };

if (require.main === module) {
  const args = process.argv.slice(2);
  function flag(name) {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : null;
  }

  const configPath = flag('--config');
  const stateDir = flag('--state-dir');
  const binding = flag('--binding');

  if (!configPath || !stateDir || !binding) {
    process.stderr.write(
      'usage: watchdog-health.js --config <path> --state-dir <path> --binding <branch>\n',
    );
    process.exit(2);
  }

  const wd = createWatchdog({ configPath, stateDir, binding });
  wd.run().catch((err) => {
    process.stderr.write(`watchdog-health fatal: ${err.message}\n`);
    process.exit(1);
  });
}
