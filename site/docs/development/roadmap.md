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

### Phase 3 — Workspace + Integrations

**Goal:** More messaging channels, integrations, and intelligence.

- More messaging adapters (WhatsApp, Discord, Slack)
- Notion integration via MCP (OAuth 2.0 + PKCE, chat-mediated auth)
- Vector memory search (semantic recall over memory files)
- Webhook ingress (GitHub events, etc.)
- Web UI for management and chat

### Phase 4 — Production Hardening

**Goal:** Ready for real 24/7 workloads.

- Security hardening (seccomp, read-only root, network policy)
- Monitoring and observability (logs, metrics, health checks)
- Session compaction (summarize old context)
- Auto memory flush before compaction
- Plugin/skill system
