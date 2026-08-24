// Shared channel `allowed_users` allowlist gating — used by every
// UserPromptSubmit hook that reacts to an inbound <channel> envelope
// (the channel-reply-reminder, pause-keyword and channel-status-responder
// stages in lib/prompt-stages/).
// A single copy so the allowlist rule can't drift out of sync between callers.

import { normalizeChannelSource } from './channel-envelope';

type Json = any;

/**
 * Resolves an envelope's (possibly plugin-qualified) source to its configured
 * channel entry via the normalized (bare server name) key — the same key the
 * send path derives from `envelope.sourceKey`, so the auth gate and the reply
 * target can never disagree about which channel config applies. Config keyed by
 * bare server name is the convention (see normalizeChannelSource); this is the
 * one place both gate functions below resolve it, so they can't drift apart.
 */
export function channelEntry(config: Json, source: string): Json {
  const channels = config?.channels;
  if (!channels || typeof channels !== 'object') return undefined;
  const key = normalizeChannelSource(source);
  return Object.prototype.hasOwnProperty.call(channels, key) ? channels[key] : undefined;
}

/** The hermit's own account on a channel. Either field is null when the entry,
 *  the field, or the config itself is missing or malformed. */
export interface ChannelBotIdentity {
  /** `@handle` — Telegram mentions and the `/cmd@handle` suffix carry this. */
  username: string | null;
  /** Numeric platform id — Discord mentions carry this, never the handle. */
  userId: string | null;
}

/**
 * Both halves of the bot's own identity from one entry lookup. Self-mention and
 * `@botname` addressing (channel-slash-address.ts) read them from three prompt
 * stages and the reply reminder reads both together; one accessor keeps "no
 * configured identity" from meaning something different in each.
 */
export function channelBotIdentity(config: Json, source: string): ChannelBotIdentity {
  const entry = channelEntry(config, source);
  return {
    username: typeof entry?.bot_username === 'string' ? entry.bot_username : null,
    userId: entry?.bot_user_id == null ? null : String(entry.bot_user_id),
  };
}

/**
 * Mirrors channel-responder/SKILL.md 1c: absent allowed_users → accept all
 * (backwards compatible); [] → lockdown; otherwise the sender's user id must
 * be present in the list. Callers that can't respond to the operator on
 * failure (hooks) can only choose not to act — never throw or block.
 *
 * `userId` arrives canonicalized by parseChannelEnvelope (the envelope's
 * `user_id` when present, else `user`) — this gate never sees the display name
 * separately, so an allowlist can only ever be matched against the platform id.
 */
export function isAllowedSender(config: Json, source: string, userId: string | null): boolean {
  const allowedUsers = channelEntry(config, source)?.allowed_users;
  if (!Array.isArray(allowedUsers)) return true; // absent/malformed -> accept all
  if (userId === null) return false; // can't verify identity against a configured allowlist
  return allowedUsers.includes(userId);
}

/**
 * Stricter gate for state-mutating (pause/resume/snooze) and disclosure (status)
 * paths. An explicit allowed_users list still wins — but when none is configured
 * this does NOT fall back to accept-all (as isAllowedSender does). Instead it
 * trusts only the operator's pinned home chat (chat_id === default_chat_id, or
 * the learned dm_channel_id until the pin is seeded), so on a no-allowlist
 * channel a stranger in a group can't freeze the hermit or read its status,
 * while the operator's own chat keeps working with zero config.
 *
 * The anchor is the *pinned* home rather than the last-learned DM so control
 * authority can't be acquired by messaging from a new chat: default_chat_id is
 * seeded once by channel-hook and moved only from the terminal. Same fallback
 * chain as resolve-outbound-channel's proactiveChatId (duplicated rather than
 * imported — an auth gate shouldn't depend on the delivery module).
 *
 * Caveat: if the operator's home IS a group/server channel, its chat_id equals
 * the group's and every member matches — those installs must set allowed_users.
 * Pinning closes the acquisition path, not this standing exposure.
 * (Documented in docs/security.md + the CHANGELOG.)
 */
export function isTrustedController(
  config: Json, source: string, userId: string | null, chatId: string | null,
): boolean {
  const ch = channelEntry(config, source);
  if (Array.isArray(ch?.allowed_users)) {
    return isAllowedSender(config, source, userId); // explicit list (incl. [] lockdown) wins
  }
  // `||`, not `??`: an empty-string pin must not mask a working dm_channel_id and
  // lock the operator out of control entirely. Truthiness on both sides so a pair
  // of empty values can never match either.
  const home = ch?.default_chat_id || ch?.dm_channel_id; // no list -> pinned-home binding
  return !!home && !!chatId && String(home) === String(chatId);
}

/**
 * The one inbound surface that may write the security tier of settings
 * (channel-settings-gate.ts). Strictly above isTrustedController: the home chat
 * carries control authority (pause/status), the maintainer chat carries
 * *settings* authority.
 *
 * Two independent facts must hold, and both come from the platform rather than
 * from message text: the envelope's chat is the configured maintainer chat, and
 * its canonical sender passes any configured allowlist. `user="operator"` is an
 * attacker-chosen string; a chat id is not, which is what makes this a
 * materially stronger signal than the envelope's identity attributes alone.
 *
 * Deliberately NOT an isTrustedController fallback chain: with no
 * maintainer_channel_id configured this returns false, and it stays exactly
 * that strict. The fallback for installs that never configured one lives in
 * isSettingsController below — which is what the gate calls — so every caller
 * wanting the strict reading of "is this the maintainer chat" still gets it.
 *
 * Caveat, sharper here than on isTrustedController: `isAllowedSender` accepts
 * all senders when no `allowed_users` is configured, so on a no-allowlist
 * install the chat id is the ONLY factor. If the maintainer chat is a group or
 * server channel — which is the usual shape, since it exists to carry technical
 * traffic away from the client chat — every member of that channel holds this
 * tier. An install that points maintainer_channel_id at anything but a 1:1 chat
 * must set `allowed_users`. (Documented in docs/security.md.)
 * The enrollment root (allowed_users, default_chat_id, dm_channel_id,
 * maintainer_channel_id) stays terminal-only even here — the gate owns that
 * list, because a chat that can re-point itself is a privilege the operator
 * can no longer revoke.
 */
export function isMaintainerController(
  config: Json, source: string, userId: string | null, chatId: string | null,
): boolean {
  const maintainer = channelEntry(config, source)?.maintainer_channel_id;
  if (!maintainer || !chatId || String(maintainer) !== String(chatId)) return false;
  return isAllowedSender(config, source, userId);
}

/**
 * Settings authority for one inbound turn — what channel-settings-gate.ts asks.
 * Either of two things grants it:
 *
 *   1. the chat IS the configured maintainer chat (isMaintainerController), or
 *   2. no maintainer chat is configured and this is an operator-run install, in
 *      which case the hermit's own pinned home chat carries the tier.
 *
 * The fallback exists because `maintainer_channel_id` is an outbound-routing
 * field for client-facing installs: the ordinary operator-run hermit never sets
 * it, which left the whole security tier unreachable on exactly the unattended
 * installs whose operator lives on a channel rather than at a shell.
 *
 * It is gated on `operator_profile` because that is where the config already
 * records who is on the other end — `technical` means the person on the chat
 * runs the box, `non-technical` means a client does, and on a client install
 * the home chat is the client's, so the fallback must not apply there. That
 * makes `operator_profile` an authority input, which is why the gate holds it
 * terminal-only alongside the enrollment root: a chat that could flip its own
 * install to `technical` would grant itself this tier.
 *
 * A configured maintainer chat turns the fallback OFF rather than widening it.
 * An operator who named a settings chat meant that one — not that one plus the
 * home chat — and the narrower reading is the one they can predict.
 *
 * The `settings_from_chat: false` opt-out is enforced by the gate, not here:
 * this answers "is this chat the authority", the gate answers "may any chat
 * hold it at all".
 *
 * Caveat worth stating, because the fallback inherits it wholesale: when
 * `allowed_users` IS configured, isTrustedController defers to the allowlist and
 * stops consulting the chat id at all. So on such an install the fallback grants
 * this tier — nonce round trip included — to any allowlisted user from any chat
 * the hermit can be reached in, not only from the pinned home. `allowed_users`
 * is a reachability list, so an operator who allowlists a teammate to let them
 * ask the hermit questions has also handed them settings authority; name only
 * the people who should hold it, or point `maintainer_channel_id` at the chat
 * that should. (Documented in docs/security.md.)
 */
export function isSettingsController(
  config: Json, source: string, userId: string | null, chatId: string | null,
): boolean {
  // Truthiness, matching isMaintainerController's own guard exactly — an empty
  // string is not a configured maintainer chat, and the two must not disagree
  // about that or a `""` would deny both tiers at once.
  if (channelEntry(config, source)?.maintainer_channel_id) {
    return isMaintainerController(config, source, userId, chatId);
  }
  // `??` covers an absent key; the explicit !== 'technical' covers a null or a
  // future profile value — anything but a known operator-run install declines.
  if ((config?.operator_profile ?? 'technical') !== 'technical') return false;
  return isTrustedController(config, source, userId, chatId);
}
