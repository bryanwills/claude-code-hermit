'use strict';

// watchdog-errors.js
// Long-running error-spike detector for /dev-up Gate 5b (always-on mode).
// Tails dev-server.log, counts dev_error_pattern matches in a rolling window,
// and emits error-spike / error-cleared events to state/alerts.json on transitions.
//
// CLI:
//   node watchdog-errors.js --config <path> --state-dir <path> --binding <branch> --log <log-path>
//
// Library API (for tests):
//   const { createErrorWatchdog } = require('./watchdog-errors');
//   const wd = createErrorWatchdog({ configPath, stateDir, binding, logPath, _lineStream });
//   // _lineStream is an EventEmitter that emits 'line' events (for testing without tail)
//
// binding is branch-only because this watchdog tails a single log file (not a
// filesystem walker). Revisit if adding fs.watch/chokidar — the binding key
// would need a worktree-path component to avoid cross-binding across worktrees.

const fs = require('node:fs');
const { execSync, spawn } = require('node:child_process');
const { isDuped, emitAlert } = require('./lib/alerts-store');
const { DEFAULT_ERROR_PATTERN } = require('./lib/dev-server-command');

function readConfig(configPath) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    return cfg['claude-code-dev-hermit'] || {};
  } catch (e) {
    return {};
  }
}

// Expands $(date ...) patterns in a log path by delegating to bash.
// Double-quotes are intentional — single-quoting would prevent $(...) expansion,
// which is exactly what we need for Winston/Pino/Laravel daily log paths.
// Input comes from operator-authored config.json, not user input.
function expandLogPath(logPath) {
  if (!logPath.includes('$(')) return logPath;
  try {
    return execSync(`bash -c "echo ${logPath}"`, { encoding: 'utf8' }).trim();
  } catch (e) {
    return logPath; // fall back to literal if bash unavailable
  }
}

// Factory — optional injections:
//   _lineStream: EventEmitter that emits 'line' strings (for tests without tail)
//   _now:        () => number — clock override for deterministic timestamp tests
function createErrorWatchdog({ configPath, stateDir, binding, logPath, _lineStream, _now }) {
  const now = _now || (() => Date.now());

  // Rolling buffer: [{timestamp, line}]
  const buffer = [];
  let state = 'quiet'; // 'quiet' | 'spiking'
  let compiledPattern = new RegExp(DEFAULT_ERROR_PATTERN);
  let tickTimer = null;
  let tailProc = null;
  let currentTailPath = null;
  let rolloverTimer = null;
  let started = false;

  function processLine(line) {
    if (compiledPattern.test(line)) {
      buffer.push({ timestamp: now(), line });
    }
  }

  function tick() {
    const cfg = readConfig(configPath);
    if (cfg.dev_watchdog?.enabled === false) return;

    const pattern = cfg.dev_error_pattern || DEFAULT_ERROR_PATTERN;
    try { compiledPattern = new RegExp(pattern); } catch (e) { /* keep previous on invalid regex */ }

    const windowMs = (cfg.dev_watchdog?.log_error_window_secs ?? 60) * 1000;
    const threshold = cfg.dev_watchdog?.log_error_alert_threshold ?? 5;
    const intervalSecs = cfg.dev_watchdog?.health_interval_secs ?? 30;

    const cutoff = now() - windowMs;
    while (buffer.length && buffer[0].timestamp < cutoff) buffer.shift();

    if (state === 'quiet' && buffer.length >= threshold) {
      emitAlert(stateDir, 'error-spike', binding, {
        count: buffer.length,
        window_secs: windowMs / 1000,
      }, intervalSecs);
      state = 'spiking';
    } else if (state === 'spiking' && buffer.length < threshold) {
      emitAlert(stateDir, 'error-cleared', binding, { count: buffer.length }, intervalSecs);
      state = 'quiet';
    }
  }

  function spawnTail(resolvedPath) {
    currentTailPath = resolvedPath;
    const proc = spawn('tail', ['-Fn0', resolvedPath]);
    let remainder = '';
    proc.stdout.on('data', (chunk) => {
      const text = remainder + chunk.toString();
      const lines = text.split('\n');
      remainder = lines.pop(); // last element may be incomplete
      for (const line of lines) {
        if (line) processLine(line);
      }
    });
    proc.on('error', () => {}); // ignore tail errors (file not found on startup is ok)
    return proc;
  }

  function start() {
    if (started) return;
    started = true;

    const lineStream = _lineStream;
    if (lineStream) {
      // Test mode: receive lines from the injected stream directly.
      lineStream.on('line', (line) => processLine(line));
    } else {
      // Production mode: spawn tail -F on the log file.
      const resolved = expandLogPath(logPath);
      tailProc = spawnTail(resolved);

      // Restart tail when a $(date ...) path changes (midnight log rotation).
      rolloverTimer = setInterval(() => {
        const newPath = expandLogPath(logPath);
        if (newPath !== currentTailPath) {
          if (tailProc) tailProc.kill();
          tailProc = spawnTail(newPath);
        }
      }, 60 * 1000);
    }

    // Tick every 1s to evaluate the rolling window.
    tickTimer = setInterval(tick, 1000);
  }

  function stop() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (rolloverTimer) { clearInterval(rolloverTimer); rolloverTimer = null; }
    if (tailProc) { tailProc.kill(); tailProc = null; }
  }

  // For tests: run a single tick synchronously after injecting lines.
  function tickNow() { tick(); }

  return { start, stop, tickNow, getState: () => state, getBuffer: () => [...buffer] };
}

module.exports = { createErrorWatchdog, DEFAULT_ERROR_PATTERN, expandLogPath };

if (require.main === module) {
  const args = process.argv.slice(2);
  function flag(name) {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : null;
  }

  const configPath = flag('--config');
  const stateDir = flag('--state-dir');
  const binding = flag('--binding');
  const logPath = flag('--log');

  if (!configPath || !stateDir || !binding || !logPath) {
    process.stderr.write(
      'usage: watchdog-errors.js --config <path> --state-dir <path> --binding <branch> --log <log-path>\n',
    );
    process.exit(2);
  }

  const wd = createErrorWatchdog({ configPath, stateDir, binding, logPath });
  wd.start();

  process.on('SIGTERM', () => { wd.stop(); process.exit(0); });
  process.on('SIGINT', () => { wd.stop(); process.exit(0); });
}
