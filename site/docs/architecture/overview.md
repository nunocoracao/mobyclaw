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
│  └───────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

### Three Services

| Container | Role | Technology |
|---|---|---|
| **gateway** | Orchestrator — messaging adapters, sessions, heartbeat, scheduler, REST API | Node.js (Express) |
| **moby** | AI brain — runs cagent, receives prompts, executes tools | cagent serve api |
| **tool-gateway** | External tools — headless browser, web search, fetch, weather via MCP | Node.js + Playwright + Chromium |

### 19 MCP Tools

The tool-gateway exposes tools to the agent via the MCP (Model Context Protocol) bridge:

**Quick tools** (lightweight, no browser):

- `browser_fetch` — Fetch a URL → clean readable text
- `browser_search` — Web search via DuckDuckGo
- `weather_get` — Current weather + forecast

**Browser automation** (full Playwright + Chromium):

- `browser_navigate` — Go to URL, get accessibility snapshot with element refs
- `browser_snapshot` — Refresh page state with refs
- `browser_screenshot` — Take PNG screenshot
- `browser_click` — Click element by ref
- `browser_type` — Type into input by ref
- `browser_fill_form` — Fill multiple fields at once
- `browser_select_option` — Select dropdown
- `browser_hover` — Hover (reveals menus, tooltips)
- `browser_press_key` — Keyboard key press
- `browser_scroll` — Scroll up/down
- `browser_back` / `browser_forward` — History navigation
- `browser_wait` — Wait for condition
- `browser_tabs` — Manage tabs
- `browser_close` — Close browser
- `browser_eval` — Execute JavaScript

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

| From → To | Protocol | How |
|---|---|---|
| gateway → moby | HTTP + SSE | POST to cagent API, streams response |
| moby → tool-gateway | MCP (stdio↔HTTP) | mcp-bridge bridges cagent's stdio MCP to tool-gateway's Streamable HTTP |
| moby → filesystem | Direct | Built-in tools read/write bind-mounted dirs |
| CLI → gateway | HTTP + SSE | `mobyclaw run` / `mobyclaw chat` hit gateway endpoints |
| agent → gateway | HTTP | Agent calls gateway API via curl (schedules, deliver) |
