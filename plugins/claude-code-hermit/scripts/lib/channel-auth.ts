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
 * maintainer_channel_id configured this returns false and the tier stays
 * terminal-only, so the privilege exists only where an operator opted into it.
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
