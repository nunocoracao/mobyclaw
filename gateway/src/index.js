// ─────────────────────────────────────────────────────────────
// mobyclaw gateway — main entry point
//
// Wires together: agent client, sessions, adapters, scheduler,
// heartbeat, and Express routes.
// ─────────────────────────────────────────────────────────────

const express = require("express");
const path = require("path");

const { AgentClient } = require("./agent-client");
const { SessionStore } = require("./sessions");
const { AdapterRegistry } = require("./adapter-registry");
const { ChannelStore } = require("./channels");
const { ScheduleStore, startSchedulerLoop } = require("./scheduler");
const { startHeartbeat } = require("./heartbeat");
const { sendToAgent, sendToAgentStream } = require("./orchestrator");
const { registerRoutes } = require("./routes");
const { setupTelegram } = require("./adapters/telegram");

const AGENT_URL = process.env.AGENT_URL || "http://moby:8080";
const PORT = process.env.PORT || 3000;
const MOBYCLAW_HOME = process.env.MOBYCLAW_HOME || "/data/.mobyclaw";

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (not crashing):", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (not crashing):", err.message || err);
});

// ─────────────────────────────────────────────────────────────
// Channel context — enriches messages with metadata
// ─────────────────────────────────────────────────────────────

function addChannelContext(channelStore, channelId, message) {
  // Skip internal channels
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
    sessions,
    channelId,
    message,
    callbacks
  ) {
    channelStore.track(channelId);
    const enriched = addChannelContext(channelStore, channelId, message);
    return sendToAgentStream(agent, sessions, channelId, enriched, callbacks);
  };
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
  const registry = new AdapterRegistry();

  const channelsPath = path.join(MOBYCLAW_HOME, "channels.json");
  const channelStore = new ChannelStore(channelsPath);

  const schedulesPath = path.join(MOBYCLAW_HOME, "schedules.json");
  const scheduleStore = new ScheduleStore(schedulesPath);

  console.log(`⏳ Waiting for agent at ${AGENT_URL}...`);
  await agent.waitForReady(120_000);
  console.log(`✓ Agent is ready`);

  // ── Messaging adapters ──────────────────────────────────

  const sendWithContext = createContextSender(channelStore);

  if (process.env.TELEGRAM_BOT_TOKEN) {
    const telegramSend = await setupTelegram(
      agent,
      sessions,
      sendWithContext
    );
    if (telegramSend) registry.register("telegram", telegramSend);
    console.log("✓ Telegram adapter loaded");
  } else {
    console.log("⊘ Telegram: no token, skipping");
  }

  // ── Scheduler + Heartbeat ───────────────────────────────

  const agentPromptFn = async (channelId, prompt) => {
    return sendToAgent(agent, sessions, channelId, prompt);
  };

  startSchedulerLoop(scheduleStore, registry, agentPromptFn, 30_000);
  startHeartbeat(agentPromptFn, channelStore);

  // ── Express app ─────────────────────────────────────────

  const app = express();
  app.use(express.json());

  registerRoutes(app, {
    agent,
    sessions,
    scheduleStore,
    channelStore,
    registry,
    sendToAgent,
    sendToAgentStream,
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
