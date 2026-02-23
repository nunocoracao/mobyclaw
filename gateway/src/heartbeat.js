// ─────────────────────────────────────────────────────────────
// Heartbeat — periodic agent wake-up
//
// Wakes the agent at regular intervals during active hours.
// The agent checks tasks, runs its heartbeat checklist, and
// can proactively notify the user if needed.
// ─────────────────────────────────────────────────────────────

function parseInterval(str) {
  const match = (str || "15m").match(/^(\d+)(s|m|h)$/);
  if (!match) return 15 * 60 * 1000;
  const val = parseInt(match[1], 10);
  switch (match[2]) {
    case "s": return val * 1000;
    case "m": return val * 60 * 1000;
    case "h": return val * 60 * 60 * 1000;
    default:  return 15 * 60 * 1000;
  }
}

function parseActiveHours(str) {
  const match = (str || "07:00-23:00").match(
    /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/
  );
  if (!match) return { start: 7, end: 23 };
  return {
    start: parseInt(match[1], 10) + parseInt(match[2], 10) / 60,
    end:   parseInt(match[3], 10) + parseInt(match[4], 10) / 60,
  };
}

function isWithinActiveHours(activeHours) {
  const now = new Date();
  const hour = now.getHours() + now.getMinutes() / 60;
  return hour >= activeHours.start && hour < activeHours.end;
}

function startHeartbeat(sendPromptFn, channelStore, options = {}) {
  const intervalMs = parseInterval(
    options.interval ||
    process.env.MOBYCLAW_HEARTBEAT_INTERVAL ||
    "15m"
  );
  const activeHoursStr =
    options.activeHours ||
    process.env.MOBYCLAW_ACTIVE_HOURS ||
    "07:00-23:00";
  const activeHours = parseActiveHours(activeHoursStr);
  let running = false;

  console.log(
    `[heartbeat] Interval: ${intervalMs / 1000}s, active hours: ${activeHoursStr}`
  );

  const timer = setInterval(async () => {
    if (!isWithinActiveHours(activeHours)) return;

    if (running) {
      console.log(`[heartbeat] Skipped — previous heartbeat still running`);
      return;
    }
    running = true;

    const now = new Date().toISOString();
    const known = channelStore.getAll();
    const defaultChannel = channelStore.getDefault();

    let channelInfo = "";
    if (Object.keys(known).length > 0) {
      const entries = Object.entries(known)
        .map(([p, ch]) => `  - ${p}: ${ch}`)
        .join("\n");
      channelInfo = `\nKnown channels:\n${entries}\nDefault channel: ${defaultChannel}\n`;
    } else {
      channelInfo =
        "\nNo known channels yet (no messages received from any platform).\n";
    }

    const prompt =
      `[HEARTBEAT | time=${now}]\n` +
      `You are being woken by a scheduled heartbeat.\n` +
      channelInfo +
      `\n` +
      `1. Read /home/agent/.mobyclaw/TASKS.md — review your task list, note anything relevant\n` +
      `2. Read /home/agent/.mobyclaw/HEARTBEAT.md — follow the checklist\n` +
      `3. If you need to notify the user about something, use:\n` +
      `   curl -s -X POST http://gateway:3000/api/deliver \\\n` +
      `     -H "Content-Type: application/json" \\\n` +
      `     -d '{"channel": "${defaultChannel || "CHANNEL_ID"}", "message": "YOUR MESSAGE"}'\n` +
      `4. If nothing needs attention, reply exactly: HEARTBEAT_OK`;

    console.log(`[heartbeat] Sending heartbeat prompt...`);

    try {
      const response = await sendPromptFn("heartbeat:main", prompt);

      if (response && response.trim() === "HEARTBEAT_OK") {
        console.log(`[heartbeat] HEARTBEAT_OK — nothing to do`);
      } else {
        console.log(
          `[heartbeat] Agent response: ${(response || "").slice(0, 200)}`
        );
      }
    } catch (err) {
      console.error(`[heartbeat] Error: ${err.message}`);
    } finally {
      running = false;
    }
  }, intervalMs);

  return timer;
}

module.exports = { startHeartbeat, parseInterval, parseActiveHours };
