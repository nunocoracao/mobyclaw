// ─────────────────────────────────────────────────────────────
// Channel Store — persists known messaging channels
//
// When a user first messages from Telegram (or any platform),
// the gateway saves that channel. This means:
//   - Schedules can default to the user's known channel
//   - Heartbeat knows where to deliver notifications
//   - Survives gateway restarts (file-based)
//   - Agent can read the file directly
// ─────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

class ChannelStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.channels = {}; // platform → channel string, e.g. { telegram: "telegram:123" }
    this.lastActive = null; // most recent messaging channel (in-memory)
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        this.channels = JSON.parse(raw);
        console.log(
          `[channels] Loaded known channels:`,
          Object.keys(this.channels).join(", ") || "(none)"
        );
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
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(this.channels, null, 2) + "\n"
      );
    } catch (err) {
      console.error(`[channels] Failed to save: ${err.message}`);
    }
  }

  /**
   * Record a channel from an incoming message.
   * Only tracks real messaging channels (not api:, cli:, heartbeat:, schedule:).
   */
  track(channelId) {
    if (!channelId) return;
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
      this.channels[platform] = channelId;
      this._save();
      console.log(
        `[channels] Updated channel: ${platform} → ${channelId}`
      );
    }
  }

  /** Get channel for a specific platform */
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

module.exports = { ChannelStore };
