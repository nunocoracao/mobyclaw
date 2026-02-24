// ─────────────────────────────────────────────────────────────
// Routes — Express route handlers for the gateway API
//
// Endpoints:
//   GET  /health          — Health check
//   GET  /status          — Service status + stats
//   GET  /api/channels    — Known messaging channels
//   GET  /api/schedules   — List schedules
//   POST /api/schedules   — Create a schedule
//   DELETE /api/schedules/:id — Cancel a schedule
//   POST /api/deliver     — Push a message to a channel
//   POST /api/stop        — Stop current run + clear queue
//   POST /prompt          — Buffered agent prompt
//   POST /prompt/stream   — Streaming agent prompt (SSE)
// ─────────────────────────────────────────────────────────────

const { PassThrough } = require("stream");
const { formatToolLabel } = require("./tool-labels");

function registerRoutes(
  app,
  { agent, sessions, scheduleStore, channelStore, registry, sendToAgent, sendToAgentStream, stopCurrentRun }
) {
  // ── Health & Status ─────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  app.get("/status", (_req, res) => {
    const channels = [];
    if (process.env.TELEGRAM_BOT_TOKEN) channels.push("telegram");
    if (process.env.DISCORD_BOT_TOKEN) channels.push("discord");
    if (process.env.SLACK_BOT_TOKEN) channels.push("slack");
    const pending = scheduleStore.list("pending").length;
    const knownChannels = channelStore.getAll();
    res.json({
      status: "running",
      agent_url: agent.baseUrl,
      channels,
      known_channels: knownChannels,
      session_id: sessions.getSessionId() || null,
      session_busy: sessions.isBusy(),
      queue_length: sessions.queueLength(),
      queue_mode: sessions.queueMode,
      last_activity: sessions.lastActivity,
      schedules_pending: pending,
      uptime: process.uptime(),
    });
  });

  // ── Channel API ─────────────────────────────────────────

  app.get("/api/channels", (_req, res) => {
    res.json({
      channels: channelStore.getAll(),
      default: channelStore.getDefault(),
    });
  });

  // ── Schedule API ────────────────────────────────────────

  app.get("/api/schedules", (req, res) => {
    const status = req.query.status || null;
    res.json(scheduleStore.list(status));
  });

  app.post("/api/schedules", (req, res) => {
    const { due, message, prompt, channel, repeat } = req.body;
    if (!due) {
      return res.status(400).json({ error: "due is required" });
    }
    if (!message && !prompt) {
      return res.status(400).json({ error: "message or prompt is required" });
    }
    const targetChannel = channel || channelStore.getDefault();
    if (!targetChannel) {
      return res
        .status(400)
        .json({ error: "channel is required (no known channels available)" });
    }
    const schedule = scheduleStore.create({
      due,
      message,
      prompt,
      channel: targetChannel,
      repeat,
    });
    console.log(
      `[schedule] Created: ${schedule.id} → ${schedule.channel} at ${schedule.due}` +
        `${schedule.repeat ? ` (repeat: ${schedule.repeat})` : ""}`
    );
    res.status(201).json(schedule);
  });

  app.delete("/api/schedules/:id", (req, res) => {
    const schedule = scheduleStore.cancel(req.params.id);
    if (!schedule) {
      return res
        .status(404)
        .json({ error: "Schedule not found or not pending" });
    }
    console.log(`[schedule] Cancelled: ${schedule.id}`);
    res.json(schedule);
  });

  // ── Delivery API ────────────────────────────────────────

  app.post("/api/deliver", async (req, res) => {
    const { channel, message } = req.body;
    if (!channel || !message) {
      return res
        .status(400)
        .json({ error: "channel and message are required" });
    }
    const ok = await registry.deliver(channel, message);
    if (ok) {
      console.log(
        `[deliver] Sent to ${channel}: ${message.slice(0, 80)}...`
      );
      res.json({ status: "delivered", channel });
    } else {
      console.error(`[deliver] Failed to ${channel}`);
      res.status(500).json({ error: `Failed to deliver to ${channel}` });
    }
  });

  // ── Stop API ────────────────────────────────────────────

  app.post("/api/stop", (_req, res) => {
    if (!stopCurrentRun) {
      return res.status(501).json({ error: "Stop not available" });
    }
    const result = stopCurrentRun(sessions);
    console.log(
      `[api] Stop: stopped=${result.stopped}, queueCleared=${result.queueCleared}`
    );
    res.json(result);
  });

  // ── Buffered prompt ─────────────────────────────────────

  app.post("/prompt", async (req, res) => {
    try {
      const { message, session_id } = req.body;
      if (!message) {
        return res.status(400).json({ error: "message is required" });
      }
      const channelId = session_id || "api:direct";
      const response = await sendToAgent(
        agent,
        sessions,
        channelId,
        message
      );
      res.json({ response, session_id: channelId });
    } catch (err) {
      console.error("Prompt error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Streaming prompt (SSE) ──────────────────────────────

  app.post("/prompt/stream", async (req, res) => {
    const { message, session_id } = req.body || {};
    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    const channelId = session_id || "api:direct";

    const pass = new PassThrough();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    if (res.socket) res.socket.setNoDelay(true);
    pass.pipe(res);

    let clientGone = false;
    res.on("close", () => {
      clientGone = true;
    });

    function sseWrite(event, data) {
      if (clientGone) return;
      pass.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    try {
      const response = await sendToAgentStream(
        agent,
        sessions,
        channelId,
        message,
        {
          onToken(text) {
            sseWrite("token", { text });
          },
          onToolStart(name) {
            sseWrite("tool", {
              name,
              status: "start",
              detail: formatToolLabel(name),
            });
          },
          onToolDetail(name, args) {
            sseWrite("tool", {
              name,
              status: "detail",
              detail: formatToolLabel(name, args),
            });
          },
          onToolEnd(name, success) {
            sseWrite("tool", { name, status: "done", success });
          },
          onError(err) {
            sseWrite("error", { message: err });
          },
          onQueued(position) {
            sseWrite("queued", { position });
          },
        }
      );

      sseWrite("done", { text: response, session_id: channelId });
    } catch (err) {
      console.error("Stream error:", err.message);
      sseWrite("error", { message: err.message });
    }

    pass.end();
  });
}

module.exports = { registerRoutes };
