// Channel-intake Stop checkpoint. After "On it" goes out, the next resident
// Stop holds once if the task record is missing or keyed to a guild text
// channel instead of a thread. Fail-open: any error returns null.
import fs from 'node:fs';
import path from 'node:path';
import { cachedChat } from './channel-chats';
import { readJson } from './cli';
import { readTasks } from './tasks';

export function intakeBlockReason(dir: string, sessionId: string | null): string | null {
  try {
    const ackPath = path.join(dir, 'state', 'intake-ack.json');
    const ack = readJson(ackPath);
    try { fs.unlinkSync(ackPath); } catch {}
    if (!ack || typeof ack !== 'object') return null;

    const ackSession = typeof ack.session_id === 'string' ? ack.session_id : null;
    if (ackSession && sessionId && ackSession !== sessionId) return null;

    const turn = readJson(path.join(dir, 'state', 'operator-turn-open.json'));
    if (!turn || typeof turn.at !== 'string') return null;
    const turnAt = Date.parse(turn.at);
    const ackAt = typeof ack.at === 'string' ? Date.parse(ack.at) : NaN;
    if (!Number.isFinite(turnAt) || !Number.isFinite(ackAt) || ackAt < turnAt) return null;

    const tasks = readTasks(dir);
    const thisTurn = tasks.filter(task => Date.parse(task.opened_at) >= turnAt);
    const ackConversation = `${ack.channel}:${ack.chat_id}`;
    if (thisTurn.length === 0 && !tasks.some(task => task.status === 'open' && task.conversation === ackConversation)) {
      return 'task skill intake is still open. Run task.ts open now for the work you just acknowledged.';
    }

    if (thisTurn.some(task => {
      if (task.owner !== 'resident' || typeof task.conversation !== 'string') return false;
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
