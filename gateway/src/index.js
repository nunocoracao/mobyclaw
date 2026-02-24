// -----------------------------------------------------------------
// mobyclaw gateway - main entry point
//
// Wires together: agent client, session, adapters, scheduler,
// heartbeat, and Express routes.
//
// Single session architecture: one cagent session shared across
// all channels. Messages are serialized through a FIFO queue.
//
// Features:
//   - Session lifecycle (daily/idle reset)
//   - Queue modes: collect (coalesce) or followup
//   - /stop abort support
//   - Typing indicators + queue feedback
// -----------------------------------------------------------------

const express = require("express");
const path = require("path");

const { AgentClient } = require("./agent-client");
const { SessionStore } = require("./sessions");
const { AdapterRegistry } = require("./adapter-registry");
const { ChannelStore } = require("./channels");
const { ScheduleStore, startSchedulerLoop } = require("./scheduler");
const { startHeartbeat } = require("./heartbeat");
const { sendToAgent, sendToAgentStream, stopCurrentRun } = require("./orchestrator");
const { registerRoutes } = require("./routes");
const { setupTelegram } = require("./adapters/telegram");
const { getOptimizedContext, CONTEXT_ENABLED } = require("./context-optimizer");

const AGENT_URL = process.env.AGENT_URL || "http://moby:8080";
const PORT = process.env.PORT || 3000;
const MOBYCLAW_HOME = process.env.MOBYCLAW_HOME || "/data/.mobyclaw";

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (not crashing):", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (not crashing):", err.message || err);
});

// -----------------------------------------------------------------
// Channel context - enriches messages with metadata
// -----------------------------------------------------------------

function addChannelContext(channelStore, channelId, message) {
  if (
    channelId.startsWith("heartbeat:") ||
    channelId.startsWith("api:") ||
    channelId.startsWith("cli:")
  ) {
    return message;
  }

  const now = new Date().toISOString();
  const defaultCh = channelStore.getDefault();
  let ctx = `[context: channel=${channelId}, time=${now}`;
  if (defaultCh && defaultCh !== channelId) {
    ctx += `, default_channel=${defaultCh}`;
  }
  ctx += `]`;
  return `${ctx}\n${message}`;
}

function createContextSender(channelStore) {
  return async function sendToAgentStreamWithContext(
    agent,
    session,
    channelId,
    message,
    callbacks
  ) {
    channelStore.track(channelId);
    let enriched = addChannelContext(channelStore, channelId, message);

    // Context optimization is now done SYNCHRONOUSLY before the call.
    // We do NOT await anything before calling sendToAgentStream —
    // otherwise there's a race window where isBusy() is still false
    // but we've logically started processing, letting a heartbeat or
    // second message sneak in and cause double-processing.
    //
    // The context fetch happens inside a sync wrapper that passes
    // the optimization as a callback the orchestrator can await
    // AFTER setting busy=true.

    const contextFetcher =
      CONTEXT_ENABLED &&
      !channelId.startsWith("heartbeat:") &&
      !channelId.startsWith("api:") &&
      !channelId.startsWith("schedule:")
        ? async () => {
            try {
              return await getOptimizedContext(message);
            } catch {
              return "";
            }
          }
        : null;

    return sendToAgentStream(agent, session, channelId, enriched, callbacks, contextFetcher);
  };
}

// -----------------------------------------------------------------
// Main
// -----------------------------------------------------------------

async function main() {
  console.log("+--------------------------------------+");
  console.log("|     mobyclaw gateway starting...      |");
  console.log("+--------------------------------------+");
  console.log();

  const agent = new AgentClient(AGENT_URL);

  // Single session store - persisted to disk
  const sessionPath = path.join(MOBYCLAW_HOME, "session.json");
  const session = new SessionStore(sessionPath, {
    queueMode: process.env.QUEUE_MODE || "collect",
    debounceMs: parseInt(process.env.QUEUE_DEBOUNCE_MS || "1000", 10),
    maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE || "20", 10),
    dailyResetHour: process.env.DAILY_RESET_HOUR !== undefined
      ? parseInt(process.env.DAILY_RESET_HOUR, 10)
      : 4,
    idleResetMinutes: process.env.IDLE_RESET_MINUTES
      ? parseInt(process.env.IDLE_RESET_MINUTES, 10)
      : null,
  });

  const registry = new AdapterRegistry();

  const channelsPath = path.join(MOBYCLAW_HOME, "channels.json");
  const channelStore = new ChannelStore(channelsPath);

  const schedulesPath = path.join(MOBYCLAW_HOME, "schedules.json");
  const scheduleStore = new ScheduleStore(schedulesPath);

  console.log(`Waiting for agent at ${AGENT_URL}...`);
  await agent.waitForReady(120_000);
  console.log(`Agent is ready`);

  // Validate persisted session — cagent sessions are in-memory and
  // don't survive container restarts. If moby restarted, the old
  // session ID is stale and would cause a 500 on first use.
  const restoredId = session.getSessionId();
  if (restoredId) {
    const valid = await agent.validateSession(restoredId);
    if (!valid) {
      console.log(`[session] Stale session ${restoredId.slice(0, 8)}... — clearing`);
      session.clear();
      // Pre-create a fresh session so the first message is instant
      try {
        const freshId = await agent.createSession();
        session.setSessionId(freshId);
        console.log(`[session] Pre-created fresh session: ${freshId.slice(0, 8)}...`);
      } catch (err) {
        console.error(`[session] Failed to pre-create session: ${err.message}`);
        // Not fatal — ensureSession() will create one on first message
      }
    } else {
      console.log(`[session] Restored session ${restoredId.slice(0, 8)}... is valid`);
    }
  }

  // -- Config summary -----------------------------------------------
  console.log(`  Queue mode: ${session.queueMode}`);
  console.log(`  Context optimizer: ${CONTEXT_ENABLED ? "enabled" : "disabled"}`);
  console.log(`  Daily reset: ${session.dailyResetHour}:00`);
  if (session.idleResetMinutes) {
    console.log(`  Idle reset: ${session.idleResetMinutes}m`);
  }

  // -- Messaging adapters -------------------------------------------

  const sendWithContext = createContextSender(channelStore);

  if (process.env.TELEGRAM_BOT_TOKEN) {
    const telegramSend = await setupTelegram(agent, session, sendWithContext, {
      stopCurrentRun,
    });
    if (telegramSend) registry.register("telegram", telegramSend);
    console.log("Telegram adapter loaded");
  } else {
    console.log("Telegram: no token, skipping");
  }

  // -- Scheduler + Heartbeat ----------------------------------------

  const agentPromptFn = async (channelId, prompt) => {
    return sendToAgent(agent, session, channelId, prompt);
  };

  startSchedulerLoop(scheduleStore, registry, agentPromptFn, 30_000);
  startHeartbeat(agentPromptFn, channelStore, { session });

  // Busy watchdog: detect stuck sessions (e.g., agent container died)
  setInterval(() => {
    session.checkBusyWatchdog(10 * 60 * 1000); // 10 min max
  }, 30_000);

  // -- Express app --------------------------------------------------

  const app = express();
  app.use(express.json());

  registerRoutes(app, {
    agent,
    sessions: session,
    scheduleStore,
    channelStore,
    registry,
    sendToAgent,
    sendToAgentStream,
    stopCurrentRun,
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Gateway API listening on :${PORT}`);
    console.log();
    console.log("Moby is ready. Send a message!");

    // Notify the last-used channel that Moby is back online.
    // Runs after listen() so the server is fully ready.
    const defaultChannel = channelStore.getDefault();
    if (defaultChannel) {
      registry
        .deliver(defaultChannel, "🐋 I'm back online and ready to go!")
        .then((ok) => {
          if (ok) console.log(`[startup] Notified ${defaultChannel}`);
        })
        .catch(() => {});
    }
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
