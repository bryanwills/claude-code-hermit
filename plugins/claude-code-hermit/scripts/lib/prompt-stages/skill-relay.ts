// Tell a delivered skill command's own pane turn who requested it and where to reply.

import { clearSkillRelay, readSkillRelay, renderCommand } from '../harness-command';
import type { StageContext, StageResult } from './types';

export function run(ctx: StageContext): StageResult | void {
  if (ctx.envelope) return;

  const relay = readSkillRelay(ctx.dir);
  if (!relay) return;
  if (ctx.prompt.trim() !== renderCommand(relay)) return;

  clearSkillRelay(ctx.dir);

  const doctorPolicy = relay.command === '/doctor'
    ? ' For /doctor, apply CLAUDE.md dedupe, trim, or migration changes that the operator confirms from chat. Decline the auto-mode-default and permission pre-approval offers because those settings remain terminal-only.'
    : '';

  return {
    context: `[skill-relay] This command was requested from chat by ${relay.by}. Send this turn's outcome, and any confirmation the skill needs, to ${relay.reply_to.source} chat ${relay.reply_to.chat_id} through the channel reply tool in channel voice. Never use AskUserQuestion for this turn.${doctorPolicy}\n`,
  };
}
