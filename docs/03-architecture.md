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
│  │   ~/.mobyclaw/       /source                                       ││
│  │   (bind mount)      (bind mount)                                   ││
│  │   memory, tasks     self-modification                              ││
│  │        │                  │                                        ││
│  │   /workspace/*                                                     ││
│  │   User projects (bind mounts from workspaces.conf)                 ││
│  └───────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

### Container Roles

The stack is **3 services:**

| Container | Role | Technology |
|---|---|---|
| **gateway** | Orchestrator — messaging adapters, sessions, heartbeat, scheduler, REST API | Node.js (Express) |
| **moby** | AI brain — runs cagent, receives prompts, executes tools (shell, filesystem, fetch, MCP) | cagent serve api |
| **tool-gateway** | External tools — headless browser (Playwright), web search, fetch, weather via MCP | Node.js + Playwright + Chromium |

**Evolution:** The original architecture planned 4 containers (moby, gateway, workspace MCP, memory MCP).
In practice, cagent's built-in tools (shell, filesystem, fetch) handle workspace and memory directly.
The tool-gateway was added later for external web services and browser automation.

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
              /workspace/*   (self-modification)
```

**Connection protocols:**

| From → To | Protocol | How |
|---|---|---|
| gateway → moby | HTTP + SSE | POST to cagent's `/api/sessions/{id}/agent/{name}`, streams response via SSE |
| moby → tool-gateway | MCP (stdio↔HTTP) | mcp-bridge bridges cagent's stdio MCP to tool-gateway's Streamable HTTP |
| moby → filesystem | Direct | cagent's built-in tools read/write bind-mounted dirs (~/.mobyclaw/, /workspace/, /source) |
| CLI → gateway | HTTP + SSE | `mobyclaw run` / `mobyclaw chat` hit gateway's `/prompt/stream` endpoint |
| agent → gateway | HTTP | Agent calls gateway API via curl (e.g., `POST /api/schedules`, `POST /api/deliver`) |

### Runtime Modes (cagent)

cagent supports multiple serving modes. We use:

| Mode | Command | Use Case |
|---|---|---|
| **API Server** | `cagent serve api soul.yaml` | Primary: HTTP API for agent interaction |
| **A2A Server** | `cagent serve a2a soul.yaml` | Future: Agent-to-agent protocol |
| **Exec** | `cagent run --exec soul.yaml` | One-shot: run a task and exit |
| **Interactive** | `cagent run soul.yaml` | Dev/debug: TUI inside container |
