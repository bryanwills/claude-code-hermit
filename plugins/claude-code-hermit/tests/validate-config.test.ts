import { test, expect } from 'bun:test';
import { validate } from '../scripts/validate-config';

test('standalone clear settings are validated and the retired flag is ignored', () => {
  const valid = { context_hygiene: { clear: { enabled: true, quiet: '1h', max_age: '24h', min_tokens: 20000 } }, tasks: { queue_nudge_minutes: 60 } };
  expect(validate(valid).errors.filter(e => /context_hygiene|tasks/.test(e))).toEqual([]);
  expect(validate({ post_close_clear: 'retired' }).errors.some(e => e.includes('post_close_clear'))).toBe(false);
  for (const [key, value] of [['enabled', 'yes'], ['quiet', 1], ['max_age', 'later'], ['min_tokens', -1]]) {
    expect(validate({ context_hygiene: { clear: { [key]: value } } }).errors.some(e => e.includes(`context_hygiene.clear.${key}`))).toBe(true);
  }
  expect(validate({ tasks: { queue_nudge_minutes: -1 } }).errors.some(e => e.includes('queue_nudge_minutes'))).toBe(true);
});
