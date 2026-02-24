## 11. Phased Roadmap

### Phase 1 — Agent in a Box ✅ COMPLETE

**Goal:** Run moby in a Docker container with persistent memory, interact via CLI.

Deliverables:
1. `agents/moby/soul.yaml` — Moby's personality, model, tools, behavior (all-in-one)
2. `Dockerfile` — Agent base image with cagent
3. `docker-compose.yml` — Single-service compose (moby only)
4. `mobyclaw` — CLI script (up, down, logs, status, run, chat)
5. `.env.example` — API key template
6. `README.md` — Getting started guide

### Phase 2 — Gateway + Messaging ✅ COMPLETE

**Goal:** Chat with moby through Telegram. Heartbeat, scheduling, and reminders working.

Deliverables:
- `gateway/` — Gateway container (message routing, sessions, scheduler)
- Telegram adapter with streaming responses and tool status indicators
- Heartbeat system (periodic agent wake-ups during active hours)
- Scheduler with reminders, recurring tasks, and prompt-based schedules
- Single session architecture with FIFO queue and disk persistence
- Telegram allowlist for user security
- Auto-backup to GitHub on a cron schedule

### Phase 2.5 — Session & Queue UX ✅ COMPLETE

**Goal:** Polished session management and user experience, inspired by OpenClaw patterns.

Deliverables:
- **Typing indicators**: Instant `sendChatAction('typing')` on message receipt, 4s refresh
- **Queue feedback**: Temporary "⏳ Queued" message when message is queued behind a running task
- **Collect queue mode**: Coalesces rapid queued messages into one combined turn (default)
- **Session lifecycle**: Daily reset at 4 AM, optional idle reset, /new + /reset commands
- **Debounce**: 1000ms debounce before draining collected messages
- **/stop command**: Abort current run + clear queue via Telegram or API
- **/status command**: Session info, queue length, uptime in Telegram

### Phase 2.7 — Tool Gateway ✅ COMPLETE

**Goal:** Agent can access external web services and a full headless browser via MCP.

Deliverables:
- **tool-gateway container**: Stateless MCP Streamable HTTP server with admin API
- **mcp-bridge**: Node.js stdio↔HTTP bridge connecting cagent to tool-gateway
- **3 lightweight tools**: `browser_fetch`, `browser_search`, `weather_get`
- **16 browser automation tools**: Full Playwright + Chromium headless browser
- **Snapshot trimming**: Tree-based compact mode — 98% reduction on real pages
- **Architecture doc**: `docs/14-tool-gateway.md` with full MCP design

### Phase 2.8 — Dashboard + Maintenance ✅ COMPLETE

**Goal:** Web dashboard for status, task management, and automated maintenance.

Deliverables:
- **dashboard container**: Python 3.11 HTTP server with SQLite task database
- **Web UI**: Status overview, task management, settings pages (with soul.yaml editor)
- **Task API**: Full CRUD REST API with history, priorities, tags, subtasks
- **Task dependency chains**: `depends_on` field with execution-time blocking (409 if deps unmet)
- **Auto-retry system**: Background thread retries failed tasks every 5 min (up to max_retries)
- **Manual retry**: `POST /api/tasks/:id/retry` endpoint
- **Personality tuning**: Read/write soul.yaml via API + settings page editor with backup
- **Conversation indexing**: Gateway auto-logs every turn; search, filter, stats endpoints
- **Lessons API**: Track lessons learned from experience (category, severity, auto-detect)
- **Memory compression**: Archive completed tasks from MEMORY.md to dated files
- **Self-healing boot**: Health checks and auto-fix on startup (`self-heal.sh`)
- **Boot context generation**: Compact BOOT.md from MEMORY.md (`generate-boot.sh`)
- **Cloudflare tunnel**: Optional remote dashboard access via trycloudflare.com
- **Repo monitoring**: GitHub activity checking script (`check-repos.sh`)
- **Code/data separation**: All code in repo (`/source/`), all user data in `~/.mobyclaw/`
- **Context window optimizer**: Smart context injection - scores MEMORY.md sections by relevance, keyword overlap, status, and recency; injects top sections within a token budget before each message reaches the agent

### Phase 2.9 — Session Stability + Agent Inner Life ✅ COMPLETE

**Goal:** Robust session management, agent continuity across resets, inner emotional life.

Deliverables:
- **Short-term memory (STM)**: Rolling buffer of last 20 exchanges, injected into new sessions
- **Context optimizer**: Smart context injection (memory sections, inner state, self-model, explorations)
- **Exploration heartbeats**: Every 4th heartbeat allows curiosity-driven web exploration
- **Inner state + journal**: Agent maintains `inner.json` (mood, energy, preoccupations) and `journal/` entries
- **Self-model**: Agent maintains `SELF.md` (who it thinks it is)
- **Session turn limit**: Auto-rotate after 80 exchanges to prevent history corruption
- **Stream error detection**: Detect corrupted sessions from SSE errors, auto-clear and retry
- **Heartbeat failure tracking**: Pause heartbeats after 2 consecutive failures, resume on session change
- **Double-processing fix**: Context fetch moved after `setBusy(true)` to eliminate race condition
- **Telegram dedup**: Track last 50 message_ids to prevent re-processing
- **Telegraf polling liveness**: Monitor and restart polling if it dies silently (5min threshold)
- **mcp-bridge improvements**: Connection retry (3 attempts), tool call timeout (120s), graceful shutdown

### Phase 3 — Read-Only Integrations 🔜 PLANNED

**Goal:** Agent can read from Slack, Notion, Gmail, and Google Calendar.

Full design document: [`docs/15-integrations.md`](15-integrations.md)

Deliverables:
- **Auth infrastructure**: Token store (encrypted), auth admin API, chat-mediated OAuth flow
- **Notion** (4 tools): `notion_search`, `notion_page`, `notion_database`, `notion_list`
- **Google** (7 tools): `gmail_inbox`, `gmail_read`, `gmail_search`, `gmail_labels`, `calendar_today`, `calendar_upcoming`, `calendar_search`
- **Slack** (4 tools): `slack_channels`, `slack_history`, `slack_search`, `slack_profile`
- **15 new MCP tools** (34 total)

Implementation order: Auth infra → Notion (simplest) → Google → Slack

### Phase 4 — Workspace + More Channels

**Goal:** Deeper workspace integration, more messaging channels.

Deliverables:
- More messaging adapters in gateway (Discord, WhatsApp, Slack)
- Vector memory search (semantic recall over memory files)
- Webhook ingress (GitHub events, etc.)
- Task tracking service integration (agent uses task API, not flat files)
- Conversation indexing integration (auto-log conversation summaries)

### Phase 5 — Production Hardening

**Goal:** Ready for real 24/7 workloads.

Deliverables:
- Security hardening (seccomp, read-only root, network policy)
- Monitoring and observability (logs, metrics, health checks)
- Session compaction (summarize old context)
- Auto memory flush before compaction
- Plugin/skill system
