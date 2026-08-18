// Unit tests for parseChannelEnvelope (scripts/lib/channel-envelope.ts) — the
// single parser behind every prompt stage that reacts to an inbound channel
// message. Pure exported helper, tested in-process (not via runScript) per the
// repo convention; normalizeChannelSource has its own coverage in
// tests/channel-auth.test.ts.
//
// Usage: bun test tests/channel-envelope.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import { parseChannelEnvelope } from '../scripts/lib/channel-envelope';

describe('parseChannelEnvelope identity attributes', () => {
  // The real Discord wire shape: `user` is the display name, `user_id` the
  // numeric platform id that config.json's allowed_users actually holds.
  test('both attributes — userId takes the platform id, userName the display name', () => {
    const env = parseChannelEnvelope(
      '<channel source="plugin:discord:discord" chat_id="C1" message_id="M1" user="display-name" user_id="123456789012345678" ts="2026-08-17T23:13:10.060Z">hi</channel>',
    );
    expect(env?.userId).toBe('123456789012345678');
    expect(env?.userName).toBe('display-name');
    expect(env?.messageId).toBe('M1');
    expect(env?.ts).toBe('2026-08-17T23:13:10.060Z');
    expect(env?.body).toBe('hi');
  });

  test('user only — userId falls back to it (telegram/imessage shape)', () => {
    const env = parseChannelEnvelope('<channel source="telegram" chat_id="C1" user="U1">hi</channel>');
    expect(env?.userId).toBe('U1');
    expect(env?.userName).toBe('U1');
  });

  test('user_id only — userName stays null', () => {
    const env = parseChannelEnvelope('<channel source="discord" chat_id="C1" user_id="ID1">hi</channel>');
    expect(env?.userId).toBe('ID1');
    expect(env?.userName).toBeNull();
  });

  test('neither — both null, so a configured allowlist fails closed', () => {
    const env = parseChannelEnvelope('<channel source="discord" chat_id="C1">hi</channel>');
    expect(env?.userId).toBeNull();
    expect(env?.userName).toBeNull();
  });

  // The \buser=" regex must not match inside user_id="…" regardless of order.
  test('attribute order does not change which value wins', () => {
    const env = parseChannelEnvelope(
      '<channel user_id="ID1" chat_id="C1" user="NAME" source="discord">hi</channel>',
    );
    expect(env?.userId).toBe('ID1');
    expect(env?.userName).toBe('NAME');
  });
});
