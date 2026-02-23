// ─────────────────────────────────────────────────────────────
// mobyclaw gateway — orchestrator
//
// Two response modes:
//   POST /prompt        — buffered JSON response
//   POST /prompt/stream — SSE streaming (tokens appear in real-time)
// ─────────────────────────────────────────────────────────────

const express = require("express");
const { PassThrough } = require("stream");
const { setupTelegram } = require("./adapters/telegram");
const { AgentClient } = require("./agent-client");
const { SessionStore } = require("./sessions");
const { formatToolLabel } = require("./tool-labels");

const AGENT_URL = process.env.AGENT_URL || "http://moby:8080";
const PORT = process.env.PORT || 3000;

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (not crashing):", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (not crashing):", err.message || err);
});

// ─────────────────────────────────────────────────────────────
// Session + agent orchestration
// ─────────────────────────────────────────────────────────────

async function ensureSession(agent, sessions, channelId) {
  let sessionId = sessions.getSessionId(channelId);
  if (!sessionId) {
    sessionId = await agent.createSession();
    sessions.setSessionId(channelId, sessionId);
    console.log(`[${channelId}] New session: ${sessionId}`);
  }
  return sessionId;
}

async function sendToAgentStream(agent, sessions, channelId, message, callbacks = {}) {
  const sessionId = await ensureSession(agent, sessions, channelId);

  if (sessions.isBusy(channelId)) {
    console.log(`[${channelId}] Session busy, queuing message`);
    return sessions.enqueue(channelId, message, callbacks);
  }

  sessions.setBusy(channelId, true);

  try {
    return await processMessageStream(agent, sessions, channelId, sessionId, message, callbacks);
  } finally {
    sessions.setBusy(channelId, false);
    drainQueue(agent, sessions, channelId);
  }
}

async function sendToAgent(agent, sessions, channelId, message) {
  return sendToAgentStream(agent, sessions, channelId, message, {});
}

async function processMessageStream(agent, sessions, channelId, sessionId, message, callbacks) {
  try {
    console.log(`[${channelId}] → agent (session: ${sessionId})`);
    const response = await agent.promptStream(message, sessionId, callbacks);
    console.log(`[${channelId}] ← agent (${response.length} chars)${response.length === 0 ? " [EMPTY]" : ""}`);
    return response;
  } catch (err) {
    console.error(`[${channelId}] Agent error: ${err.message}`);
    if (isSessionError(err)) {
      console.log(`[${channelId}] Resetting session and retrying...`);
      sessions.clear(channelId);
      try {
        const newSessionId = await agent.createSession();
        sessions.setSessionId(channelId, newSessionId);
        const response = await agent.promptStream(message, newSessionId, callbacks);
        console.log(`[${channelId}] ← agent retry (${response.length} chars)`);
        return response;
      } catch (retryErr) {
        console.error(`[${channelId}] Retry also failed: ${retryErr.message}`);
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
    const response = await processMessageStream(agent, sessions, channelId, sessionId, message, callbacks || {});
    resolve(response);
  } catch (err) {
    reject(err);
  } finally {
    sessions.setBusy(channelId, false);
    drainQueue(agent, sessions, channelId);
  }
}

function isSessionError(err) {
  const msg = (err.message || "").toLowerCase();
  return msg.includes("404") || msg.includes("session") || msg.includes("context canceled") ||
         msg.includes("aborted") || msg.includes("timed out") || msg.includes("econnreset");
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log("┌──────────────────────────────────────┐");
  console.log("│     mobyclaw gateway starting...      │");
  console.log("└──────────────────────────────────────┘");
  console.log();

  const agent = new AgentClient(AGENT_URL);
  const sessions = new SessionStore();

  console.log(`⏳ Waiting for agent at ${AGENT_URL}...`);
  await agent.waitForReady(120_000);
  console.log(`✓ Agent is ready`);

  if (process.env.TELEGRAM_BOT_TOKEN) {
    await setupTelegram(agent, sessions, sendToAgentStream);
    console.log("✓ Telegram adapter loaded");
  } else {
    console.log("⊘ Telegram: no token, skipping");
  }

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));

  app.get("/status", (_req, res) => {
    const channels = [];
    if (process.env.TELEGRAM_BOT_TOKEN) channels.push("telegram");
    if (process.env.DISCORD_BOT_TOKEN) channels.push("discord");
    if (process.env.SLACK_BOT_TOKEN) channels.push("slack");
    res.json({ status: "running", agent_url: AGENT_URL, channels, sessions: sessions.count(), uptime: process.uptime() });
  });

  // ── Buffered prompt ───────────────────────────────────────
  app.post("/prompt", async (req, res) => {
    try {
      const { message, session_id } = req.body;
      if (!message) return res.status(400).json({ error: "message is required" });
      const channelId = session_id || "api:direct";
      const response = await sendToAgent(agent, sessions, channelId, message);
      res.json({ response, session_id: channelId });
    } catch (err) {
      console.error("Prompt error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Streaming prompt (SSE via PassThrough) ────────────────
  //
  // Strategy: We use a PassThrough stream that's piped to the
  // HTTP response. Writes to the PassThrough from inside the
  // agent client's data callback are immediately pushed to the
  // pipe, bypassing any buffering issues with res.write() from
  // nested I/O callbacks.
  //
  app.post("/prompt/stream", async (req, res) => {
    const { message, session_id } = req.body || {};
    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    const channelId = session_id || "api:direct";

    // Create a PassThrough stream and pipe it to the response
    const pass = new PassThrough();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    if (res.socket) res.socket.setNoDelay(true);

    pass.pipe(res);

    // Track client disconnection via the RESPONSE socket, not the request.
    // req.on('close') fires as soon as the POST body is consumed, which is
    // immediately — NOT when the client disconnects. The response socket's
    // close event is what indicates the client actually left.
    let clientGone = false;
    res.on("close", () => { clientGone = true; });

    let tokenCount = 0;

    function sseWrite(event, data) {
      if (clientGone) return;
      pass.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    try {
      const response = await sendToAgentStream(
        agent, sessions, channelId, message,
        {
          onToken(text)            { tokenCount++; sseWrite("token", { text }); },
          onToolStart(name)        { sseWrite("tool", { name, status: "start", detail: formatToolLabel(name) }); },
          onToolDetail(name, args) { sseWrite("tool", { name, status: "detail", detail: formatToolLabel(name, args) }); },
          onToolEnd(name, success) { sseWrite("tool", { name, status: "done", success }); },
          onError(err)             { sseWrite("error", { message: err }); },
        }
      );

      sseWrite("done", { text: response, session_id: channelId });
    } catch (err) {
      console.error("Stream error:", err.message);
      sseWrite("error", { message: err.message });
    }

    pass.end();
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`✓ Gateway API listening on :${PORT}`);
    console.log();
    console.log("🐋 Moby is ready. Send a message!");
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
