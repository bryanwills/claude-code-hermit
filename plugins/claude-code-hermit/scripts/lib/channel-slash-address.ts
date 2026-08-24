// Shared slash-command *addressing* for inbound channel messages — used by the
// pause-keyword, harness-command and channel-status-responder stages in
// lib/prompt-stages/.
//
// Deliberately NOT a tokenizer. It answers two questions only — "is this a slash
// command?" and "is it addressed to us?" — and hands the remainder back
// untouched. Each command family keeps its own argument grammar downstream:
// harness-command.ts splits on a single space and enforces exact token counts,
// while pause-keyword accepts `\s+` before a snooze duration. Centralizing the
// split too would force both through one rule and silently narrow `/snooze  2h`.
//
// The `@botname` suffix is Telegram's group convention (a client rewrites a
// command picked from the bot menu to `/cmd@thebot`), but the rule here is
// transport-neutral: any channel whose config entry carries a `bot_username`
// gets suffix addressing. It stays safe on every platform because the suffix
// must name THIS bot — a command aimed at another bot in a shared group is not
// ours to act on, and fails closed.

/** Strip one optional leading `@`. `channel-bot-id.ts` writes `bot_username`
 *  bare (channel-reply-reminder.ts prepends the `@` itself when matching
 *  mentions), but the same file documents that an operator may set the key by
 *  hand for a channel with no identity probe — so tolerate `@handle` there
 *  rather than silently never matching. */
function bareHandle(handle: string): string {
  return (handle.startsWith('@') ? handle.slice(1) : handle).toLowerCase();
}

export interface AddressedSlashCommand {
  /** First token, lowercased, with any `@botname` suffix removed. Keeps its leading `/`. */
  command: string;
  /** Everything after the first token, byte-for-byte — leading whitespace included. */
  rest: string;
}

/**
 * Resolves an inbound body's slash command and address.
 *
 * Returns null when the body is not a slash command, or when it carries an
 * `@suffix` that does not name this bot — including every suffixed command when
 * `botUsername` is unknown. Null means "not ours": callers return silently, the
 * same no-op an unauthorized sender gets, so the mechanism can't be probed.
 */
export function resolveSlashCommand(
  body: string, botUsername: string | null,
): AddressedSlashCommand | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('/')) return null;

  // First token is everything up to the first whitespace; `rest` keeps the
  // whitespace that follows, so a family whose grammar cares about it still sees it.
  const split = /^(\S+)([\s\S]*)$/.exec(trimmed);
  if (!split) return null;
  let command = split[1];
  const rest = split[2];

  const at = command.indexOf('@');
  if (at !== -1) {
    const suffix = bareHandle(command.slice(at + 1));
    const own = botUsername == null ? '' : bareHandle(botUsername);
    // Compared in full, never truncated: two long handles sharing a prefix must
    // not compare equal. Empty suffix (`/pause@`) can never match a real handle,
    // and an unknown handle can never authorize one — both fall out here.
    if (!own || suffix !== own) return null;
    command = command.slice(0, at);
  }

  return { command: command.toLowerCase(), rest };
}
