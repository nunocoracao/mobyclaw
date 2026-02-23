// ─────────────────────────────────────────────────────────────
// Session Store — maps channels to cagent sessions
//
// Each channel (e.g., "telegram:12345") maps to a cagent
// session ID. The actual conversation history is managed by
// cagent server-side — we just need to track the mapping.
//
// Sessions also have a "busy" flag to prevent concurrent
// requests to the same cagent session (which would cause one
// to hang until the other finishes).
// ─────────────────────────────────────────────────────────────

class SessionStore {
  constructor() {
    // channelId -> { sessionId: string, busy: boolean }
    this.sessions = new Map();
    // channelId -> { sessionId: string, busy: boolean }  (overflow)
    this.overflow = new Map();
    // channelId -> [{ resolve, reject, message }]
    this.queues = new Map();
  }

  /**
   * Get the cagent session ID for a channel, or null if none exists
   */
  getSessionId(channelId) {
    const entry = this.sessions.get(channelId);
    return entry ? entry.sessionId : null;
  }

  /**
   * Store a cagent session ID for a channel
   */
  setSessionId(channelId, sessionId) {
    this.sessions.set(channelId, { sessionId, busy: false });
  }

  /**
   * Check if a session is currently busy (processing a request)
   */
  isBusy(channelId) {
    const entry = this.sessions.get(channelId);
    return entry ? entry.busy : false;
  }

  /**
   * Mark a session as busy/free
   */
  setBusy(channelId, busy) {
    const entry = this.sessions.get(channelId);
    if (entry) {
      entry.busy = busy;
    }
  }

  /**
   * Clear a channel's session (forces a new session on next message)
   */
  clear(channelId) {
    this.sessions.delete(channelId);
    // Don't clear queue — pending messages will get a fresh session
  }

  /**
   * Get number of active sessions
   */
  count() {
    return this.sessions.size;
  }

  // ── Overflow sessions ───────────────────────────────────
  // Used when primary is busy and a new message arrives.
  // Gives the user a parallel "fresh Moby" to talk to.

  getOverflowSessionId(channelId) {
    const entry = this.overflow.get(channelId);
    return entry ? entry.sessionId : null;
  }

  setOverflowSessionId(channelId, sessionId) {
    this.overflow.set(channelId, { sessionId, busy: false });
  }

  isOverflowBusy(channelId) {
    const entry = this.overflow.get(channelId);
    return entry ? entry.busy : false;
  }

  setOverflowBusy(channelId, busy) {
    const entry = this.overflow.get(channelId);
    if (entry) entry.busy = busy;
  }

  clearOverflow(channelId) {
    this.overflow.delete(channelId);
  }

  /**
   * Enqueue a message for a channel. Returns a promise that resolves
   * when the message has been processed.
   */
  enqueue(channelId, message, callbacks = {}) {
    return new Promise((resolve, reject) => {
      if (!this.queues.has(channelId)) {
        this.queues.set(channelId, []);
      }
      this.queues.get(channelId).push({ resolve, reject, message, callbacks });
    });
  }

  /**
   * Dequeue the next pending message for a channel, or null if empty.
   */
  dequeue(channelId) {
    const queue = this.queues.get(channelId);
    if (!queue || queue.length === 0) return null;
    return queue.shift();
  }

  /**
   * Check if there are pending messages for a channel
   */
  hasPending(channelId) {
    const queue = this.queues.get(channelId);
    return queue && queue.length > 0;
  }
}

module.exports = { SessionStore };
