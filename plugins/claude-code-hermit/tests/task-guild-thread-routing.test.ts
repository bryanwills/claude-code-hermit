import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture } from './helpers/tasks';

test('resident guild thread resolves without a helper binding', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open(['--owner', 'resident', '--conversation', 'discord:thread1', '--card', JSON.stringify({ chat_id: 'thread1', message_id: 'card1' })]);
    const list = await f.ok('list', ['--conversation', 'discord:thread1', '--open', '--json']);
    expect(list.rows.map((r: any) => r.id)).toEqual([id]);
    expect(list.rows[0].owner).toBe('resident');
    expect(fs.existsSync(path.join(f.dir, 'state/conversations.json'))).toBe(false);
  } finally { f.cleanup(); }
});
