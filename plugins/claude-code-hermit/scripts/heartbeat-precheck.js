'use strict';

// heartbeat-precheck.js — fast-path verdict before the LLM evaluates HEARTBEAT.md.
// Usage: node heartbeat-precheck.js [--peek] <hermit-state-dir>
// Output (stdout, one line): SKIP|<reason>  |  OK  |  AUTO_CLOSE  |  EVALUATE
// Exit 0 always. Without --peek: writes updated alert-state.json (increments total_ticks).
// With --peek: read-only — computes the same verdict without any state mutation.
//
// Owner contract (write-field split with SKILL.md):
//   This script owns: alert-state.json total_ticks
//   SKILL.md owns:    alert-state.json alerts{}, self_eval{}, last_digest_date

const fs = require('fs');
const path = require('path');
const { currentHHMM, todayYMD } = require('./lib/time');

function emit(verdict) {
  process.stdout.write(verdict + '\n');
  process.exit(0);
}

const peek = process.argv[2] === '--peek';
const stateDir = peek ? process.argv[3] : process.argv[2];
if (!stateDir) emit('EVALUATE');

const readJSON = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
};

const writeJSON = (p, obj) => {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8'); }
  catch { /* fail-open */ }
};

// Normalises a HEARTBEAT.md checklist item to its dedup key.
// Key format mirrors SKILL.md: 'checklist:<first-8-chars-normalized>'.
function normalizeItemKey(itemText) {
  const text = itemText
    .replace(/^[-*+]\s*(\[.\]\s*)?/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  return text ? `checklist:${text}` : null;
}

let heartbeatContent;
try { heartbeatContent = fs.readFileSync(path.join(stateDir, 'HEARTBEAT.md'), 'utf-8'); }
catch { emit('SKIP|HEARTBEAT.md missing'); }

const checklistItems = heartbeatContent
  .split('\n')
  .map(l => l.trim())
  .filter(l => /^[-*+]\s/.test(l));

if (checklistItems.length === 0) emit('SKIP|HEARTBEAT.md has no checklist items');

// Pending-close drain: if the daily-auto-close routine queued a close because the
// operator was active at midnight, drain it as soon as a 10-min lull appears.
// Runs BEFORE active-hours / 20-tick / micro-proposal gates — the close is the
// signal, not a notification.
if (readJSON(path.join(stateDir, 'state', 'pending-close.json')) !== null) {
  const runtime = readJSON(path.join(stateDir, 'state', 'runtime.json')) ?? {};
  if (runtime.session_state === 'in_progress') {
    const lastAction = readJSON(path.join(stateDir, 'state', 'last-operator-action.json'));
    const tStr = lastAction && typeof lastAction.at === 'string' ? lastAction.at : null;
    const t = tStr ? new Date(tStr).getTime() : NaN;
    let now = Date.now();
    if (process.env.HERMIT_NOW) {
      const d = new Date(process.env.HERMIT_NOW).getTime();
      if (!isNaN(d)) now = d;
    }
    // Absent or malformed last-operator-action.json → treat as idle indefinitely
    // (per daily-auto-close SKILL.md step 5 fail-open rule).
    if (isNaN(t) || (now - t) / (1000 * 60) > 10) emit('AUTO_CLOSE');
  }
}

const config = readJSON(path.join(stateDir, 'config.json')) ?? {};
const hbConfig = config.heartbeat ?? {};
const timezone = config.timezone ?? 'UTC';
const activeHours = hbConfig.active_hours;

if (activeHours?.start && activeHours?.end) {
  const hhmm = currentHHMM(timezone);
  if (hhmm !== null && (hhmm < activeHours.start || hhmm >= activeHours.end)) {
    emit('SKIP|outside active hours');
  }
}

const alertStatePath = path.join(stateDir, 'state', 'alert-state.json');
const alertState = readJSON(alertStatePath) ?? { alerts: {}, last_digest_date: null, self_eval: {}, total_ticks: 0 };
if (typeof alertState.total_ticks !== 'number' || !Number.isFinite(alertState.total_ticks)) {
  alertState.total_ticks = 0;
}
if (!peek) {
  alertState.total_ticks += 1;
  writeJSON(alertStatePath, alertState);
}

// peek fires one tick early; the subsequent mutating call lands on the multiple-of-20
if (peek ? (alertState.total_ticks + 1) % 20 === 0 : alertState.total_ticks % 20 === 0) emit('EVALUATE');

const microProposals = readJSON(path.join(stateDir, 'state', 'micro-proposals.json')) ?? { pending: [] };
const hasPendingMicro = Array.isArray(microProposals.pending) &&
  microProposals.pending.some(p => p.status === 'pending' && p.tier === 1);
if (hasPendingMicro) emit('EVALUATE');

const runtime = readJSON(path.join(stateDir, 'state', 'runtime.json')) ?? {};
const sessionState = runtime.session_state ?? 'idle';

if (sessionState === 'in_progress') {
  let now = Date.now();
  if (process.env.HERMIT_NOW) {
    const d = new Date(process.env.HERMIT_NOW).getTime();
    if (!isNaN(d)) now = d;
  }

  // Prefer last-operator-action.json: records genuine operator prompts only, unaffected
  // by routine writes (reflect, scheduled-checks, heartbeat alerts) that bump SHELL.md mtime.
  // Falls back to SHELL.md mtime for pre-upgrade installs that don't have the file yet.
  let usedActionFile = false;
  try {
    const lastAction = readJSON(path.join(stateDir, 'state', 'last-operator-action.json'));
    if (lastAction && typeof lastAction.at === 'string') {
      const t = new Date(lastAction.at).getTime();
      if (!isNaN(t)) {
        if ((now - t) / (1000 * 60 * 60) > 12) emit('AUTO_CLOSE');
        usedActionFile = true; // valid timestamp — skip mtime fallback
      }
    }
  } catch { /* fail-open: fall through to mtime */ }

  if (!usedActionFile) {
    // SHELL.md mtime fallback (absent or malformed last-operator-action.json).
    // Fail-open: any stat error → fall through to EVALUATE (LLM does the stale check).
    try {
      const shellPath = path.join(stateDir, 'sessions', 'SHELL.md');
      const mtime = fs.statSync(shellPath).mtime.getTime();
      if ((now - mtime) / (1000 * 60 * 60) > 12) emit('AUTO_CLOSE');
    } catch { /* fail-open */ }
  }
  // stale-session check needs SHELL.md parsing — delegate to LLM
  emit('EVALUATE');
}

// waiting-timeout check requires elapsed computation — delegate to LLM
if (sessionState === 'waiting' && hbConfig.waiting_timeout) emit('EVALUATE');

const alerts = alertState.alerts ?? {};
const hasSuppressed = Object.values(alerts).some(e => e?.suppressed === true);
const today = todayYMD(timezone);
if (hasSuppressed && alertState.last_digest_date !== today) emit('EVALUATE');

// OK fires only when every item in HEARTBEAT.md has a matching entry in alerts{}
// that is suppressed (count > 5) and not approaching resolution (consecutive_clean === 0).
// The default template ships a freeform item that will rarely appear suppressed,
// so OK fires primarily for operators who curate structural-only checklist items.
for (const item of checklistItems) {
  const key = normalizeItemKey(item);
  if (!key) emit('EVALUATE');
  const entry = alerts[key];
  if (!entry || !entry.suppressed || (entry.consecutive_clean ?? 0) > 0) emit('EVALUATE');
}

emit('OK');
