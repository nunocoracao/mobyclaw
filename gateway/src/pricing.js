/**
 * pricing.js - Calculate LLM request cost from token counts.
 *
 * Prices are per 1M tokens (USD).
 * cagent sends token counts but its cost field is unreliable,
 * so we calculate it ourselves here.
 *
 * Anthropic pricing reference: https://www.anthropic.com/pricing
 */

// Model pricing table. Keys are matched via substring (lowercase).
// Ordered most-specific first.
const MODEL_PRICING = [
  // Claude 3.7 Sonnet
  {
    match: "claude-3-7-sonnet",
    input: 3.0,
    output: 15.0,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  // Claude 3.5 Sonnet (all variants)
  {
    match: "claude-3-5-sonnet",
    input: 3.0,
    output: 15.0,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  // cagent model name format: "claude-sonnet-4-6" etc.
  {
    match: "claude-sonnet",
    input: 3.0,
    output: 15.0,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  // Claude 3.5 Haiku
  {
    match: "claude-3-5-haiku",
    input: 0.80,
    output: 4.0,
    cacheRead: 0.08,
    cacheWrite: 1.0,
  },
  // Claude Haiku (generic)
  {
    match: "claude-haiku",
    input: 0.80,
    output: 4.0,
    cacheRead: 0.08,
    cacheWrite: 1.0,
  },
  // Claude 3 Opus
  {
    match: "claude-3-opus",
    input: 15.0,
    output: 75.0,
    cacheRead: 1.50,
    cacheWrite: 18.75,
  },
  // cagent model name format: "claude-opus-4-6" etc.
  {
    match: "claude-opus",
    input: 15.0,
    output: 75.0,
    cacheRead: 1.50,
    cacheWrite: 18.75,
  },
];

/**
 * Find pricing for a model by name.
 * @param {string} model - Model name (e.g. "claude-sonnet-4-6")
 * @returns {object} pricing object with input/output/cacheRead/cacheWrite per 1M tokens
 */
function getPricing(model) {
  const normalized = (model || "").toLowerCase();
  for (const p of MODEL_PRICING) {
    if (normalized.includes(p.match)) return p;
  }
  // Unknown model - warn and use a conservative fallback
  console.warn(`[pricing] Unknown model "${model}", using Sonnet pricing as fallback`);
  return { input: 3.0, output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 };
}

/**
 * Calculate cost (USD) from token usage.
 *
 * Anthropic's billing:
 *   - input_tokens:        full price for non-cached input
 *   - cached_input_tokens: cache READ price (cheaper)
 *   - cached_write_tokens: cache WRITE price (slightly more than input)
 *   - output_tokens:       output price
 *
 * Note: input_tokens from cagent includes ALL input (cached + non-cached).
 * So non-cached input = input_tokens - cached_input_tokens.
 *
 * @param {string} model
 * @param {object} tokens - { input_tokens, output_tokens, cached_input_tokens, cached_write_tokens }
 * @returns {number} cost in USD
 */
function calculateCost(model, tokens) {
  const {
    input_tokens = 0,
    output_tokens = 0,
    cached_input_tokens = 0,
    cached_write_tokens = 0,
  } = tokens;

  const pricing = getPricing(model);

  // Non-cached input = total input minus what was served from cache
  const nonCachedInput = Math.max(0, input_tokens - cached_input_tokens);

  const cost =
    (nonCachedInput * pricing.input +
      cached_input_tokens * pricing.cacheRead +
      cached_write_tokens * pricing.cacheWrite +
      output_tokens * pricing.output) /
    1_000_000;

  return cost;
}

module.exports = { calculateCost, getPricing };
