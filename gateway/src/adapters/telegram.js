// ─────────────────────────────────────────────────────────────
// Telegram Adapter — streaming response with progressive edits
//
// Message separation logic:
//   Each agent response can have multiple phases of tool calls
//   and text. We send SEPARATE Telegram messages for each text
//   segment so the user gets a notification for each one.
//
//   - Tool status lines are grouped into a single message that
//     gets edited in-place (⏳ → ✅/❌)
//   - Text tokens stream into their own message (edited as
//     tokens arrive)
//   - When a new tool phase starts after text, a new tool
//     message is created
//   - When new text starts after tools, a new text message
//     is created
//
// Commands:
//   /clear  — reset conversation (alias /new, /reset)
//   /stop   — abort current run + clear queue
//   /status — show session info
//
// OpenClaw-inspired UX:
//   - Typing indicator fires immediately on message receipt
//   - Queue feedback: user sees "⏳ Queued" when message is
//     queued behind a running task
//   - Debounce: rapid messages are collected into one turn
// ─────────────────────────────────────────────────────────────

const { Telegraf } = require("telegraf");
const { formatToolLabel } = require("../tool-labels");

const EDIT_INTERVAL_MS = 1200;
const TEXT_FIRST_SEND_DELAY_MS = 2500;
const TEXT_GAP_NEW_MSG_MS = 3000;
const TG_MAX_LEN = 4096;

// Deduplication: track recently processed message IDs to prevent
// double-processing when polling restarts. Telegram message_id is
// unique per chat. We keep the last 50 IDs.
const RECENT_MSG_IDS = new Set();
const MAX_RECENT = 50;
const recentOrder = [];

// Allowed user IDs - if set, only these users can interact
const ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isUserAllowed(userId) {
  if (ALLOWED_USERS.length === 0) return true;
  return ALLOWED_USERS.includes(String(userId));
}

async function setupTelegram(agent, sessions, sendToAgentStream, { stopCurrentRun } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const bot = new Telegraf(token);
  const me = await bot.telegram.getMe();
  console.log(`  Telegram bot: @${me.username} (${me.first_name})`);

  bot.catch((err, ctx) => {
    console.error(`Telegraf error for ${ctx.updateType}:`, err.message);
  });

  if (ALLOWED_USERS.length > 0) {
    console.log(`  Allowed users: ${ALLOWED_USERS.join(", ")}`);
  } else {
    console.log(`  Warning: no TELEGRAM_ALLOWED_USERS set - bot is open to everyone`);
  }

  // Middleware: reject unauthorized users early
  bot.use((ctx, next) => {
    const userId = ctx.from?.id;
    if (!isUserAllowed(userId)) {
      console.log(`[telegram] Blocked user ${userId} (${ctx.from?.username || "unknown"})`);
      return;
    }
    return next();
  });

  // -- /start -------------------------------------------------------
  bot.start((ctx) => {
    ctx.reply(
      "Hello there!\n\n" +
        "Commands:\n" +
        "/new — fresh conversation\n" +
        "/stop — abort current task\n" +
        "/status — show session info"
    );
  });

  // -- /clear, /new, /reset ----------------------------------------
  for (const cmd of ["clear", "new", "reset"]) {
    bot.command(cmd, (ctx) => {
      sessions.clear();
      ctx.reply("🧹 Conversation cleared. Fresh start!");
    });
  }

  // -- /stop --------------------------------------------------------
  bot.command("stop", (ctx) => {
    if (!stopCurrentRun) {
      ctx.reply("⚠️ Stop not available.");
      return;
    }
    const result = stopCurrentRun(sessions);
    if (result.stopped) {
      const parts = ["🛑 Stopped current task."];
      if (result.queueCleared > 0) {
        parts.push(`Cleared ${result.queueCleared} queued message(s).`);
      }
      ctx.reply(parts.join(" "));
    } else if (result.queueCleared > 0) {
      ctx.reply(`🛑 Cleared ${result.queueCleared} queued message(s).`);
    } else {
      ctx.reply("Nothing running right now. 👍");
    }
  });

  // -- /status ------------------------------------------------------
  bot.command("status", (ctx) => {
    const sessionId = sessions.getSessionId();
    const busy = sessions.isBusy();
    const qLen = sessions.queueLength();
    const uptime = Math.floor(process.uptime());
    const uptimeStr =
      uptime > 3600
        ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
        : `${Math.floor(uptime / 60)}m ${uptime % 60}s`;

    const lines = [
      `📊 *Session Status*`,
      ``,
      `Session: \`${sessionId ? sessionId.slice(0, 12) + "..." : "none"}\``,
      `Status: ${busy ? "🔴 Busy" : "🟢 Ready"}`,
      qLen > 0 ? `Queue: ${qLen} message(s) waiting` : `Queue: empty`,
      `Uptime: ${uptimeStr}`,
    ];

    if (sessions.lastActivity) {
      const ago = Math.floor(
        (Date.now() - new Date(sessions.lastActivity).getTime()) / 1000
      );
      const agoStr =
        ago > 3600
          ? `${Math.floor(ago / 3600)}h ago`
          : ago > 60
            ? `${Math.floor(ago / 60)}m ago`
            : `${ago}s ago`;
      lines.push(`Last activity: ${agoStr}`);
    }

    ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {
      ctx.reply(lines.join("\n"));
    });
  });

  // -- Text messages ------------------------------------------------
  bot.on("text", (ctx) => {
    const chatId = ctx.chat.id;
    const message = ctx.message.text;
    const msgId = ctx.message.message_id;
    if (message.startsWith("/")) return;

    // Dedup: skip if we've already processed this message
    if (RECENT_MSG_IDS.has(msgId)) {
      console.log(`[telegram:${chatId}] Dedup skip msg_id=${msgId}`);
      return;
    }
    RECENT_MSG_IDS.add(msgId);
    recentOrder.push(msgId);
    while (recentOrder.length > MAX_RECENT) {
      RECENT_MSG_IDS.delete(recentOrder.shift());
    }

    handleMessage(
      bot.telegram, agent, sessions, sendToAgentStream, chatId, message
    );
  });

  // Delete any stale webhook first — if a previous instance set one,
  // or if Telegram has a phantom webhook, long-polling won't receive updates.
  await bot.telegram.deleteWebhook({ drop_pending_updates: false });

  // Launch long-polling. Await the launch to catch initial errors.
  // Use allowedUpdates to reduce unnecessary traffic.
  bot.launch({
    dropPendingUpdates: false,
    allowedUpdates: ["message", "callback_query"],
  }).catch(err => {
    console.error(`[telegram] bot.launch() FATAL:`, err.message);
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  // Telegraf polling liveness monitor.
  // Telegraf can silently stop polling (network reset, etc.) with zero
  // indication. We track activity and restart if idle too long.
  // Conservative threshold: 5 minutes. Checks every 60s.
  let lastTelegrafActivity = Date.now();
  const POLL_DEAD_THRESHOLD = 5 * 60 * 1000; // 5 minutes
  const POLL_CHECK_INTERVAL = 60_000;         // check every 60s

  // Intercept update processing to track liveness
  const origHandleUpdate = bot.handleUpdate.bind(bot);
  bot.handleUpdate = (...args) => {
    lastTelegrafActivity = Date.now();
    return origHandleUpdate(...args);
  };

  setInterval(async () => {
    const idleMs = Date.now() - lastTelegrafActivity;
    if (idleMs < POLL_DEAD_THRESHOLD) return;

    // Idle for 5+ minutes. Could be legitimately quiet. Check if Telegram
    // API is reachable — if so, restart polling just in case.
    try {
      await bot.telegram.getMe();
    } catch {
      // API unreachable — network issue, not polling issue
      return;
    }

    console.log(`[telegram] No activity for ${Math.round(idleMs/1000)}s — restarting polling`);
    try { bot.stop(); } catch {}
    await new Promise(r => setTimeout(r, 3000));
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    bot.launch({
      dropPendingUpdates: false,  // dedup handles duplicates
      allowedUpdates: ["message", "callback_query"],
    }).catch(err => {
      console.error(`[telegram] Restart failed:`, err.message);
    });
    lastTelegrafActivity = Date.now();
    console.log(`[telegram] Polling restarted`);
  }, POLL_CHECK_INTERVAL);

  // Return a proactive send function for the adapter registry
  return async function sendToChat(chatId, message) {
    const result = await sendSafe(bot.telegram, chatId, message);
    if (!result) throw new Error("Telegram sendMessage failed");
  };
}

// ─────────────────────────────────────────────────────────────
// Message segment manager
// ─────────────────────────────────────────────────────────────

class MessageSegments {
  constructor(telegram, chatId) {
    this.telegram = telegram;
    this.chatId = chatId;

    this.phase = null;

    this.toolLines = [];
    this.toolMessageId = null;
    this.toolMarkdown = true;
    this.toolLastEdited = "";
    this.toolDirty = false;

    this.textContent = "";
    this.textMessageId = null;
    this.textMarkdown = true;
    this.textLastEdited = "";
    this.textDirty = false;

    this.editTimer = null;
    this.flushing = false;
    this.flushQueued = false;

    this.allMessageIds = [];

    this.textFirstSendTimer = null;
    this.lastTokenTime = 0;
  }

  _switchToTools() {
    if (this.phase === "tools") return;
    this.phase = "tools";
    this.toolLines = [];
    this.toolMessageId = null;
    this.toolMarkdown = true;
    this.toolLastEdited = "";
    this.toolDirty = false;
  }

  _switchToText() {
    if (this.phase === "text") return;
    this.phase = "text";
    this.textContent = "";
    this.textMessageId = null;
    this.textMarkdown = true;
    this.textLastEdited = "";
    this.textDirty = false;
    if (this.textFirstSendTimer) {
      clearTimeout(this.textFirstSendTimer);
      this.textFirstSendTimer = null;
    }
  }

  addToolStart(name) {
    this._switchToTools();
    const label = formatToolLabel(name);
    this.toolLines.push({ emoji: "⏳", label, toolName: name });
    this.toolDirty = true;
    this._ensureTimer();
    this._flushSoon();
  }

  updateToolDetail(name, args) {
    const label = formatToolLabel(name, args);
    for (let i = this.toolLines.length - 1; i >= 0; i--) {
      if (this.toolLines[i].emoji === "⏳" && this.toolLines[i].toolName === name) {
        this.toolLines[i].label = label;
        break;
      }
    }
    this.toolDirty = true;
  }

  updateToolEnd(name, success) {
    for (let i = this.toolLines.length - 1; i >= 0; i--) {
      if (this.toolLines[i].emoji === "⏳" && this.toolLines[i].toolName === name) {
        this.toolLines[i].emoji = success ? "✅" : "❌";
        break;
      }
    }
    this.toolDirty = true;
  }

  addToken(text) {
    const now = Date.now();
    if (
      this.phase === "text" &&
      this.textMessageId &&
      this.lastTokenTime > 0 &&
      (now - this.lastTokenTime) > TEXT_GAP_NEW_MSG_MS
    ) {
      this.phase = null;
    }
    this.lastTokenTime = now;
    this._switchToText();
    this.textContent += text;
    this.textDirty = true;
    this._ensureTimer();
    this._flushSoon();
  }

  _ensureTimer() {
    if (this.editTimer) return;
    this.editTimer = setInterval(() => {
      if (this.toolDirty || this.textDirty) this.flush();
    }, EDIT_INTERVAL_MS);
  }

  stopTimer() {
    if (this.editTimer) {
      clearInterval(this.editTimer);
      this.editTimer = null;
    }
    if (this.textFirstSendTimer) {
      clearTimeout(this.textFirstSendTimer);
      this.textFirstSendTimer = null;
    }
  }

  _flushSoon() {
    if (this.phase === "tools" && !this.toolMessageId && !this.flushing) {
      this.flush();
      return;
    }
    if (this.phase === "text" && !this.textMessageId && !this.textFirstSendTimer) {
      this.textFirstSendTimer = setTimeout(() => {
        this.textFirstSendTimer = null;
        if (this.textDirty && !this.textMessageId) {
          this.flush();
        }
      }, TEXT_FIRST_SEND_DELAY_MS);
    }
  }

  async flush() {
    if (this.flushing) {
      this.flushQueued = true;
      return;
    }
    this.flushing = true;

    try {
      if (this.toolDirty && this.toolLines.length > 0) {
        const text = this.toolLines.map((t) => `${t.emoji} ${t.label}`).join("\n");
        const truncated = truncate(text);

        if (!this.toolMessageId) {
          const sent = await sendSafe(this.telegram, this.chatId, truncated);
          if (sent) {
            this.toolMessageId = sent.message_id;
            this.toolMarkdown = sent.usedMarkdown;
            this.allMessageIds.push(sent.message_id);
            this.toolLastEdited = truncated;
            this.toolDirty = false;
          }
        } else if (truncated !== this.toolLastEdited) {
          const ok = await editSafe(this.telegram, this.chatId, this.toolMessageId, truncated, this.toolMarkdown);
          if (ok) {
            this.toolLastEdited = truncated;
            this.toolDirty = false;
          }
        } else {
          this.toolDirty = false;
        }
      }

      if (this.textDirty && this.textContent) {
        const truncated = truncate(this.textContent);

        if (!this.textMessageId) {
          const sent = await sendSafe(this.telegram, this.chatId, truncated);
          if (sent) {
            this.textMessageId = sent.message_id;
            this.textMarkdown = sent.usedMarkdown;
            this.allMessageIds.push(sent.message_id);
            this.textLastEdited = truncated;
            this.textDirty = false;
          }
        } else if (truncated !== this.textLastEdited) {
          const ok = await editSafe(this.telegram, this.chatId, this.textMessageId, truncated, this.textMarkdown);
          if (ok) {
            this.textLastEdited = truncated;
            this.textDirty = false;
          }
        } else {
          this.textDirty = false;
        }
      }
    } catch (err) {
      console.error(`[telegram:${this.chatId}] Flush error:`, err.message);
    } finally {
      this.flushing = false;
      if (this.flushQueued) {
        this.flushQueued = false;
        this.flush();
      }
    }
  }

  async finalize() {
    this.stopTimer();
    for (const t of this.toolLines) {
      if (t.emoji === "⏳") t.emoji = "✅";
    }
    if (this.toolLines.length > 0) this.toolDirty = true;
    await this.flush();
  }

  async finalizeError() {
    this.stopTimer();
    for (const t of this.toolLines) {
      if (t.emoji === "⏳") t.emoji = "❌";
    }
    if (this.toolLines.length > 0) this.toolDirty = true;

    if (this.textMessageId) {
      this.textContent += "\n\n⚠️ _Something went wrong. Try again._";
      this.textDirty = true;
    }

    await this.flush();

    if (this.allMessageIds.length === 0) {
      await sendSafe(
        this.telegram,
        this.chatId,
        "Sorry, I hit an error processing that. Please try again. 🔧"
      );
    }
  }

  hasSentAnything() {
    return this.allMessageIds.length > 0;
  }
}

// ─────────────────────────────────────────────────────────────
// Handle incoming message
// ─────────────────────────────────────────────────────────────

async function handleMessage(
  telegram, agent, sessions, sendToAgentStream, chatId, message
) {
  const channelId = `telegram:${chatId}`;
  console.log(
    `[telegram:${chatId}] ← "${message.slice(0, 80)}${message.length > 80 ? "..." : ""}"`
  );

  // Send typing indicator immediately (OpenClaw: instant mode)
  await telegram.sendChatAction(chatId, "typing").catch(() => {});

  const segments = new MessageSegments(telegram, chatId);

  // Track whether we showed a queued message (to edit it away later)
  let queuedMessageId = null;

  const typingInterval = setInterval(() => {
    if (!segments.hasSentAnything()) {
      telegram.sendChatAction(chatId, "typing").catch(() => {});
    }
  }, 4000);

  try {
    const response = await sendToAgentStream(
      agent, sessions, channelId, message,
      {
        onToken(text) {
          // If we had a queued notice, delete it now that we're streaming
          if (queuedMessageId) {
            telegram.deleteMessage(chatId, queuedMessageId).catch(() => {});
            queuedMessageId = null;
          }
          segments.addToken(text);
        },

        onToolStart(name) {
          if (queuedMessageId) {
            telegram.deleteMessage(chatId, queuedMessageId).catch(() => {});
            queuedMessageId = null;
          }
          segments.addToolStart(name);
        },

        onToolDetail(name, args) {
          segments.updateToolDetail(name, args);
        },

        onToolEnd(name, success) {
          segments.updateToolEnd(name, success);
        },

        onError(err) {
          console.error(`[telegram:${chatId}] Stream error: ${err}`);
        },

        // Queue feedback: show user their message is queued
        onQueued(position) {
          const queueMsg =
            position === 1
              ? "⏳ _Working on something else, I'll get to this next..._"
              : `⏳ _Queued (position ${position}). I'll get to this soon..._`;

          sendSafe(telegram, chatId, queueMsg).then((sent) => {
            if (sent) queuedMessageId = sent.message_id;
          });
        },
      }
    );

    clearInterval(typingInterval);

    // Clean up queued notice if still showing
    if (queuedMessageId) {
      telegram.deleteMessage(chatId, queuedMessageId).catch(() => {});
      queuedMessageId = null;
    }

    if (!response && !segments.hasSentAnything()) {
      await telegram.sendMessage(
        chatId,
        "I processed your message but didn't have anything to say. Try again?"
      );
      return;
    }

    await segments.finalize();

    console.log(`[telegram:${chatId}] → ${(response || "").length} chars`);
  } catch (err) {
    clearInterval(typingInterval);

    if (queuedMessageId) {
      telegram.deleteMessage(chatId, queuedMessageId).catch(() => {});
    }

    // Handle aborted runs gracefully
    if (err.name === "AbortError" || err.message?.includes("aborted") || err.message?.includes("Queue cleared")) {
      console.log(`[telegram:${chatId}] Run aborted/cleared`);
      return;
    }

    console.error(`[telegram:${chatId}] Error:`, err.message);
    await segments.finalizeError();
  }
}

// ─────────────────────────────────────────────────────────────
// Telegram API helpers
// ─────────────────────────────────────────────────────────────

function truncate(text) {
  if (text.length <= TG_MAX_LEN) return text;
  return text.slice(0, TG_MAX_LEN - 4) + " ...";
}

async function sendSafe(telegram, chatId, text) {
  try {
    const msg = await telegram.sendMessage(chatId, text, { parse_mode: "Markdown" });
    return { message_id: msg.message_id, usedMarkdown: true };
  } catch {
    try {
      const msg = await telegram.sendMessage(chatId, text);
      return { message_id: msg.message_id, usedMarkdown: false };
    } catch (err) {
      console.error(`[telegram] sendMessage failed:`, err.message);
      return null;
    }
  }
}

async function editSafe(telegram, chatId, messageId, text, useMarkdown) {
  const opts = useMarkdown ? { parse_mode: "Markdown" } : undefined;
  try {
    await telegram.editMessageText(chatId, messageId, undefined, text, opts);
    return true;
  } catch (err) {
    if (err.message?.includes("not modified")) return true;
    if (useMarkdown) {
      try {
        await telegram.editMessageText(chatId, messageId, undefined, text);
        return true;
      } catch (err2) {
        if (err2.message?.includes("not modified")) return true;
        console.error(`[telegram] editMessage failed:`, err2.message);
        return false;
      }
    }
    console.error(`[telegram] editMessage failed:`, err.message);
    return false;
  }
}

module.exports = { setupTelegram };
