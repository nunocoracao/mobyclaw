// -----------------------------------------------------------------
// Session Store — single session with queue modes
//
// One cagent session shared across all channels (telegram, CLI,
// heartbeat, schedules). Messages are serialized through a FIFO
// queue.
//
// Queue modes (inspired by OpenClaw):
//   - collect (default): coalesce rapid messages into one turn
//   - followup: each queued message becomes a separate turn
//
// Session lifecycle:
//   - Daily reset at configurable hour (default 4 AM)
//   - Idle reset after configurable minutes (optional)
//   - /new or /reset commands force a fresh session
//   - Session maintenance prunes stale data on write
// -----------------------------------------------------------------

const fs = require("fs");
const path = require("path");

class SessionStore {
  constructor(persistPath, config = {}) {
    this.persistPath = persistPath;
    this.sessionId = null;
    this.busy = false;
    this.queue = []; // [{ resolve, reject, channelId, message, callbacks, enqueuedAt }]
    this.lastActivity = null; // ISO timestamp of last message sent to agent

    // Queue config
    this.queueMode = config.queueMode || "collect";
    this.debounceMs = config.debounceMs ?? 1000;
    this.maxQueueSize = config.maxQueueSize ?? 20;
    this._debounceTimer = null;

    // Session lifecycle
    this.dailyResetHour = config.dailyResetHour ?? 4; // 4 AM
    this.idleResetMinutes = config.idleResetMinutes ?? null; // null = disabled
    this.maxTurns = config.maxTurns ?? 80; // auto-rotate after N exchanges
    this.turnCount = 0;
    this.lastResetAt = null; // ISO timestamp

    // Abort support
    this._currentAbortController = null;

    // Short-term memory: track when a new session starts
    // so we can inject recent history on the first message
    this._sessionIsNew = false;

    this._load();
  }

  // -- Persistence --------------------------------------------------

  _load() {
    try {
      if (this.persistPath && fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, "utf-8");
        const data = JSON.parse(raw);
        if (data.sessionId) {
          this.sessionId = data.sessionId;
          this.lastActivity = data.lastActivity || null;
          this.lastResetAt = data.lastResetAt || null;
          console.log(`[session] Restored session: ${this.sessionId}`);
        }
      }
    } catch (err) {
      console.error(`[session] Failed to load persisted session: ${err.message}`);
    }
  }

  _save() {
    try {
      if (!this.persistPath) return;
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        this.persistPath,
        JSON.stringify(
          {
            sessionId: this.sessionId,
            lastActivity: this.lastActivity,
            lastResetAt: this.lastResetAt,
            updated: new Date().toISOString(),
          },
          null,
          2
        ) + "\n"
      );
    } catch (err) {
      console.error(`[session] Failed to persist session: ${err.message}`);
    }
  }

  // -- Session ID ---------------------------------------------------

  getSessionId() {
    return this.sessionId;
  }

  setSessionId(id) {
    this.sessionId = id;
    this._save();
  }

  clear() {
    this.sessionId = null;
    this.turnCount = 0;
    this.lastResetAt = new Date().toISOString();
    this._sessionIsNew = true; // next message should get STM injection
    this._save();
  }

  touchActivity() {
    this.lastActivity = new Date().toISOString();
    this.turnCount++;
    this._save();
  }

  // -- Session lifecycle checks ------------------------------------

  /**
   * Check if the session should be reset based on daily/idle rules.
   * Returns true if session should be refreshed.
   */
  shouldReset() {
    if (!this.sessionId) return false;

    // Turn limit — prevent sessions from growing too large
    if (this.maxTurns && this.turnCount >= this.maxTurns) {
      console.log(`[session] Turn limit reset (${this.turnCount}/${this.maxTurns} turns)`);
      return true;
    }

    // Daily reset check
    if (this.dailyResetHour !== null) {
      const now = new Date();
      const today = new Date(now);
      today.setHours(this.dailyResetHour, 0, 0, 0);

      // If reset time has passed today and last activity was before reset time
      if (now >= today && this.lastActivity) {
        const lastAct = new Date(this.lastActivity);
        if (lastAct < today) {
          console.log(`[session] Daily reset triggered (${this.dailyResetHour}:00)`);
          return true;
        }
      }
    }

    // Idle reset check
    if (this.idleResetMinutes && this.lastActivity) {
      const idleMs = Date.now() - new Date(this.lastActivity).getTime();
      const limitMs = this.idleResetMinutes * 60 * 1000;
      if (idleMs > limitMs) {
        console.log(`[session] Idle reset triggered (${this.idleResetMinutes}m idle)`);
        return true;
      }
    }

    return false;
  }

  // -- Busy / queue -------------------------------------------------

  isBusy() {
    return this.busy;
  }

  setBusy(busy) {
    this.busy = busy;
    if (busy) {
      this._busySince = Date.now();
    } else {
      this._busySince = null;
    }
  }

  /**
   * Safety watchdog: if busy for longer than maxMs, auto-clear.
   * This catches cases where the agent connection dies silently
   * (e.g., container restart without TCP RST) and the busy flag
   * gets stuck. Called periodically from a timer.
   */
  checkBusyWatchdog(maxMs = 10 * 60 * 1000) {
    if (!this.busy || !this._busySince) return false;
    if (Date.now() - this._busySince > maxMs) {
      console.error(
        `[session] WATCHDOG: busy for ${Math.round((Date.now() - this._busySince) / 1000)}s — force-clearing`
      );
      this.busy = false;
      this._busySince = null;
      return true; // was stuck
    }
    return false;
  }

  /**
   * Enqueue a message. Returns a promise that resolves when the message
   * is processed. In 'collect' mode, rapid messages may be coalesced.
   */
  enqueue(channelId, message, callbacks = {}) {
    return new Promise((resolve, reject) => {
      // Enforce queue cap
      if (this.queue.length >= this.maxQueueSize) {
        console.warn(`[session] Queue full (${this.maxQueueSize}), dropping oldest`);
        const dropped = this.queue.shift();
        dropped.reject(new Error("Dropped from queue (overflow)"));
      }

      this.queue.push({
        resolve,
        reject,
        channelId,
        message,
        callbacks,
        enqueuedAt: Date.now(),
      });
    });
  }

  /**
   * Dequeue the next message(s). In collect mode, coalesces queued
   * messages from the same channel into one combined message.
   */
  dequeue() {
    if (this.queue.length === 0) return null;

    if (this.queueMode === "collect" && this.queue.length > 1) {
      return this._dequeueCollected();
    }

    return this.queue.shift();
  }

  /**
   * Collect mode: merge all queued messages into one combined turn.
   * Multiple resolvers are tracked so all promises complete.
   */
  _dequeueCollected() {
    const items = this.queue.splice(0, this.queue.length);

    // Group by channel, take the last one's callbacks (most recent)
    const messages = items.map((i) => i.message);
    const combined = messages.join("\n\n---\n\n");
    const primaryChannel = items[items.length - 1].channelId;
    const primaryCallbacks = items[items.length - 1].callbacks;

    console.log(
      `[session] Collected ${items.length} queued messages into one turn`
    );

    // Return a combined entry where resolve/reject fan out to all items
    return {
      channelId: primaryChannel,
      message: `[${items.length} messages were queued while you were busy. Here they are combined:]\n\n${combined}`,
      callbacks: primaryCallbacks,
      resolve(response) {
        for (const item of items) item.resolve(response);
      },
      reject(err) {
        for (const item of items) item.reject(err);
      },
    };
  }

  hasPending() {
    return this.queue.length > 0;
  }

  queueLength() {
    return this.queue.length;
  }

  /**
   * Clear all queued messages (used by /stop).
   * Returns the number of cleared items.
   */
  clearQueue() {
    const count = this.queue.length;
    for (const item of this.queue) {
      item.reject(new Error("Queue cleared by /stop"));
    }
    this.queue = [];
    return count;
  }

  // -- Abort support -----------------------------------------------

  setAbortController(ctrl) {
    this._currentAbortController = ctrl;
  }

  getAbortController() {
    return this._currentAbortController;
  }

  clearAbortController() {
    this._currentAbortController = null;
  }

  // -- Short-term memory flag -----------------------------------

  /**
   * Check if this is a fresh session that needs STM injection.
   * Consuming: returns true once, then resets the flag.
   */
  consumeNewSessionFlag() {
    if (this._sessionIsNew) {
      this._sessionIsNew = false;
      return true;
    }
    return false;
  }

  isNewSession() {
    return this._sessionIsNew;
  }
}

module.exports = { SessionStore };
