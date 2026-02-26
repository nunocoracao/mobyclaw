## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Host Machine                                  │
│                                                                       │
│  ┌────────────┐                                                       │
│  │ mobyclaw   │── docker compose up/down/logs/run ──┐                │
│  │ CLI        │                                       │                │
│  └────────────┘                                       ▼                │
│  ┌───────────────────────────────────────────────────────────────────┐│
│  │                     Docker Compose Stack                           ││
│  │                     (mobyclaw network)                              ││
│  │                                                                    ││
│  │  ┌────────────────────────────────┐                                ││
│  │  │            gateway             │                                ││
│  │  │     (orchestrator container)   │                                ││
│  │  │                                │                                ││
│  │  │  ┌──────────┐  ┌───────────┐  │                                ││
│  │  │  │ Messaging │  │ Session   │  │                                ││
│  │  │  │ Adapters  │  │ Store +   │  │                                ││
│  │  │  │ (Telegram)│  │ Queue     │  │                                ││
│  │  │  └──────────┘  └───────────┘  │                                ││
│  │  │  ┌──────────┐  ┌───────────┐  │                                ││
│  │  │  │ Scheduler │  │ Heartbeat │  │                                ││
│  │  │  └──────────┘  └───────────┘  │                                ││
│  │  │  :3000 (REST API + SSE)       │                                ││
│  │  └──────────────┬─────────────────┘                                ││
│  │                 │ HTTP + SSE                                       ││
│  │                 ▼                                                  ││
│  │  ┌────────────────────────────────┐     ┌─────────────────────┐   ││
│  │  │             moby               │     │    tool-gateway     │   ││
│  │  │       (agent container)        │     │ (browser + tools)   │   ││
│  │  │    cagent serve api soul.yaml  │     │                     │   ││
│  │  │                                │     │  🌐 Playwright      │   ││
│  │  │  tools:                        │ MCP │  🔍 Search          │   ││
│  │  │    shell │ filesystem │ fetch  │◀───▶│  📄 Fetch           │   ││
│  │  │    mcp-bridge (stdio↔HTTP) ────┼─────│  🌤️ Weather         │   ││
│  │  │                                │     │                     │   ││
│  │  │  :8080 (cagent HTTP API)       │     │  :8081 MCP          │   ││
│  │  └─────┬──────────────────┬───────┘     │  :3100 Admin        │   ││
│  │        │                  │             └─────────────────────┘   ││
│  │                                                                    ││
│  │  ┌────────────────────────────────┐                                ││
│  │  │           dashboard            │                                ││
│  │  │    (web UI + task API +        │                                ││
│  │  │     maintenance scripts)       │                                ││
│  │  │                                │                                ││
│  │  │  📊 Status dashboard           │                                ││
│  │  │  📋 Task API + dependencies    │                                ││
│  │  │  🔄 Auto-retry (failed tasks)  │                                ││
│  │  │  🧬 Soul.yaml editor           │                                ││
│  │  │  🔧 Self-heal + boot scripts   │                                ││
│  │  │  🔗 Cloudflare tunnel          │                                ││
│  │  │  :7777 HTTP                    │                                ││
│  │  └────────────────────────────────┘                                ││
│  │                                                                    ││
│  │   Bind mounts:                                                     ││
│  │   ~/.mobyclaw/ ── user data (memory, tasks, schedules, credentials)││
│  │   /source/     ── code (self-modification by moby only)            ││
│  │   /workspace/* ── user projects (from workspaces.conf)             ││
│  └───────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

### Container Roles

The stack is **4 services:**

| Container | Role | Technology |
|---|---|---|
| **gateway** | Orchestrator - messaging adapters, sessions, heartbeat, scheduler, REST API | Node.js (Express) |
| **moby** | AI brain - runs cagent, receives prompts, executes tools (shell, filesystem, fetch, MCP) | cagent serve api |
| **tool-gateway** | External tools - headless browser (Playwright), web search, fetch, weather via MCP | Node.js + Playwright + Chromium |
| **dashboard** | Web dashboard, task API (SQLite) with dependency chains + auto-retry, personality editor (soul.yaml), maintenance scripts, Cloudflare tunnel | Python 3.11 + cloudflared |

**Key principle: code vs data separation.**
All service code (including scripts, dashboards, and maintenance logic) lives in the repo.
All user-specific data (memory, tasks, schedules, credentials) lives in `~/.mobyclaw/`.
Containers read/write user data via bind-mounted volumes but never store code in the user folder.

**Evolution:** The original architecture planned 4 containers (moby, gateway, workspace MCP, memory MCP).
In practice, cagent's built-in tools (shell, filesystem, fetch) handle workspace and memory directly.
The tool-gateway was added for external web services and browser automation.
The dashboard was added as a 4th service for web UI, task tracking, and maintenance scripts.

### MCP Tool Bridge

The tool-gateway exposes 19 tools to cagent via MCP (Model Context Protocol):

```
cagent ──stdio──▸ mcp-bridge (Node.js) ──HTTP──▸ tool-gateway:8081
                  (in moby container)             (separate container)
```

The mcp-bridge:
1. Connects to tool-gateway via `StreamableHTTPClientTransport`
2. Discovers remote tools via `client.listTools()`
3. Converts JSON Schema → Zod and re-registers each tool locally via `McpServer.tool()`
4. Serves them to cagent via `StdioServerTransport`

**19 tools total:**
- 3 lightweight: `browser_fetch` (Readability extraction), `browser_search` (DuckDuckGo), `weather_get` (Open-Meteo)
- 16 browser automation: `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_hover`, `browser_press_key`, `browser_scroll`, `browser_back`, `browser_forward`, `browser_wait`, `browser_tabs`, `browser_close`, `browser_eval`

Browser tools use **accessibility snapshots with aria-ref** element targeting — the same approach as `@playwright/mcp`. The agent sees a structured text tree of the page, each interactive element gets a ref, and the agent uses those refs to click/type/fill.

### Messaging Adapters

Messaging platforms are **adapters inside the gateway**, not separate containers:

| Adapter | Library | Enabled via |
|---|---|---|
| Telegram | Telegraf | `TELEGRAM_BOT_TOKEN` env var |
| WhatsApp | Baileys / whatsapp-web.js | `WHATSAPP_AUTH` env var |
| Discord | discord.js | `DISCORD_BOT_TOKEN` env var |
| Slack | Bolt | `SLACK_BOT_TOKEN` env var |

**Why adapters inside gateway, not separate bridge containers?**
- Simpler: one container, one codebase, one config
- All messaging libraries are Node.js anyway
- Enable/disable via env var presence: no token = adapter doesn't load

### How Services Connect

```
                    ┌───────────┐
  Telegram, CLI,    │  gateway  │  messaging, scheduler, heartbeat
  HTTP API      ─→  │  :3000    │  REST API, SSE streaming
                    └─────┬─────┘
                          │ HTTP + SSE
                          ▼
                    ┌───────────┐          ┌───────────────┐
                    │   moby    │──MCP────▶│ tool-gateway  │
                    │  :8080    │  bridge  │ :8081 / :3100 │
                    └──┬─────┬──┘          │               │
                       │     │             │ Playwright +  │
              bind mounts:   │             │ Chromium      │
              ~/.mobyclaw/    /source       └───────────────┘
              /workspace/*   (self-mod)

                    ┌───────────────┐
                    │   dashboard   │  web UI, task API, maintenance
                    │   :7777       │  reads/writes ~/.mobyclaw/ data
                    └───────────────┘
```

**Connection protocols:**

| From -> To | Protocol | How |
|---|---|---|
| gateway -> moby | HTTP + SSE | POST to cagent's `/api/sessions/{id}/agent/{name}`, streams response via SSE |
| gateway -> dashboard | HTTP | Context optimizer fetches relevant memory via `GET /api/context` |
| moby -> tool-gateway | MCP (stdio-to-HTTP) | mcp-bridge bridges cagent's stdio MCP to tool-gateway's Streamable HTTP |
| moby -> filesystem | Direct | cagent's built-in tools read/write bind-mounted dirs (~/.mobyclaw/, /workspace/, /source) |
| moby -> dashboard | HTTP | Agent calls dashboard API via curl (e.g., `GET /api/tasks`, `POST /api/memory/compress`) |
| moby -> gateway | HTTP | Agent calls gateway API via curl (e.g., `POST /api/schedules`, `POST /api/deliver`) |
| CLI -> gateway | HTTP + SSE | `mobyclaw run` / `mobyclaw chat` hit gateway's `/prompt/stream` endpoint |
| dashboard -> filesystem | Direct | Dashboard reads/writes `~/.mobyclaw/` data via bind mount |

### Runtime Modes (cagent)

cagent supports multiple serving modes. We use:

| Mode | Command | Use Case |
|---|---|---|
| **API Server** | `cagent serve api soul.yaml` | Primary: HTTP API for agent interaction |
| **A2A Server** | `cagent serve a2a soul.yaml` | Future: Agent-to-agent protocol |
| **Exec** | `cagent run --exec soul.yaml` | One-shot: run a task and exit |
| **Interactive** | `cagent run soul.yaml` | Dev/debug: TUI inside container |

### Dashboard API Reference

The dashboard (`http://dashboard:7777`) exposes a REST API used by moby, the gateway, and the web UI.

#### Read endpoints (GET)

| Endpoint | Description |
|---|---|
| `GET /api/settings` | Current settings including tunnel info, soul config |
| `GET /api/tasks` | List tasks (filter: `?status=todo\|in_progress\|done\|failed`, `?priority=`, `?tag=`) |
| `GET /api/tasks/stats` | Task counts by status |
| `GET /api/tasks/blocked` | Tasks blocked by unmet dependencies |
| `GET /api/tasks/:id/deps` | Dependency check for a specific task |
| `GET /api/conversations` | Conversation log (filter: `?q=search_term`, `?channel=`, `?limit=`) |
| `GET /api/conversations/stats` | Conversation counts and channel breakdown |
| `GET /api/lessons` | Lessons learned entries |
| `GET /api/memory` | Raw MEMORY.md content |
| `GET /api/soul` | Current soul.yaml content |
| `GET /api/inner-state` | Current inner.json (agent emotional state) |
| `GET /api/self-model` | Current SELF.md content |
| `GET /api/journal` | Recent journal entries (filter: `?date=YYYY-MM-DD`) |
| `GET /api/explorations` | Exploration files list and content |
| `GET /api/explorations/stats` | Exploration counts and topics |
| `GET /api/context` | Context optimizer output (params: `?query=`, `?budget=`) |
| `GET /api/usage` | Token usage log entries |
| `GET /api/usage/stats` | Aggregated cost and token stats |
| `GET /api/retry/status` | Auto-retry queue status |
| `GET /api/tunnel` | Current tunnel info (URL, pid, started time) |

#### Write endpoints (POST/PUT)

| Endpoint | Description |
|---|---|
| `POST /api/tasks` | Create a task (`title`, `status`, `priority`, `tags`, `depends_on`) |
| `PUT /api/tasks/:id` | Update a task (dependency-aware: 409 if deps unmet) |
| `POST /api/tasks/:id/retry` | Retry a failed task |
| `POST /api/conversations` | Log a conversation turn |
| `POST /api/lessons` | Add a lesson (`lesson`, `category`, `severity`) |
| `POST /api/memory/compress` | Archive completed tasks from MEMORY.md |
| `POST /api/memory` | Write raw content to MEMORY.md |
| `POST /api/soul` | Write soul.yaml content |
| `POST /api/retry/run` | Trigger manual retry of failed tasks |
| `POST /api/usage` | Log token usage entry |
| `POST /api/inner-state` | Write inner.json (agent updates own state) |
| `POST /api/self-model` | Write SELF.md content |
| `POST /api/journal` | Append a journal entry |
| `POST /api/tunnel/start` | Start Cloudflare tunnel - sends URL to user via Telegram when ready |

#### Tunnel management

The agent can start the Cloudflare tunnel remotely without host access:

```bash
# Start tunnel (non-blocking - sends URL via Telegram when ready)
curl -s -X POST http://dashboard:7777/api/tunnel/start

# Check current tunnel status
curl -s http://dashboard:7777/api/tunnel
```

The start endpoint checks if a tunnel is already running (by PID), kills it if stale, then spawns a fresh cloudflared process. The URL is sent automatically via the gateway's `/api/deliver` endpoint once cloudflared reports it ready.
