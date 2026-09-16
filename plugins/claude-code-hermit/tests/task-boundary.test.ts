import { test, expect } from 'bun:test';
import { passesExecutionBoundary } from '../scripts/lib/tasks';
import { taskFixture } from './helpers/tasks';

test('execution boundary checks identity, idle age, helpers and token floor', () => {
  const f = taskFixture();
  try {
    expect(passesExecutionBoundary(f.dir)).toEqual({ ok: false, reason: 'execution-not-idle' });
    const execution = { state: 'idle', at: new Date(Date.now() - 61000).toISOString(), cc_session_id: 'resident' };
    f.put('state/execution.json', execution);
    expect(passesExecutionBoundary(f.dir)).toEqual({ ok: false, reason: 'stale-identity' });
    f.put('state/runtime.json', { cc_session_id: 'resident' });
    f.put('state/execution.json', { ...execution, at: new Date().toISOString() });
    expect(passesExecutionBoundary(f.dir)).toEqual({ ok: false, reason: 'idle-too-fresh' });
    f.put('state/execution.json', execution);
    f.put('state/conversations.json', { 'discord:thread': { status: 'running' } });
    expect(passesExecutionBoundary(f.dir)).toEqual({ ok: false, reason: 'helper-running' });
    f.put('state/conversations.json', {});
    expect(passesExecutionBoundary(f.dir, { minTokens: 20000 })).toEqual({ ok: false, reason: 'under-token-floor' });
    expect(passesExecutionBoundary(f.dir)).toEqual({ ok: true });
  } finally { f.cleanup(); }
});
