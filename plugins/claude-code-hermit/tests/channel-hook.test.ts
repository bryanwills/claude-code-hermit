import { describe, test, expect } from 'bun:test';
import { persistDmChannelId } from '../scripts/channel-hook';

// The sender allow-list gate (channel-reply-reminder.ts isAllowedSender) and
// validate-config both require channel IDs to be strings. If a channel plugin
// delivers chat_id as a JSON number, persistDmChannelId must coerce it so a
// number never lands in config.json.
describe('persistDmChannelId — dm_channel_id string coercion', () => {
  test('coerces a numeric chat_id to its string form', () => {
    const config: any = { channels: { discord: { dm_channel_id: null } } };
    const changed = persistDmChannelId(config, 'discord', 555);
    expect(changed).toBe(true);
    expect(config.channels.discord.dm_channel_id).toBe('555');
    expect(typeof config.channels.discord.dm_channel_id).toBe('string');
  });

  test('a numeric chat_id equal to the stored string id is a no-op', () => {
    const config: any = { channels: { discord: { dm_channel_id: '555' } } };
    expect(persistDmChannelId(config, 'discord', 555)).toBe(false);
    expect(persistDmChannelId(config, 'discord', '555')).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('555');
  });

  test('a falsy chatId returns false and leaves the existing id untouched', () => {
    const config: any = { channels: { discord: { dm_channel_id: 'D1' } } };
    expect(persistDmChannelId(config, 'discord', null)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('D1');
  });
});

// The maintainer chat is an outbound-only second destination
// (docs/security.md § tiered disclosure) and must never be re-learned as
// dm_channel_id — dm_channel_id also binds operator trust in
// lib/channel-auth.ts isTrustedController.
describe('persistDmChannelId — maintainer chat exclusion', () => {
  test('a chatId equal to maintainer_channel_id is refused, dm_channel_id untouched', () => {
    const config: any = {
      channels: { discord: { dm_channel_id: 'D1', maintainer_channel_id: 'M1' } },
    };
    expect(persistDmChannelId(config, 'discord', 'M1')).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('D1');
  });

  test('a chatId equal to maintainer_channel_id is refused even when dm_channel_id is null', () => {
    const config: any = {
      channels: { discord: { dm_channel_id: null, maintainer_channel_id: 'M1' } },
    };
    expect(persistDmChannelId(config, 'discord', 'M1')).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe(null);
  });

  test('a numeric chatId matching a string maintainer_channel_id is still refused', () => {
    const config: any = {
      channels: { discord: { dm_channel_id: 'D1', maintainer_channel_id: '555' } },
    };
    expect(persistDmChannelId(config, 'discord', 555)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('D1');
  });

  test('a chatId different from maintainer_channel_id is still learned normally', () => {
    const config: any = {
      channels: { discord: { dm_channel_id: 'D1', maintainer_channel_id: 'M1' } },
    };
    expect(persistDmChannelId(config, 'discord', 'D2')).toBe(true);
    expect(config.channels.discord.dm_channel_id).toBe('D2');
  });
});
