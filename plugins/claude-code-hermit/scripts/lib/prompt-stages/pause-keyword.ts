// UserPromptSubmit stage — deterministic pause/resume/snooze keyword writer
// (PROP-015). Writes state/pause.json directly from an inbound <channel>
// envelope, before any model involvement, so pause/resume never depends on
// model cooperation or on a tool call the pause-gate itself might deny.
//
// Probe-verified limit (compiled/spike-channel-stop-probe-2026-07-03.md): this
// only fires between turns — a UserPromptSubmit hook never sees a mid-turn
// steering message. Mid-turn "stop" is cooperative text; the binding mid-turn
// interrupt is the watchdog's Escape-to-pane (scripts/hermit-watchdog.ts).
//
// Gated by the same allowed_users allowlist as channel-reply-reminder.ts
// (lib/channel-auth.ts's isAllowedSender, shared by both; also see
// channel-responder/SKILL.md 1c) — an unauthorized sender's message is a
// silent no-op: no state change, no stdout, so the mechanism can't be probed
// by an unauthorized prompt.

import { safeForLLM } from '../sanitize';
import { senderLabel } from '../channel-envelope';
import { setPause, clearPause, parseSnoozeDuration } from '../pause';
import { isTrustedController } from '../channel-auth';
import type { StageContext, StageResult } from './types';

const MAX_BY_LEN = 64;
const MAX_DURATION_LEN = 32;

export function run(ctx: StageContext): StageResult | void {
  // Shared envelope parser (also used by channel-reply-reminder/status-responder),
  // so the grammar can't drift. Requires a chat_id — which the DM-binding gate
  // below needs anyway, and every real inbound envelope carries.
  const env = ctx.envelope;
  if (!env) return;
  const sourceRaw = env.source;
  const userId = env.userId;
  const body = env.body;
  if (!body) return;

  // Exact-match only — no fuzzy matching, so ordinary conversational text
  // ("please pause and think about this") never accidentally triggers a
  // state change.
  const keyword = body.toLowerCase();
  const snoozeMatch = /^snooze\s+(\S+)$/.exec(keyword);

  let action: 'pause' | 'resume' | 'snooze' | null = null;
  let durationRaw: string | null = null;
  if (keyword === 'pause' || keyword === 'stop') action = 'pause';
  else if (keyword === 'resume') action = 'resume';
  else if (snoozeMatch) { action = 'snooze'; durationRaw = snoozeMatch[1]; }
  if (!action) return;

  const dir = ctx.dir;
  const config = ctx.config();
  // Stricter gate than a plain reply: pausing is state-mutating, so an unconfigured
  // channel trusts only the operator's DM (chat_id === dm_channel_id), not accept-all.
  if (!isTrustedController(config, sourceRaw, userId, env.chatId)) return; // unauthorized — silent no-op

  const by = safeForLLM(senderLabel(env).slice(0, MAX_BY_LEN));

  if (action === 'pause') {
    setPause(dir, { reason: 'operator', by });
    return {
      context: `[pause] Hermit paused by ${by} (indefinite). Only the channel reply tool works until resumed.\n`,
    };
  } else if (action === 'resume') {
    clearPause(dir);
    return { context: `[pause] Hermit resumed by ${by}. Normal operation restored.\n` };
  } else {
    const durationSafe = safeForLLM((durationRaw ?? '').slice(0, MAX_DURATION_LEN));
    const ms = durationRaw ? parseSnoozeDuration(durationRaw) : null;
    if (ms === null) {
      return {
        context: `[pause] Could not parse snooze duration "${durationSafe}" — expected e.g. "30m", "2h", "1d". No change made.\n`,
      };
    }
    const until = new Date(Date.now() + ms).toISOString();
    setPause(dir, { reason: 'operator', by, until });
    return { context: `[pause] Hermit paused by ${by} until ${until}.\n` };
  }
}
