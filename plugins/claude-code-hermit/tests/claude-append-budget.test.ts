// CLAUDE-APPEND budget + relocation-anchor test.
//
// The CLAUDE-APPEND block is injected into every hatched operator project's
// CLAUDE.md / CLAUDE.local.md, so it is re-paid on every session load AND every
// subagent dispatch (subagents inherit CLAUDE.md). This test locks in the
// token-efficiency trim (v-token-efficiency): it caps the block size, guards the
// per-skill description tax against creep, and — critically — asserts that every
// load-bearing anchor and every relocation target still exists. If a pointer in
// the trimmed APPEND ever dangles (e.g. the notification protocol was removed
// from channel-responder), this fails instead of silently losing behavior.
//
// Usage: bun test tests/claude-append-budget.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const APPEND_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'CLAUDE-APPEND.md');
const CHANNEL_RESPONDER = path.join(PLUGIN_ROOT, 'skills', 'channel-responder', 'SKILL.md');
const WATCH_SKILL = path.join(PLUGIN_ROOT, 'skills', 'watch', 'SKILL.md');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');
const AGENTS_DIR = path.join(PLUGIN_ROOT, 'agents');

const append = fs.readFileSync(APPEND_PATH, 'utf8');

describe('CLAUDE-APPEND size budget', () => {
  test('block stays under the post-trim ceiling', () => {
    // Pre-trim was 10,632 B. Trimmed to ~6,836 B, then held near 7,000 until the
    // auto-mode classifier's "Sanctioned egress" safety bullet (~7,164 B). Raised
    // to 7,600 for the "Channel voice" rule (~7,532 B), then to 7,700 for the
    // `ROUTINE_DUE` notification-handler line (~7,638 B), then to 7,850 for the
    // unified `channel-send.ts --notice` proactive-notify mechanism replacing the
    // model-side resolver + reply-tool instruction (~7,795 B), then to 7,900 for
    // the closing `<!-- /claude-code-hermit: Session Discipline -->` marker
    // (~7,877 B) that makes evolve-plan.ts's block bounds authoritative instead
    // of heuristic — all deliberate, reviewed additions, not creep. The
    // context-engineering trim then removed the watch authoring-rules duplicate,
    // the channel-send exit-code walkthrough, the delegation-economics tutorial,
    // the suggestion-path enumeration, and the numeric micro-rules, landing at
    // ~6,199 B. Keep a small margin without reopening the door to re-bloat.
    // Raised to 7,200 for the Recall-first routing rule: a 601 B bullet against
    // 9 B of remaining headroom, landing at ~7,092 B. Its trigger list and its
    // three justifications (channel-DB coverage, relevance+recency ranking,
    // bounded file:line digest) are also stated in recall's own frontmatter
    // description — that duplication is accepted, not overlooked, so don't
    // "fix" it by deleting either copy without checking the other.
    // Raised to 8,350 for the knowledge-placement rule (settled knowledge gets
    // one authoritative home): a 1,081 B paragraph landing at ~8,173 B. It must
    // be always-loaded — the settlement moment ("from now on, always X") happens
    // mid-conversation with no skill loaded, and an on-demand pointer proved a
    // two-hop reliability risk in review. Includes the exact observations.ts
    // call form because the fallback row is written outside any skill context.
    expect(Buffer.byteLength(append, 'utf8')).toBeLessThanOrEqual(8350);
  });
});

describe('CLAUDE-APPEND load-bearing anchors', () => {
  // These strings are referenced by other skills/scripts by name, or are the
  // literal invocation an operator-notification path executes. Removing any of
  // them breaks a cross-reference — the trim must preserve all of them.
  const anchors = [
    '<!-- claude-code-hermit: Session Discipline -->', // evolve marker (block replace)
    '<!-- /claude-code-hermit: Session Discipline -->', // closing marker (evolve block bounds)
    '## Operator Notification',                        // referenced by reflect + hermit-evolve
    '## Watches',
    '## Knowledge Discipline',
    '## Rules',
    'channel-send.ts .claude-code-hermit --notice', // the unified proactive-notify invocation
    'HEARTBEAT_EVALUATE',                              // heartbeat notification trigger
    'ROUTINE_DUE',                                      // routine-monitor notification trigger
    'covered-by-memory',                               // canonical memory-suppression code
  ];
  for (const a of anchors) {
    test(`contains anchor: ${a}`, () => {
      expect(append.includes(a)).toBe(true);
    });
  }
});

describe('relocation targets received the moved content', () => {
  test('channel-responder carries the outbound notification protocol', () => {
    const cr = fs.readFileSync(CHANNEL_RESPONDER, 'utf8');
    expect(cr.includes('Outbound notification protocol')).toBe(true);
    // the protocol body must route through the unified --notice mechanism, not a
    // model-side resolver + reply-tool call.
    expect(cr.includes('channel-send.ts')).toBe(true);
    expect(cr.includes('--notice')).toBe(true);
  });

  test('watch skill carries the authoring rules (Monitor params)', () => {
    const w = fs.readFileSync(WATCH_SKILL, 'utf8');
    expect(w.includes('Monitor tool params are required')).toBe(true);
    expect(w.includes('|| true')).toBe(true); // poll-loop resilience rule relocated in
  });

  test('APPEND points to channel-responder for the full protocol', () => {
    expect(append.includes('channel-responder')).toBe(true);
  });

  test('the two proposal gates own the covered-by-memory protocol', () => {
    // The APPEND states the memory-first rule in one sentence and defers the
    // protocol (paths, exemptions, quote-the-match) to the components that
    // execute it. If either gate loses the code, the rule has no enforcer.
    for (const agent of ['proposal-triage.md', 'reflection-judge.md']) {
      const body = fs.readFileSync(path.join(AGENTS_DIR, agent), 'utf8');
      expect(body.includes('covered-by-memory')).toBe(true);
    }
  });
});

describe('push-format constant has exactly one owner', () => {
  // The ≤200-char push rule had 9 prose copies across 4 plugins and zero code
  // backing (the code-enforced limits are Telegram 4096 / Discord 2000 in
  // lib/channel-send.ts, a different path). The APPEND is the single owner —
  // it is always loaded, so every skill's pointer resolves. Each domain plugin
  // guards its own notification skills in its own suite, because CI is
  // path-filtered per plugin and a cross-plugin assertion here would never run
  // for the edits it exists to catch.
  // Tolerant of respacing (`≤ 200 chars`): a near-miss restatement is still a
  // restatement, and this guard exists to catch exactly that.
  const CONSTANT = /≤\s*200\s*chars/;

  test('core APPEND states the constant', () => {
    expect(CONSTANT.test(append)).toBe(true);
  });

  for (const skill of ['brief', 'channel-responder']) {
    test(`${skill} defers to the APPEND instead of restating it`, () => {
      const body = fs.readFileSync(path.join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
      expect(CONSTANT.test(body)).toBe(false);
      expect(body.includes('Operator Notification push format')).toBe(true);
    });
  }

  test('brief keeps its own condensation priorities', () => {
    // The pointer replaces the shared constant, never the producer-owned
    // decision about which facts survive condensation.
    const body = fs.readFileSync(path.join(SKILLS_DIR, 'brief', 'SKILL.md'), 'utf8');
    expect(body.includes('open proposal count')).toBe(true);
  });
});

describe('per-skill description tax (creep guard)', () => {
  test('sum of frontmatter description bytes stays bounded', () => {
    let total = 0;
    for (const dir of fs.readdirSync(SKILLS_DIR)) {
      const skillPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const body = fs.readFileSync(skillPath, 'utf8');
      const m = body.match(/^description:\s*(.*)$/m);
      if (m) total += Buffer.byteLength(m[1], 'utf8');
    }
    // Current post-trim total ~7,586 B. Ceiling guards against re-bloating
    // descriptions (which are always-loaded and inherited by every subagent).
    // Raised to 8,100 when recall's description grew 214 B -> 734 B to carry
    // its use-this-instead-of-grep triggers, taking the total to ~7,879 B.
    // Reverting that one description would put the total back at ~7,359 B and
    // need no raise; keeping it (and the overlapping APPEND bullet above) is a
    // deliberate call to state the recall-first rule in both always-loaded
    // surfaces rather than rely on either alone.
    expect(total).toBeLessThanOrEqual(8100);
  });
});
