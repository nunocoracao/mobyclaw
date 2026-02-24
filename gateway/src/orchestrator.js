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
const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://dashboard:7777";

const { addExchange, getHistoryBlock } = require("./short-term-memory");

// Accumulated usage for the current session day (in-memory, logged to dashboard)
let _usageBuffer = [];

let _drainTimer = null;

function isSessionError(err) {
  const msg = (err.message || "").toLowerCase();
  return (
    msg.includes("404") ||
    msg.includes("session") ||
    msg.includes("context canceled") ||
    msg.includes("aborted") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    // Corrupted session — tool_use/tool_result out of sync
    msg.includes("sequencing") ||
    msg.includes("tool_use_id") ||
    msg.includes("invalid_request_error") ||
    msg.includes("all models failed") ||
    // Socket-level failures
    msg.includes("socket idle") ||
    msg.includes("connection likely dead")
  );
}

async function ensureSession(agent, session) {
  // Check if session needs lifecycle reset (daily/idle)
  if (session.shouldReset()) {
    console.log(`[orchestrator] Session lifecycle reset`);
    session.clear(); // sets _sessionIsNew = true
  }

  let sessionId = session.getSessionId();
  if (sessionId) {
    return sessionId;
  }

  // Creating a brand new session — flag it for STM injection
  sessionId = await agent.createSession();
  session.setSessionId(sessionId);
  session._sessionIsNew = true;
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
    // Inject short-term memory on first message of a new session
    let finalMessage = message;
    if (session.consumeNewSessionFlag()) {
      const stmBlock = getHistoryBlock();
      if (stmBlock) {
        console.log(`[${channelId}] Injecting short-term memory into new session`);
        finalMessage = stmBlock + message;
      }
    }

    console.log(`[${channelId}] -> agent (session: ${sessionId.slice(0, 8)}...)`);
    const result = await agent.promptStream(finalMessage, sessionId, callbacks);
    const response = typeof result === "string" ? result : result.text || "";
    const usage = typeof result === "object" ? result.usage : null;
    console.log(
      `[${channelId}] <- agent (${response.length} chars)${response.length === 0 ? " [EMPTY]" : ""}` +
      (usage ? ` [tokens: ${usage.input_tokens}in/${usage.output_tokens}out, $${usage.cost?.toFixed(4) || "?"}]` : "")
    );

    // Log conversation (fire-and-forget)
    logConversation(channelId, message, response, 0);

    // Save to short-term memory (fire-and-forget)
    try {
      addExchange(channelId, message, response);
    } catch (err) {
      console.error(`[orchestrator] STM save failed: ${err.message}`);
    }

    // Log usage to dashboard (fire-and-forget)
    if (usage) {
      logUsage(channelId, sessionId, usage);
    }

    return response;
  } catch (err) {
    // If this was an intentional abort, don't retry
    if (err.name === "AbortError" || err.message?.includes("aborted")) {
      console.log(`[${channelId}] Run aborted`);
      throw err;
    }

    console.error(`[${channelId}] Agent error: ${err.message}`);

    if (isSessionError(err)) {
      console.log(`[${channelId}] Session error detected — clearing and retrying`);
      console.log(`[${channelId}]   Error: ${err.message.slice(0, 200)}`);
      session.clear();

      try {
        const newSessionId = await agent.createSession();
        session.setSessionId(newSessionId);
        console.log(`[orchestrator] Recovery session: ${newSessionId}`);

        const retryResult = await agent.promptStream(message, newSessionId, callbacks);
        const response = typeof retryResult === "string" ? retryResult : retryResult.text || "";
        const usage = typeof retryResult === "object" ? retryResult.usage : null;
        console.log(`[${channelId}] <- agent retry (${response.length} chars)`);
        if (usage) logUsage(channelId, newSessionId, usage);
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
  callbacks = {},
  contextFetcher = null
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

  // Set busy FIRST, before any async work, to prevent races
  session.setBusy(true);

  // Now safe to do async context enrichment — no other message
  // can sneak in because isBusy() is true
  let enrichedMessage = message;
  if (contextFetcher) {
    try {
      const ctx = await contextFetcher();
      if (ctx) enrichedMessage = ctx + message;
    } catch {
      // Continue without context
    }
  }

  const sessionId = await ensureSession(agent, session);
  session.touchActivity();

  try {
    return await processMessageStream(
      agent,
      session,
      channelId,
      sessionId,
      enrichedMessage,
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

/**
 * Log a completed conversation turn to the dashboard API.
 * Fire-and-forget - never blocks the response flow.
 */
function logConversation(channelId, userMessage, agentResponse, toolCount) {
  // Skip heartbeat/system messages
  if (channelId === "heartbeat" || channelId === "system") return;
  // Skip empty exchanges
  if (!userMessage || !agentResponse) return;

  const snippet = (text, maxLen) =>
    text.length > maxLen ? text.slice(0, maxLen) + "..." : text;

  const payload = {
    timestamp: new Date().toISOString(),
    channel: channelId,
    summary: snippet(userMessage, 200),
    topics: [],
    key_facts: [],
    message_count: 1,
  };

  fetch(`${DASHBOARD_URL}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => {
    // Silent fail - conversation logging is best-effort
    console.error(`[orchestrator] Conversation log failed: ${err.message}`);
  });
}

/**
 * Log token usage to the dashboard API.
 * Fire-and-forget - never blocks the response flow.
 */
function logUsage(channelId, sessionId, usage) {
  if (!usage) return;

  const payload = {
    timestamp: new Date().toISOString(),
    channel: channelId,
    session_id: sessionId,
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cached_input_tokens: usage.last_message?.cached_input_tokens || 0,
    cached_write_tokens: usage.last_message?.cached_write_tokens || 0,
    context_length: usage.context_length || 0,
    context_limit: usage.context_limit || 0,
    cost: usage.cost || 0,
    model: usage.last_message?.Model || "",
  };

  fetch(`${DASHBOARD_URL}/api/usage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.error(`[orchestrator] Usage log failed: ${err.message}`);
  });
}

module.exports = {
  sendToAgent,
  sendToAgentStream,
  stopCurrentRun,
};
