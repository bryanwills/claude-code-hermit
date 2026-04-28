'use strict';

// Tests for watchdog-errors.js — run with: node scripts/watchdog-errors.test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createErrorWatchdog, DEFAULT_ERROR_PATTERN } = require('./watchdog-errors');
const { readAlerts } = require('./lib/alerts-store');

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed += 1;
  } else {
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    failed += 1;
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-errors-test-'));
}

function writeConfig(configPath, devHermit) {
  fs.writeFileSync(configPath, JSON.stringify({ 'claude-code-dev-hermit': devHermit }), 'utf8');
}

// Creates a watchdog with an injected line stream and optional clock.
// Returns { wd, stream, clock } where clock.advance(ms) shifts the internal clock forward.
function makeWd(configPath, stateDir, binding) {
  const stream = new EventEmitter();
  let offset = 0;
  const clock = {
    now: () => Date.now() + offset,
    advance: (ms) => { offset += ms; },
  };
  const wd = createErrorWatchdog({
    configPath, stateDir, binding, _lineStream: stream, _now: clock.now,
  });
  wd.start();
  return { wd, stream, clock };
}

function injectLines(stream, lines) {
  for (const line of lines) stream.emit('line', line);
}

// ── spike detection ────────────────────────────────────────────────────────

console.log('\nspike detection — threshold reached:');
{
  const stateDir = tmpDir();
  const configPath = path.join(tmpDir(), 'config.json');
  writeConfig(configPath, {
    dev_watchdog: {
      enabled: true,
      health_interval_secs: 30,
      log_error_window_secs: 60,
      log_error_alert_threshold: 3,
    },
  });

  const { wd, stream } = makeWd(configPath, stateDir, 'feature/foo');

  // Inject 2 matching lines — below threshold
  injectLines(stream, [
    'Error: something went wrong',
    'Error: another problem',
  ]);
  wd.tickNow();
  ok('no spike at 2 errors (threshold=3)', readAlerts(stateDir).length === 0);

  // Inject one more — now at threshold
  injectLines(stream, ['Uncaught TypeError: cannot read property']);
  wd.tickNow();
  ok('error-spike alert after 3 errors', readAlerts(stateDir).length === 1);
  ok('kind is error-spike', readAlerts(stateDir)[0].kind === 'error-spike');
  ok('count in details', readAlerts(stateDir)[0].details.count === 3);

  wd.stop();
}

// ── cleared detection ──────────────────────────────────────────────────────

console.log('\ncleared detection — count drops below threshold:');
{
  const stateDir = tmpDir();
  const configPath = path.join(tmpDir(), 'config.json');
  writeConfig(configPath, {
    dev_watchdog: {
      enabled: true,
      health_interval_secs: 30,
      log_error_window_secs: 60,
      log_error_alert_threshold: 1,
    },
  });

  const { wd, stream, clock } = makeWd(configPath, stateDir, 'feature/clear');

  injectLines(stream, ['Error: boom']);
  wd.tickNow(); // → spiking
  ok('spiking after 1 error', wd.getState() === 'spiking');

  // Advance clock past the 60s window so the entry ages out on the next tick.
  clock.advance(61 * 1000);
  wd.tickNow(); // buffer pruned (entry older than window) → cleared
  ok('error-cleared emitted', readAlerts(stateDir).some(a => a.kind === 'error-cleared'));
  ok('state back to quiet', wd.getState() === 'quiet');

  wd.stop();
}

// ── non-matching lines not counted ────────────────────────────────────────

console.log('\nnon-matching lines not counted:');
{
  const stateDir = tmpDir();
  const configPath = path.join(tmpDir(), 'config.json');
  writeConfig(configPath, {
    dev_watchdog: {
      enabled: true,
      health_interval_secs: 30,
      log_error_window_secs: 60,
      log_error_alert_threshold: 2,
    },
  });

  const { wd, stream } = makeWd(configPath, stateDir, 'main');
  injectLines(stream, [
    'GET /api/users 200',
    'listening on port 3000',
    'webpack compiled successfully',
    'INFO: all systems normal',
  ]);
  wd.tickNow();
  ok('no spike for info lines', readAlerts(stateDir).length === 0);
  ok('buffer is empty (no matches)', wd.getBuffer().length === 0);

  wd.stop();
}

// ── deduplication ──────────────────────────────────────────────────────────

console.log('\ndeduplication — no duplicate spike within window:');
{
  const stateDir = tmpDir();
  const configPath = path.join(tmpDir(), 'config.json');
  writeConfig(configPath, {
    dev_watchdog: {
      enabled: true,
      health_interval_secs: 30, // dedup window = 120s
      log_error_window_secs: 60,
      log_error_alert_threshold: 1,
    },
  });

  const { wd, stream, clock } = makeWd(configPath, stateDir, 'feature/dup');

  injectLines(stream, ['Error: first']);
  wd.tickNow(); // → spike
  ok('first spike written', readAlerts(stateDir).length === 1);

  // Age out the first error so the buffer drops below threshold, triggering 'cleared'.
  clock.advance(61 * 1000);
  wd.tickNow(); // → cleared

  // Now inject a new error — should spike again but dedup window (120s) suppresses it
  // since the first spike was < 120s ago (clock advanced only 61s).
  injectLines(stream, ['Error: second']);
  wd.tickNow(); // dedup suppresses the second spike

  const alerts = readAlerts(stateDir);
  const spikes = alerts.filter(a => a.kind === 'error-spike');
  ok('only one spike within dedup window', spikes.length === 1);

  wd.stop();
}

// ── disabled watchdog ──────────────────────────────────────────────────────

console.log('\ndev_watchdog.enabled: false:');
{
  const stateDir = tmpDir();
  const configPath = path.join(tmpDir(), 'config.json');
  writeConfig(configPath, {
    dev_watchdog: { enabled: false, log_error_alert_threshold: 1, log_error_window_secs: 60 },
  });

  const { wd, stream } = makeWd(configPath, stateDir, 'main');
  injectLines(stream, ['Error: this should be ignored']);
  wd.tickNow();
  ok('no alert when disabled', readAlerts(stateDir).length === 0);

  wd.stop();
}

// ── DEFAULT_ERROR_PATTERN coverage ────────────────────────────────────────

console.log('\nDEFAULT_ERROR_PATTERN matches expected error lines:');
{
  const re = new RegExp(DEFAULT_ERROR_PATTERN);
  const matches = [
    'Error: something',
    'TypeError: cannot read',
    'EADDRINUSE: port 3000',
    'Uncaught ReferenceError: foo is not defined',
    'UnhandledPromiseRejection',
    'Cannot find module ./foo',
    'Compilation failed',
    '[fatal] something went wrong',
    'crashed',
  ];
  const noMatches = [
    'GET /api/foo 200',
    'successfully compiled',
    'webpack: done',
    'info: ready on port 3000',
  ];

  for (const line of matches) ok(`matches: ${line.slice(0, 40)}`, re.test(line));
  for (const line of noMatches) ok(`no match: ${line.slice(0, 40)}`, !re.test(line));
}

// ── config re-read (threshold change) ─────────────────────────────────────

console.log('\nconfig re-read — threshold change takes effect:');
{
  const stateDir = tmpDir();
  const configPath = path.join(tmpDir(), 'config.json');
  writeConfig(configPath, {
    dev_watchdog: { enabled: true, health_interval_secs: 30, log_error_window_secs: 60, log_error_alert_threshold: 5 },
  });

  const { wd, stream } = makeWd(configPath, stateDir, 'feature/cfg');
  injectLines(stream, ['Error: a', 'Error: b', 'Error: c']);
  wd.tickNow();
  ok('no spike at 3 errors with threshold=5', readAlerts(stateDir).length === 0);

  writeConfig(configPath, {
    dev_watchdog: { enabled: true, health_interval_secs: 30, log_error_window_secs: 60, log_error_alert_threshold: 3 },
  });
  wd.tickNow();
  ok('spike fires after threshold lowered to 3', readAlerts(stateDir).length === 1);

  wd.stop();
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
