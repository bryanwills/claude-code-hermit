// Unit tests for scripts/lib/channel-auth.ts and its normalizeChannelSource
// dependency (scripts/lib/channel-envelope.ts) — the shared config-lookup gate
// behind pause-keyword.ts, channel-reply-reminder.ts, and
// channel-status-responder.ts. Pure exported helpers, tested in-process (not
// via runScript) per the repo convention (see tests/pause-lib.test.ts).
//
// Usage: bun test tests/channel-auth.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import { normalizeChannelSource } from '../scripts/lib/channel-envelope';
import {
  isAllowedSender, isTrustedController, isMaintainerController, isSettingsController,
  settingsPolicy,
} from '../scripts/lib/channel-auth';

describe('normalizeChannelSource', () => {
  test('plugin-qualified source — returns the server name', () => {
    expect(normalizeChannelSource('plugin:discord:discord')).toBe('discord');
    expect(normalizeChannelSource('plugin:voice:voice')).toBe('voice');
  });

  test('bare source — passes through unchanged', () => {
    expect(normalizeChannelSource('discord')).toBe('discord');
  });

  test('non-plugin colon string — passes through unchanged', () => {
    expect(normalizeChannelSource('foo:bar')).toBe('foo:bar');
  });

  test('more than two segments after plugin: — NOT normalized (unrecognized shape)', () => {
    expect(normalizeChannelSource('plugin:a:b:c')).toBe('plugin:a:b:c');
  });

  test('empty string — passes through unchanged', () => {
    expect(normalizeChannelSource('')).toBe('');
  });
});

describe('isAllowedSender with plugin-qualified sources', () => {
  test('qualified source resolves to bare-keyed config allowlist', () => {
    const config = { channels: { discord: { allowed_users: ['U1'] } } };
    expect(isAllowedSender(config, 'plugin:discord:discord', 'U1')).toBe(true);
    expect(isAllowedSender(config, 'plugin:discord:discord', 'STRANGER')).toBe(false);
  });

  test('no allowlist configured, qualified source — accept-all fallback still applies', () => {
    const config = { channels: { discord: {} } };
    expect(isAllowedSender(config, 'plugin:discord:discord', 'ANYONE')).toBe(true);
  });

  test('qualified source, no matching config entry at all — accept-all fallback (absent allowlist)', () => {
    const config = { channels: {} };
    expect(isAllowedSender(config, 'plugin:discord:discord', 'ANYONE')).toBe(true);
  });
});

describe('isTrustedController with plugin-qualified sources', () => {
  test('DM-binding match on a qualified source, no allowlist configured', () => {
    const config = { channels: { discord: { dm_channel_id: '1' } } };
    expect(isTrustedController(config, 'plugin:discord:discord', 'U1', '1')).toBe(true);
    expect(isTrustedController(config, 'plugin:discord:discord', 'U1', '99')).toBe(false);
  });

  test('explicit allowlist on a qualified source wins over DM binding', () => {
    const config = { channels: { discord: { allowed_users: ['ALLOWED'], dm_channel_id: '1' } } };
    expect(isTrustedController(config, 'plugin:discord:discord', 'ALLOWED', '99')).toBe(true);
    expect(isTrustedController(config, 'plugin:discord:discord', 'STRANGER', '1')).toBe(false);
  });

  test('allowed_users=[] lockdown on a qualified source — nobody trusted', () => {
    const config = { channels: { discord: { allowed_users: [] } } };
    expect(isTrustedController(config, 'plugin:discord:discord', 'ANYONE', '1')).toBe(false);
  });

  test('normalized bare key is authoritative — the send path uses the same key, so auth must too', () => {
    // A config keyed ONLY by the qualified form is off-convention and does not
    // resolve: the send path always looks up the normalized bare name, so if the
    // auth gate honored the qualified key it would pass a sender the send path
    // can't route/token (the #634 auth/send split). The bare key is the one truth.
    const qualifiedOnly = { channels: { 'plugin:discord:discord': { dm_channel_id: '1' } } };
    expect(isTrustedController(qualifiedOnly, 'plugin:discord:discord', 'U1', '1')).toBe(false);

    // When both forms are present, the normalized (bare) key wins.
    const both = {
      channels: {
        'plugin:discord:discord': { dm_channel_id: '1' },
        discord: { dm_channel_id: '99' },
      },
    };
    expect(isTrustedController(both, 'plugin:discord:discord', 'U1', '99')).toBe(true);
    expect(isTrustedController(both, 'plugin:discord:discord', 'U1', '1')).toBe(false);
  });

  test('genericity: an unrecognized custom channel plugin normalizes the same way', () => {
    const config = { channels: { crm: { dm_channel_id: '1' } } };
    expect(isTrustedController(config, 'plugin:acme-crm:crm', 'U1', '1')).toBe(true);
  });

  test('no config entry matches, qualified or normalized — untrusted (fails closed)', () => {
    const config = { channels: {} };
    expect(isTrustedController(config, 'plugin:discord:discord', 'U1', '1')).toBe(false);
  });
});

// With no allowed_users, control authority binds to the *pinned* home rather
// than the last-learned DM: dm_channel_id follows whichever chat wrote last, so
// anchoring there let a new chat acquire pause/resume/status authority just by
// messaging. default_chat_id only moves from the terminal.
describe('isTrustedController — pinned-home anchor', () => {
  test('the pin is the anchor; a moved dm_channel_id grants nothing', () => {
    const config = { channels: { discord: { dm_channel_id: 'MOVED', default_chat_id: 'HOME' } } };
    expect(isTrustedController(config, 'discord', 'U1', 'HOME')).toBe(true);
    expect(isTrustedController(config, 'discord', 'U1', 'MOVED')).toBe(false);
  });

  test('unpinned install still anchors on the learned DM (unchanged for pre-pin configs)', () => {
    const config = { channels: { discord: { dm_channel_id: 'D1' } } };
    expect(isTrustedController(config, 'discord', 'U1', 'D1')).toBe(true);
    expect(isTrustedController(config, 'discord', 'U1', 'OTHER')).toBe(false);
  });

  test('an explicit allowlist still wins over the pin', () => {
    const config = {
      channels: { discord: { allowed_users: ['ALLOWED'], default_chat_id: 'HOME' } },
    };
    expect(isTrustedController(config, 'discord', 'ALLOWED', 'ANY')).toBe(true);
    expect(isTrustedController(config, 'discord', 'STRANGER', 'HOME')).toBe(false);
  });

  test('allowed_users=[] lockdown is not reopened by a matching pin', () => {
    const config = { channels: { discord: { allowed_users: [], default_chat_id: 'HOME' } } };
    expect(isTrustedController(config, 'discord', 'ANYONE', 'HOME')).toBe(false);
  });
});

describe('isMaintainerController — strict, no fallback', () => {
  test('the configured maintainer chat holds it; the home chat does not', () => {
    const config = {
      channels: { discord: { default_chat_id: 'HOME', maintainer_channel_id: 'OPS' } },
    };
    expect(isMaintainerController(config, 'discord', 'U1', 'OPS')).toBe(true);
    expect(isMaintainerController(config, 'discord', 'U1', 'HOME')).toBe(false);
  });

  test('unconfigured — nobody holds it, whatever the chat', () => {
    const config = { channels: { discord: { default_chat_id: 'HOME' } } };
    expect(isMaintainerController(config, 'discord', 'U1', 'HOME')).toBe(false);
  });

  test('an allowlist still applies to the maintainer chat', () => {
    const config = {
      channels: { discord: { allowed_users: ['ALLOWED'], maintainer_channel_id: 'OPS' } },
    };
    expect(isMaintainerController(config, 'discord', 'ALLOWED', 'OPS')).toBe(true);
    expect(isMaintainerController(config, 'discord', 'STRANGER', 'OPS')).toBe(false);
  });
});

// The fallback: `maintainer_channel_id` is an outbound-routing field client-
// facing installs set, so an operator-run hermit that never set one had no
// reachable security tier at all. Its home chat now carries it — but only when
// operator_profile says the person on that chat runs the box.
describe('isSettingsController — home-chat fallback', () => {
  test('technical install, no maintainer chat — the pinned home holds the tier', () => {
    const config = {
      operator_profile: 'technical',
      channels: { discord: { default_chat_id: 'HOME', dm_channel_id: 'MOVED' } },
    };
    expect(isSettingsController(config, 'discord', 'U1', 'HOME')).toBe(true);
    expect(isSettingsController(config, 'discord', 'U1', 'MOVED')).toBe(false);
  });

  test('absent operator_profile defaults to technical', () => {
    const config = { channels: { discord: { default_chat_id: 'HOME' } } };
    expect(isSettingsController(config, 'discord', 'U1', 'HOME')).toBe(true);
  });

  test('non-technical install — the client chat never inherits the tier', () => {
    const config = {
      operator_profile: 'non-technical',
      channels: { discord: { default_chat_id: 'CLIENT' } },
    };
    expect(isSettingsController(config, 'discord', 'U1', 'CLIENT')).toBe(false);
  });

  test('a configured maintainer chat turns the fallback off, not wider', () => {
    const config = {
      operator_profile: 'technical',
      channels: { discord: { default_chat_id: 'HOME', maintainer_channel_id: 'OPS' } },
    };
    expect(isSettingsController(config, 'discord', 'U1', 'OPS')).toBe(true);
    expect(isSettingsController(config, 'discord', 'U1', 'HOME')).toBe(false);
  });

  test('an empty-string maintainer id reads as unconfigured, not as a lockout', () => {
    const config = {
      operator_profile: 'technical',
      channels: { discord: { default_chat_id: 'HOME', maintainer_channel_id: '' } },
    };
    expect(isSettingsController(config, 'discord', 'U1', 'HOME')).toBe(true);
  });

  test('the fallback inherits the allowlist — a stranger in the home chat is refused', () => {
    const config = {
      operator_profile: 'technical',
      channels: { discord: { allowed_users: ['ALLOWED'], default_chat_id: 'HOME' } },
    };
    expect(isSettingsController(config, 'discord', 'ALLOWED', 'HOME')).toBe(true);
    expect(isSettingsController(config, 'discord', 'STRANGER', 'HOME')).toBe(false);
  });

  test('an unconfigured channel grants nothing', () => {
    const config = { operator_profile: 'technical', channels: {} };
    expect(isSettingsController(config, 'discord', 'U1', 'ANY')).toBe(false);
  });
});

describe('settingsPolicy', () => {
  const withPolicy = (settings_policy: unknown) => ({
    channels: { discord: { default_chat_id: 'HOME', settings_policy } },
  });

  test('the three literals round-trip', () => {
    expect(settingsPolicy(withPolicy('allow'), 'discord')).toBe('allow');
    expect(settingsPolicy(withPolicy('ask'), 'discord')).toBe('ask');
    expect(settingsPolicy(withPolicy('deny'), 'discord')).toBe('deny');
  });

  test('an absent key resolves to ask, never to allow', () => {
    expect(settingsPolicy({ channels: { discord: { default_chat_id: 'HOME' } } }, 'discord')).toBe('ask');
  });

  test('an unconfigured channel and an absent channels object resolve to ask', () => {
    expect(settingsPolicy({ channels: {} }, 'discord')).toBe('ask');
    expect(settingsPolicy({}, 'discord')).toBe('ask');
  });

  // The fail-safe direction is what makes a hand-edited or half-migrated config
  // safe: only the two literals that relax or tighten deliberately are honored,
  // and everything else keeps the confirmation code.
  test('a garbage value resolves to ask rather than being coerced', () => {
    for (const bad of [null, true, false, 0, 'open', 'ALLOW', 'allowed', {}, []]) {
      expect(settingsPolicy(withPolicy(bad), 'discord')).toBe('ask');
    }
  });

  test('the plugin-qualified source resolves like the bare name', () => {
    expect(settingsPolicy(withPolicy('allow'), 'plugin:discord:discord')).toBe('allow');
  });
});
