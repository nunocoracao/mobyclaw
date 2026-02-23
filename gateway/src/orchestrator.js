// ─────────────────────────────────────────────────────────────
// Orchestrator — session management + agent communication
//
// Manages the lifecycle of sending messages to the agent:
//   - Session creation and reuse per channel
//   - Busy/queue management (one request at a time per session)
//   - Error recovery with automatic session reset
// ─────────────────────────────────────────────────────────────

function isSessionError(err) {
  const msg = (err.message || "").toLowerCase();
  return (
    msg.includes("404") ||
    msg.includes("session") ||
    msg.includes("context canceled") ||
    msg.includes("aborted") ||
    msg.includes("timed out") ||
    msg.includes("econnreset")
  );
}

async function ensureSession(agent, sessions, channelId) {
  let sessionId = sessions.getSessionId(channelId);
  if (!sessionId) {
    sessionId = await agent.createSession();
    sessions.setSessionId(channelId, sessionId);
    console.log(`[${channelId}] New session: ${sessionId}`);
  }
  return sessionId;
}

async function processMessageStream(
  agent,
  sessions,
  channelId,
  sessionId,
  message,
  callbacks
) {
  try {
    console.log(`[${channelId}] → agent (session: ${sessionId})`);
    const response = await agent.promptStream(message, sessionId, callbacks);
    console.log(
      `[${channelId}] ← agent (${response.length} chars)${response.length === 0 ? " [EMPTY]" : ""}`
    );
    return response;
  } catch (err) {
    console.error(`[${channelId}] Agent error: ${err.message}`);
    if (isSessionError(err)) {
      console.log(`[${channelId}] Resetting session and retrying...`);
      sessions.clear(channelId);
      try {
        const newSessionId = await agent.createSession();
        sessions.setSessionId(channelId, newSessionId);
        const response = await agent.promptStream(
          message,
          newSessionId,
          callbacks
        );
        console.log(
          `[${channelId}] ← agent retry (${response.length} chars)`
        );
        return response;
      } catch (retryErr) {
        console.error(
          `[${channelId}] Retry also failed: ${retryErr.message}`
        );
        throw retryErr;
      }
    }
    throw err;
  }
}

async function drainQueue(agent, sessions, channelId) {
  const next = sessions.dequeue(channelId);
  if (!next) return;
  const { resolve, reject, message, callbacks } = next;
  sessions.setBusy(channelId, true);
  try {
    let sessionId = sessions.getSessionId(channelId);
    if (!sessionId) {
      sessionId = await agent.createSession();
      sessions.setSessionId(channelId, sessionId);
    }
    const response = await processMessageStream(
      agent,
      sessions,
      channelId,
      sessionId,
      message,
      callbacks || {}
    );
    resolve(response);
  } catch (err) {
    reject(err);
  } finally {
    sessions.setBusy(channelId, false);
    drainQueue(agent, sessions, channelId);
  }
}

/**
 * Send a message to the agent with streaming callbacks.
 * Handles session creation, busy queuing, and error recovery.
 *
 * If the primary session is busy, routes to an overflow session
 * so the user isn't blocked by long-running tasks.
 */
async function sendToAgentStream(
  agent,
  sessions,
  channelId,
  message,
  callbacks = {}
) {
  const sessionId = await ensureSession(agent, sessions, channelId);

  if (sessions.isBusy(channelId)) {
    // Primary is busy — use overflow session instead of queuing
    return handleOverflow(agent, sessions, channelId, message, callbacks);
  }

  sessions.setBusy(channelId, true);

  try {
    return await processMessageStream(
      agent,
      sessions,
      channelId,
      sessionId,
      message,
      callbacks
    );
  } finally {
    sessions.setBusy(channelId, false);
    // Clear overflow session — next time primary is busy, a fresh one is created
    sessions.clearOverflow(channelId);
    drainQueue(agent, sessions, channelId);
  }
}

/**
 * Handle a message when the primary session is busy.
 * Creates/reuses an overflow session for parallel processing.
 */
async function handleOverflow(agent, sessions, channelId, message, callbacks) {
  // If overflow is also busy, queue on overflow (rare — 3+ concurrent messages)
  if (sessions.isOverflowBusy(channelId)) {
    console.log(`[${channelId}] Overflow also busy, queuing`);
    return sessions.enqueue(channelId, message, callbacks);
  }

  // Create overflow session if needed
  let overflowId = sessions.getOverflowSessionId(channelId);
  if (!overflowId) {
    overflowId = await agent.createSession();
    sessions.setOverflowSessionId(channelId, overflowId);
    console.log(`[${channelId}] Created overflow session: ${overflowId}`);
  }

  console.log(`[${channelId}] Primary busy → overflow session`);
  sessions.setOverflowBusy(channelId, true);

  try {
    // Prepend context so the overflow Moby knows the situation
    const hint =
      `[Note: The user's main conversation is currently busy processing a long task. ` +
      `This is a parallel session — you have full tool access but won't have the conversation ` +
      `history from the main session. If the user asks about status or progress, check ` +
      `recent file changes, git log, or /home/agent/.mobyclaw/ for clues.]\n`;
    const enriched = hint + message;

    return await processMessageStream(
      agent,
      sessions,
      channelId,
      overflowId,
      enriched,
      callbacks
    );
  } finally {
    sessions.setOverflowBusy(channelId, false);
  }
}

/**
 * Send a message to the agent without streaming (buffered response).
 */
async function sendToAgent(agent, sessions, channelId, message) {
  return sendToAgentStream(agent, sessions, channelId, message, {});
}

module.exports = {
  sendToAgent,
  sendToAgentStream,
};
