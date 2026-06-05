'use strict';

// Per-1M-token pricing (USD). Source of truth for all cost calculations.
// Keep in sync with the displayed model names in cost-tracker.js detectModel().
// Note: when Anthropic updates prices, change ONLY this file.
const PRICING = {
  haiku:  { input: 0.80, cacheWrite: 1.00,  cacheRead: 0.08, output: 4.0  },
  sonnet: { input: 3.00, cacheWrite: 3.75,  cacheRead: 0.30, output: 15.0 },
  opus:   { input: 15.0, cacheWrite: 18.75, cacheRead: 1.50, output: 75.0 },
};

/**
 * Returns the per-component cost breakdown in USD for a single API turn.
 * Unknown models fall back to sonnet pricing.
 *
 * @param {string} model - 'haiku' | 'sonnet' | 'opus'
 * @param {number} inputTokens
 * @param {number} cacheWriteTokens
 * @param {number} cacheReadTokens
 * @param {number} outputTokens
 * @returns {{ input: number, cacheWrite: number, cacheRead: number, output: number }}
 */
function costByType(model, inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens) {
  const p = PRICING[model] || PRICING.sonnet;
  return {
    input:      (inputTokens      / 1_000_000) * p.input,
    cacheWrite: (cacheWriteTokens / 1_000_000) * p.cacheWrite,
    cacheRead:  (cacheReadTokens  / 1_000_000) * p.cacheRead,
    output:     (outputTokens     / 1_000_000) * p.output,
  };
}

/**
 * Returns the total cost in USD for a single API turn.
 */
function calculateCost(model, inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens) {
  const c = costByType(model, inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens);
  return c.input + c.cacheWrite + c.cacheRead + c.output;
}

module.exports = { PRICING, costByType, calculateCost };
