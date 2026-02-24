// ─────────────────────────────────────────────────────────────
// Context Window Optimizer — smart context injection
//
// Before user messages reach the agent, this module fetches
// the most relevant memory sections from the dashboard's
// context API and prepends them to the message. This means
// the agent doesn't need to manually read MEMORY.md on
// every turn — relevant context is pre-loaded.
//
// Features:
//   - Keyword scoring: sections matching the user's message rank higher
//   - Always includes: Identity, User, Preferences (core knowledge)
//   - Prioritizes: IN PROGRESS tasks, recent entries
//   - Deprioritizes: DONE/CANCELLED tasks, old entries
//   - Token budget: configurable max tokens for context
//   - Graceful fallback: if API fails, returns empty (agent reads memory itself)
// ─────────────────────────────────────────────────────────────

const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://dashboard:7777";
const CONTEXT_BUDGET = parseInt(process.env.CONTEXT_BUDGET_TOKENS || "1500", 10);
const CONTEXT_ENABLED = process.env.CONTEXT_OPTIMIZER !== "false"; // enabled by default

/**
 * Fetch optimized context for a user message.
 * Returns a string to prepend to the message, or "" on failure.
 */
async function getOptimizedContext(userMessage) {
  if (!CONTEXT_ENABLED) return "";

  try {
    const query = encodeURIComponent(userMessage.slice(0, 300));
    const url = `${DASHBOARD_URL}/api/context?query=${query}&budget=${CONTEXT_BUDGET}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); // 3s max

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      console.error(`[context] API returned ${res.status}`);
      return "";
    }

    const data = await res.json();

    if (!data.context || data.context.trim().length === 0) {
      return "";
    }

    console.log(
      `[context] ${data.sections_included}/${data.sections_total} sections ` +
      `(${data.total_tokens} tokens, pruned ${data.sections_pruned})`
    );

    return (
      `[MEMORY CONTEXT — auto-loaded, ${data.sections_included}/${data.sections_total} sections]\n` +
      data.context +
      `\n[/MEMORY CONTEXT]\n\n`
    );
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("[context] API timed out (3s)");
    } else {
      console.error(`[context] Error: ${err.message}`);
    }
    return "";
  }
}

module.exports = { getOptimizedContext, CONTEXT_ENABLED };
