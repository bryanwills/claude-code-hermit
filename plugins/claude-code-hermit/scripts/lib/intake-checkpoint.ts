// Channel-intake Stop checkpoint. After "On it" goes out, the next resident
// Stop holds once if any acknowledged chat has no task record, or a new record
// is keyed to a guild text channel instead of a thread. Fail-open: any error
// returns null.
import fs from 'node:fs';
import path from 'node:path';
import { cachedChat } from './channel-chats';
import { readJson } from './cli';
import { readTasks } from './tasks';

export function intakeBlockReason(dir: string, sessionId: string | null): string | null {
  try {
    const ackPath = path.join(dir, 'state', 'intake-acks.jsonl');
    let raw = '';
    try { raw = fs.readFileSync(ackPath, 'utf8'); } catch {}
    try { fs.unlinkSync(ackPath); } catch {}
    if (!raw) return null;

    const turn = readJson(path.join(dir, 'state', 'operator-turn-open.json'));
    if (!turn || typeof turn.at !== 'string') return null;
    const turnAt = Date.parse(turn.at);
    if (!Number.isFinite(turnAt)) return null;

    const acks = raw.split('\n').flatMap(line => {
      try {
        const ack = JSON.parse(line);
        const ackSession = typeof ack?.session_id === 'string' ? ack.session_id : null;
        if (ackSession && sessionId && ackSession !== sessionId) return [];
        const ackAt = typeof ack.at === 'string' ? Date.parse(ack.at) : NaN;
        return Number.isFinite(ackAt) && ackAt >= turnAt ? [ack] : [];
      } catch { return []; }
    });
    if (acks.length === 0) return null;

    const tasks = readTasks(dir);
    const openedThisTurn = (task: { opened_at: string }) => Date.parse(task.opened_at) >= turnAt;
    // A record resumed this turn without a conversation (e.g. opened from a
    // peer request) backs the ack: its file was rewritten this turn.
    const resumedConversationless = tasks.some(task => {
      if (task.conversation !== null) return false;
      try { return fs.statSync(path.join(dir, 'tasks', `${task.id}.md`)).mtimeMs >= turnAt; } catch { return false; }
    });
    const missing = resumedConversationless ? [] : acks.filter(ack => !tasks.some(task =>
      (task.conversation === `${ack.channel}:${ack.chat_id}` || task.card_chat_id === ack.chat_id)
      && (task.status === 'open' || openedThisTurn(task))));
    if (missing.length > 0) {
      const chats = [...new Set(missing.map(ack => `${ack.channel}:${ack.chat_id}`))].join(', ');
      return `task skill intake is still open. Run task.ts open now for the work you just acknowledged in ${chats}.`;
    }

    if (tasks.some(task => {
      if (!openedThisTurn(task) || task.owner !== 'resident' || typeof task.conversation !== 'string') return false;
      const chatId = task.conversation.slice(task.conversation.indexOf(':') + 1);
      const type = cachedChat(dir, chatId)?.type;
      return type === 0 || type === 5;
    })) {
      return 'task skill resident guild thread is still open. The task record is keyed to a guild channel; open a thread and key the record to it.';
    }
    return null;
  } catch {
    return null;
  }
}
