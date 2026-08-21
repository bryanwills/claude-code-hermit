// UserPromptSubmit stage — report a delivered /model or /effort switch back to the
// session from the transcript.
//
// The gap this closes: delivery works (the Stop hook types the command into the pane
// and Claude Code applies it), but the model's sense of WHICH model it is running is
// fixed at session start and does not follow the switch. Asked "did it work?", the
// session answered from that stale self-perception and reported a working switch as a
// silent failure — twice, on two hermits, one of which then filed an upstream bug for
// a bug that did not exist.
//
// So the answer comes from the transcript instead, where the serving model is stamped
// on every assistant entry. This stage states the fact and nothing more; how it reaches
// the operator is the model's business.
//
// The timestamp gate is the whole correctness argument: on the prompt immediately after
// delivery the newest assistant entry is still the PRE-switch one, so reporting it would
// reproduce exactly the stale answer this exists to prevent. Until an entry newer than
// the delivery exists, the marker is held and the session is told only that its
// self-perception may be stale.

import { readSwitchVerify, clearSwitchVerify, renderCommand } from '../harness-command';
import { lastAssistantModel } from '../cc-compat';
import type { StageContext, StageResult } from './types';

export function run(ctx: StageContext): StageResult | void {
  const pending = readSwitchVerify(ctx.dir);
  if (!pending) return;

  const rendered = renderCommand(pending);
  const observed = ctx.transcriptPath ? lastAssistantModel(ctx.transcriptPath) : null;

  // No transcript to read, or nothing served since the switch landed: hold the marker
  // and warn rather than answer from a pre-switch entry.
  if (!observed || Date.parse(observed.timestamp) <= Date.parse(pending.delivered_at)) {
    return {
      context: `[harness-command] "${rendered}" was delivered to this session at ${pending.delivered_at} and is not yet observable in the transcript. Your own sense of which model you run is fixed at session start and does not follow a switch — do not report it as the active one.\n`,
    };
  }

  clearSwitchVerify(ctx.dir);
  return {
    context: `[harness-command] "${rendered}" delivered at ${pending.delivered_at} — the transcript now reports model ${observed.model}. That is the session's serving model; prefer it over your own sense of which model you run.\n`,
  };
}
