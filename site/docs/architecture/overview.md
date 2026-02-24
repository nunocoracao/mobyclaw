## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Host Machine                                 │
│                                                                   │
│  ┌────────────┐                                                   │
│  │ mobyclaw   │── docker compose up/down/logs/run ──┐            │
│  │ CLI        │                                       │            │
│  └────────────┘                                       ▼            │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                  Docker Compose Stack                         │  │
│  │                  (mobyclaw network)                           │  │
│  │                                                               │  │
│  │  ┌───────────────────────────────────────────────────────┐   │  │
│  │  │                    gateway                             │   │  │
│  │  │              (orchestrator container)                   │   │  │
│  │  │                                                         │   │  │
│  │  │  ┌────────────┐ ┌──────────┐ ┌──────────────────────┐ │   │  │
│  │  │  │  Messaging  │ │ Session  │ │     Scheduler        │ │   │  │
│  │  │  │  Adapters   │ │ Store +  │ │  + Heartbeat         │ │   │  │
│  │  │  │ TG/WA/DC/SL│ │ Overflow │ │                      │ │   │  │
│  │  │  └──────┬─────┘ └──────────┘ └──────────┬───────────┘ │   │  │
│  │  │         │                                │              │   │  │
│  │  │    ┌────┴─────┐ ┌──────────┐ ┌──────────┴───────────┐ │   │  │
│  │  │    │ Adapter   │ │ Channel  │ │    Orchestrator      │ │   │  │
│  │  │    │ Registry  │ │ Store    │ │  (session lifecycle)  │ │   │  │
│  │  │    └──────────┘ └──────────┘ └──────────┬───────────┘ │   │  │
│  │  │                                         │              │   │  │
│  │  │              HTTP + SSE to agent         │              │   │  │
│  │  │                                         │              │   │  │
│  │  │  :3000 (REST API + SSE streaming)       │              │   │  │
│  │  └─────────────────────────────────────────┼──────────┘   │  │
│  │                                             │               │  │
│  │                                             ▼               │  │
│  │  ┌───────────────────────────────────────────────────────┐   │  │
│  │  │                     moby                               │   │  │
│  │  │              (agent container)                          │   │  │
│  │  │         cagent serve api soul.yaml                     │   │  │
│  │  │                                                         │   │  │
│  │  │  tools: shell │ filesystem │ fetch │ think              │   │  │
│  │  │                                                         │   │  │
│  │  │  :8080 (cagent HTTP API + SSE)                         │   │  │
│  │  └──────────┬────────────────────────────────┬────────────┘   │  │
│  │             │                                │                 │  │
│  │     ~/.mobyclaw/ (bind mount)       /source (bind mount)       │  │
│  │     memory, tasks, soul.yaml        project source code        │  │
│  │     schedules, channels             (self-modification)        │  │
│  │             │                                │                 │  │
│  │  ┌──────────┴──────────┐     ┌───────────────┴──────────┐     │  │
│  │  │  /workspace/*       │     │  /source                 │     │  │
│  │  │  User projects      │     │  mobyclaw source code    │     │  │
│  │  │  (bind mounts from  │     │  (bind mount from host   │     │  │
│  │  │   workspaces.conf)  │     │   project root)          │     │  │
│  │  └─────────────────────┘     └──────────────────────────┘     │  │
│  │                                                               │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Container Roles

The stack is **2 services** (simplified from the originally planned 4):

| Container | Role | Technology |
|---|---|---|
| **moby** | AI brain — runs cagent, receives prompts, executes tools (shell, filesystem, fetch) | cagent serve api |
| **gateway** | Orchestrator — messaging adapters, sessions, heartbeat, scheduler, REST API | Node.js (Express) |

**Note:** The original architecture planned 4 containers (moby, gateway, workspace MCP, memory MCP).
In practice, cagent's built-in tools (shell, filesystem, fetch) handle everything the MCP services
would have provided. The agent reads/writes memory and workspace files directly via bind mounts.
This is simpler, faster, and has fewer moving parts.

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
- Separate containers = more images, more networking, more config for little benefit
- OpenClaw does it this way — all channels live in the gateway
- Enable/disable via env var presence: no token = adapter doesn't load

### How Services Connect

```
                    ┌───────────┐
  Telegram, WA,     │  gateway  │  messaging, scheduler, heartbeat
  Discord, Slack ─→ │  :3000    │  REST API, SSE streaming
                    └─────┬─────┘
                          │ HTTP + SSE
                          ▼
                    ┌───────────┐
                    │   moby    │  AI brain (cagent serve api)
                    │  :8080    │  tools: shell, filesystem, fetch
                    └──┬─────┬──┘
                       │     │
              bind mounts:   │
              ~/.mobyclaw/    /source
              /workspace/*   (self-modification)
```

**Connection protocols:**

| From → To | Protocol | How |
|---|---|---|
| gateway → moby | HTTP + SSE | POST to cagent's `/api/sessions/{id}/agent/{name}`, streams response via SSE |
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
