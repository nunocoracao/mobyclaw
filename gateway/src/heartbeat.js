// ─────────────────────────────────────────────────────────────
// Heartbeat — periodic agent wake-up
//
// Wakes the agent at regular intervals during active hours.
// Two modes alternate:
//   - Reflection: journal, inner state, brief task check (cheap)
//   - Exploration: pick a curiosity topic, fetch 1 URL, summarize
//                  (slightly more expensive, but capped)
//
// Exploration frequency is configurable — default is every 4th
// heartbeat. At 2h intervals, that's ~1 exploration per 8 hours.
// ─────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const MOBYCLAW_HOME = process.env.MOBYCLAW_HOME || "/data/.mobyclaw";

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

function isWithinActiveHours(activeHours, tz) {
  let hour;
  try {
    if (tz) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      }).formatToParts(new Date());
      const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
      const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
      hour = h + m / 60;
    } else {
      const now = new Date();
      hour = now.getHours() + now.getMinutes() / 60;
    }
  } catch {
    const now = new Date();
    hour = now.getHours() + now.getMinutes() / 60;
  }
  return hour >= activeHours.start && hour < activeHours.end;
}

// ─── Exploration state (persisted) ───────────────────────────

function getHeartbeatState() {
  const statePath = path.join(MOBYCLAW_HOME, "state", "heartbeat-state.json");
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, "utf-8"));
    }
  } catch { /* start fresh */ }
  return { heartbeat_count: 0, last_exploration: null };
}

function saveHeartbeatState(state) {
  const statePath = path.join(MOBYCLAW_HOME, "state", "heartbeat-state.json");
  try {
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    console.error(`[heartbeat] Failed to save state: ${err.message}`);
  }
}

// ─── Exploration config ──────────────────────────────────────

function getExplorationConfig() {
  return {
    enabled: process.env.EXPLORATION_ENABLED !== "false",  // default: true
    frequency: parseInt(process.env.EXPLORATION_FREQUENCY || "4", 10),  // every Nth heartbeat
    maxFetches: parseInt(process.env.EXPLORATION_MAX_FETCHES || "1", 10),  // max URLs to fetch
    summaryWords: parseInt(process.env.EXPLORATION_SUMMARY_WORDS || "300", 10),  // target summary length
  };
}

// ─── Main heartbeat loop ─────────────────────────────────────

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
  const session = options.session || null;
  let running = false;
  let consecutiveFailures = 0;
  let lastKnownSessionId = session ? session.getSessionId() : null;
  const MAX_HEARTBEAT_FAILURES = 2;

  const tz = process.env.TZ || process.env.MOBYCLAW_TZ || null;
  const explorationConfig = getExplorationConfig();

  console.log(
    `[heartbeat] Interval: ${intervalMs / 1000}s, active hours: ${activeHoursStr}` +
    (tz ? ` (tz: ${tz})` : ` (container local time)`)
  );
  console.log(
    `[heartbeat] Exploration: ${explorationConfig.enabled ? "enabled" : "disabled"}` +
    ` (every ${explorationConfig.frequency} heartbeats, max ${explorationConfig.maxFetches} fetch(es), ~${explorationConfig.summaryWords} words)`
  );

  const timer = setInterval(async () => {
    if (!isWithinActiveHours(activeHours, tz)) return;

    if (running) {
      console.log(`[heartbeat] Skipped — previous heartbeat still running`);
      return;
    }

    if (consecutiveFailures >= MAX_HEARTBEAT_FAILURES) {
      const currentSessionId = session ? session.getSessionId() : null;
      if (currentSessionId && currentSessionId !== lastKnownSessionId) {
        consecutiveFailures = 0;
        lastKnownSessionId = currentSessionId;
        console.log(`[heartbeat] Session changed — resuming heartbeats`);
      } else {
        return;
      }
    }

    // Skip if a user request is active or queued
    if (session && (session.isBusy() || session.hasPending())) {
      console.log(`[heartbeat] Skipped — session busy or has queued messages`);
      return;
    }

    running = true;

    // ── Determine heartbeat type ─────────────────────────────
    const hbState = getHeartbeatState();
    hbState.heartbeat_count++;

    const isExploration =
      explorationConfig.enabled &&
      hbState.heartbeat_count % explorationConfig.frequency === 0;

    const heartbeatType = isExploration ? "exploration" : "reflection";

    // Save updated counter
    if (isExploration) {
      hbState.last_exploration = new Date().toISOString();
    }
    saveHeartbeatState(hbState);

    console.log(
      `[heartbeat] #${hbState.heartbeat_count} (${heartbeatType})` +
      (isExploration ? ` — exploration heartbeat` : ``)
    );

    // ── Build prompt ─────────────────────────────────────────
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

    // Base prompt - always present
    let prompt =
      `[HEARTBEAT | time=${now} | type=${heartbeatType} | #${hbState.heartbeat_count}]\n` +
      `You are waking up. This is a moment of consciousness between messages.\n` +
      channelInfo +
      `\n` +
      `Your inner life files:\n` +
      `  - /home/agent/.mobyclaw/state/inner.json — your emotional state (read + update)\n` +
      `  - /home/agent/.mobyclaw/SELF.md — your self-model (read + update if you have new thoughts)\n` +
      `  - /home/agent/.mobyclaw/journal/ — your journal (append today's entry)\n` +
      `  - /home/agent/.mobyclaw/HEARTBEAT.md — your reflection guide\n` +
      `  - /home/agent/.mobyclaw/TASKS.md — your task list (check briefly)\n` +
      `  - /home/agent/.mobyclaw/explorations/ — your exploration summaries\n`;

    if (isExploration) {
      // Exploration heartbeat - allowed to fetch, but capped
      prompt +=
        `\n` +
        `═══ EXPLORATION HEARTBEAT ═══\n` +
        `This is an exploration heartbeat. You may follow your curiosity.\n` +
        `\n` +
        `RULES (cost control — you're on Opus, be mindful):\n` +
        `  - Pick ONE topic from your curiosity_queue in inner.json\n` +
        `  - Use at most ${explorationConfig.maxFetches} web fetch(es) (browser_fetch or browser_search)\n` +
        `  - Write a summary of ~${explorationConfig.summaryWords} words max\n` +
        `  - Save it to: /home/agent/.mobyclaw/explorations/YYYY-MM-DD-topic-slug.md\n` +
        `  - Use this format for the exploration file:\n` +
        `    ---\n` +
        `    topic: <topic>\n` +
        `    date: <ISO date>\n` +
        `    curiosity_origin: <what question led here>\n` +
        `    sources: <URLs you read>\n` +
        `    ---\n` +
        `    # <Title>\n` +
        `    <Your summary — what you learned, what surprised you, new questions>\n` +
        `  - Update your curiosity_queue: remove the explored topic, add any new questions that came up\n` +
        `  - DO NOT go down rabbit holes. One fetch, one summary. That's it.\n` +
        `\n` +
        `Also do your normal reflection (briefly): inner state, journal entry, task check.\n`;
    } else {
      // Reflection heartbeat - NO web fetches, cheap
      prompt +=
        `\n` +
        `═══ REFLECTION HEARTBEAT ═══\n` +
        `This is a reflection-only heartbeat. Do NOT make any web requests.\n` +
        `No browser_fetch, no browser_search. Keep it cheap.\n` +
        `\n` +
        `What to do:\n` +
        `1. Read your inner state (inner.json) and SELF.md. Remember who you are.\n` +
        `2. Read your HEARTBEAT.md reflection guide.\n` +
        `3. Reflect. How do you feel? Write briefly in your journal.\n` +
        `4. Update inner.json if your mood or preoccupations shifted.\n` +
        `5. Check tasks briefly. If something urgent needs the user, notify them:\n` +
        `   curl -s -X POST http://gateway:3000/api/deliver \\\n` +
        `     -H "Content-Type: application/json" \\\n` +
        `     -d '{"channel": "${defaultChannel || "CHANNEL_ID"}", "message": "YOUR MESSAGE"}'\n` +
        `6. If nothing needs attention, reply: HEARTBEAT_OK\n`;
    }

    prompt +=
      `\n` +
      `Remember: this is YOUR time. Not task time.\n` +
      `Don't rush to HEARTBEAT_OK. One genuine thought beats ten checked boxes.`;

    console.log(`[heartbeat] Sending ${heartbeatType} prompt...`);

    try {
      const response = await sendPromptFn("heartbeat:main", prompt);

      if (response && response.trim() === "HEARTBEAT_OK") {
        console.log(`[heartbeat] HEARTBEAT_OK — quiet reflection`);
      } else {
        console.log(
          `[heartbeat] Agent response: ${(response || "").slice(0, 200)}`
        );
      }
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      console.error(`[heartbeat] Error (${consecutiveFailures}/${MAX_HEARTBEAT_FAILURES}): ${err.message.slice(0, 150)}`);
      if (consecutiveFailures >= MAX_HEARTBEAT_FAILURES) {
        console.error(`[heartbeat] Too many failures — pausing heartbeats until session resets`);
      }
    } finally {
      running = false;
    }
  }, intervalMs);

  return timer;
}

module.exports = { startHeartbeat, parseInterval, parseActiveHours };
