// ─────────────────────────────────────────────────────────────
// Short-Term Memory — rolling buffer of recent conversations
//
// Solves the "amnesia problem": when cagent sessions reset,
// all conversation history is lost. This module saves the last
// N exchanges to a file, and provides a formatted history block
// that can be injected into the first message of a new session.
//
// Architecture:
//   - addExchange() called after each successful agent response
//   - getHistoryBlock() returns formatted history for injection
//   - Context is stripped of injected prefixes to avoid ballooning
//   - Messages are capped in length to stay within token budget
// ─────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const MOBYCLAW_HOME = process.env.MOBYCLAW_HOME || "/data/.mobyclaw";
const STM_PATH = path.join(MOBYCLAW_HOME, "short-term-memory.json");
const MAX_EXCHANGES = parseInt(process.env.STM_MAX_EXCHANGES || "20", 10);
const MAX_MSG_LENGTH = parseInt(process.env.STM_MAX_MSG_LENGTH || "1500", 10);

/**
 * Load saved exchanges from disk.
 */
function load() {
  try {
    if (fs.existsSync(STM_PATH)) {
      return JSON.parse(fs.readFileSync(STM_PATH, "utf-8"));
    }
  } catch (err) {
    console.error(`[stm] Failed to load: ${err.message}`);
  }
  return [];
}

/**
 * Save exchanges to disk.
 */
function save(messages) {
  try {
    const dir = path.dirname(STM_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STM_PATH, JSON.stringify(messages, null, 2) + "\n");
  } catch (err) {
    console.error(`[stm] Failed to save: ${err.message}`);
  }
}

/**
 * Strip injected context prefixes from a user message.
 * We don't want the memory context / channel metadata in the history —
 * just the actual user message.
 */
function stripInjectedContext(message) {
  // Remove [MEMORY CONTEXT ...] block (multiline)
  let clean = message.replace(
    /\[MEMORY CONTEXT[\s\S]*?\[\/MEMORY CONTEXT\]\s*/g,
    ""
  );
  // Remove [SHORT-TERM MEMORY ...] block (multiline) — don't nest history
  clean = clean.replace(
    /\[SHORT-TERM MEMORY[\s\S]*?\[\/SHORT-TERM MEMORY\]\s*/g,
    ""
  );
  // Remove [context: ...] line
  clean = clean.replace(/^\[context:.*?\]\n/m, "");
  // Remove collected message header
  clean = clean.replace(
    /^\[\d+ messages were queued.*?combined:\]\s*/m,
    ""
  );
  return clean.trim();
}

/**
 * Truncate text to maxLen characters, with ellipsis if truncated.
 */
function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text || "";
  return text.slice(0, maxLen) + "…";
}

/**
 * Record a completed exchange (user message + agent response).
 * Maintains a rolling buffer of the last MAX_EXCHANGES exchanges.
 */
function addExchange(channel, userMessage, agentResponse) {
  // Skip heartbeat/system messages — they're not conversational
  if (
    channel === "heartbeat" ||
    channel.startsWith("heartbeat:") ||
    channel === "system" ||
    channel.startsWith("schedule:")
  ) {
    return;
  }

  // Skip empty exchanges
  if (!userMessage || !agentResponse) return;

  const cleanUser = stripInjectedContext(userMessage);
  if (!cleanUser) return;

  const messages = load();

  messages.push({
    time: new Date().toISOString(),
    channel,
    user: truncate(cleanUser, MAX_MSG_LENGTH),
    agent: truncate(agentResponse, MAX_MSG_LENGTH),
  });

  // Keep only the most recent exchanges
  while (messages.length > MAX_EXCHANGES) {
    messages.shift();
  }

  save(messages);
}

/**
 * Build a formatted history block for injection into a new session.
 * Returns a string ready to prepend to the first message, or "" if empty.
 */
function getHistoryBlock() {
  const messages = load();
  if (messages.length === 0) return "";

  const lines = messages.map((m) => {
    const timeStr = m.time
      ? new Date(m.time).toISOString().replace("T", " ").slice(0, 19) + " UTC"
      : "";
    const channelStr = m.channel ? ` [${m.channel}]` : "";
    return (
      `[${timeStr}${channelStr}]\n` +
      `User: ${m.user}\n` +
      `Marvin: ${m.agent}`
    );
  });

  return (
    `[SHORT-TERM MEMORY — last ${messages.length} conversation exchanges]\n` +
    `This is your recent conversation history, injected because a new session started.\n` +
    `Use this to maintain conversational continuity.\n\n` +
    lines.join("\n\n---\n\n") +
    `\n[/SHORT-TERM MEMORY]\n\n`
  );
}

module.exports = { addExchange, getHistoryBlock };
