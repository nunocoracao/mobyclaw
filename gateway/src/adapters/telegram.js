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
// This means: user gets separate notifications for each
// distinct text response from the agent. Tool status and
// response text are never mixed in the same message.
// ─────────────────────────────────────────────────────────────

const { Telegraf } = require("telegraf");
const { formatToolLabel } = require("../tool-labels");

const EDIT_INTERVAL_MS = 1200;
const TEXT_FIRST_SEND_DELAY_MS = 2500; // Buffer text before first send for better notification previews
const TEXT_GAP_NEW_MSG_MS = 3000;     // If no tokens for this long, next tokens get a new message
const TG_MAX_LEN = 4096;

// Allowed user IDs - if set, only these users can interact
const ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isUserAllowed(userId) {
  if (ALLOWED_USERS.length === 0) return true;
  return ALLOWED_USERS.includes(String(userId));
}

async function setupTelegram(agent, sessions, sendToAgentStream) {
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
      return; // silent ignore
    }
    return next();
  });

  bot.start((ctx) => {
    ctx.reply(
      "Hey! I'm Moby, your personal AI agent.\n\n" +
        "Just send me a message and I'll help you out. " +
        "I remember our conversations, so feel free to pick up where we left off."
    );
  });

  bot.command("clear", (ctx) => {
    const channelId = `telegram:${ctx.chat.id}`;
    sessions.clear();
    ctx.reply("🧹 Conversation cleared. Fresh start!");
  });

  bot.on("text", (ctx) => {
    const chatId = ctx.chat.id;
    const message = ctx.message.text;
    if (message.startsWith("/")) return;
    handleMessage(
      bot.telegram, agent, sessions, sendToAgentStream, chatId, message
    );
  });

  bot.launch({ dropPendingUpdates: true });
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  // Return a proactive send function for the adapter registry
  return async function sendToChat(chatId, message) {
    const result = await sendSafe(bot.telegram, chatId, message);
    if (!result) throw new Error("Telegram sendMessage failed");
  };
}

// ─────────────────────────────────────────────────────────────
// Message segment manager
//
// Manages a sequence of Telegram messages for one agent response.
// Each "segment" is either a tool-status block or a text block.
// New segments get new Telegram messages. Tool status and text
// are never mixed in the same message.
//
// Flow for a typical agent response:
//   tools phase → tool message (edited in place)
//   text phase  → new text message (streamed via edits)
//   tools phase → new tool message (edited in place)
//   text phase  → new text message (streamed via edits)
// ─────────────────────────────────────────────────────────────

class MessageSegments {
  constructor(telegram, chatId) {
    this.telegram = telegram;
    this.chatId = chatId;

    // Current phase: null | "tools" | "text"
    this.phase = null;

    // Current tool message state
    this.toolLines = [];         // { emoji, label, toolName }
    this.toolMessageId = null;
    this.toolMarkdown = true;
    this.toolLastEdited = "";
    this.toolDirty = false;

    // Current text message state
    this.textContent = "";
    this.textMessageId = null;
    this.textMarkdown = true;
    this.textLastEdited = "";
    this.textDirty = false;

    // Edit timer (shared)
    this.editTimer = null;
    this.flushing = false;
    this.flushQueued = false;

    // Track all sent message IDs (for hasSentAnything)
    this.allMessageIds = [];

    // Delayed first-send timer for text messages
    this.textFirstSendTimer = null;

    // Timestamp of the last text token (for gap detection)
    this.lastTokenTime = 0;
  }

  // -- Phase transitions ------------------------------------------

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

    // Clear any pending first-send timer from a previous text segment
    if (this.textFirstSendTimer) {
      clearTimeout(this.textFirstSendTimer);
      this.textFirstSendTimer = null;
    }
  }

  // -- Tool events ------------------------------------------------

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

  // -- Text events ------------------------------------------------

  addToken(text) {
    const now = Date.now();

    // If we're already in a text phase with a sent message, and
    // there's been a long gap since the last token, start a new
    // text message so the user gets a fresh notification.
    if (
      this.phase === "text" &&
      this.textMessageId &&
      this.lastTokenTime > 0 &&
      (now - this.lastTokenTime) > TEXT_GAP_NEW_MSG_MS
    ) {
      // Force a new text segment
      this.phase = null;
    }

    this.lastTokenTime = now;
    this._switchToText();
    this.textContent += text;
    this.textDirty = true;
    this._ensureTimer();
    this._flushSoon();
  }

  // -- Flush logic ------------------------------------------------

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
    // Tools: flush immediately (status indicators, no notification concern)
    if (this.phase === "tools" && !this.toolMessageId && !this.flushing) {
      this.flush();
      return;
    }

    // Text: delay the first send so the notification preview has real content.
    // Without this, the notification shows just the first word.
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
      // Flush tool message if dirty
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

      // Flush text message if dirty
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

  // -- Finalize ---------------------------------------------------
  // Called when the agent stream ends. We do NOT use the full
  // accumulated response here because it contains text from ALL
  // segments. Instead we just do a final flush of whatever the
  // current segment has accumulated via streaming tokens.

  async finalize() {
    this.stopTimer();

    // Mark any remaining ⏳ tools as done
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

    // Add error to current text message if one exists
    if (this.textMessageId) {
      this.textContent += "\n\n⚠️ _Something went wrong. Try again._";
      this.textDirty = true;
    }

    await this.flush();

    // If we never sent anything, send a standalone error
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

  await telegram.sendChatAction(chatId, "typing").catch(() => {});

  const segments = new MessageSegments(telegram, chatId);

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
          segments.addToken(text);
        },

        onToolStart(name) {
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
      }
    );

    clearInterval(typingInterval);

    if (!response && !segments.hasSentAnything()) {
      await telegram.sendMessage(
        chatId,
        "I processed your message but didn't have anything to say. Try again?"
      );
      return;
    }

    // finalize() just flushes current segment state - does NOT
    // use the full `response` to avoid duplicating text across messages
    await segments.finalize();

    console.log(`[telegram:${chatId}] → ${(response || "").length} chars`);
  } catch (err) {
    clearInterval(typingInterval);
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

// sendSafe returns { message_id, usedMarkdown } or null
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
    // If markdown edit failed, retry without markdown
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
