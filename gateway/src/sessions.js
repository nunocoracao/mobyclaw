// -----------------------------------------------------------------
// Session Store - single session architecture
//
// One cagent session shared across all channels (telegram, CLI,
// heartbeat, schedules). Messages are serialized through a FIFO
// queue. Session ID is persisted to disk so it survives restarts.
// -----------------------------------------------------------------

const fs = require("fs");
const path = require("path");

class SessionStore {
  constructor(persistPath) {
    this.persistPath = persistPath;
    this.sessionId = null;
    this.busy = false;
    this.queue = []; // [{ resolve, reject, channelId, message, callbacks }]

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
        JSON.stringify({ sessionId: this.sessionId, updated: new Date().toISOString() }, null, 2) + "\n"
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
    this._save();
  }

  // -- Busy / queue -------------------------------------------------

  isBusy() {
    return this.busy;
  }

  setBusy(busy) {
    this.busy = busy;
  }

  enqueue(channelId, message, callbacks = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, channelId, message, callbacks });
    });
  }

  dequeue() {
    if (this.queue.length === 0) return null;
    return this.queue.shift();
  }

  hasPending() {
    return this.queue.length > 0;
  }

  queueLength() {
    return this.queue.length;
  }
}

module.exports = { SessionStore };
