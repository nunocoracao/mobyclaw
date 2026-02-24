## 12. Phased Roadmap

### Phase 1 - Agent in a Box ✅ COMPLETE

**Goal:** Run moby in a Docker container with persistent memory, interact via CLI.

Deliverables:
1. `agents/moby/soul.yaml` - Moby's personality, model, tools, behavior (all-in-one)
3. `Dockerfile` - Agent base image with cagent
4. `docker-compose.yml` - Single-service compose (moby only)
5. `mobyclaw` - CLI script (up, down, logs, status, run, chat)
6. `.env.example` - API key template
7. `README.md` - Getting started guide

Success criteria:
- `./mobyclaw up` starts moby in a container (long-lived, always running)
- `./mobyclaw up` on a fresh machine walks through interactive setup first
- `./mobyclaw run "Hello, who are you?"` gets a personality-rich response
- `./mobyclaw run "Remember that my name is Alice"` → agent writes to `~/.mobyclaw/MEMORY.md`
- `./mobyclaw run "What's my name?"` → agent recalls from MEMORY.md
- `./mobyclaw chat` opens an interactive session
- Memory persists across `./mobyclaw down && ./mobyclaw up`

### Phase 2 - Gateway + Messaging ✅ COMPLETE

**Goal:** Chat with moby through Telegram. Heartbeat, scheduling, and reminders working.

Deliverables:
- `gateway/` - Gateway container (message routing, sessions, scheduler)
- Telegram adapter with streaming responses and tool status indicators
- Heartbeat system (periodic agent wake-ups during active hours)
- Scheduler with reminders, recurring tasks, and prompt-based schedules
- Single session architecture with FIFO queue and disk persistence
- Telegram allowlist for user security
- Auto-backup to GitHub on a cron schedule
- Updated docker-compose.yml with gateway service
- `./mobyclaw workspace` and credential management CLI commands

Success criteria:
- Send a Telegram message → get a streaming response from moby
- Moby remembers conversations across Telegram messages
- Heartbeat fires during active hours, moby checks HEARTBEAT.md
- Scheduled reminders deliver at the right time via Telegram
- Recurring tasks (daily briefings, periodic backups) run reliably
- `./mobyclaw status` shows connected channels

### Phase 3 - Workspace + Integrations

**Goal:** Agent can access local files. More messaging channels.

Deliverables:
- More messaging adapters in gateway (WhatsApp, Discord, Slack)
- Vector memory search (semantic recall over memory files)
- Webhook ingress (GitHub events, etc.)
- Web UI for management and chat

### Phase 4 - Production Hardening

**Goal:** Ready for real 24/7 workloads.

Deliverables:
- Security hardening (seccomp, read-only root, network policy)
- Monitoring and observability (logs, metrics, health checks)
- Session compaction (summarize old context)
- Auto memory flush before compaction
- Plugin/skill system
