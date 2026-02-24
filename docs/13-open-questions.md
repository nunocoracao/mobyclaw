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
