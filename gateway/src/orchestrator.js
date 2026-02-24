// -----------------------------------------------------------------
// Orchestrator - single session message pipeline
//
// All messages (from any channel) flow through one cagent session.
// Messages are serialized via a FIFO queue - only one request at a
// time. This gives the agent full conversation context across all
// inputs (telegram, CLI, heartbeat, schedules).
// -----------------------------------------------------------------

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

async function ensureSession(agent, session) {
  let sessionId = session.getSessionId();
  if (sessionId) {
    // Verify the session still exists on the cagent side
    try {
      // Quick ping - list sessions and check ours is there
      // If cagent restarted, the session might be gone
      return sessionId;
    } catch {
      console.log(`[orchestrator] Session ${sessionId} seems dead, creating new one`);
      session.clear();
    }
  }

  sessionId = await agent.createSession();
  session.setSessionId(sessionId);
  console.log(`[orchestrator] New session: ${sessionId}`);
  return sessionId;
}

async function processMessageStream(
  agent,
  session,
  channelId,
  sessionId,
  message,
  callbacks
) {
  try {
    console.log(`[${channelId}] -> agent (session: ${sessionId.slice(0, 8)}...)`);
    const response = await agent.promptStream(message, sessionId, callbacks);
    console.log(
      `[${channelId}] <- agent (${response.length} chars)${response.length === 0 ? " [EMPTY]" : ""}`
    );
    return response;
  } catch (err) {
    console.error(`[${channelId}] Agent error: ${err.message}`);

    if (isSessionError(err)) {
      console.log(`[${channelId}] Session error - resetting and retrying...`);
      session.clear();

      try {
        const newSessionId = await agent.createSession();
        session.setSessionId(newSessionId);
        console.log(`[orchestrator] Recovery session: ${newSessionId}`);

        const response = await agent.promptStream(message, newSessionId, callbacks);
        console.log(`[${channelId}] <- agent retry (${response.length} chars)`);
        return response;
      } catch (retryErr) {
        console.error(`[${channelId}] Retry also failed: ${retryErr.message}`);
        throw retryErr;
      }
    }

    throw err;
  }
}

/**
 * Drain queued messages one at a time through the single session.
 */
async function drainQueue(agent, session) {
  const next = session.dequeue();
  if (!next) return;

  const { resolve, reject, channelId, message, callbacks } = next;
  session.setBusy(true);

  try {
    const sessionId = await ensureSession(agent, session);
    const response = await processMessageStream(
      agent,
      session,
      channelId,
      sessionId,
      message,
      callbacks || {}
    );
    resolve(response);
  } catch (err) {
    reject(err);
  } finally {
    session.setBusy(false);
    drainQueue(agent, session);
  }
}

/**
 * Send a message to the agent with streaming callbacks.
 * All channels share the same session. If busy, message is queued.
 */
async function sendToAgentStream(
  agent,
  session,
  channelId,
  message,
  callbacks = {}
) {
  // If busy, queue the message and wait
  if (session.isBusy()) {
    const qLen = session.queueLength() + 1;
    console.log(`[${channelId}] Session busy, queuing (position ${qLen})`);
    return session.enqueue(channelId, message, callbacks);
  }

  const sessionId = await ensureSession(agent, session);
  session.setBusy(true);

  try {
    return await processMessageStream(
      agent,
      session,
      channelId,
      sessionId,
      message,
      callbacks
    );
  } finally {
    session.setBusy(false);
    drainQueue(agent, session);
  }
}

/**
 * Send a message without streaming (buffered response).
 */
async function sendToAgent(agent, session, channelId, message) {
  return sendToAgentStream(agent, session, channelId, message, {});
}

module.exports = {
  sendToAgent,
  sendToAgentStream,
};
