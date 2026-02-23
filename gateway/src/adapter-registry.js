// ─────────────────────────────────────────────────────────────
// Adapter Registry — routes messages to platform adapters
//
// Each adapter registers a send function for its platform.
// The registry parses "platform:id" channel strings and
// dispatches to the right adapter.
// ─────────────────────────────────────────────────────────────

class AdapterRegistry {
  constructor() {
    this.adapters = {};
  }

  register(platform, sendFn) {
    this.adapters[platform] = sendFn;
    console.log(`[adapters] Registered: ${platform}`);
  }

  async deliver(channel, message) {
    const colonIdx = channel.indexOf(":");
    if (colonIdx === -1) {
      console.error(`[adapters] Invalid channel format: ${channel}`);
      return false;
    }
    const platform = channel.substring(0, colonIdx);
    const id = channel.substring(colonIdx + 1);

    const sendFn = this.adapters[platform];
    if (!sendFn) {
      console.error(`[adapters] No adapter for platform: ${platform}`);
      return false;
    }

    try {
      await sendFn(id, message);
      return true;
    } catch (err) {
      console.error(
        `[adapters] Delivery failed to ${channel}: ${err.message}`
      );
      return false;
    }
  }
}

module.exports = { AdapterRegistry };
