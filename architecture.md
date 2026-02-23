# Mobyclaw Architecture

> **Source of truth** for all design decisions. Every significant pattern,
> trade-off, and rationale lives here. Consult before making changes; update
> after making decisions.

---

## 1. Vision

**Mobyclaw** is a long-lived personal AI agent that runs in Docker containers.
You deploy it, connect your messaging apps, and it becomes your always-on AI
companion — with persistent memory, a personality, and the ability to take
action on your behalf.

Think: **OpenClaw, but containerized and powered by cagent.**

### What it is

- A **personal AI agent** that's always running (long-lived daemon)
- Reachable through your **messaging apps** (Telegram, WhatsApp, Discord, Slack, etc.)
- Has **persistent memory** — it remembers who you are, what you've discussed, your preferences
- **Proactive** — it can wake itself up via heartbeats, cron jobs, and scheduled tasks
- Runs in **Docker Compose** — one `docker compose up` and you have a personal AI
- Powered by **cagent** — the agent loop, tool execution, and model inference

### What it is not

- Not a chatbot SDK — it's a deployable personal agent, ready to go
- Not a SaaS — runs on your machine, your infrastructure, your API keys
- Not stateless — the whole point is that it persists, remembers, and acts over time

### How it maps to OpenClaw

| OpenClaw | Mobyclaw | Notes |
|---|---|---|
| Gateway (monolithic Node.js daemon) | **Gateway container** (orchestrator) | Handles messaging, sessions, cron, heartbeat |
| Agent Loop (embedded in Gateway) | **cagent** (agent container) | cagent handles inference + tools |
| SOUL.md, IDENTITY.md, USER.md | **soul.yaml** per agent | Single file: personality + cagent config, inline `instruction` |
| MEMORY.md + memory/*.md | **Same** — Markdown in `~/.mobyclaw/` | Bind-mounted host dir, agent reads/writes via tools |
| HEARTBEAT.md + heartbeat runner | **Gateway scheduler** | Sends periodic prompts to agent |
| Cron jobs | **Gateway scheduler** | Persistent cron, stored in `~/.mobyclaw/` |
| Messaging channels (WA, TG, etc.) | **Gateway adapters** | Pluggable modules inside gateway, enabled via env vars |
| Sandboxing (Docker for tool isolation) | **Containers ARE the runtime** | Agent already runs in Docker |
| CLI (`openclaw gateway`, etc.) | **`mobyclaw` CLI** (bash) | Wraps docker compose |
| Sessions + command queue | **Gateway** manages sessions | Routes messages, serializes runs |
| Tool policy (allow/deny) | **cagent toolset config** | Per-agent YAML |
| Multi-agent routing + bindings | **Out of scope** — single agent by design | — |

---

## 2. Core Concepts

### 2.1 The Personal Agent

Mobyclaw runs a **personal AI agent** that:
1. Has a **personality** defined in `soul.yaml`
2. Has **persistent memory** in Markdown files (MEMORY.md, memory/*.md)
3. Is **always running** in a Docker container
4. Can be **reached** via messaging apps or direct HTTP/CLI
5. Can **wake itself** via heartbeats and cron jobs
6. Can **take action** using tools (shell, filesystem, fetch, etc.)

### 2.2 Moby — The One Agent

Mobyclaw runs **exactly one agent: moby**. There is no multi-agent routing,
no agent marketplace, no agent registry. One agent, one container, one personality.
This is a deliberate simplification — a personal AI agent doesn't need to be a
platform.

Moby lives at `agents/moby/` and has:
- `soul.yaml` — Moby's personality, model, tools, and behavioral guidelines (all-in-one)

### 2.3 Trigger Sources

The agent doesn't just respond to messages. It has multiple input sources:

| Trigger | How it works | Example |
|---|---|---|
| **Messaging** | User sends a message via WhatsApp/Telegram/etc. | "What's on my calendar today?" |
| **Heartbeat** | Periodic wake-up (every 30m by default) | Agent checks HEARTBEAT.md, reviews pending tasks |
| **Cron** | Scheduled jobs (one-shot or recurring) | "Every morning at 7am, summarize my emails" |
| **Webhook** | HTTP POST to the gateway | GitHub push event triggers code review |
| **CLI** | Direct prompt via `mobyclaw run` | `mobyclaw run "Deploy to staging"` |

### 2.4 Memory

Memory is **plain Markdown files on the host** at `~/.mobyclaw/`, bind-mounted
into containers. Same philosophy as OpenClaw.

| File | Purpose | Lifecycle |
|---|---|---|
| `MEMORY.md` | Curated long-term memory (facts, preferences, people) | Agent maintains it |
| `memory/YYYY-MM-DD.md` | Daily log (append-only notes) | One per day, auto-created |
| `HEARTBEAT.md` | Heartbeat checklist (what to check each wake-up) | User/agent maintained |
| `soul.yaml` | Agent personality + config (user-editable!) | User/agent maintained |

These files live at `~/.mobyclaw/` on the host. Users can edit `soul.yaml` or
`HEARTBEAT.md` directly with any text editor — the agent picks up changes on
the next turn.

**Phase 2+**: Vector search over memory files for semantic recall.

### 2.5 User Data Directory

All evolving agent state lives on the host filesystem, not inside Docker
volumes. This makes it visible, editable, and portable.

```
~/.mobyclaw/
├── soul.yaml            # Agent personality + config (user-editable)
├── MEMORY.md            # Long-term curated memory
├── HEARTBEAT.md         # Heartbeat checklist
├── credentials.env      # Service credentials (GH_TOKEN, AWS keys, etc.)
├── workspaces.conf      # Workspace folder mappings (name=path)
├── memory/              # Daily logs
│   ├── 2026-02-23.md
│   ├── 2026-02-22.md
│   └── ...
├── sessions/            # Conversation history
└── logs/                # Agent activity logs
```

**Platform paths:**

| OS | Path |
|---|---|
| macOS | `~/.mobyclaw/` |
| Linux | `~/.mobyclaw/` |
| Windows | `%USERPROFILE%\.mobyclaw\` |

**Why bind mount, not Docker volume?**
- Users can see and edit files directly (`vim ~/.mobyclaw/soul.yaml`)
- Easy to back up, sync, or version control
- Survives `docker system prune` — Docker volumes don't
- Portable: copy `~/.mobyclaw/` to a new machine and your agent comes with you

### 2.6 Workspaces

Workspaces are **host directories bind-mounted into the agent container** at
`/workspace/<name>`. This lets the agent read, modify, and create files in the
user's actual projects.

- **Configured in** `~/.mobyclaw/workspaces.conf` (simple `name=path` format)
- **Mounted via** `docker-compose.override.yml` (auto-generated, see §8.3)
- **Managed via** `mobyclaw workspace add|remove|list` CLI commands
- **Available at** `/workspace/<name>` inside the agent container

Workspaces are real bind mounts — changes are bidirectional and immediate.
The agent's `soul.yaml` instructions tell it to check `/workspace/` when the
user asks to work on "their project" or "their code".

### 2.7 Service Credentials

Service credentials let the agent use external tools (GitHub CLI, AWS CLI, etc.)
on the user's behalf. They are **environment variables injected into the agent
container** at runtime.

- **Configured in** `~/.mobyclaw/credentials.env` (standard `KEY=value` format)
- **Injected via** `docker-compose.override.yml` `env_file` directive
- **Managed via** `mobyclaw init` (interactive) or direct file editing
- **Never exposed** — the agent's instructions prohibit displaying credential values

Credentials are separate from `.env` because they serve different purposes:
- `.env` = mobyclaw infrastructure (LLM keys, messaging tokens, settings)
- `credentials.env` = user's service tokens (passed through to the agent)

This separation means `.env` stays in the project root (gitignored) while
`credentials.env` lives in `~/.mobyclaw/` alongside the agent's other state.

### 2.8 Sessions

A session is a conversation thread with history. Sessions are:
- **Per-channel**: each DM, group, or platform gets its own session
- **Persistent**: stored on disk, survive container restarts
- **Compactable**: old context gets summarized to stay within model limits

---

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
│  │  │  │  Adapters   │ │ Store    │ │  (Heartbeat + Cron)  │ │   │  │
│  │  │  │ TG/WA/DC/SL│ │          │ │                      │ │   │  │
│  │  │  └──────┬─────┘ └──────────┘ └──────────┬───────────┘ │   │  │
│  │  │         │                                │              │   │  │
│  │  │         └────────────┬───────────────────┘              │   │  │
│  │  │                      │                                   │   │  │
│  │  │              HTTP to agent container                     │   │  │
│  │  │                      │                                   │   │  │
│  │  │  :3000 (control API) │                                   │   │  │
│  │  └──────────────────────┼───────────────────────────────┘   │  │
│  │                         │                                     │  │
│  │                         ▼                                     │  │
│  │  ┌───────────────────────────────────────────────────────┐   │  │
│  │  │                     moby                               │   │  │
│  │  │              (agent container)                          │   │  │
│  │  │         cagent serve api soul.yaml                     │   │  │
│  │  │                                                         │   │  │
│  │  │  instruction │ tools │ memory r/w │ workspace access    │   │  │
│  │  │                                                         │   │  │
│  │  │  :8080 (cagent HTTP API)                               │   │  │
│  │  └──────────┬────────────────────────────────┬────────────┘   │  │
│  │             │                                │                 │  │
│  │        MCP stdio                        MCP stdio              │  │
│  │             │                                │                 │  │
│  │  ┌──────────┴──────────┐     ┌───────────────┴──────────┐     │  │
│  │  │     workspace       │     │        memory            │     │  │
│  │  │   (MCP server)      │     │     (MCP server)         │     │  │
│  │  │                     │     │                          │     │  │
│  │  │  mounts host dirs   │     │  ~/.mobyclaw/ bind mount │     │  │
│  │  │  at /mnt/host       │     │  MEMORY.md, memory/,     │     │  │
│  │  │                     │     │  soul.yaml, HEARTBEAT.md  │     │  │
│  │  └─────────────────────┘     └──────────────────────────┘     │  │
│  │                                                               │  │
│  │  ┌──────────────────┐                                         │  │
│  │  │  /data           │ (Docker volume — gateway only)          │  │
│  │  │  ├── sessions/   │                                         │  │
│  │  │  ├── cron/       │                                         │  │
│  │  │  └── state/      │                                         │  │
│  │  └──────────────────┘                                         │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Container Roles

The stack is built from **4 core services**, each owning one concern:

| Container | Role | Technology | Phase |
|---|---|---|---|
| **moby** | AI brain — runs cagent, receives prompts, calls tools on other services | cagent serve api | 1 |
| **gateway** | Orchestrator — messaging adapters, sessions, heartbeat, cron | Node.js or Go | 2 |
| **workspace** | Filesystem — mounts host directories, exposes them as MCP tools to the agent | MCP server (cagent serve mcp) | 1 |
| **memory** | Memory — stores MEMORY.md + daily logs, provides vector search | MCP server + search API | 1 |

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
  Telegram, WA,     │  gateway  │  messaging, cron, heartbeat
  Discord, Slack ─→ │  :3000    │
                    └─────┬─────┘
                          │ HTTP
                          ▼
                    ┌───────────┐
                    │   moby    │  AI brain (cagent serve api)
                    │  :8080    │
                    └──┬─────┬──┘
              MCP stdio│     │MCP stdio
                       ▼     ▼
              ┌──────────┐ ┌──────────┐
              │workspace │ │  memory  │
              │(MCP srv) │ │(MCP srv) │
              └────┬─────┘ └────┬─────┘
                   │            │
              host mounts   ~/.mobyclaw/
```

**Connection protocols:**

| From → To | Protocol | How |
|---|---|---|
| gateway → moby | HTTP | POST to cagent's `/v1/run` API |
| moby → workspace | MCP (stdio) | cagent `type: mcp` toolset, `command` launches client that connects to workspace container |
| moby → memory | MCP (stdio) | cagent `type: mcp` toolset, `command` launches client that connects to memory container |
| CLI → moby | HTTP | Direct `curl` to cagent API (Phase 1, no gateway) |

### Runtime Modes (cagent)

cagent supports multiple serving modes. We use:

| Mode | Command | Use Case |
|---|---|---|
| **API Server** | `cagent serve api soul.yaml` | Primary: HTTP API for agent interaction |
| **A2A Server** | `cagent serve a2a soul.yaml` | Future: Agent-to-agent protocol |
| **Exec** | `cagent run --exec soul.yaml` | One-shot: run a task and exit |
| **Interactive** | `cagent run soul.yaml` | Dev/debug: TUI inside container |

---

## 4. Project Structure

```
mobyclaw/
├── architecture.md            # This file — source of truth
├── mobyclaw.yaml              # DEV ONLY: cagent config for the development agent
│
├── agents/                    # Agent definitions
│   └── moby/                  # The default "moby" agent
│       ├── soul.yaml          # All-in-one: personality, model, tools, behavior
│       └── defaults/          # Default files copied to ~/.mobyclaw/ on init
│           ├── MEMORY.md      # Initial memory template
│           ├── HEARTBEAT.md   # Initial heartbeat checklist
│           ├── credentials.env # Credential file template (comments only)
│           └── workspaces.conf # Workspace config template (comments only)
│
├── gateway/                   # Gateway orchestrator
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js           # Express app, /prompt and /prompt/stream endpoints
│       ├── agent-client.js    # HTTP client for cagent API with SSE streaming
│       ├── sessions.js        # Session store with per-channel queuing
│       ├── tool-labels.js     # Shared tool name → human-readable label formatting
│       └── adapters/          # Messaging platform adapters
│           └── telegram.js    # Telegraf bot with progressive message editing
│
├── Dockerfile                 # Agent base image: Debian + cagent + tools
├── docker-compose.yml         # Static compose manifest (git-committed)
├── docker-compose.override.yml # GENERATED: credentials + workspace mounts (gitignored)
├── .env.example               # Template for API keys and config
├── .env                       # Actual secrets (gitignored, created by init)
│
├── mobyclaw                    # CLI script (bash)
│
└── README.md                  # User-facing documentation
```

### What's NOT in the product

- `mobyclaw.yaml` — This is the cagent config for the **development agent** that
  helps build mobyclaw. It is not part of the product runtime.

---

## 5. Agent Definition Format

### 5.1 Agent Config (`agents/<name>/soul.yaml`)

This is a **standard cagent agent YAML** with the full personality inlined.
Example for moby:

```yaml
agents:
  root:
    name: moby
    model: opus

    instruction: |
      # Moby — Your Personal AI Agent

      You are **Moby**, a personal AI agent running in a Docker container...

      ## Identity
      - **Name:** Moby
      - **Tone:** Conversational but precise...

      ## Memory
      ...

      ## Constraints
      ...

    toolsets:
      - type: shell
      - type: filesystem
      - type: fetch
      - type: think

    add_date: true
    add_environment_info: true
```

**Design decision:** We use cagent's native YAML format directly. No wrapper,
no abstraction. This means:
- Zero translation layer between mobyclaw config and cagent config
- Users can leverage any cagent feature without mobyclaw needing to know about it
- cagent docs apply directly

The personality lives inside the `instruction:` field as a YAML block scalar (`|`).
This keeps everything in one file while remaining readable — the `instruction`
block is effectively Markdown inside YAML.

**Why not a separate soul.md?** cagent's `instruction` field is string-only —
it doesn't support `file:` references. While `add_prompt_files` can inject file
contents into the prompt, having the personality inline means:
- One file to understand the whole agent
- One file to copy to a new machine
- One file to edit when customizing
- No hidden dependencies between files

### 5.2 Runtime File (`~/.mobyclaw/soul.yaml`)

At runtime, the agent's `soul.yaml` is loaded from `~/.mobyclaw/soul.yaml` (the
user's copy), not from the repo. On first run, `mobyclaw init` copies the
default `agents/moby/soul.yaml` to `~/.mobyclaw/soul.yaml` as a starting point.

```
~/.mobyclaw/
├── soul.yaml           # Active agent config (user-editable)
├── MEMORY.md           # Long-term curated memory
├── HEARTBEAT.md        # Heartbeat checklist
├── credentials.env     # Service credentials (GH_TOKEN, etc.)
├── workspaces.conf     # Workspace folder mappings
├── memory/
│   ├── 2026-02-23.md   # Daily log
│   └── ...
├── sessions/           # Conversation history
└── logs/               # Agent logs
```

These are just files on the host. The agent reads and writes them via
cagent's built-in filesystem tools. They persist across container restarts
because they're bind-mounted from the host filesystem.

---

## 6. Gateway (Orchestrator)

The gateway is the **central nervous system** of mobyclaw. It's a long-lived
process that:

1. **Receives messages** from all connected channels (Telegram, WhatsApp, CLI, webhooks)
2. **Manages sessions** — maps channels/users to conversation threads
3. **Routes to the agent** — sends prompts to cagent's HTTP API
4. **Runs the scheduler** — heartbeats and cron jobs trigger agent turns
5. **Delivers responses** — routes agent replies back to the right channel

### 6.1 Message Flow

```
User sends "What's my schedule?" via Telegram
  │
  ▼
gateway's Telegram adapter receives message
  │
  ├─ Look up session for telegram:dm:12345
  ├─ Load session history
  ├─ Enqueue in command queue (serialize per session)
  │
  ▼
gateway sends agent turn
  │
  ├─ POST http://moby:8080/v1/run
  │   { prompt: "What's my schedule?", session_id: "..." }
  │
  ▼
cagent runs agent loop
  │
  ├─ Assembles system prompt (soul.yaml instruction + context)
  ├─ Model inference
  ├─ Tool calls (reads calendar, writes memory, etc.)
  ├─ Final response: "You have a standup at 10am and..."
  │
  ▼
gateway receives response
  │
  ├─ Store in session history
  ├─ Route back to originating channel
  │
  ▼
gateway delivers response via Telegram adapter
```

### 6.2 Heartbeat Flow

```
Scheduler timer fires (every 30 minutes)
  │
  ├─ Is it within active hours? (e.g., 8am-11pm)
  │
  ▼
gateway sends heartbeat prompt to agent
  │
  ├─ POST http://moby:8080/v1/run
  │   { prompt: "Read HEARTBEAT.md. Follow it strictly.
  │              If nothing needs attention, reply HEARTBEAT_OK.",
  │     session_id: "heartbeat:main" }
  │
  ▼
cagent runs agent loop
  │
  ├─ Reads HEARTBEAT.md
  ├─ Checks pending tasks, reviews memory
  ├─ Either: "HEARTBEAT_OK" (nothing to do)
  │   Or: "Reminder: you have a meeting in 30 minutes"
  │
  ▼
gateway processes response
  │
  ├─ If HEARTBEAT_OK → suppress, don't deliver
  └─ If actual content → deliver to user's last active channel
```

### 6.3 Cron Flow

```
Cron job fires: "Morning brief" (every day at 7am)
  │
  ▼
gateway creates isolated session
  │
  ├─ POST http://moby:8080/v1/run
  │   { prompt: "Summarize overnight updates. Check emails and calendar.",
  │     session_id: "cron:morning-brief" }
  │
  ▼
cagent runs agent loop
  │
  ├─ Reviews overnight activity, memory, etc.
  ├─ Composes summary
  │
  ▼
gateway delivers to configured channel
  │
  └─ Sends summary to user's WhatsApp/Telegram/Slack
```

### 6.4 Message Serialization

cagent can only process one request per session at a time. If the gateway
sends a second message to the same session while the first is still running,
the second request will hang until the first completes (or time out).

The gateway serializes messages per channel:
- Each channel has a **queue** of pending messages
- While a message is being processed (session is "busy"), new messages are queued
- When processing completes, the next queued message is sent
- If a session error occurs, the session is reset and the message retried once

This prevents concurrent requests to the same cagent session and ensures
messages are processed in order.

### 6.5 Streaming Architecture

cagent's SSE stream emits `agent_choice` tokens as the model generates them.
The gateway streams these tokens through to all consumers in real-time,
making the agent feel fast even for long responses.

**Streaming pipeline:**

```
cagent SSE stream
  │
  │  agent_choice tokens (1-2s after request)
  ▼
agent-client.js (promptStream)
  │
  │  onToken(text) callback
  ▼
gateway routing (sendToAgentStream)
  │
  ├─→ POST /prompt/stream (SSE)  → CLI prints tokens to terminal
  ├─→ Telegram adapter           → edits message every ~1s
  └─→ POST /prompt (buffered)    → waits for full response (legacy)
```

**Gateway SSE endpoint** (`POST /prompt/stream`):
- Returns `text/event-stream` with events: `token`, `tool`, `done`, `error`
- Uses a `PassThrough` stream piped to the HTTP response
- Critical: disconnect detection uses `res.on('close')`, NOT `req.on('close')`
  (the request close event fires immediately when the POST body is consumed,
  not when the client disconnects — this was a subtle bug)

**Telegram streaming**: Instead of waiting for the full response, the adapter:
1. Sends a placeholder message as soon as the first token arrives (~1-2s)
2. Edits that message every ~1.2s with accumulated text
3. Shows tool status ("⏳ Writing to memory...") during tool calls
4. Does a final edit when the stream completes

**CLI streaming**: `mobyclaw run` and `mobyclaw chat` connect to the SSE
endpoint and print tokens directly to stdout as they arrive. Tool call
status is shown on stderr so it doesn't pollute piped output.

---


```
Debian slim + cagent binary + common dev tools (git, curl, jq, etc.)
```

**Design decisions:**
- **Debian slim** over Alpine: better compatibility with cagent and dev tools
- **cagent installed at build time**: pinned version for reproducibility
- **Common tools included**: git, curl, jq, ripgrep — agents need these for
  shell tool execution
- **Non-root user**: agent runs as `agent` user (uid 1000) for security
- **Workspace at `/workspace`**: standard mount point for all agents

### 7.2 Agent Entrypoint

```bash
cagent serve api /agent/soul.yaml --working-dir /workspace
```

The container:
1. Starts cagent in API server mode
2. Loads the agent config from `/agent/soul.yaml`
3. Sets the working directory to `/workspace` (mounted from host)
4. Listens on port 8080
5. Serves the agent API (send prompts, get responses, manage sessions)

**Tool approval:** `cagent serve api` requires explicit tool approval per
session. When creating a session via `POST /api/sessions`, the gateway MUST
set `{"tools_approved": true}` in the request body. Without this, the SSE
stream will pause at `tool_call_confirmation` events and wait indefinitely
for client-side approval that never comes. This was a critical bug discovered
during development — the agent would respond to simple messages (no tools)
but hang forever on any message that triggered a tool call (e.g., writing
to memory). The fix is a single field on session creation.

### 7.3 cagent HTTP API Reference

Discovered through testing. This is the API surface of `cagent serve api`:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/ping` | GET | Health check. Returns `{"status":"ok"}` |
| `/api/agents` | GET | List available agents. Returns `[{"name":"soul",...}]` |
| `/api/sessions` | GET | List all sessions |
| `/api/sessions` | POST | Create session. Body: `{"tools_approved": true}`. Returns session object with `id`. |
| `/api/sessions/{id}` | GET | Get session details and message history |
| `/api/sessions/{id}/agent/{name}` | POST | Send messages to agent. Body: `[{"role":"user","content":"..."}]`. Returns SSE stream. |

**Agent name resolution:** The `{name}` in the agent endpoint comes from the
**config filename** (e.g., `soul.yaml` → agent name is `soul`), NOT from the
`name:` field in the YAML or the agents map key. This is a cagent convention.

**SSE stream event types:**

| Event Type | When | Contains |
|---|---|---|
| `agent_info` | Start of stream | Agent name, model, welcome message |
| `team_info` | Start of stream | Available agents list |
| `toolset_info` | Start of stream | Number of available tools |
| `stream_started` | Agent begins processing | Session ID |
| `agent_choice_reasoning` | During inference (thinking) | Reasoning text (extended thinking) |
| `agent_choice` | During inference | **Response text tokens** — this is the actual reply |
| `partial_tool_call` | Tool being called | Tool name and partial arguments (streaming) |
| `tool_call_confirmation` | Tool awaiting approval | Only if `tools_approved: false` — **blocks stream** |
| `tool_result` | After tool execution | Tool output |
| `message_added` | Message persisted | Session ID |
| `token_usage` | After each model turn | Input/output tokens, cost |
| `session_title` | Auto-generated | Session title from content |
| `stream_stopped` | End of stream | Session ID |
| `error` | On failure | Error message |

**Multi-turn tool streams:** A single SSE stream may contain multiple model
turns. When the model calls a tool, the stream continues through:
`agent_choice_reasoning` → `partial_tool_call` → (tool executes) →
`tool_result` → `agent_choice` (final response). The gateway must read the
**entire stream** to collect all `agent_choice` content.

### 7.4 Volume Mounts

| Mount | Type | Container Path | Purpose |
|---|---|---|---|
| `~/.mobyclaw/` | Bind mount | `/home/agent/.mobyclaw` | All agent state: memory, soul, sessions, logs |
| Agent config | Bind mount (ro) | `/agent/` | Agent YAML (from repo) |

**Key principle:** Everything lives at `~/.mobyclaw/` on the host. No Docker
volumes. This means:
- All state persists across container restarts
- `cp -r ~/.mobyclaw/ backup/` is a complete backup
- `docker system prune` won't destroy anything

### 7.4 Secrets & Environment Variables

All secrets and configuration live in a **single `.env` file** at the project
root. Docker Compose loads it via `env_file` and injects variables into the
right containers.

#### Strategy

- **One `.env` file** — single place for all secrets. No scattered config.
- **`.env.example`** — checked into git with placeholder values. Users copy to
  `.env` and fill in their keys.
- **`.env` is gitignored** — never committed. `.gitignore` includes `.env` from
  day one.
- **No secrets baked into images** — the Dockerfile never `COPY`s `.env` or
  `ARG`s secrets. They're injected at runtime via Compose.
- **Least-privilege distribution** — each container only receives the env vars
  it needs. The agent container gets LLM API keys. The gateway gets messaging
  tokens. Neither gets the other's secrets.

#### Why `.env` file (not Docker Secrets, Vault, etc.)

Mobyclaw is a **personal agent on your own machine**. Docker Secrets requires
Swarm mode. Vault/SOPS/etc. add operational complexity for zero benefit when
you're the only user. A `.env` file is:
- Simple: one file, `cp .env.example .env`, edit, done
- Standard: Docker Compose native support, every dev knows it
- Portable: copy `.env` to a new machine alongside `~/.mobyclaw/`
- Secure enough: file permissions (`chmod 600 .env`), gitignored, never in images

If someone deploys mobyclaw on a shared server or CI, they can use their
platform's native secret injection (GitHub Actions secrets, systemd credentials,
etc.) — those just set env vars, which Compose picks up the same way.

#### Variable Reference

| Variable | Container | Required | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | moby | Yes (if using Anthropic) | Anthropic model access |
| `OPENAI_API_KEY` | moby | Yes (if using OpenAI) | OpenAI model access |
| `TELEGRAM_BOT_TOKEN` | gateway | No | Enables Telegram adapter |
| `DISCORD_BOT_TOKEN` | gateway | No | Enables Discord adapter |
| `SLACK_BOT_TOKEN` | gateway | No | Enables Slack adapter |
| `WHATSAPP_AUTH` | gateway | No | Enables WhatsApp adapter |
| `MOBYCLAW_HEARTBEAT_INTERVAL` | gateway | No | Heartbeat frequency (default: `30m`) |
| `MOBYCLAW_HOME` | all | No | Override `~/.mobyclaw/` path |

**Convention:** Messaging adapter tokens double as feature flags — if
`TELEGRAM_BOT_TOKEN` is unset, the Telegram adapter simply doesn't load.
No token = no adapter = no error.

#### Least-Privilege Distribution in Compose

```yaml
services:
  moby:
    environment:
      - ANTHROPIC_API_KEY         # LLM keys only
      - OPENAI_API_KEY
    # NO messaging tokens

  gateway:
    environment:
      - TELEGRAM_BOT_TOKEN        # Messaging tokens only
      - DISCORD_BOT_TOKEN
      - SLACK_BOT_TOKEN
      - WHATSAPP_AUTH
      - MOBYCLAW_HEARTBEAT_INTERVAL
    # NO LLM API keys
```

The `.env` file holds everything, but Compose's per-service `environment`
block controls which container sees which variable. This way, a compromised
gateway can't leak your Anthropic key, and a compromised agent can't access
your Telegram bot.

#### `.env.example` Template

```bash
# ─── LLM Provider Keys ───────────────────────────────────────
# At least one is required. Uncomment and fill in.
ANTHROPIC_API_KEY=
# OPENAI_API_KEY=

# ─── Messaging (all optional) ────────────────────────────────
# Set a token to enable that channel. No token = adapter disabled.
# TELEGRAM_BOT_TOKEN=
# DISCORD_BOT_TOKEN=
# SLACK_BOT_TOKEN=
# WHATSAPP_AUTH=

# ─── Agent Settings ──────────────────────────────────────────
# MOBYCLAW_HOME=~/.mobyclaw
# MOBYCLAW_HEARTBEAT_INTERVAL=30m
```

#### File Permissions

`mobyclaw init` sets `chmod 600 .env` after creating it. The `.env` file
contains API keys worth money — it should only be readable by the owner.

---

## 8. Docker Compose Design

### 8.1 Phase 1 — Agent Only (no gateway)

```yaml
services:
  moby:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    volumes:
      - ./agents/moby:/agent:ro
      - ${MOBYCLAW_HOME:-~/.mobyclaw}:/home/agent/.mobyclaw
    env_file:
      - .env
    restart: unless-stopped
    networks:
      - mobyclaw
    deploy:
      resources:
        limits:
          memory: 2g
          cpus: "1.0"

networks:
  mobyclaw:
    driver: bridge
```

### 8.3 Compose Override Generation

User-specific configuration (credentials and workspaces) is injected via
`docker-compose.override.yml`, which is **auto-generated** by the CLI on
every `mobyclaw up`. This file is gitignored and treated as a derived
artifact — never hand-edited.

**Mechanism:**

```
mobyclaw up
  │
  ├─ Read ~/.mobyclaw/credentials.env
  ├─ Read ~/.mobyclaw/workspaces.conf
  ├─ Generate docker-compose.override.yml
  │     ├─ env_file: for credentials (if any key=value lines exist)
  │     └─ volumes:  for workspaces (if any name=path lines exist)
  └─ docker compose up (picks up override automatically)
```

**Generated override example:**

```yaml
# AUTO-GENERATED by mobyclaw — do not edit manually
services:
  moby:
    env_file:
      - /Users/you/.mobyclaw/credentials.env
    volumes:
      - /Users/you/projects/myapp:/workspace/myapp
      - /Users/you/Documents/notes:/workspace/notes
```

**Design decisions:**
- **Override, not inline in docker-compose.yml** — The base compose file stays
  static and git-committed. Per-user config lives in the override. Docker
  Compose merges them automatically.
- **Regenerated every time** — The override is rebuilt from `credentials.env`
  and `workspaces.conf` on each `up`. This means edits to those config files
  take effect immediately on next restart.
- **Graceful degradation** — If both files are empty/missing/comment-only,
  no override is generated and the base compose works as-is.
- **Absolute paths** — The override uses absolute paths to `credentials.env`
  because Docker Compose resolves env_file paths relative to the compose file
  location, not the user's home.

**Why `docker-compose.override.yml` (not `-f` flag)?**
Docker Compose automatically loads `docker-compose.override.yml` when it
exists in the same directory. No need for extra `-f` flags. The CLI's
`docker compose -f docker-compose.yml` still picks it up.

Phase 1 is **one container**. moby has `~/.mobyclaw/` bind-mounted and uses
cagent's built-in filesystem tools to read/write memory directly. No separate
memory or workspace services yet.

### 8.2 Phase 2 — Full Stack with Gateway

```yaml
services:
  moby:
    build:
      context: .
      dockerfile: Dockerfile
    volumes:
      - ./agents/moby:/agent:ro
      - ${MOBYCLAW_HOME:-~/.mobyclaw}:/home/agent/.mobyclaw
    env_file:
      - .env
    environment:
      - ANTHROPIC_API_KEY         # LLM keys only
      - OPENAI_API_KEY
    restart: unless-stopped
    networks:
      - mobyclaw

  gateway:
    build:
      context: ./gateway
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    volumes:
      - ${MOBYCLAW_HOME:-~/.mobyclaw}:/data/.mobyclaw
    env_file:
      - .env
    environment:
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
      - DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN:-}
      - SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN:-}
      - WHATSAPP_AUTH=${WHATSAPP_AUTH:-}
      - MOBYCLAW_HEARTBEAT_INTERVAL=${MOBYCLAW_HEARTBEAT_INTERVAL:-30m}
    depends_on:
      - moby
    restart: unless-stopped
    networks:
      - mobyclaw

networks:
  mobyclaw:
    driver: bridge
```

---

## 9. CLI Design (`mobyclaw`)

A **bash script** at `./mobyclaw` that wraps Docker Compose with agent-aware
commands. It's the primary interface for setting up, running, and interacting
with moby.

### Commands

| Command | What it does | Phase |
|---|---|---|
| `mobyclaw init` | **Interactive setup** — LLM, channels, agent config | 1 |
| `mobyclaw up` | Start Moby (runs init automatically if needed) | 1 |
| `mobyclaw down` | Stop everything | 1 |
| `mobyclaw logs [service]` | Tail logs | 1 |
| `mobyclaw status` | Show running services, connected channels, agent health | 1 |
| `mobyclaw run "<prompt>"` | Send a one-shot prompt to moby via HTTP | 1 |
| `mobyclaw chat` | Interactive chat session with moby (CLI) | 1 |
| `mobyclaw exec` | Shell into the agent container | 1 |
| `mobyclaw workspace list` | Show mounted workspaces | 1 |
| `mobyclaw workspace add <path> [name]` | Mount a host folder | 1 |
| `mobyclaw workspace remove <name>` | Unmount a folder | 1 |
| `mobyclaw help` | Show help | 1 |
| `mobyclaw version` | Show version | 1 |
| `mobyclaw memory` | Show recent memory entries | 2 |
| `mobyclaw cron list` | Show scheduled cron jobs | 2 |
| `mobyclaw cron add` | Add a cron job | 2 |
| `mobyclaw channels` | Show connected messaging channels | 2 |

### `mobyclaw init` — Interactive Onboarding

The init command is the entry point for new users. It walks through setup
interactively, asking only what's needed and skipping everything else.

**Flow:**

```
mobyclaw init
  │
  ├─ 1. Check prerequisites (docker, curl)
  │     └─ Fail fast if missing
  │
  ├─ 2. LLM Provider
  │     ├─ Choose: Anthropic / OpenAI / Both
  │     ├─ Enter API key(s) (hidden input)
  │     └─ Choose model (sensible default offered)
  │
  ├─ 3. Messaging Channels (all optional, default: skip)
  │     ├─ Telegram?  → token or skip
  │     ├─ Discord?   → token or skip
  │     ├─ Slack?     → token or skip
  │     └─ WhatsApp?  → auth or skip
  │
  ├─ 4. Service Credentials (all optional, default: skip)
  │     ├─ GitHub?  → GH_TOKEN or skip
  │     ├─ AWS?     → key pair or skip
  │     └─ Custom?  → name=value loop
  │
  ├─ 5. Workspace Folders (all optional, default: skip)
  │     └─ Add folder?  → path + name loop
  │
  ├─ 6. Agent Settings
  │     ├─ Heartbeat interval (default: 30m)
  │     └─ Data directory (default: ~/.mobyclaw)
  │
  ├─ 7. Create data directory
  │     ├─ ~/.mobyclaw/{memory,sessions,logs}/
  │     ├─ Copy soul.yaml (if not exists — never overwrite)
  │     ├─ Copy MEMORY.md (if not exists)
  │     ├─ Copy HEARTBEAT.md (if not exists)
  │     ├─ Write credentials.env (append new, keep existing)
  │     └─ Write workspaces.conf (append new, keep existing)
  │
  ├─ 8. Write .env file
  │     ├─ All config in one file
  │     ├─ chmod 600 (secrets protection)
  │     └─ Commented-out lines for skipped services
  │
  ├─ 9. Generate docker-compose.override.yml
  │     ├─ env_file for credentials (if any)
  │     └─ volumes for workspaces (if any)
  │
  └─ 10. Summary + next steps
        ├─ What was configured
        ├─ What files were created
        └─ "Run: mobyclaw up"
```

**Design principles for init:**

- **Skip by default** — Messaging channels default to "no". Only LLM is
  required. This means a user can get running with just an API key.
- **Never overwrite user data** — If `~/.mobyclaw/soul.yaml` already exists,
  init keeps it. Re-running init is safe.
- **Re-runnable** — Running `init` again asks if you want to overwrite `.env`.
  Useful for adding a new channel or changing providers.
- **Hidden input for secrets** — API keys use `read -s` (no echo). Never
  shown on screen.
- **Sensible defaults everywhere** — Enter through the whole flow and you
  get a working setup with Anthropic Claude.
- **Guidance inline** — Each channel prompt includes a brief hint on where
  to get the token (BotFather link, Discord dev portal, etc.).

### Design Decisions

- **Bash script, not a compiled binary** — Keep it simple. Docker + curl + jq
  are the only dependencies.
- **Thin wrapper over docker compose** — CLI adds agent-awareness but delegates
  all container lifecycle to Compose.
- **`mobyclaw run` uses HTTP** — Sends a prompt to cagent's API via curl.
- **`mobyclaw chat` for interactive** — Opens a streaming conversation loop.
- **`mobyclaw up` auto-inits** — Running `up` without prior init seamlessly
  runs the full init flow, then immediately starts containers. One command
  from zero to running agent. `init` still exists as a standalone command
  for users who want to configure without starting.
- **`mobyclaw init` is interactive, not flag-based** — A personal agent setup
  is a one-time event. Interactive prompts are friendlier than `--flag` soup.
  Power users can skip init entirely and just write `.env` manually.

---

## 10. Agent Loop (Powered by cagent)

We do NOT implement our own agent loop. cagent handles the full cycle:

```
Prompt (from gateway, CLI, or scheduler)
  │
  ▼
cagent serve api
  │
  ├─ Assembles system prompt (soul.yaml instruction + context)
  ├─ Model inference (Anthropic/OpenAI/etc.)
  ├─ Tool execution (shell, filesystem, fetch, etc.)
  │   ├─ Read MEMORY.md, memory/*.md
  │   ├─ Write new memories
  │   ├─ Execute shell commands
  │   ├─ Tool results fed back to model
  │   └─ Loop until model produces final response
  ├─ Response streaming
  └─ Session persistence (managed by cagent)
```

**Design decision:** Delegating the agent loop entirely to cagent means:
- We get tool execution, streaming, retries, context management for free
- We focus on what matters: orchestration, messaging, and memory
- Upgrades to cagent automatically improve all mobyclaw agents

---

## 11. Security Model

### Phase 1 (Simple)

| Concern | Mitigation |
|---|---|
| Agent isolation | Runs in its own container |
| Workspace access | Volume mounts control what agent can see |
| API key exposure | `.env` file, not baked into images; least-privilege per container (§7.4) |
| Network access | Agent can reach internet (needed for LLM APIs) |
| Resource limits | Compose `deploy.resources` caps memory + CPU |
| Host access | Non-root container user, no privileged mode |

### Phase 2 (Hardened)

- Read-only root filesystem with tmpfs for `/tmp`
- Network policy: agent can only reach LLM APIs + gateway
- DM access control: allowlists per messaging channel
- Agent-specific API key scoping
- Workspace access tiers: `none`, `ro`, `rw`

---

## 12. Phased Roadmap

### Phase 1 — Agent in a Box ✦ START HERE

**Goal:** Run moby in a Docker container with persistent memory, interact via CLI.

Deliverables:
1. `agents/moby/soul.yaml` — Moby's personality, model, tools, behavior (all-in-one)
3. `Dockerfile` — Agent base image with cagent
4. `docker-compose.yml` — Single-service compose (moby only)
5. `mobyclaw` — CLI script (up, down, logs, status, run, chat)
6. `.env.example` — API key template
7. `README.md` — Getting started guide

Success criteria:
- `mobyclaw up` starts moby in a container (long-lived, always running)
- `mobyclaw up` on a fresh machine walks through interactive setup first
- `mobyclaw run "Hello, who are you?"` gets a personality-rich response
- `mobyclaw run "Remember that my name is Alice"` → agent writes to `~/.mobyclaw/MEMORY.md`
- `mobyclaw run "What's my name?"` → agent recalls from MEMORY.md
- `mobyclaw chat` opens an interactive session
- Memory persists across `mobyclaw down && mobyclaw up`

### Phase 2 — Gateway + Messaging

**Goal:** Chat with moby through Telegram. Heartbeat and cron working.

Deliverables:
- `gateway/` — Gateway container (message routing, sessions, scheduler)
- Messaging adapters (Telegram first, then WhatsApp, Discord, Slack)
- Heartbeat system (periodic agent wake-ups)
- Cron job system (scheduled tasks)
- Session management (conversation threads per user/channel)
- Updated docker-compose.yml with gateway service
- `mobyclaw channels` and `mobyclaw cron` CLI commands

Success criteria:
- Send a Telegram message → get a response from moby
- Moby remembers conversations across Telegram messages
- Heartbeat fires every 30m, moby checks HEARTBEAT.md
- Cron job sends a daily morning summary to Telegram
- `mobyclaw status` shows connected channels

### Phase 3 — Workspace + Integrations

**Goal:** Agent can access local files. More messaging channels.

Deliverables:
- Workspace service (local filesystem mounts, MCP server)
- More messaging adapters in gateway (WhatsApp, Discord, Slack)
- Vector memory search (semantic recall over memory files)
- Webhook ingress (GitHub events, etc.)
- Web UI for management and chat

### Phase 4 — Production Hardening

**Goal:** Ready for real 24/7 workloads.

Deliverables:
- Security hardening (seccomp, read-only root, network policy)
- Monitoring and observability (logs, metrics, health checks)
- Session compaction (summarize old context)
- Auto memory flush before compaction
- Plugin/skill system


---

## 13. Key Architectural Decisions Log

| # | Decision | Rationale | Date |
|---|---|---|---|
| ADR-001 | Use cagent native YAML, no wrapper format | Zero translation layer, users get full cagent features | 2026-02-23 |
| ADR-002 | `soul.yaml` as single identity file per agent | Simpler than OpenClaw's 6+ bootstrap files. Can add more via `add_prompt_files` | 2026-02-23 |
| ADR-003 | `cagent serve api` as primary container entrypoint | HTTP API is the natural interface for containerized agents | 2026-02-23 |
| ADR-004 | Bash CLI, not compiled binary | Minimal dependencies (docker, curl, jq). Ship fast, iterate. | 2026-02-23 |
| ADR-005 | Debian slim base image | Better cagent/tool compat than Alpine. Acceptable size trade-off. | 2026-02-23 |
| ADR-006 | `mobyclaw.yaml` is dev-only, not product config | Separation of concerns: dev agent ≠ product agent | 2026-02-23 |
| ADR-007 | "moby" as the default/reference agent | Clear identity, easy onboarding, extensible pattern | 2026-02-23 |
| ADR-008 | Docker Compose over Kubernetes | Right-sized for personal agent deployment. K8s is overkill. | 2026-02-23 |
| ADR-009 | Delegate agent loop entirely to cagent | Focus on orchestration, not reimplementing inference + tool execution | 2026-02-23 |
| ADR-010 | Memory as plain Markdown files (OpenClaw pattern) | Simple, portable, agent can read/write with filesystem tools. No DB needed. | 2026-02-23 |
| ADR-011 | Gateway as separate container from agent | Clean separation: gateway handles I/O + routing, agent handles thinking + acting | 2026-02-23 |
| ADR-012 | Messaging adapters inside gateway, not separate containers | Simpler (one container), all JS libs anyway, enable/disable via env vars. Matches OpenClaw. | 2026-02-23 |
| ADR-013 | Docker volumes for persistence | Workspace (memory) and data (sessions, cron) survive container restarts | 2026-02-23 |
| ADR-014 | 4-service separation: moby, gateway, workspace, memory | Each concern in its own container. Clean ownership. Independent scaling/failure. | 2026-02-23 |
| ADR-015 | Workspace + memory as MCP servers | cagent's `type: mcp` toolset connects moby to services. No direct host mounts on agent. | 2026-02-23 |
| ADR-016 | Separate workspace and memory volumes | Workspace = host files (projects, code). Memory = agent state (MEMORY.md, daily logs). Different lifecycles, different owners. | 2026-02-23 |
| ADR-017 | `~/.mobyclaw/` as user data directory, bind-mounted | User-visible, editable, portable, survives `docker system prune`. Not a Docker volume. | 2026-02-23 |
| ADR-018 | Messaging adapters inside gateway, not separate bridge containers | Simpler, less config, matches OpenClaw. Enable via env var presence. | 2026-02-23 |
| ADR-019 | Single agent only — no multi-agent support | Mobyclaw is a personal agent, not a platform. One agent (moby), one container. Simplifies routing, config, and mental model. Can always revisit. | 2026-02-23 |
| ADR-020 | Sessions created with `tools_approved: true` | `cagent serve api` pauses at `tool_call_confirmation` unless the session has `tools_approved: true`. Gateway sets this on session creation. Container isolation provides the safety boundary. | 2026-02-23 |
| ADR-021 | `.env` file for secrets management | Single file, Docker Compose native, no Swarm/Vault needed. Least-privilege: per-service `environment` blocks control which container sees which var. | 2026-02-23 |
| ADR-022 | End-to-end streaming via SSE PassThrough | cagent emits tokens in real-time. Gateway streams them through via PassThrough piped to HTTP response. Critical: use `res.on('close')` not `req.on('close')` for disconnect detection. Telegram adapter edits message every ~1s. CLI prints tokens to stdout. | 2026-02-23 |
| ADR-023 | `docker-compose.override.yml` for per-user config | Base compose stays static + git-committed. Override is auto-generated from `credentials.env` + `workspaces.conf` on every `mobyclaw up`. Docker Compose merges them automatically. Gitignored. | 2026-02-23 |
| ADR-024 | Separate `credentials.env` from `.env` | `.env` = mobyclaw infra (LLM keys, messaging). `credentials.env` = user service tokens (gh, aws). Different owners, different lifecycle. credentials.env lives in `~/.mobyclaw/` (portable with agent state). | 2026-02-23 |
| ADR-025 | Workspaces as host bind mounts via `workspaces.conf` | Simple `name=path` format in `~/.mobyclaw/workspaces.conf`. CLI manages it (`workspace add/remove/list`). Override generation maps to Docker volumes. Changes require restart. | 2026-02-23 |

---

## 14. Open Questions

- ~~**cagent serve api exact endpoints**~~: **RESOLVED** — See §7.3.
- ~~**cagent session management**~~: **RESOLVED** — cagent manages sessions natively.
  Gateway only needs to track channelId → sessionId mapping.
- ~~**Gateway language**~~: **RESOLVED** — Node.js (JavaScript). Telegraf, express,
  and other messaging libraries are all JS. Works well.
- ~~**Health checks**~~: **RESOLVED** — `GET /api/ping` returns `{"status":"ok"}`.
  Used in Dockerfile HEALTHCHECK and gateway's `waitForReady()`.
- **MCP stdio over network**: cagent's MCP toolset uses `command` (stdio transport).
  For workspace/memory in separate containers, we need a thin CLI client that
  bridges stdio ↔ network (e.g., `mcp-client http://workspace:9100`). Need to
  build or find this.
- **Memory search**: Phase 2+ needs vector search over memory files. Options:
  embedded SQLite with vector extension, or a lightweight sidecar (Qdrant, Chroma).
- **Hot reload**: Can we update `soul.yaml` without restarting the agent container?
  cagent may re-read instructions on each request.
- **Heartbeat in Phase 1**: Could we do a lightweight heartbeat via a simple
  cron/timer on the host that curls the agent API? This would give us heartbeat
  behavior even before the gateway exists.

---

*Last updated: 2026-02-23*
