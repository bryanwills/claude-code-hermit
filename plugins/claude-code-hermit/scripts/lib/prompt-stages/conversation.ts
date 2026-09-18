import { threadRecords } from '../tasks';
import { resolveSlashCommand } from '../channel-slash-address';
import { channelBotIdentity, isAllowedSender, isSelfMentioned } from '../channel-auth';
import { cachedChat } from '../channel-chats';
import { safeForLLM } from '../sanitize';
import { capture } from './channel-reply-reminder';
import type { StageContext, StageResult } from './types';

// An assignment on a Discord guild channel (type 0 or 5) gets its own thread, and the
// record's conversation key is that thread. A message in the parent channel therefore
// belongs to no task thread, whatever record the channel's key might match.
const inThreadChat = (ctx: StageContext, sourceKey: string, chatId: string) =>
  sourceKey !== 'discord' || ![0, 5].includes(cachedChat(ctx.dir, chatId)?.type ?? -1);

export async function run(ctx: StageContext): Promise<StageResult | void> {
  const env = ctx.envelope;
  if (!env || !isAllowedSender(ctx.config(), env.source, env.userId)) return;
  const key = `${env.sourceKey}:${env.chatId}`;
  const addressed = resolveSlashCommand(env.body, channelBotIdentity(ctx.config(), env.source));
  const name = addressed?.command.slice(1);
  const args = addressed?.rest.trim() ?? '';
  const conversationCommand = !!name && ['help', 'mute', 'unmute', 'restart'].includes(name) && !args;
  // Harness commands sent into a worker-owned thread belong to the thread, not the
  // session: `!clear` restarts the worker and the rest are refused here, before the
  // harness-command stage could record them for the resident. A resident-owned thread
  // takes them as ordinary session commands, like any other chat.
  const harnessCommand = !!name && ['clear', 'compact', 'model', 'effort', 'advisor', 'permission-mode'].includes(name);
  const record = inThreadChat(ctx, env.sourceKey, env.chatId)
    ? threadRecords(ctx.dir).find(task => task.conversation === key)
    : undefined;
  if (!record) {
    // `!help` is answerable anywhere, so it gets its annotation rather than the
    // "needs a thread" refusal — without one the model has nothing to act on.
    if (conversationCommand) {
      return { context: name === 'help' ? '[conversation command: help]' : '[conversation command outside a task thread]' };
    }
    return;
  }
  ctx.conversation = { key, task_id: record.id, owner: record.owner };
  const context = `[task thread ${safeForLLM(key)}: owner=${record.owner === 'resident' ? 'resident' : 'worker'}, muted=${record.muted}, waiting=${record.waiting_on !== null}]`;
  if (harnessCommand && record.owner !== 'resident') {
    ctx.skipHarnessCommand = true;
    if (name === 'clear') return { context: `${context}\n[conversation command: restart]` };
    const reason = name === 'model' || name === 'effort' ? 'per-conversation model/effort not supported' : `!${name} does not reach the resident from a task thread`;
    return { context: `${context}\n[conversation command refused: ${reason}]` };
  }
  if (conversationCommand) return { context: `${context}\n[conversation command: ${name}]` };
  // Mute silences ordinary steering, not an addressed command: pause/resume/snooze
  // and status are documented as always reachable from chat, and blocking here
  // settles the disposition before their stages ever run.
  if (record.muted && !addressed && !await isSelfMentioned(ctx.dir, ctx.config(), env.sourceKey, env.chatId, env.body)) {
    capture(ctx, env, true);
    return { block: 'muted conversation: recorded' };
  }
  return { context };
}
