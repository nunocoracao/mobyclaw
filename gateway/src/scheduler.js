// ─────────────────────────────────────────────────────────────
// Scheduler — timed reminders and recurring schedules
//
// Two responsibilities:
//   1. Schedule store: CRUD for schedules, persists to JSON file
//   2. Scheduler loop: fires due schedules every N seconds
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
        const all = JSON.parse(raw);
        this.schedules = all.filter((s) => s.status === "pending");
        const pruned = all.length - this.schedules.length;
        console.log(
          `[scheduler] Loaded ${this.schedules.length} pending schedule(s)` +
            `${pruned > 0 ? ` (pruned ${pruned} old)` : ""}`
        );
        if (pruned > 0) this._save();
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
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(this.schedules, null, 2) + "\n"
      );
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
    const idx = this.schedules.findIndex(
      (s) => s.id === id && s.status === "pending"
    );
    if (idx === -1) return null;
    const [schedule] = this.schedules.splice(idx, 1);
    schedule.status = "cancelled";
    this._save();
    return schedule;
  }

  markDelivered(id) {
    const idx = this.schedules.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const [schedule] = this.schedules.splice(idx, 1);
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
      } while (d.getDay() === 0 || d.getDay() === 6);
      return d.toISOString();
    }

    case "weekly":
      d.setDate(d.getDate() + 7);
      return d.toISOString();

    case "monthly":
      d.setMonth(d.getMonth() + 1);
      return d.toISOString();

    default:
      if (typeof repeat === "string" && repeat.includes(" ")) {
        return computeNextCron(d, repeat);
      }
      return null;
  }
}

function computeNextCron(after, cronExpr) {
  try {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const [minSpec, hourSpec, , , dowSpec] = parts;
    const targetMin = minSpec === "*" ? 0 : parseInt(minSpec, 10);
    const targetHour = hourSpec === "*" ? 0 : parseInt(hourSpec, 10);
    const allowedDays = parseDowSpec(dowSpec);

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
  if (spec === "*") return null;
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

// ─── Scheduler Loop ──────────────────────────────────────────

function startSchedulerLoop(
  store,
  registry,
  sendPromptFn,
  intervalMs = 30_000
) {
  console.log(`[scheduler] Loop started (every ${intervalMs / 1000}s)`);

  const timer = setInterval(async () => {
    const due = store.getDue();
    if (due.length === 0) return;

    for (const schedule of due) {
      console.log(
        `[scheduler] Firing: ${schedule.id} → ${schedule.channel}` +
          `${schedule.prompt ? " (prompt)" : ""}`
      );

      let deliveryMessage = schedule.message;

      // Prompt-based: run the agent, use its response
      if (schedule.prompt) {
        try {
          const sessionId = `schedule:${schedule.id}`;
          console.log(
            `[scheduler] Running agent prompt for ${schedule.id}...`
          );
          const agentResponse = await sendPromptFn(sessionId, schedule.prompt);

          if (agentResponse && agentResponse.trim().length > 0) {
            deliveryMessage = agentResponse;
            console.log(
              `[scheduler] Agent responded (${agentResponse.length} chars)`
            );
          } else {
            console.warn(
              `[scheduler] Agent returned empty response for ${schedule.id}`
            );
            if (!deliveryMessage) {
              console.warn(`[scheduler] No fallback message, skipping delivery`);
              store.markDelivered(schedule.id);
              handleRecurring(store, schedule);
              continue;
            }
          }
        } catch (err) {
          console.error(
            `[scheduler] Agent prompt failed for ${schedule.id}: ${err.message}`
          );
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
        console.error(
          `[scheduler] Delivery failed for ${schedule.id}, will retry next loop`
        );
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
    console.warn(
      `[scheduler] Could not compute next occurrence for repeat="${schedule.repeat}"`
    );
  }
}

// ─── Exports ─────────────────────────────────────────────────

module.exports = { ScheduleStore, startSchedulerLoop };
