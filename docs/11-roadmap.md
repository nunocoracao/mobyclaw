## 12. Phased Roadmap

### Phase 1 — Agent in a Box ✅ COMPLETE

**Goal:** Run moby in a Docker container with persistent memory, interact via CLI.

Deliverables:
1. `agents/moby/soul.yaml` — Moby's personality, model, tools, behavior (all-in-one)
3. `Dockerfile` — Agent base image with cagent
4. `docker-compose.yml` — Single-service compose (moby only)
5. `mobyclaw` — CLI script (up, down, logs, status, run, chat)
6. `.env.example` — API key template
7. `README.md` — Getting started guide

Success criteria:
- `mobyclaw up` starts moby in a container (long-lived, always running)
- `mobyclaw up` on a fresh machine walks through interactive setup first
- `mobyclaw run "Hello, who are you?"` gets a personality-rich response
- `mobyclaw run "Remember that my name is Alice"` → agent writes to `~/.mobyclaw/MEMORY.md`
- `mobyclaw run "What's my name?"` → agent recalls from MEMORY.md
- `mobyclaw chat` opens an interactive session
- Memory persists across `mobyclaw down && mobyclaw up`

### Phase 2 — Gateway + Messaging ✅ COMPLETE

**Goal:** Chat with moby through Telegram. Heartbeat and cron working.

Deliverables:
- `gateway/` — Gateway container (message routing, sessions, scheduler)
- Messaging adapters (Telegram first, then WhatsApp, Discord, Slack)
- Heartbeat system (periodic agent wake-ups)
- Cron job system (scheduled tasks)
- Session management (conversation threads per user/channel)
- Updated docker-compose.yml with gateway service
- `mobyclaw channels` and `mobyclaw cron` CLI commands

Success criteria:
- Send a Telegram message → get a response from moby
- Moby remembers conversations across Telegram messages
- Heartbeat fires every 30m, moby checks HEARTBEAT.md
- Cron job sends a daily morning summary to Telegram
- `mobyclaw status` shows connected channels

### Phase 3 — Workspace + Integrations

**Goal:** Agent can access local files. More messaging channels.

Deliverables:
- Workspace service (local filesystem mounts, MCP server)
- More messaging adapters in gateway (WhatsApp, Discord, Slack)
- Vector memory search (semantic recall over memory files)
- Webhook ingress (GitHub events, etc.)
- Web UI for management and chat

### Phase 4 — Production Hardening

**Goal:** Ready for real 24/7 workloads.

Deliverables:
- Security hardening (seccomp, read-only root, network policy)
- Monitoring and observability (logs, metrics, health checks)
- Session compaction (summarize old context)
- Auto memory flush before compaction
- Plugin/skill system
