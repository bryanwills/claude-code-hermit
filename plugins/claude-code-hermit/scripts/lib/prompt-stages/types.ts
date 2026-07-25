// The contract every UserPromptSubmit stage implements.
//
// Stages are plain functions, not scripts: they never read stdin, never write
// stdout, and never call process.exit. They return what they want emitted and
// let user-prompt-pipeline.ts decide — which is what makes the "a block emits
// JSON alone" rule enforceable in one place instead of seven.

export interface ChannelEnvelope {
  source: string;
  sourceKey: string;
  chatId: string;
  userId: string | null;
  messageId?: string | null;
  body: string;
  ts?: string | null;
}

export interface StageContext {
  /** Resolved hermit state dir — computed once for the whole pipeline. */
  dir: string;
  /** The submitted prompt text. */
  prompt: string;
  /** Parsed channel envelope, or null for operator/internal input. */
  envelope: ChannelEnvelope | null;
  /** config.json, read at most once per prompt regardless of how many stages ask. */
  config(): any;
  /** state/runtime.json, read at most once per prompt. */
  runtime(): any;
}

export interface StageResult {
  /** additionalContext to inject. Concatenated with other stages', in stage order. */
  context?: string;
  /**
   * Reason for a `{"decision":"block"}`. Set only after the stage has confirmed
   * the operator was told out-of-band (a successful channel send) — blocking
   * without that would swallow the message into silence.
   */
  block?: string;
}

export type Stage = (ctx: StageContext) => StageResult | void | Promise<StageResult | void>;
