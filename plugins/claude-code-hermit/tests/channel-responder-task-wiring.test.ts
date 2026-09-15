import { it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './helpers/run';
const read = (skill: string) => fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
it('task precedence is before the state check and honors micro-approval first', () => { const text = read('channel-responder'); const pre = text.slice(0, text.indexOf('## 1b. Check Session State')); expect(pre).toContain('Micro-approval'); expect(pre).toContain('task.ts list'); expect(pre.indexOf('Micro-approval')).toBeLessThan(pre.indexOf('task.ts list')); });
for (const branch of ['Bound conversation', 'Bind', 'Task assignment', 'New instruction']) it(`${branch} names task invocation`, () => { const text = read('channel-responder'); const index = text.indexOf(`- **${branch}**`); expect(index).toBeGreaterThan(-1); expect(text.slice(index, index + 5500)).toContain('task.ts'); });
it('task assignment opens the record before the progress-card line', () => {
  const text = read('channel-responder');
  const slice = text.slice(text.indexOf('- **Task assignment**'), text.indexOf('- **Micro-approval response**'));
  expect(slice.indexOf('task.ts open')).toBeGreaterThan(-1);
  expect(slice.indexOf('task.ts open')).toBeLessThan(slice.indexOf('Progress card:'));
  expect(slice).not.toContain('- After the On it reply');
});
it('session-start remains and card milestones and close-out use records', () => { expect(read('channel-responder')).toContain('/claude-code-hermit:session-start'); const text = read('session'); for (const term of ['task.ts note', 'task.ts block', 'task.ts list', 'queued']) expect(text).toContain(term); });
it('REPORT handling records result and validates sender as before', () => { const text = read('watch'); expect(text).toContain('task.ts block'); expect(text).toContain('generation'); });
it('parked resume continues in place without renaming flags', () => {
  const text = read('channel-responder');
  expect(text).toContain("claude --bg --resume '<session_id>' '<body>'");
  expect(text).not.toContain("--resume '<session_id>' --name");
});
it('watch re-reads the registry before parking', () => {
  expect(read('watch')).toContain('re-read `claude agents --json`');
});
