# 🐋 mobyclaw

[![GitHub Pages](https://img.shields.io/badge/docs-GitHub%20Pages-blue?logo=github)](https://nunocoracao.github.io/mobyclaw/)
[![Docker](https://img.shields.io/badge/runs%20on-Docker-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/get-docker/)
[![Powered by cagent](https://img.shields.io/badge/powered%20by-cagent-8B5CF6)](https://github.com/docker/cagent)

**Your personal AI agent, containerized.**

Mobyclaw is a long-lived personal AI agent that runs in Docker containers.
You deploy it, connect your messaging apps, and it becomes your always-on AI
companion — with persistent memory, a personality, and the ability to take
action on your behalf.

**One command to start. Remembers everything. Always running.**

```bash
./mobyclaw up
```

> 📖 **Full documentation:** [nunocoracao.github.io/mobyclaw](https://nunocoracao.github.io/mobyclaw/)

---

## Features

- **Always on** — runs as a Docker Compose stack, restarts automatically
- **Persistent memory** — remembers who you are, what you've discussed, your preferences (plain Markdown files you can read and edit)
- **Chat via Telegram** — streaming responses with real-time tool status indicators
- **CLI chat** — interactive terminal sessions and one-shot prompts
- **Web browsing** — full headless browser (Playwright + Chromium) for navigating pages, filling forms, creating accounts, taking screenshots
- **Web search & reading** — search the web via DuckDuckGo, fetch and extract clean text from any URL
- **Weather** — current conditions and forecasts for any location
- **Scheduling & reminders** — set reminders, recurring tasks, and timed notifications
- **Proactive heartbeat** — wakes itself up periodically to check on tasks and notify you
- **Workspace access** — mount your project folders so the agent can read and edit your actual code
- **Service credentials** — authenticate GitHub via OAuth, add AWS keys, etc. and it uses CLIs on your behalf
- **Self-modifying** — can edit its own config, personality, and even source code, then trigger rebuilds
- **Auto-backup** — scheduled backups of agent state to a private GitHub repo
- **Your machine, your data** — runs locally, no SaaS, your API keys

---

## How It Works

```
┌────────────────────────────────────────────────────────────────────┐
│                     Docker Compose Stack                           │
│                                                                    │
│  ┌──────────────────┐  HTTP+SSE  ┌─────────────────┐             │
│  │     gateway       │───────────▶│      moby       │             │
│  │    (Node.js)      │            │  (cagent API)   │             │
│  │                   │            │                 │             │
│  │  Telegram adapter │            │  LLM inference  │             │
│  │  Session mgmt     │            │  Shell access   │             │
│  │  Scheduler/cron   │            │  Filesystem     │             │
│  │  Heartbeat        │            │  HTTP fetch     │             │
│  │  REST API         │            │  Memory R/W     │             │
│  └──────────────────┘            │  MCP bridge ────┼──┐          │
│                                   └─────────────────┘  │          │
│                                                        │ MCP      │
│                                  ┌─────────────────┐   │          │
│                                  │  tool-gateway    │◀──┘          │
│                                  │  (Node.js)      │             │
│                                  │                 │             │
│                                  │  🌐 Browser     │             │
│                                  │  🔍 Search      │             │
│                                  │  📄 Fetch       │             │
│                                  │  🌤️ Weather     │             │
│                                  │  🎭 Playwright  │             │
│                                  └─────────────────┘             │
│                                                                    │
│  Volumes:                                                          │
│    ~/.mobyclaw/  ─── memory, config, schedules, sessions           │
│    /workspace/* ─── your project folders (bind mounts)             │
│    /source/     ─── mobyclaw source (self-modification)            │
└────────────────────────────────────────────────────────────────────┘
```

**Three services:**

| Container | Role | Technology |
|---|---|---|
| **gateway** | Orchestrator — messaging, sessions, scheduling, heartbeat, REST API | Node.js / Express |
| **moby** | AI brain — LLM inference, tool execution, memory | cagent |
| **tool-gateway** | External tools — web browser, search, fetch, weather via MCP | Node.js / Playwright |

Powered by [cagent](https://github.com/docker/cagent) for the agent loop —
LLM inference, tool execution, and session management are all handled by
cagent. Mobyclaw adds orchestration, messaging, scheduling, and persistent
memory on top.

---

## Tool Gateway

The tool-gateway provides 19 MCP tools to the agent via a Streamable HTTP
bridge. Tools range from lightweight utilities to a full headless browser.

### Quick Tools (fast, no browser needed)

| Tool | What it does |
|---|---|
| `browser_fetch` | Fetch a URL → clean readable text (Readability extraction) |
| `browser_search` | Web search via DuckDuckGo |
| `weather_get` | Current weather + forecast for any location |

### Browser Automation (full Playwright + Chromium)

| Tool | What it does |
|---|---|
| `browser_navigate` | Go to a URL, returns accessibility snapshot with element refs |
| `browser_snapshot` | Get current page state — all elements with ref IDs |
| `browser_screenshot` | Take a PNG screenshot |
| `browser_click` | Click an element by ref |
| `browser_type` | Type into an input field by ref |
| `browser_fill_form` | Fill multiple form fields at once |
| `browser_select_option` | Select dropdown option |
| `browser_hover` | Hover over element (reveals menus, tooltips) |
| `browser_press_key` | Press keyboard key (Enter, Tab, Escape, etc.) |
| `browser_scroll` | Scroll page up/down |
| `browser_back` / `browser_forward` | Browser history navigation |
| `browser_wait` | Wait for text to appear/disappear or a fixed time |
| `browser_tabs` | List, create, close, or switch between tabs |
| `browser_close` | Close the browser |
| `browser_eval` | Execute JavaScript in the page |

**How it works:** The agent navigates to a page and receives an accessibility
snapshot — a structured text representation showing every interactive element
with a ref ID. The agent uses these refs to click, type, and fill forms.
After each action, it gets an updated snapshot with fresh refs.

**Example flow:**
```
1. browser_navigate("https://example.com/signup")
   → snapshot: textbox "Email" ref=s1e3, button "Sign up" ref=s1e5
2. browser_type(ref="s1e3", text="user@example.com")
3. browser_click(ref="s1e5")
   → snapshot: "Account created!" heading
```

---

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (with Compose v2)
- An LLM API key ([Anthropic](https://console.anthropic.com/) or [OpenAI](https://platform.openai.com/))

### 1. Clone and start

```bash
git clone https://github.com/nunocoracao/mobyclaw.git
cd mobyclaw
./mobyclaw up    # interactive setup on first run, then starts containers
```

The first run walks you through setup:
- LLM provider and API key (required)
- Messaging channels — Telegram (optional, more coming)
- Service credentials — GitHub, AWS, custom (all optional)
- Workspace folders — mount host directories into the agent (optional)

### 2. Talk to your agent

```bash
# One-shot prompt
./mobyclaw run "Hello, who are you?"

# Interactive chat
./mobyclaw chat

# Or message your Telegram bot (if configured)
```

### 3. Manage

```bash
./mobyclaw status          # health, channels, sessions
./mobyclaw logs             # tail container logs
./mobyclaw logs moby        # just the agent logs
./mobyclaw down             # stop everything
./mobyclaw exec             # shell into the agent container
```

---

## Workspaces

Mount your project folders so the agent can read and edit your files:

```bash
./mobyclaw workspace add ~/projects/myapp
./mobyclaw workspace add ~/Documents/notes docs
./mobyclaw workspace list
./mobyclaw workspace remove myapp
```

Workspaces appear at `/workspace/<name>` inside the agent container.
Changes are bidirectional and immediate (bind mounts). Requires a restart
to take effect.

## Service Credentials

Give your agent access to CLIs like `gh`, `aws`, etc.:

```bash
# During setup:
./mobyclaw init    # prompts for AWS, custom credentials

# Or edit directly:
vim ~/.mobyclaw/credentials.env
```

**GitHub** uses OAuth device flow — no token needed:
```bash
# After starting, just ask Moby to authenticate:
mobyclaw run "authenticate with GitHub"
# Moby runs `gh auth login` and gives you a code + URL to open in your browser
```

The `gh` OAuth session is persisted at `~/.mobyclaw/gh/` and survives restarts.

**Other credentials** use standard `KEY=value` format in `credentials.env`:

```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
NPM_TOKEN=npm_...
```

Credentials are injected as environment variables into the agent container.
The agent is instructed never to display credential values.

---

## Configuration

Everything lives in two places:

### Project root (git-tracked infrastructure)

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Static compose manifest (3 services) |
| `.env` | API keys, messaging tokens, settings (gitignored) |
| `agents/moby/soul.yaml` | Default agent personality |

### `~/.mobyclaw/` (user data, portable)

| File | Purpose |
|------|---------|
| `soul.yaml` | Agent personality + config (user-editable) |
| `MEMORY.md` | Long-term curated memory |
| `TASKS.md` | Task and reminder list |
| `HEARTBEAT.md` | Heartbeat checklist |
| `credentials.env` | Service credentials (AWS, NPM, etc.) |
| `gh/` | GitHub CLI OAuth config (persisted across restarts) |
| `workspaces.conf` | Workspace folder mappings |
| `memory/` | Daily logs (YYYY-MM-DD.md) |
| `sessions/` | Session persistence |

**Portability:** Copy `~/.mobyclaw/` to a new machine and your agent comes
with you — memory, personality, credentials, everything.

### Customize the personality

Edit `~/.mobyclaw/soul.yaml` — the `instruction:` block is the agent's
personality and behavior in Markdown. After editing, restart with
`./mobyclaw down && ./mobyclaw up`.

---

## CLI Reference

```
Usage: mobyclaw <command> [options]

Commands:
  init                          Interactive setup wizard
  up                            Start the agent (runs init if needed)
  down                          Stop everything
  logs [service]                Tail container logs
  status                        Show health and services
  run "<prompt>"                Send a one-shot prompt
  chat                          Interactive chat session
  exec                          Shell into the agent container
  workspace list                Show mounted workspaces
  workspace add <path> [name]   Mount a host folder
  workspace remove <name>       Unmount a folder
  help                          Show help
  version                       Show version
```

---

## Project Structure

```
mobyclaw/
├── mobyclaw                    # CLI (bash script)
├── docker-compose.yml          # Compose manifest (3 services)
├── Dockerfile                  # Agent image: Debian + cagent + Node.js + mcp-bridge
├── agents/moby/
│   ├── soul.yaml               # Agent personality, model, tools
│   └── defaults/               # Templates copied to ~/.mobyclaw/ on init
├── gateway/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js            # Express app + REST API
│       ├── orchestrator.js     # Session routing, collect mode, debounce
│       ├── agent-client.js     # HTTP client for cagent with SSE streaming
│       ├── sessions.js         # Session store with lifecycle + queue
│       ├── scheduler.js        # Schedules, reminders, heartbeat
│       ├── heartbeat.js        # Heartbeat with skip guard
│       ├── channels.js         # Persistent channel store
│       ├── routes.js           # API routes including /api/stop
│       ├── tool-labels.js      # Tool name formatting for Telegram
│       ├── adapter-registry.js # Platform→sendFn dispatch
│       └── adapters/
│           └── telegram.js     # Telegram bot with streaming + typing
├── tool-gateway/
│   ├── Dockerfile              # Node.js 22 + Playwright + Chromium
│   ├── package.json
│   ├── mcp-bridge              # Node.js stdio↔HTTP bridge (also in moby)
│   └── src/
│       ├── index.js            # MCP server + admin API
│       └── tools/
│           ├── browser.js      # browser_fetch + browser_search
│           ├── weather.js      # weather_get (Open-Meteo)
│           └── playwright.js   # 16 browser automation tools
├── site/                       # GitHub Pages landing page
├── docs/                       # Architecture documentation
└── README.md
```

---

## Architecture

See [architecture.md](architecture.md) for the full design document, or browse
the [online docs](https://nunocoracao.github.io/mobyclaw/docs/).

### Key design choices

- **cagent native** — uses cagent's YAML format directly, no wrapper layer
- **Docker Compose** — right-sized for personal deployment (not Kubernetes)
- **Three containers** — gateway (orchestrator), moby (AI brain), tool-gateway (external tools)
- **Plain files** — memory is Markdown, config is YAML, secrets are `.env`
- **Bind mounts** — all state at `~/.mobyclaw/`, not Docker volumes (survives `docker system prune`)
- **MCP bridge** — tool-gateway tools exposed to cagent via stdio↔HTTP bridge using MCP protocol
- **Accessibility snapshots** — browser uses Playwright's aria-ref system for reliable element targeting

---

## Roadmap

- [x] **Phase 1** — Agent in a box (CLI, memory, Docker Compose)
- [x] **Phase 2** — Gateway + Telegram streaming, heartbeat, scheduling, reminders
- [x] **Phase 2.5** — OpenClaw-inspired session UX (queue, collect mode, /stop, /status)
- [x] **Phase 2.7** — Tool gateway (web browsing, search, fetch, weather, 19 MCP tools)
- [ ] **Phase 3** — More messaging channels, webhook ingress, vector memory search
- [ ] **Phase 4** — Production hardening (seccomp, network policy, monitoring)

---

## License

MIT
