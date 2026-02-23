// ─────────────────────────────────────────────────────────────
// Telegram Adapter — streaming response with progressive edits
//
// Tool calls show as persistent status lines at the top:
//   ⏳ Reading file...                   (started, no args yet)
//   ⏳ Reading file: ~/.mobyclaw/MEMORY.md   (args received)
//   ✅ Reading file: ~/.mobyclaw/MEMORY.md   (succeeded)
//   ❌ Reading file: /nonexistent.txt        (failed)
// ─────────────────────────────────────────────────────────────

const { Telegraf } = require("telegraf");
const { formatToolLabel } = require("../tool-labels");

const EDIT_INTERVAL_MS = 1200;
const TG_MAX_LEN = 4096;

async function setupTelegram(agent, sessions, sendToAgentStream) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const bot = new Telegraf(token);
  const me = await bot.telegram.getMe();
  console.log(`  Telegram bot: @${me.username} (${me.first_name})`);

  bot.catch((err, ctx) => {
    console.error(`Telegraf error for ${ctx.updateType}:`, err.message);
  });

  bot.start((ctx) => {
    ctx.reply(
      "Hey! 👋 I'm Moby, your personal AI agent.\n\n" +
        "Just send me a message and I'll help you out. " +
        "I remember our conversations, so feel free to pick up where we left off."
    );
  });

  bot.command("clear", (ctx) => {
    const channelId = `telegram:${ctx.chat.id}`;
    sessions.clear(channelId);
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
  // Must throw on failure so the scheduler knows delivery failed
  return async function sendToChat(chatId, message) {
    const result = await sendSafe(bot.telegram, chatId, message);
    if (!result) throw new Error("Telegram sendMessage failed");
  };
}

async function handleMessage(
  telegram, agent, sessions, sendToAgentStream, chatId, message
) {
  const channelId = `telegram:${chatId}`;
  console.log(
    `[telegram:${chatId}] ← "${message.slice(0, 80)}${message.length > 80 ? "..." : ""}"`
  );

  await telegram.sendChatAction(chatId, "typing").catch(() => {});

  // ── Streaming state ─────────────────────────────────────
  // toolLines[]: { emoji, label }
  //   emoji — "⏳", "✅", or "❌"
  //   label — human-readable detail (e.g. "Reading file: MEMORY.md")
  //
  let toolLines = [];
  let responseText = "";
  let sentMessageId = null;
  let lastEditedText = "";
  let editTimer = null;
  let dirty = false;
  let flushing = false;
  let flushQueued = false;

  function buildDisplayText() {
    const parts = [];
    if (toolLines.length > 0) {
      parts.push(toolLines.map((t) => `${t.emoji} ${t.label}`).join("\n"));
    }
    if (responseText) {
      parts.push(responseText);
    }
    return parts.join("\n\n");
  }

  async function flush() {
    if (flushing) {
      flushQueued = true;
      return;
    }
    flushing = true;
    try {
      const displayText = buildDisplayText();
      if (!displayText || displayText === lastEditedText) return;
      const truncated =
        displayText.length > TG_MAX_LEN
          ? displayText.slice(0, TG_MAX_LEN - 4) + " ..."
          : displayText;

      if (!sentMessageId) {
        const sent = await sendSafe(telegram, chatId, truncated);
        if (sent) {
          sentMessageId = sent.message_id;
          lastEditedText = truncated;
          dirty = false;
        }
      } else if (truncated !== lastEditedText) {
        const ok = await editSafe(telegram, chatId, sentMessageId, truncated);
        if (ok) {
          lastEditedText = truncated;
          dirty = false;
        }
      }
    } catch (err) {
      console.error(`[telegram:${chatId}] Flush error:`, err.message);
    } finally {
      flushing = false;
      if (flushQueued) {
        flushQueued = false;
        flush();
      }
    }
  }

  function startEditTimer() {
    if (editTimer) return;
    editTimer = setInterval(() => {
      if (dirty) flush();
    }, EDIT_INTERVAL_MS);
  }

  function stopEditTimer() {
    if (editTimer) {
      clearInterval(editTimer);
      editTimer = null;
    }
  }

  function ensureStreamStarted() {
    if (!sentMessageId && !flushing) {
      clearInterval(typingInterval);
      flush();
      startEditTimer();
    }
  }

  const typingInterval = setInterval(() => {
    if (!sentMessageId) {
      telegram.sendChatAction(chatId, "typing").catch(() => {});
    }
  }, 4000);

  try {
    const response = await sendToAgentStream(
      agent, sessions, channelId, message,
      {
        onToken(text) {
          responseText += text;
          dirty = true;
          if (responseText.length > 0) ensureStreamStarted();
        },

        onToolStart(name) {
          const label = formatToolLabel(name);
          toolLines.push({ emoji: "⏳", label, toolName: name });
          dirty = true;
          ensureStreamStarted();
        },

        onToolDetail(name, args) {
          // Update the last ⏳ line for this tool with detailed label
          const label = formatToolLabel(name, args);
          for (let i = toolLines.length - 1; i >= 0; i--) {
            if (toolLines[i].emoji === "⏳" && toolLines[i].toolName === name) {
              toolLines[i].label = label;
              break;
            }
          }
          dirty = true;
        },

        onToolEnd(name, success) {
          for (let i = toolLines.length - 1; i >= 0; i--) {
            if (toolLines[i].emoji === "⏳" && toolLines[i].toolName === name) {
              toolLines[i].emoji = success ? "✅" : "❌";
              break;
            }
          }
          dirty = true;
        },

        onError(err) {
          console.error(`[telegram:${chatId}] Stream error: ${err}`);
        },
      }
    );

    stopEditTimer();
    clearInterval(typingInterval);

    if (!response && toolLines.length === 0) {
      if (!sentMessageId) {
        await telegram.sendMessage(
          chatId,
          "I processed your message but didn't have anything to say. Try again?"
        );
      }
      return;
    }

    responseText = response;
    for (const t of toolLines) {
      if (t.emoji === "⏳") t.emoji = "✅";
    }
    dirty = true;
    await flush();

    console.log(`[telegram:${chatId}] → ${response.length} chars`);
  } catch (err) {
    stopEditTimer();
    clearInterval(typingInterval);
    console.error(`[telegram:${chatId}] Error:`, err.message);

    for (const t of toolLines) {
      if (t.emoji === "⏳") t.emoji = "❌";
    }

    if (sentMessageId) {
      responseText += "\n\n⚠️ _Something went wrong. Try again._";
      dirty = true;
      await flush();
    } else {
      await telegram
        .sendMessage(chatId, "Sorry, I hit an error processing that. Please try again. 🔧")
        .catch(() => {});
    }
  }
}

async function sendSafe(telegram, chatId, text) {
  try {
    return await telegram.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch {
    try {
      return await telegram.sendMessage(chatId, text);
    } catch (err) {
      console.error(`[telegram] sendMessage failed:`, err.message);
      return null;
    }
  }
}

async function editSafe(telegram, chatId, messageId, text) {
  try {
    await telegram.editMessageText(chatId, messageId, undefined, text, {
      parse_mode: "Markdown",
    });
    return true;
  } catch (err) {
    if (err.message?.includes("not modified")) return true;
    try {
      await telegram.editMessageText(chatId, messageId, undefined, text);
      return true;
    } catch (err2) {
      if (err2.message?.includes("not modified")) return true;
      console.error(`[telegram] editMessage failed:`, err2.message);
      return false;
    }
  }
}

module.exports = { setupTelegram };
