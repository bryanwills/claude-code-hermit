// Pure prompt-token signal selection shared by the watchdog's hygiene tiers and
// doctor-check's context tripwire. Extracted because the two had drifted: the
// watchdog was moved to last_call_prompt_tokens-first (d9e782f) while doctor's
// deliberate mirror kept preferring the turn-wide max_prompt_tokens — which on a
// turn that compacted mid-flight describes a context CC already threw away.
// Doctor's original reason to duplicate (CWD-relative state paths) does not
// apply here: these functions take a cost-log entry and return numbers, no I/O.

type Json = any;

/** Fallback fixed-surface estimate when no measured value exists yet (fresh
 *  hermit before its first compaction). 50k keeps the compact trigger's
 *  cold-start behavior at the pre-conversation-gate level: threshold 100k +
 *  assumed 50k ≈ the old 150k total-prompt default. */
export const ASSUMED_SURFACE_TOKENS = 50_000;

/**
 * Prompt-side token count for a cost-log entry — approximates real context size,
 * not the per-turn billing total. Peak since the turn's last compaction when
 * present (the newest call in the normal case; stays correct across a mid-turn
 * compaction, unlike max_prompt_tokens). Entries logged before those fields
 * existed fall back to the per-call average of the summed total, which is far
 * closer to context size than the raw sum (a multi-call turn's sum is a
 * multiple of its actual context).
 */
export function promptTokensOf(entry: Json): number {
  if (typeof entry.last_call_prompt_tokens === 'number') return entry.last_call_prompt_tokens;
  if (typeof entry.max_prompt_tokens === 'number') return entry.max_prompt_tokens;
  const sum = (entry.input_tokens ?? 0) + (entry.cache_write_tokens ?? 0) + (entry.cache_read_tokens ?? 0);
  return isEstimateOnly(entry) ? Math.round(sum / (entry.api_calls || 1)) : sum;
}

/** True when a cost-log entry lacks the real per-call peak (max_prompt_tokens) and
 *  spans more than one API call — promptTokensOf can only average such an entry,
 *  which is why the destructive /clear tier refuses to act on it (the compact
 *  tier tolerates the estimate: it self-corrects one turn later). */
export function isEstimateOnly(entry: Json): boolean {
  return typeof entry.max_prompt_tokens !== 'number'
    && typeof entry.api_calls === 'number' && entry.api_calls > 1;
}

/**
 * Estimated compactible conversation in the entry's context: total prompt minus
 * the hermit's recorded fixed-surface upper bound (state/context-surface.json),
 * or minus ASSUMED_SURFACE_TOKENS when none is recorded. Because the recorded
 * value is an upper bound (it carries post-boundary wake messages), the result
 * is a lower bound on compactible content — the compact gate therefore fires
 * later than exact, never earlier.
 */
export function compactibleTokens(entry: Json, surfaceUpperBound: number | null): number {
  return promptTokensOf(entry) - (surfaceUpperBound ?? ASSUMED_SURFACE_TOKENS);
}
