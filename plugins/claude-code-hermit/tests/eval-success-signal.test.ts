// Unit tests for proposal.ts's success-signal verb (bun test port of test-eval-success-signal.sh).
// Validate mode (grammar) and evaluate mode (MET / UNMET / INSUFFICIENT_DATA).
//
// The script is a CLI contract (argv in, process.exit + one-line JSON on stdout,
// nothing exported) — exercised as a subprocess via runScript. The bash suite's
// inline `bun -e` JSON probes are replaced by JSON.parse of stdout.
//
// Usage: bun test tests/eval-success-signal.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, runProposal } from './helpers/run';

// ---------- helpers ----------

const validate = (predicate: string) =>
  runScript('proposal.ts', { args: ['success-signal', '--validate', predicate] });

/** Run a test body with a throwaway .claude-code-hermit state dir (sessions/ pre-made). */
function withStateDir(fn: (sdir: string) => Promise<void> | void, subdir = 'sessions') {
  return async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-eval-'));
    const sdir = path.join(workdir, '.claude-code-hermit');
    fs.mkdirSync(path.join(sdir, subdir), { recursive: true });
    try {
      await fn(sdir);
    } finally {
      try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
    }
  };
}

/** Write a session report fixture with a given id, date, and cost_usd. */
function writeReport(sdir: string, id: string, date: string, cost: string) {
  fs.writeFileSync(path.join(sdir, 'sessions', `${id}-REPORT.md`), `---
id: ${id}
status: completed
date: ${date}
duration: ~1h
cost_usd: ${cost}
tokens: 10000
tags: []
task: "test task"
escalation: balanced
operator_turns: 2
closed_via: operator
---
# Session Report: ${id}
## Completed
Test.
`);
}

/** Evaluate-mode run; asserts exit 0 and returns the parsed JSON verdict line. */
async function evaluate(sdir: string, acceptedDate: string, acceptedInSession: string, predicate: string) {
  const r = await runProposal(sdir, ['success-signal', acceptedDate, acceptedInSession, predicate]);
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout);
}

// -------------------------------------------------------
// Validate mode
// -------------------------------------------------------

describe('validate mode', () => {
  test('validate: canonical predicate accepted', async () => {
    expect((await validate('avg_session_cost_usd < 0.30 over 10 sessions')).exitCode).toBe(0);
  });

  test('validate: <= op accepted', async () => {
    expect((await validate('avg_session_cost_usd <= 0.50 over 5 sessions')).exitCode).toBe(0);
  });

  test('validate: > op accepted', async () => {
    expect((await validate('avg_session_cost_usd > 0.10 over 3 sessions')).exitCode).toBe(0);
  });

  test('validate: >= op accepted', async () => {
    expect((await validate('avg_session_cost_usd >= 0.05 over 1 session')).exitCode).toBe(0);
  });

  test('validate: integer threshold accepted', async () => {
    expect((await validate('avg_session_cost_usd < 1 over 7 sessions')).exitCode).toBe(0);
  });

  test('validate: bad op rejected (exit non-zero)', async () => {
    expect((await validate('avg_session_cost_usd ~ 0.30 over 10 sessions')).exitCode).not.toBe(0);
  });

  test('validate: bad op prints reason', async () => {
    const r = await validate('avg_session_cost_usd ~ 0.30 over 10 sessions');
    expect(r.stdout + r.stderr).toContain('invalid grammar');
  });

  test('validate: unsupported metric rejected', async () => {
    expect((await validate('total_tokens < 1000 over 5 sessions')).exitCode).not.toBe(0);
  });

  test('validate: unsupported metric prints reason', async () => {
    const r = await validate('total_tokens < 1000 over 5 sessions');
    expect(r.stdout + r.stderr).toContain('unsupported metric');
  });

  test("validate: missing 'over N sessions' rejected", async () => {
    expect((await validate('avg_session_cost_usd < 0.30')).exitCode).not.toBe(0);
  });

  test('validate: missing window number rejected', async () => {
    expect((await validate('avg_session_cost_usd < 0.30 over sessions')).exitCode).not.toBe(0);
  });
});

// -------------------------------------------------------
// Evaluate mode
// -------------------------------------------------------

describe('evaluate mode', () => {
  test('evaluate: INSUFFICIENT_DATA when fewer sessions than window', withStateDir(async (sdir) => {
    // 3 sessions post-accept, window = 5 → not enough
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.20');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.22');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.18');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 5 sessions');
    expect(d.verdict).toBe('INSUFFICIENT_DATA');
  }));

  test('evaluate: sessions_counted in INSUFFICIENT_DATA output', withStateDir(async (sdir) => {
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.20');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 5 sessions');
    expect(d.sessions_counted).toBe(1);
  }));

  test('evaluate: MET when avg < threshold', withStateDir(async (sdir) => {
    // avg = (0.20+0.22+0.18+0.19+0.21) / 5 = 0.20 < 0.30
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.20');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.22');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.18');
    writeReport(sdir, 'S-004', '2026-05-04T10:00:00Z', '0.19');
    writeReport(sdir, 'S-005', '2026-05-05T10:00:00Z', '0.21');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 5 sessions');
    expect(d.verdict).toBe('MET');
  }));

  test('evaluate: observed value in MET output', withStateDir(async (sdir) => {
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.20');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.20');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.20');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 3 sessions');
    expect(d.observed).toBe(0.2);
  }));

  test('evaluate: UNMET when avg >= threshold (< op)', withStateDir(async (sdir) => {
    // avg = 0.40 which is NOT < 0.30
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.40');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.40');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.40');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 3 sessions');
    expect(d.verdict).toBe('UNMET');
  }));

  test('evaluate: accepted_in_session excluded from window', withStateDir(async (sdir) => {
    // S-001 is the implementation session (high cost); S-002..S-004 are under threshold.
    // If S-001 were included, avg would be (1.50+0.20+0.20+0.20)/4 = 0.525 → UNMET.
    // With exclusion, avg = (0.20+0.20+0.20)/3 = 0.20 → MET.
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '1.50');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.20');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.20');
    writeReport(sdir, 'S-004', '2026-05-04T10:00:00Z', '0.20');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'S-001', 'avg_session_cost_usd < 0.30 over 3 sessions');
    expect(d.verdict).toBe('MET');
  }));

  test('evaluate: sessions before accepted_date excluded', withStateDir(async (sdir) => {
    // S-001 is before accepted_date and should be excluded.
    // Only S-002..S-003 are valid (< 3 needed) → INSUFFICIENT_DATA.
    writeReport(sdir, 'S-001', '2026-04-01T10:00:00Z', '0.10');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.20');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.20');
    const d = await evaluate(sdir, '2026-05-01T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 3 sessions');
    expect(d.verdict).toBe('INSUFFICIENT_DATA');
  }));

  test('evaluate: malformed report does not crash (fail-open)', withStateDir(async (sdir) => {
    // Write a non-YAML file that will fail frontmatter parse.
    fs.writeFileSync(path.join(sdir, 'sessions', 'S-BAD-REPORT.md'), 'not a frontmatter file\n');
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.20');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.20');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.20');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 3 sessions');
    // Bad file is skipped; valid ones are evaluated normally.
    expect(d.verdict).toBe('MET');
  }));

  test('evaluate: missing sessions dir returns INSUFFICIENT_DATA (not crash)', withStateDir(async (sdir) => {
    // No sessions/ directory (only state/ exists).
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 3 sessions');
    expect(d.verdict).toBe('INSUFFICIENT_DATA');
  }, 'state'));

  test('evaluate: cost_usd=0 sessions excluded (no spurious MET)', withStateDir(async (sdir) => {
    // cost_usd defaults to 0.00 when the cost-tracker hook is inactive. Three
    // such sessions must NOT satisfy "< 0.30" — they are unrecorded, not $0.
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.00');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.00');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.00');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 3 sessions');
    expect(d.verdict).toBe('INSUFFICIENT_DATA');
  }));

  test('evaluate: unrecorded sessions skipped, recorded ones still count', withStateDir(async (sdir) => {
    // Two unrecorded + three recorded → window of 3 fills from the recorded ones.
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.00');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.20');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.00');
    writeReport(sdir, 'S-004', '2026-05-04T10:00:00Z', '0.20');
    writeReport(sdir, 'S-005', '2026-05-05T10:00:00Z', '0.20');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 3 sessions');
    expect(d.verdict).toBe('MET');
    expect(d.sessions_counted).toBe(3);
    expect(d.observed).toBe(0.2);
  }));
});
