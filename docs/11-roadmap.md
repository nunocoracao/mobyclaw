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

### Phase 2.5 - Session & Queue UX (OpenClaw-inspired) ✅ COMPLETE

**Goal:** Polished session management and user experience, inspired by OpenClaw patterns.

Deliverables:
- **Typing indicators**: Instant `sendChatAction('typing')` on message receipt, 4s refresh
- **Queue feedback**: Temporary "⏳ Queued" message in Telegram when message is queued
- **Collect queue mode**: Coalesces rapid queued messages into one combined turn (default)
- **Session lifecycle**: Daily reset at 4 AM, optional idle reset, /new + /reset commands
- **Queue cap**: Max 20 messages with oldest-drop overflow policy
- **Debounce**: 1000ms debounce before draining collected messages
- **/stop command**: Abort current run + clear queue via Telegram or API
- **/status command**: Session info, queue length, uptime in Telegram
- **SSE queued event**: Streaming endpoint emits `queued` event for programmatic clients

Success criteria:
- User sees typing indicator immediately when sending a message
- User sees feedback when message is queued behind a running task
- Rapid "continue, continue" messages are coalesced into one turn
- Sessions reset daily at 4 AM (fresh context each day)
- /stop aborts long-running tasks without restarting the agent
- /new starts a fresh conversation

### Phase 2.7 - Tool Gateway ✅ COMPLETE

**Goal:** Agent can access external web services (search, fetch, weather) via MCP tool gateway.

Deliverables:
- **tool-gateway container**: Stateless MCP Streamable HTTP server with admin API
- **mcp-bridge**: Node.js stdio↔HTTP bridge connecting cagent to tool-gateway
- **browser_fetch tool**: Fetch URL → clean readable text (Readability extraction)
- **browser_search tool**: Web search via DuckDuckGo HTML lite
- **weather_get tool**: Current weather + forecast via Open-Meteo (free, no API key)
- **Zod schemas**: All tool definitions use proper Zod types (MCP SDK v1.27.0 requirement)
- **Architecture doc**: `docs/14-tool-gateway.md` with full design for future OAuth/service integrations

Success criteria:
- `weather_get` returns current weather for any city via API and Telegram ✅
- `browser_search` returns DuckDuckGo results ✅
- `browser_fetch` extracts readable text from web pages ✅
- Tools discoverable by cagent through MCP bridge (stdio) ✅
- Tool-gateway runs in separate container with independent health checks ✅
- Agent can chain tools (search → fetch → summarize) ✅
- **Full headless browser** — Playwright + Chromium in tool-gateway ✅
- Agent can navigate pages, see accessibility snapshots with element refs ✅
- Agent can fill forms, click buttons, submit multi-step flows ✅
- Agent can take screenshots for visual verification ✅
- 19 tools total (3 lightweight + 16 browser automation) ✅
- **Snapshot trimming** — tree-based compact mode: HN 59KB→1.4KB (98%), GitHub 53KB→5KB (91%) ✅
- `browser_snapshot` accepts `full=true` for complete accessibility tree when needed ✅

### Phase 3 - Read-Only Integrations 🔜 PLANNED

**Goal:** Agent can read from Slack, Notion, Gmail, and Google Calendar.

Full design document: [`docs/15-integrations.md`](15-integrations.md)

Deliverables:
- **Auth infrastructure**: Token store (encrypted), auth admin API endpoints, chat-mediated OAuth flow
- **Notion** (4 tools): `notion_search`, `notion_page`, `notion_database`, `notion_list` — internal integration token (API key)
- **Google** (7 tools): `gmail_inbox`, `gmail_read`, `gmail_search`, `gmail_labels`, `calendar_today`, `calendar_upcoming`, `calendar_search` — OAuth 2.0 (shared project for Gmail + Calendar)
- **Slack** (4 tools): `slack_channels`, `slack_history`, `slack_search`, `slack_profile` — OAuth 2.0 User Token
- **Soul.yaml**: Integration tool descriptions, "connect {service}" conversational flow
- **15 new MCP tools** (34 total)

Implementation order: Auth infra → Notion (simplest) → Google → Slack

Success criteria:
- User says "connect notion" → pastes token → Moby confirms connection
- User says "connect google" → clicks OAuth link → authorizes → Moby confirms
- Moby can search Notion, read pages, query databases
- Moby can check inbox, read emails, summarize threads
- Moby can check today's calendar, upcoming events, find meeting times
- Moby can list Slack channels, read history, search messages
- All tokens encrypted at rest
- All access is read-only (no write scopes)

### Phase 4 - Workspace + More Channels

**Goal:** Agent can access local files. More messaging channels.

Deliverables:
- More messaging adapters in gateway (Discord, etc.)
- Vector memory search (semantic recall over memory files)
- Webhook ingress (GitHub events, etc.)
- Web UI for management and chat

### Phase 5 - Production Hardening

**Goal:** Ready for real 24/7 workloads.

Deliverables:
- Security hardening (seccomp, read-only root, network policy)
- Monitoring and observability (logs, metrics, health checks)
- Session compaction (summarize old context)
- Auto memory flush before compaction
- Plugin/skill system
