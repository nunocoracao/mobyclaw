## Phased Roadmap

### Phase 1 — Agent in a Box ✅ COMPLETE

**Goal:** Run moby in a Docker container with persistent memory, interact via CLI.

- `agents/moby/soul.yaml` — Moby's personality, model, tools, behavior
- `Dockerfile` — Agent base image with cagent
- `docker-compose.yml` — Compose manifest
- `mobyclaw` — CLI script (up, down, logs, status, run, chat)
- Persistent memory in `~/.mobyclaw/` (MEMORY.md, daily logs)

### Phase 2 — Gateway + Messaging ✅ COMPLETE

**Goal:** Chat with moby through Telegram. Heartbeat, scheduling, and reminders working.

- `gateway/` — Gateway container (message routing, sessions, scheduler)
- Telegram adapter with streaming responses and tool status indicators
- Heartbeat system (periodic agent wake-ups during active hours)
- Scheduler with reminders, recurring tasks, and prompt-based schedules
- Single session architecture with FIFO queue and disk persistence
- Auto-backup to GitHub on a cron schedule

### Phase 2.5 — Session & Queue UX ✅ COMPLETE

**Goal:** Polished session management inspired by OpenClaw patterns.

- Collect queue mode (coalesces rapid messages into one turn)
- Typing indicators and queue feedback in Telegram
- /stop, /new, /reset, /clear, /status commands
- Daily session reset at 4 AM, debounce, queue cap (20)
- SSE `queued` event for programmatic clients

### Phase 2.7 — Tool Gateway ✅ COMPLETE

**Goal:** Agent can access external web services and automate browser interactions.

- **tool-gateway container**: Stateless MCP Streamable HTTP server + admin API
- **mcp-bridge**: Node.js stdio↔HTTP bridge connecting cagent to tool-gateway
- **19 MCP tools total:**
    - `browser_fetch` — clean text extraction from any URL
    - `browser_search` — web search via DuckDuckGo
    - `weather_get` — current weather + forecast (Open-Meteo, free)
    - 16 **browser automation** tools (Playwright + Chromium):
      `browser_navigate`, `browser_snapshot`, `browser_screenshot`,
      `browser_click`, `browser_type`, `browser_fill_form`,
      `browser_select_option`, `browser_hover`, `browser_press_key`,
      `browser_scroll`, `browser_back`, `browser_forward`,
      `browser_wait`, `browser_tabs`, `browser_close`, `browser_eval`
- Accessibility snapshots with aria-ref element targeting
- Persistent browser context with 10min idle auto-close

### Phase 2.8 — Dashboard + Maintenance ✅ COMPLETE

**Goal:** Web dashboard for status, task management, and automated maintenance.

- **dashboard container**: Python 3.11 HTTP server with SQLite task database
- **Web UI**: Status overview, task management, settings pages (with soul.yaml editor)
- **Task API**: Full CRUD REST API with history, priorities, tags
- **Task dependency chains**: `depends_on` field with execution-time blocking (409 if deps unmet)
- **Auto-retry system**: Background thread retries failed tasks every 5 min (up to max_retries)
- **Personality tuning**: Read/write soul.yaml via API + settings page editor
- **Conversation indexing**: Gateway auto-logs every turn; search, filter, stats endpoints
- **Lessons API**: Track lessons learned from experience (category, severity)
- **Memory compression**: Archive completed tasks from MEMORY.md to dated files
- **Self-healing boot**: Health checks and auto-fix on startup (`self-heal.sh`)
- **Cloudflare tunnel**: Optional remote dashboard access via trycloudflare.com
- **Context window optimizer**: Smart context injection - scores MEMORY.md sections by relevance and injects top sections within a token budget before each message

### Phase 2.9 — Session Stability + Agent Inner Life ✅ COMPLETE

**Goal:** Robust session management, agent continuity across resets, inner emotional life.

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

### Phase 2.9.1 — Dashboard + Tunnel Polish ✅ COMPLETE

**Goal:** Agent self-service for tunnel management, dashboard API completeness.

- **Agent-controlled tunnel start**: `POST /api/tunnel/start` - agent can start Cloudflare tunnel without host access. Delivers URL via Telegram automatically.
- **Full dashboard API reference**: All GET/POST/PUT endpoints documented
- **Tunnel status endpoint**: `GET /api/tunnel` returns current URL, PID, and start time

### Phase 3 — Read-Only Integrations 🔜 PLANNED

**Goal:** Agent can read from Slack, Notion, Gmail, and Google Calendar.

- **Auth infrastructure**: Token store (encrypted), auth admin API, chat-mediated OAuth flow
- **Notion** (4 tools): `notion_search`, `notion_page`, `notion_database`, `notion_list`
- **Google** (7 tools): `gmail_inbox`, `gmail_read`, `gmail_search`, `gmail_labels`, `calendar_today`, `calendar_upcoming`, `calendar_search`
- **Slack** (4 tools): `slack_channels`, `slack_history`, `slack_search`, `slack_profile`
- **15 new MCP tools** (34 total)

### Phase 4 — Workspace + More Channels

**Goal:** Deeper workspace integration, more messaging channels.

- More messaging adapters (Discord, WhatsApp, Slack)
- Vector memory search (semantic recall over memory files)
- Webhook ingress (GitHub events, etc.)
- Conversation summarization and session compaction

### Phase 5 — Production Hardening

**Goal:** Ready for real 24/7 workloads.

- Security hardening (seccomp, read-only root, network policy)
- Monitoring and observability (logs, metrics, health checks)
- Session compaction (summarize old context)
- Plugin/skill system
