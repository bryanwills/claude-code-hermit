import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture } from './helpers/tasks';
import { dutySummary } from '../scripts/lib/duty-summary';

test('requested mode and schedule remain separate from observed liveness', () => {
  const f = taskFixture();
  try {
    f.put('config.json', { heartbeat: { enabled: false }, routines: [{ id: 'daily', enabled: true, schedule: '0 9 * * *' }] });
    fs.writeFileSync(path.join(f.dir, 'state/.boot-id'), 'boot');
    f.put('state/heartbeat-monitor.control.json', { mode: 'forced', boot_id: 'boot' });
    f.put('state/routine-monitor.runtime.json', { mode: 'croncreate-fallback', boot_id: 'boot' });
    f.put('state/heartbeat-liveness.json', { last_peek_at: new Date().toISOString() });
    expect(dutySummary(f.dir).join('\n')).toContain('mode=forced');
    expect(dutySummary(f.dir).join('\n')).toContain('mode=croncreate-fallback');
    expect(dutySummary(f.dir).join('\n')).toContain('observed pid=unknown');
    f.put('state/heartbeat-monitor.control.json', { mode: 'forced', boot_id: 'previous' });
    expect(dutySummary(f.dir).join('\n')).toContain('mode=auto');
  } finally { f.cleanup(); }
});
