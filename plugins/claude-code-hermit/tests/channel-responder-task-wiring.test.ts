import { it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './helpers/run';
const read = (skill: string) => fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
it('intake uses the bounded task digest and injected policy', () => {
  const text = read('channel-responder');
  const pre = text.slice(text.indexOf('## 1. Load Context'), text.indexOf('## 1c.'));
  expect(pre).toContain('task.ts list');
  expect(pre).toContain('record-operator-action.ts --force');
  expect(pre).toContain('injected TASKS.md');
  expect(pre).not.toContain('session-archive.ts');
});
for (const branch of ['Bound conversation', 'Bind', 'Task assignment', 'New instruction']) it(`${branch} names task invocation`, () => { const text = read('channel-responder'); const index = text.indexOf(`- **${branch}**`); expect(index).toBeGreaterThan(-1); expect(text.slice(index, index + 5500)).toContain('task.ts'); });
it('resident guild threads bypass helper binding', () => {
  const text = read('channel-responder');
  expect(text.indexOf('- **Resident guild thread**')).toBeLessThan(text.indexOf('- **Bind**'));
  expect(text).toContain('[resident task thread <key>]');
  expect(text).toContain('--owner resident --conversation <sourceKey>:<thread-id>');
  expect(text).toContain('Never call `conversation.ts bind`');
  expect(text).not.toContain('/claude-code-hermit:session-start');
});
it('REPORT handling records result and validates sender as before', () => { const text = read('watch'); expect(text).toContain('task.ts block'); expect(text).toContain('generation'); });
it('parked resume continues in place without renaming flags', () => {
  const text = read('channel-responder');
  expect(text).toContain("claude --bg --resume '<session_id>' '<body>'");
  expect(text).not.toContain("--resume '<session_id>' --name");
});
it('watch re-reads the registry before parking', () => {
  expect(read('watch')).toContain('re-read `claude agents --json`');
});
