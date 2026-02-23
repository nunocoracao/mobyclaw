// ─────────────────────────────────────────────────────────────
// Scheduler — timed reminders, recurring schedules, heartbeat
//
// Three responsibilities:
//   1. Schedule store: CRUD for schedules, persists to JSON file
//   2. Scheduler loop: fires due schedules every 30s
//   3. Heartbeat timer: wakes agent every HEARTBEAT_INTERVAL
//
// Two schedule types:
//   - message: pre-composed text, delivered directly (no LLM)
//   - prompt:  sent to the agent at fire time; agent's response
//              is delivered to the channel (requires LLM call)
// ─────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ─── Schedule Store ──────────────────────────────────────────

class ScheduleStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.schedules = [];
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        this.schedules = JSON.parse(raw);
        console.log(`[scheduler] Loaded ${this.schedules.length} schedule(s) from ${this.filePath}`);
      }
    } catch (err) {
      console.error(`[scheduler] Failed to load schedules: ${err.message}`);
      this.schedules = [];
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.schedules, null, 2) + "\n");
    } catch (err) {
      console.error(`[scheduler] Failed to save schedules: ${err.message}`);
    }
  }

  create({ due, message, prompt, channel, repeat }) {
    const schedule = {
      id: "sch_" + crypto.randomBytes(6).toString("hex"),
      due,
      message: message || null,
      prompt: prompt || null,
      channel,
      status: "pending",
      repeat: repeat || null,
      created_at: new Date().toISOString(),
      delivered_at: null,
    };
    this.schedules.push(schedule);
    this._save();
    return schedule;
  }

  list(status) {
    if (status) return this.schedules.filter((s) => s.status === status);
    return this.schedules;
  }

  get(id) {
    return this.schedules.find((s) => s.id === id);
  }

  cancel(id) {
    const schedule = this.get(id);
    if (!schedule) return null;
    if (schedule.status !== "pending") return null;
    schedule.status = "cancelled";
    this._save();
    return schedule;
  }

  markDelivered(id) {
    const schedule = this.get(id);
    if (!schedule) return;
    schedule.status = "delivered";
    schedule.delivered_at = new Date().toISOString();
    this._save();
    return schedule;
  }

  getDue() {
    const now = new Date();
    return this.schedules.filter(
      (s) => s.status === "pending" && new Date(s.due) <= now
    );
  }
}

// ─── Recurring schedule helpers ──────────────────────────────

function computeNextOccurrence(due, repeat) {
  const d = new Date(due);

  switch (repeat) {
    case "daily":
      d.setDate(d.getDate() + 1);
      return d.toISOString();

    case "weekdays": {
      do {
        d.setDate(d.getDate() + 1);
      } while (d.getDay() === 0 || d.getDay() === 6); // skip Sat/Sun
      return d.toISOString();
    }

    case "weekly":
      d.setDate(d.getDate() + 7);
      return d.toISOString();

    case "monthly":
      d.setMonth(d.getMonth() + 1);
      return d.toISOString();

    default:
      // Cron expression — parse and compute next fire time
      if (typeof repeat === "string" && repeat.includes(" ")) {
        return computeNextCron(d, repeat);
      }
      return null;
  }
}

function computeNextCron(after, cronExpr) {
  // Simple cron parser: minute hour day-of-month month day-of-week
  // e.g., "0 7 * * 1-5" = 7:00 AM on weekdays
  try {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const [minSpec, hourSpec, , , dowSpec] = parts;

    const targetMin = minSpec === "*" ? 0 : parseInt(minSpec, 10);
    const targetHour = hourSpec === "*" ? 0 : parseInt(hourSpec, 10);

    // Parse day-of-week spec
    const allowedDays = parseDowSpec(dowSpec);

    // Start from the day after `after`, check up to 400 days out
    const candidate = new Date(after);
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(targetHour, targetMin, 0, 0);

    for (let i = 0; i < 400; i++) {
      if (allowedDays === null || allowedDays.includes(candidate.getDay())) {
        return candidate.toISOString();
      }
      candidate.setDate(candidate.getDate() + 1);
    }
    return null;
  } catch {
    return null;
  }
}

function parseDowSpec(spec) {
  if (spec === "*") return null; // any day
  const days = [];
  for (const part of spec.split(",")) {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      for (let d = start; d <= end; d++) days.push(d % 7);
    } else {
      days.push(parseInt(part, 10) % 7);
    }
  }
  return days;
}

// ─── Adapter Registry ────────────────────────────────────────

class AdapterRegistry {
  constructor() {
    this.adapters = {};
  }

  register(platform, sendFn) {
    this.adapters[platform] = sendFn;
    console.log(`[scheduler] Registered adapter: ${platform}`);
  }

  async deliver(channel, message) {
    const colonIdx = channel.indexOf(":");
    if (colonIdx === -1) {
      console.error(`[scheduler] Invalid channel format: ${channel}`);
      return false;
    }
    const platform = channel.substring(0, colonIdx);
    const id = channel.substring(colonIdx + 1);

    const sendFn = this.adapters[platform];
    if (!sendFn) {
      console.error(`[scheduler] No adapter for platform: ${platform}`);
      return false;
    }

    try {
      await sendFn(id, message);
      return true;
    } catch (err) {
      console.error(`[scheduler] Delivery failed to ${channel}: ${err.message}`);
      return false;
    }
  }
}

// ─── Scheduler (fires due schedules) ─────────────────────────

function startSchedulerLoop(store, registry, sendPromptFn, intervalMs = 30_000) {
  console.log(`[scheduler] Loop started (every ${intervalMs / 1000}s)`);

  const timer = setInterval(async () => {
    const due = store.getDue();
    if (due.length === 0) return;

    for (const schedule of due) {
      console.log(`[scheduler] Firing: ${schedule.id} → ${schedule.channel}${schedule.prompt ? " (prompt)" : ""}`);

      let deliveryMessage = schedule.message;

      // Prompt-based schedule: run the agent first, use its response
      if (schedule.prompt) {
        try {
          const sessionId = `schedule:${schedule.id}`;
          console.log(`[scheduler] Running agent prompt for ${schedule.id}...`);
          const agentResponse = await sendPromptFn(sessionId, schedule.prompt);

          if (agentResponse && agentResponse.trim().length > 0) {
            deliveryMessage = agentResponse;
            console.log(`[scheduler] Agent responded (${agentResponse.length} chars)`);
          } else {
            console.warn(`[scheduler] Agent returned empty response for ${schedule.id}`);
            if (!deliveryMessage) {
              console.warn(`[scheduler] No fallback message, skipping delivery`);
              store.markDelivered(schedule.id);
              handleRecurring(store, schedule);
              continue;
            }
          }
        } catch (err) {
          console.error(`[scheduler] Agent prompt failed for ${schedule.id}: ${err.message}`);
          if (!deliveryMessage) {
            console.error(`[scheduler] No fallback, will retry next loop`);
            continue;
          }
          console.log(`[scheduler] Falling back to pre-composed message`);
        }
      }

      const ok = await registry.deliver(schedule.channel, deliveryMessage);

      if (ok) {
        store.markDelivered(schedule.id);
        console.log(`[scheduler] Delivered: ${schedule.id}`);
        handleRecurring(store, schedule);
      } else {
        console.error(`[scheduler] Delivery failed for ${schedule.id}, will retry next loop`);
      }
    }
  }, intervalMs);

  return timer;
}

function handleRecurring(store, schedule) {
  if (!schedule.repeat) return;

  const nextDue = computeNextOccurrence(schedule.due, schedule.repeat);
  if (nextDue) {
    const next = store.create({
      due: nextDue,
      message: schedule.message,
      prompt: schedule.prompt,
      channel: schedule.channel,
      repeat: schedule.repeat,
    });
    console.log(`[scheduler] Recurring: next ${next.id} at ${nextDue}`);
  } else {
    console.warn(`[scheduler] Could not compute next occurrence for repeat="${schedule.repeat}"`);
  }
}


// ─── Heartbeat ───────────────────────────────────────────────

function parseInterval(str) {
  const match = (str || "15m").match(/^(\d+)(s|m|h)$/);
  if (!match) return 15 * 60 * 1000; // default 15 minutes
  const val = parseInt(match[1], 10);
  switch (match[2]) {
    case "s": return val * 1000;
    case "m": return val * 60 * 1000;
    case "h": return val * 60 * 60 * 1000;
    default:  return 15 * 60 * 1000;
  }
}

function parseActiveHours(str) {
  // "07:00-23:00" → { start: 7, end: 23 }
  const match = (str || "07:00-23:00").match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
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
  const intervalMs = parseInterval(options.interval || process.env.MOBYCLAW_HEARTBEAT_INTERVAL || "15m");
  const activeHours = parseActiveHours(options.activeHours || process.env.MOBYCLAW_ACTIVE_HOURS || "07:00-23:00");

  console.log(`[heartbeat] Interval: ${intervalMs / 1000}s, active hours: ${options.activeHours || process.env.MOBYCLAW_ACTIVE_HOURS || "07:00-23:00"}`);

  const timer = setInterval(async () => {
    if (!isWithinActiveHours(activeHours)) {
      return; // silent outside active hours
    }

    const now = new Date().toISOString();
    const known = channelStore.getAll();
    const defaultChannel = channelStore.getDefault();

    // Build channels section for the prompt
    let channelInfo = "";
    if (Object.keys(known).length > 0) {
      const entries = Object.entries(known).map(([p, ch]) => `  - ${p}: ${ch}`).join("\n");
      channelInfo = `\nKnown channels:\n${entries}\nDefault channel: ${defaultChannel}\n`;
    } else {
      channelInfo = "\nNo known channels yet (no messages received from any platform).\n";
    }

    const prompt =
      `[HEARTBEAT | time=${now}]\n` +
      `You are being woken by a scheduled heartbeat.\n` +
      channelInfo + `\n` +
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
        console.log(`[heartbeat] Agent response: ${(response || "").slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[heartbeat] Error: ${err.message}`);
    }
  }, intervalMs);

  return timer;
}

// ─── Channel Store ───────────────────────────────────────────
//
// Persists known messaging channels to channels.json.
// When a user first messages from Telegram (or any platform),
// the gateway saves that channel. This means:
//   - Schedules can default to the user's known channel
//   - Heartbeat knows where to deliver notifications
//   - Survives gateway restarts (file-based)
//   - Agent can read the file directly
//

class ChannelStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.channels = {};       // platform → channel string, e.g. { telegram: "telegram:123" }
    this.lastActive = null;   // most recent messaging channel (in-memory)
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        this.channels = JSON.parse(raw);
        console.log(`[channels] Loaded known channels:`, Object.keys(this.channels).join(", ") || "(none)");
      }
    } catch (err) {
      console.error(`[channels] Failed to load: ${err.message}`);
      this.channels = {};
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.channels, null, 2) + "\n");
    } catch (err) {
      console.error(`[channels] Failed to save: ${err.message}`);
    }
  }

  /**
   * Record a channel from an incoming message.
   * Only tracks real messaging channels (not api:, cli:, heartbeat:, schedule:).
   * For each platform, stores the FIRST channel seen — since this is a personal
   * agent, there's typically one chat per platform.
   */
  track(channelId) {
    if (!channelId) return;
    // Skip non-messaging channels
    if (/^(api|cli|heartbeat|schedule):/.test(channelId)) return;

    this.lastActive = channelId;

    const colonIdx = channelId.indexOf(":");
    if (colonIdx === -1) return;
    const platform = channelId.substring(0, colonIdx);

    if (!this.channels[platform]) {
      this.channels[platform] = channelId;
      this._save();
      console.log(`[channels] Saved new channel: ${platform} → ${channelId}`);
    } else if (this.channels[platform] !== channelId) {
      // Update if different chat (user switched groups, etc.)
      this.channels[platform] = channelId;
      this._save();
      console.log(`[channels] Updated channel: ${platform} → ${channelId}`);
    }
  }

  /** Get channel for a specific platform, e.g. "telegram" → "telegram:12345" */
  get(platform) {
    return this.channels[platform] || null;
  }

  /** Get all known channels as { platform: channelId } */
  getAll() {
    return { ...this.channels };
  }

  /** Get the best delivery channel — last active, or first known */
  getDefault() {
    if (this.lastActive) return this.lastActive;
    const keys = Object.keys(this.channels);
    return keys.length > 0 ? this.channels[keys[0]] : null;
  }
}

// ─── Exports ─────────────────────────────────────────────────

module.exports = {
  ScheduleStore,
  ChannelStore,
  AdapterRegistry,
  startSchedulerLoop,
  startHeartbeat,
  parseInterval,
  parseActiveHours,
};
