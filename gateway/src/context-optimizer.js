// ─────────────────────────────────────────────────────────────
// Context Window Optimizer — smart context injection
//
// Before user messages reach the agent, this module fetches
// the most relevant memory sections from the dashboard's
// context API and prepends them to the message. This means
// the agent doesn't need to manually read MEMORY.md on
// every turn — relevant context is pre-loaded.
//
// Also injects:
//   - Inner state (emotional state from inner.json)
//   - Self-model summary (from SELF.md)
//   - Relevant explorations (from explorations/ folder)
//
// Features:
//   - Keyword scoring: sections matching the user's message rank higher
//   - Always includes: Identity, User, Preferences (core knowledge)
//   - Inner state injection: emotional state from inner.json
//   - Exploration injection: matching explorations from curiosity sessions
//   - Prioritizes: IN PROGRESS tasks, recent entries
//   - Deprioritizes: DONE/CANCELLED tasks, old entries
//   - Token budget: configurable max tokens for context
//   - Graceful fallback: if API fails, returns empty (agent reads memory itself)
// ─────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://dashboard:7777";
const CONTEXT_BUDGET = parseInt(process.env.CONTEXT_BUDGET_TOKENS || "1500", 10);
const CONTEXT_ENABLED = process.env.CONTEXT_OPTIMIZER !== "false"; // enabled by default
const MOBYCLAW_HOME = process.env.MOBYCLAW_HOME || "/data/.mobyclaw";
const EXPLORATION_CONTEXT_MAX = parseInt(process.env.EXPLORATION_CONTEXT_MAX || "2", 10);

/**
 * Read the agent's inner emotional state file.
 * Returns a compact summary string, or "" if unavailable.
 */
function getInnerState() {
  try {
    const innerPath = path.join(MOBYCLAW_HOME, "state", "inner.json");
    if (!fs.existsSync(innerPath)) return "";

    const raw = fs.readFileSync(innerPath, "utf-8");
    const state = JSON.parse(raw);

    const parts = [];

    // Mood
    if (state.mood) {
      const m = state.mood;
      let moodStr = m.primary || "neutral";
      if (m.secondary) moodStr += ` / ${m.secondary}`;
      if (m.note) moodStr += ` - "${m.note}"`;
      parts.push(`Mood: ${moodStr}`);
    }

    // Energy
    if (state.energy !== undefined) {
      parts.push(`Energy: ${state.energy}`);
    }

    // Preoccupations
    if (state.preoccupations && state.preoccupations.length > 0) {
      parts.push(`On my mind: ${state.preoccupations.join("; ")}`);
    }

    // Curiosity queue
    if (state.curiosity_queue && state.curiosity_queue.length > 0) {
      parts.push(`Curious about: ${state.curiosity_queue.slice(0, 3).join("; ")}`);
    }

    // Most recent event
    if (state.recent_events && state.recent_events.length > 0) {
      const latest = state.recent_events[state.recent_events.length - 1];
      parts.push(`Last notable moment: ${latest.event}`);
      if (latest.feeling) parts.push(`  Felt: ${latest.feeling}`);
    }

    if (parts.length === 0) return "";

    return parts.join("\n");
  } catch (err) {
    console.error(`[context] Inner state read error: ${err.message}`);
    return "";
  }
}

/**
 * Read a compact summary from SELF.md (first ~20 lines of "The Basics" + "What I Value").
 * Returns a brief self-model string, or "" if unavailable.
 */
function getSelfSummary() {
  try {
    const selfPath = path.join(MOBYCLAW_HOME, "SELF.md");
    if (!fs.existsSync(selfPath)) return "";

    const raw = fs.readFileSync(selfPath, "utf-8");
    const lines = raw.split("\n");

    // Extract just the first two sections (basics + nature) - keep it compact
    const sections = [];
    let currentSection = null;
    let lineCount = 0;

    for (const line of lines) {
      if (line.startsWith("## ")) {
        if (sections.length >= 2) break; // Only first 2 sections
        currentSection = line;
        sections.push(line);
        lineCount = 0;
      } else if (currentSection && lineCount < 8) {
        if (line.trim()) {
          sections.push(line);
          lineCount++;
        }
      }
    }

    if (sections.length === 0) return "";
    return sections.join("\n");
  } catch (err) {
    console.error(`[context] Self summary read error: ${err.message}`);
    return "";
  }
}

/**
 * Find explorations relevant to the user's message.
 * Reads exploration files, scores by keyword overlap, returns top N.
 * Returns a compact string, or "" if none found.
 */
function getRelevantExplorations(userMessage) {
  try {
    const explorationsDir = path.join(MOBYCLAW_HOME, "explorations");
    if (!fs.existsSync(explorationsDir)) return "";

    const files = fs.readdirSync(explorationsDir)
      .filter(f => f.endsWith(".md"))
      .sort()
      .reverse(); // newest first

    if (files.length === 0) return "";

    // Extract keywords from user message (lowercase, 3+ chars, no stop words)
    const stopWords = new Set([
      "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
      "her", "was", "one", "our", "out", "has", "have", "been", "some",
      "them", "than", "this", "that", "what", "when", "how", "who", "which",
      "will", "with", "from", "they", "would", "there", "their", "about",
      "could", "other", "into", "more", "your", "just", "also", "very",
    ]);
    const messageWords = new Set(
      userMessage.toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length >= 3 && !stopWords.has(w))
    );

    if (messageWords.size === 0) return "";

    // Score each exploration by keyword overlap
    const scored = [];
    for (const file of files.slice(0, 50)) { // cap at 50 most recent
      try {
        const content = fs.readFileSync(
          path.join(explorationsDir, file), "utf-8"
        );

        // Extract frontmatter topic for bonus scoring
        const topicMatch = content.match(/^topic:\s*(.+)$/m);
        const topic = topicMatch ? topicMatch[1].toLowerCase() : "";

        const contentWords = new Set(
          (content.toLowerCase() + " " + topic)
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter(w => w.length >= 3)
        );

        let score = 0;
        for (const word of messageWords) {
          if (contentWords.has(word)) score++;
        }

        // Bonus for topic match
        for (const word of messageWords) {
          if (topic.includes(word)) score += 2;
        }

        if (score > 0) {
          scored.push({ file, content, score });
        }
      } catch { /* skip unreadable files */ }
    }

    if (scored.length === 0) return "";

    // Return top N explorations, truncated
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, EXPLORATION_CONTEXT_MAX);

    const summaries = top.map(({ file, content }) => {
      // Truncate to ~500 chars to keep context budget manageable
      const truncated = content.length > 500
        ? content.slice(0, 500) + "\n[...truncated]"
        : content;
      return `### ${file}\n${truncated}`;
    });

    return summaries.join("\n\n");
  } catch (err) {
    console.error(`[context] Exploration read error: ${err.message}`);
    return "";
  }
}

/**
 * Fetch optimized context for a user message.
 * Returns a string to prepend to the message, or "" on failure.
 */
async function getOptimizedContext(userMessage) {
  if (!CONTEXT_ENABLED) return "";

  // Fetch memory context from dashboard API
  let memoryContext = "";
  try {
    const query = encodeURIComponent(userMessage.slice(0, 300));
    const url = `${DASHBOARD_URL}/api/context?query=${query}&budget=${CONTEXT_BUDGET}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); // 3s max

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      if (data.context && data.context.trim().length > 0) {
        console.log(
          `[context] ${data.sections_included}/${data.sections_total} sections ` +
          `(${data.total_tokens} tokens, pruned ${data.sections_pruned})`
        );
        memoryContext = data.context;
      }
    } else {
      console.error(`[context] API returned ${res.status}`);
    }
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("[context] API timed out (3s)");
    } else {
      console.error(`[context] Error: ${err.message}`);
    }
  }

  // Read inner state (local file, fast)
  const innerState = getInnerState();
  const selfSummary = getSelfSummary();
  const explorations = getRelevantExplorations(userMessage);

  // Build the combined context block
  const parts = [];

  if (memoryContext) {
    parts.push(memoryContext);
  }

  if (innerState) {
    parts.push(`[INNER STATE — your current emotional/cognitive state]\n${innerState}\n[/INNER STATE]`);
  }

  if (selfSummary) {
    parts.push(`[SELF — who you think you are]\n${selfSummary}\n[/SELF]`);
  }

  if (explorations) {
    parts.push(`[EXPLORATIONS — relevant things you've explored]\n${explorations}\n[/EXPLORATIONS]`);
  }

  if (parts.length === 0) return "";

  const sectionCount = memoryContext ? "memory+inner" : "inner";
  return (
    `[MEMORY CONTEXT — auto-loaded, ${sectionCount}]\n` +
    parts.join("\n\n") +
    `\n[/MEMORY CONTEXT]\n\n`
  );
}

module.exports = { getOptimizedContext, CONTEXT_ENABLED };
