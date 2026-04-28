'use strict';

// Tests for watchdog-health.js — run with: node scripts/watchdog-health.test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWatchdog } = require('./watchdog-health');
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-health-test-'));
}

function writeConfig(configPath, devHermit) {
  fs.writeFileSync(configPath, JSON.stringify({ 'claude-code-dev-hermit': devHermit }), 'utf8');
}

function mockProbeResult(isOk) {
  return () => Promise.resolve(isOk
    ? { ok: true, status: 200 }
    : { ok: false, status: 502, error: 'ECONNREFUSED' });
}

function mockSleep() {
  const calls = [];
  const fn = (ms) => { calls.push(ms); return Promise.resolve(); };
  fn.calls = calls;
  return fn;
}

async function runTests() {
  // ── degradation detection ───────────────────────────────────────────────

  console.log('\nhealthy → degraded transition:');
  {
    const stateDir = tmpDir();
    const configPath = path.join(tmpDir(), 'config.json');
    writeConfig(configPath, {
      dev_health_url: 'http://localhost:3000/health',
      dev_watchdog: { enabled: true, health_interval_secs: 30, consecutive_failures_to_alert: 3 },
    });

    const sleep = mockSleep();
    const wd = createWatchdog({
      configPath, stateDir, binding: 'feature/test',
      _probe: mockProbeResult(false), _sleep: sleep,
    });

    await wd.tick(); await wd.tick();
    let alerts = readAlerts(stateDir);
    ok('no alert after 2 failures', alerts.length === 0);

    await wd.tick();
    alerts = readAlerts(stateDir);
    ok('health-degraded alert after 3 failures', alerts.length === 1);
    ok('kind is health-degraded', alerts[0].kind === 'health-degraded');
    ok('binding matches', alerts[0].binding === 'feature/test');
    ok('consecutive_failures in details', alerts[0].details.consecutive_failures === 3);
    ok('not acknowledged', alerts[0].acknowledged === false);
  }

  // ── recovery detection ──────────────────────────────────────────────────

  console.log('\ndegraded → healthy transition:');
  {
    const stateDir = tmpDir();
    const configPath = path.join(tmpDir(), 'config.json');
    writeConfig(configPath, {
      dev_health_url: 'http://localhost:3000/health',
      dev_watchdog: { enabled: true, health_interval_secs: 1, consecutive_failures_to_alert: 3 },
    });

    const sleep = mockSleep();
    const wdFail = createWatchdog({
      configPath, stateDir, binding: 'main',
      _probe: mockProbeResult(false), _sleep: sleep,
    });
    await wdFail.tick(); await wdFail.tick(); await wdFail.tick();

    const wdRecover = createWatchdog({
      configPath, stateDir, binding: 'main',
      _probe: mockProbeResult(true), _sleep: sleep,
    });
    const wdBoth = createWatchdog({
      configPath, stateDir, binding: 'main-recovery',
      _probe: mockProbeResult(false), _sleep: sleep,
    });
    await wdBoth.tick(); await wdBoth.tick(); await wdBoth.tick();
    ok('health-degraded emitted for main-recovery', readAlerts(stateDir).filter(a => a.binding === 'main-recovery' && a.kind === 'health-degraded').length === 1);
  }

  // ── recovery via stateful instance ─────────────────────────────────────

  console.log('\ndegraded → healthy (stateful instance):');
  {
    const stateDir = tmpDir();
    const configPath = path.join(tmpDir(), 'config.json');
    writeConfig(configPath, {
      dev_health_url: 'http://localhost:3000/health',
      dev_watchdog: { enabled: true, health_interval_secs: 1, consecutive_failures_to_alert: 3 },
    });

    const sleep = mockSleep();
    let shouldPass = false;
    const wd = createWatchdog({
      configPath, stateDir, binding: 'main',
      _probe: () => Promise.resolve(shouldPass
        ? { ok: true, status: 200 }
        : { ok: false, status: 502, error: 'ECONNREFUSED' }),
      _sleep: sleep,
    });

    // Drive to degraded
    await wd.tick(); await wd.tick(); await wd.tick();
    ok('state is degraded after 3 failures', wd.getState() === 'degraded');

    // Now pass — should emit health-recovered
    shouldPass = true;
    await wd.tick();
    const alerts = readAlerts(stateDir);
    ok('health-recovered emitted after passing probe', alerts.some(a => a.kind === 'health-recovered'));
    ok('state returns to healthy', wd.getState() === 'healthy');
  }

  // ── deduplication ───────────────────────────────────────────────────────

  console.log('\ndeduplication — suppress same kind within window:');
  {
    const stateDir = tmpDir();
    const configPath = path.join(tmpDir(), 'config.json');
    // interval=30 → dedup window = 120s; our test runs in < 1s so dedup always applies
    writeConfig(configPath, {
      dev_health_url: 'http://localhost:3000/health',
      dev_watchdog: { enabled: true, health_interval_secs: 30, consecutive_failures_to_alert: 3 },
    });

    const sleep = mockSleep();
    const wd = createWatchdog({
      configPath, stateDir, binding: 'feature/dup',
      _probe: mockProbeResult(false), _sleep: sleep,
    });

    await wd.tick(); await wd.tick(); await wd.tick(); // triggers degraded
    ok('first degraded event written', readAlerts(stateDir).length === 1);

    // Additional failure ticks — dedup window is still active (real time < 120s)
    await wd.tick(); await wd.tick();
    ok('no duplicate within dedup window', readAlerts(stateDir).length === 1);
  }

  // ── disabled watchdog ───────────────────────────────────────────────────

  console.log('\ndev_watchdog.enabled: false:');
  {
    const stateDir = tmpDir();
    const configPath = path.join(tmpDir(), 'config.json');
    writeConfig(configPath, {
      dev_health_url: 'http://localhost:3000/health',
      dev_watchdog: { enabled: false },
    });

    const sleep = mockSleep();
    let probed = false;
    const wd = createWatchdog({
      configPath, stateDir, binding: 'main',
      _probe: () => { probed = true; return Promise.resolve({ ok: false }); },
      _sleep: sleep,
    });
    await wd.tick();

    ok('probe not called when disabled', !probed);
    ok('no alerts emitted when disabled', readAlerts(stateDir).length === 0);
    ok('sleep(5000) called as heartbeat', sleep.calls[0] === 5000);
  }

  // ── no dev_health_url ───────────────────────────────────────────────────

  console.log('\nno dev_health_url:');
  {
    const stateDir = tmpDir();
    const configPath = path.join(tmpDir(), 'config.json');
    writeConfig(configPath, { dev_watchdog: { enabled: true } });

    const sleep = mockSleep();
    let probed = false;
    const wd = createWatchdog({
      configPath, stateDir, binding: 'main',
      _probe: () => { probed = true; return Promise.resolve({ ok: true }); },
      _sleep: sleep,
    });
    const result = await wd.tick();

    ok('probe not called when no URL', !probed);
    ok('returns exit:true signal', result?.exit === true);
  }

  // ── config re-read per tick ─────────────────────────────────────────────

  console.log('\nconfig re-read — threshold change takes effect:');
  {
    const stateDir = tmpDir();
    const configPath = path.join(tmpDir(), 'config.json');

    writeConfig(configPath, {
      dev_health_url: 'http://localhost:3000/health',
      dev_watchdog: { enabled: true, health_interval_secs: 1, consecutive_failures_to_alert: 5 },
    });

    const sleep = mockSleep();
    const wd = createWatchdog({ configPath, stateDir, binding: 'main', _probe: mockProbeResult(false), _sleep: sleep });

    await wd.tick(); await wd.tick(); await wd.tick(); // 3 failures, threshold=5 → no alert
    ok('no alert at 3 failures with threshold=5', readAlerts(stateDir).length === 0);

    writeConfig(configPath, {
      dev_health_url: 'http://localhost:3000/health',
      dev_watchdog: { enabled: true, health_interval_secs: 1, consecutive_failures_to_alert: 3 },
    });
    await wd.tick(); // now threshold=3, failures=4 >= 3 → alert
    ok('alert fires after threshold lowered to 3', readAlerts(stateDir).length === 1);
  }
}

runTests().then(() => {
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}).catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
