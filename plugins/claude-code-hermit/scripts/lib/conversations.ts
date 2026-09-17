import fs from 'node:fs';
import path from 'node:path';
import { acquireLockWithWait, releaseLock } from './lockfile';
import { writeFileAtomic } from './md-write';

export type ConversationStatus = 'running' | 'idle' | 'parked' | 'unknown';
export interface Conversation {
  session_name: string;
  session_id: string;
  worktree: string;
  generation: number;
  card: { chat_id: string; message_id: string } | null;
  muted: boolean;
  created: string;
  last_activity: string;
  status: ConversationStatus;
}
export type ConversationPatch = Partial<Omit<Conversation, 'created' | 'generation'>> & { generation?: '+1' };
type Store = Record<string, Conversation>;

function withStore<T>(dir: string, write: boolean, run: (store: Store) => T): T {
  const file = path.join(dir, 'state', 'conversations.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  if (!acquireLockWithWait(lock, 2000)) throw new Error('lock-unavailable');
  try {
    let store: Store;
    try { store = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw new Error('invalid-store');
      store = {};
    }
    if (!store || typeof store !== 'object' || Array.isArray(store)) throw new Error('invalid-store');
    const result = run(store);
    if (write) writeFileAtomic(file, JSON.stringify(store, null, 2) + '\n');
    return result;
  } finally { releaseLock(lock); }
}

// `<sourceKey>:<chat_id>`. The source half is a config key, so it stays bare word
// characters; the chat-id half has to admit what real channels hand out — Discord
// snowflakes and Telegram's negative ids, but also iMessage GUIDs (`iMessage;-;+1555…`)
// and whatever a marketplace channel plugin supplies. The charset stays free of
// whitespace, colons, and markup so the key can still be interpolated into
// model-facing context and split back apart on its single separator.
export function checkKey(key: string): void {
  if (!/^[\w-]+:[\w.~+@;=-]{1,128}$/.test(key)) throw new Error('invalid-key');
}

export function lookup(dir: string, key: string): Conversation | null {
  checkKey(key);
  return withStore(dir, false, store => store[key] ?? null);
}

export function list(dir: string): Store {
  return withStore(dir, false, store => store);
}

export function bind(dir: string, key: string, input: Pick<Conversation, 'session_name' | 'session_id' | 'worktree'>): void {
  checkKey(key);
  if (!input.session_name || !input.session_id || !path.isAbsolute(input.worktree)) throw new Error('invalid-binding');
  withStore(dir, true, store => {
    if (store[key]) throw new Error('already-bound');
    const now = new Date().toISOString();
    store[key] = { ...input, generation: 1, card: null, muted: false, created: now, last_activity: now, status: 'running' };
  });
}

export function update(dir: string, key: string, patch: ConversationPatch): void {
  checkKey(key);
  withStore(dir, true, store => {
    const record = store[key];
    if (!record) throw new Error('not-found');
    const { generation, ...fields } = patch;
    store[key] = { ...record, ...fields, generation: record.generation + (generation === '+1' ? 1 : 0), last_activity: new Date().toISOString() };
  });
}

export function unbind(dir: string, key: string): void {
  checkKey(key);
  withStore(dir, true, store => { delete store[key]; });
}

const JOB_ID = /^[0-9a-f]{8}$/;
const JOB_FIELD_CAP = 120;

export type HelperStatusRow = {
  name: unknown;
  sessionId: unknown;
  state: unknown;
  detail?: string;
  tempo?: string;
  needs?: string;
  age_s?: number;
};

function cappedField(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return value.slice(0, JOB_FIELD_CAP);
}

export function helperStatus(agentsText: string, jobsDir: string, nowMs: number): HelperStatusRow[] {
  let agents: unknown;
  try { agents = JSON.parse(agentsText); } catch { return []; }
  if (!Array.isArray(agents)) return [];
  const rows: HelperStatusRow[] = [];
  for (const agent of agents) {
    if (agent?.kind !== 'background') continue;
    const row: HelperStatusRow = { name: agent.name, sessionId: agent.sessionId, state: agent.state };
    const id = agent.id;
    if (typeof id === 'string' && JOB_ID.test(id)) {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(jobsDir, id, 'state.json'), 'utf8'));
        if (job && typeof job === 'object' && !Array.isArray(job)) {
          const rec = job as Record<string, unknown>;
          const detail = cappedField(rec.detail);
          if (detail) row.detail = detail;
          if (typeof rec.tempo === 'string') row.tempo = rec.tempo;
          const needs = cappedField(rec.needs);
          if (needs) row.needs = needs;
          if (typeof rec.updatedAt === 'string') {
            const updated = Date.parse(rec.updatedAt);
            if (Number.isFinite(updated)) row.age_s = Math.floor((nowMs - updated) / 1000);
          }
        }
      } catch {}
    }
    rows.push(row);
  }
  return rows;
}

export async function awaitAgent(
  bgId: string,
  opts: { timeoutMs: number; readRegistry: () => unknown },
): Promise<{ sessionId: string; cwd: string } | null> {
  if (!JOB_ID.test(bgId)) throw new Error('invalid-bg-id');
  const deadline = Date.now() + opts.timeoutMs;
  while (true) {
    let agents: unknown = opts.readRegistry();
    if (typeof agents === 'string') {
      try { agents = JSON.parse(agents); } catch { agents = []; }
    }
    const entry = Array.isArray(agents) ? agents.find(agent => agent?.id === bgId) : undefined;
    if (entry && typeof entry.sessionId === 'string' && typeof entry.cwd === 'string') {
      return { sessionId: entry.sessionId, cwd: entry.cwd };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await Bun.sleep(Math.min(1000, remaining));
  }
}

export function prune(dir: string, agentsText: string): void {
  withStore(dir, false, store => {
    let agents: unknown;
    try { agents = JSON.parse(agentsText); } catch { return; }
    if (!Array.isArray(agents) || agents.length === 0) return;
    const ids = new Set(agents.map(agent => agent?.sessionId).filter(id => typeof id === 'string'));
    let changed = false;
    for (const record of Object.values(store)) {
      if ((record.status === 'running' || record.status === 'idle') && !ids.has(record.session_id)) {
        record.status = 'unknown';
        changed = true;
      }
    }
    if (changed) writeFileAtomic(path.join(dir, 'state', 'conversations.json'), JSON.stringify(store, null, 2) + '\n');
  });
}
