// -----------------------------------------------------------------
// Orchestrator — single session message pipeline
//
// All messages (from any channel) flow through one cagent session.
// Messages are serialized via a FIFO queue - only one request at a
// time. This gives the agent full conversation context across all
// inputs (telegram, CLI, heartbeat, schedules).
//
// Features (inspired by OpenClaw):
//   - Session lifecycle: daily reset, idle reset
//   - Queue modes: collect (coalesce) or followup (individual)
//   - Debounce: brief pause after enqueue before draining (collect)
//   - /stop command: abort current run + clear queue
//   - User feedback: onQueued callback when message is queued
// -----------------------------------------------------------------

const DEBOUNCE_MS = parseInt(process.env.QUEUE_DEBOUNCE_MS || "1000", 10);

let _drainTimer = null;

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
  // Check if session needs lifecycle reset (daily/idle)
  if (session.shouldReset()) {
    console.log(`[orchestrator] Session lifecycle reset`);
    session.clear();
  }

  let sessionId = session.getSessionId();
  if (sessionId) {
    return sessionId;
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
    // If this was an intentional abort, don't retry
    if (err.name === "AbortError" || err.message?.includes("aborted")) {
      console.log(`[${channelId}] Run aborted`);
      throw err;
    }

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
 * Uses debounce in collect mode to let rapid messages accumulate.
 */
function scheduleDrain(agent, session) {
  if (_drainTimer) return; // already scheduled

  const delay = session.queueMode === "collect" ? DEBOUNCE_MS : 0;

  _drainTimer = setTimeout(() => {
    _drainTimer = null;
    drainQueue(agent, session);
  }, delay);
}

async function drainQueue(agent, session) {
  const next = session.dequeue();
  if (!next) return;

  const { resolve, reject, channelId, message, callbacks } = next;
  session.setBusy(true);

  try {
    const sessionId = await ensureSession(agent, session);
    session.touchActivity();

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
    session.clearAbortController();

    // Check for more queued messages
    if (session.hasPending()) {
      scheduleDrain(agent, session);
    }
  }
}

/**
 * Send a message to the agent with streaming callbacks.
 * All channels share the same session. If busy, message is queued.
 *
 * callbacks can include:
 *   onToken(text), onToolStart(name), onToolDetail(name, args),
 *   onToolEnd(name, success), onError(err),
 *   onQueued(position) — called when message is queued (not immediately processed)
 */
async function sendToAgentStream(
  agent,
  session,
  channelId,
  message,
  callbacks = {}
) {
  // If busy, queue the message and notify caller
  if (session.isBusy()) {
    const qLen = session.queueLength() + 1;
    console.log(`[${channelId}] Session busy, queuing (position ${qLen})`);

    // Notify the adapter that message was queued (for typing/UX feedback)
    if (callbacks.onQueued) {
      callbacks.onQueued(qLen);
    }

    const promise = session.enqueue(channelId, message, callbacks);

    // Schedule drain with debounce (in case current run finishes)
    scheduleDrain(agent, session);

    return promise;
  }

  const sessionId = await ensureSession(agent, session);
  session.setBusy(true);
  session.touchActivity();

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
    session.clearAbortController();

    // Drain any queued messages
    if (session.hasPending()) {
      scheduleDrain(agent, session);
    }
  }
}

/**
 * Send a message without streaming (buffered response).
 */
async function sendToAgent(agent, session, channelId, message) {
  return sendToAgentStream(agent, session, channelId, message, {});
}

/**
 * Abort the current running agent request and clear the queue.
 * Returns { stopped: true, queueCleared: number } or { stopped: false }.
 */
function stopCurrentRun(session) {
  if (!session.isBusy()) {
    const cleared = session.clearQueue();
    return { stopped: false, queueCleared: cleared };
  }

  // Cancel any pending drain
  if (_drainTimer) {
    clearTimeout(_drainTimer);
    _drainTimer = null;
  }

  // Clear the queue first
  const cleared = session.clearQueue();

  // Abort is not directly supported by cagent HTTP API yet,
  // but we signal it so the orchestrator can handle it
  const ctrl = session.getAbortController();
  if (ctrl) {
    ctrl.abort();
  }

  return { stopped: true, queueCleared: cleared };
}

module.exports = {
  sendToAgent,
  sendToAgentStream,
  stopCurrentRun,
};
