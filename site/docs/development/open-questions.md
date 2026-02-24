## 14. Open Questions

- ~~**cagent serve api exact endpoints**~~: **RESOLVED** — See §7.3.
- ~~**cagent session management**~~: **RESOLVED** — cagent manages sessions natively.
  Gateway only needs to track channelId → sessionId mapping.
- ~~**Gateway language**~~: **RESOLVED** — Node.js (JavaScript). Telegraf, express,
  and other messaging libraries are all JS. Works well.
- ~~**Health checks**~~: **RESOLVED** — `GET /api/ping` returns `{"status":"ok"}`.
  Used in Dockerfile HEALTHCHECK and gateway's `waitForReady()`.
- ~~**MCP stdio over network**~~: **RESOLVED — Not needed.** cagent built-in tools handle all file access via bind mounts.
- **Memory search**: Phase 2+ needs vector search over memory files. Options:
  embedded SQLite with vector extension, or a lightweight sidecar (Qdrant, Chroma).
- ~~**Hot reload**~~: **RESOLVED — No.** cagent does NOT hot-reload soul.yaml. Container restart required.
- ~~**Heartbeat in Phase 1**~~: **RESOLVED — Implemented in gateway.**
- ~~**Session lifecycle / unbounded growth**~~: **RESOLVED** — Daily reset (4 AM), idle reset (optional), /new command. Queue cap at 20 messages. Collect mode coalesces rapid messages.
- ~~**Queue overflow / user blocked during long tasks**~~: **RESOLVED** — Collect mode coalesces queued messages into one turn. Queue feedback shows "⏳ Queued" in Telegram. /stop aborts current run. Cap prevents unbounded growth.
- ~~**Typing indicators**~~: **RESOLVED** — Instant mode: `sendChatAction('typing')` on message receipt, 4s refresh.
- **Block streaming / chunking**: Long responses could benefit from OpenClaw-style paragraph-aware chunking. Currently we do simple progressive edit. Not urgent — most responses are <4096 chars.
- **Context compaction**: cagent sessions grow unbounded within a session. No compaction mechanism yet. Daily reset is the current workaround. Could add `/compact` command that triggers a summary turn.
- **Multi-user DM isolation**: Currently single-user assumption (one person talks to the bot). If multiple users message, they share context. Would need per-user sessions like OpenClaw's `dmScope: per-channel-peer`.
