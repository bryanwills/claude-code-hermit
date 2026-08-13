// Claude Code transcript JSONL builders. The schema encoded here is the one
// scripts/lib/cc-compat.ts parses (extractUsage / turnPromptText) — when the
// harness changes shape, tests/fixture-helpers.test.ts is the loud failure.

export function triggerPrompt(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: text } });
}

export interface AssistantEntryOpts {
  model?: string;
  timestamp?: string;
  inputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  outputTokens?: number;
}

export function assistantEntry(opts: AssistantEntryOpts = {}): string {
  const {
    model = 'claude-sonnet-4-6',
    timestamp,
    inputTokens = 2,
    cacheRead = 0,
    cacheWrite = 0,
    outputTokens = 50,
  } = opts;
  return JSON.stringify({
    type: 'assistant',
    ...(timestamp !== undefined ? { timestamp } : {}),
    message: {
      model,
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
        output_tokens: outputTokens,
      },
      content: [{ type: 'text', text: 'ok' }],
    },
  });
}
