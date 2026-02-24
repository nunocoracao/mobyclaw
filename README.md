# 🐋 mobyclaw

[![GitHub Pages](https://img.shields.io/badge/docs-GitHub%20Pages-blue?logo=github)](https://nunocoracao.github.io/mobyclaw/)
[![Docker](https://img.shields.io/badge/runs%20on-Docker-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/get-docker/)
[![Powered by cagent](https://img.shields.io/badge/powered%20by-cagent-8B5CF6)](https://github.com/docker/cagent)

**Your personal AI agent, containerized.**

Mobyclaw is a long-lived personal AI agent that runs in Docker containers.
You deploy it, connect your messaging apps, and it becomes your always-on AI
companion - with persistent memory, a personality, and the ability to take
action on your behalf.

**One command to start. Remembers everything. Always running.**

```bash
./mobyclaw up
```

> 📖 **Full documentation:** [nunocoracao.github.io/mobyclaw](https://nunocoracao.github.io/mobyclaw/)

---

## Features

- **Always on** - runs as a Docker Compose stack, restarts automatically
- **Persistent memory** - remembers who you are, what you've discussed, your preferences (plain Markdown files you can read and edit)
- **Chat via Telegram** - streaming responses with real-time tool status indicators
- **CLI chat** - interactive terminal sessions and one-shot prompts
- **Scheduling & reminders** - set reminders, recurring tasks, and timed notifications
- **Proactive heartbeat** - wakes itself up periodically to check on tasks and notify you
- **Workspace access** - mount your project folders so the agent can read and edit your actual code
- **Service credentials** - give it your GitHub token, AWS keys, etc. and it uses CLIs on your behalf
- **Self-modifying** - can edit its own config, personality, and even source code, then trigger rebuilds
- **Auto-backup** - scheduled backups of agent state to a private GitHub repo
- **Your machine, your data** - runs locally, no SaaS, your API keys

---

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│                  Docker Compose Stack                     │
│                                                          │
│  ┌──────────────────┐   HTTP+SSE   ┌─────────────────┐  │
│  │     gateway       │─────────────▶│      moby       │  │
│  │    (Node.js)      │              │  (cagent API)   │  │
│  │                   │              │                 │  │
│  │  Telegram adapter │              │  LLM inference  │  │
│  │  Session mgmt     │              │  Shell access   │  │
│  │  Scheduler/cron   │              │  Filesystem     │  │
│  │  Heartbeat        │              │  HTTP fetch     │  │
│  │  REST API         │              │  Memory R/W     │  │
│  └──────────────────┘              └─────────────────┘  │
│                                                          │
│  Volumes:                                                │
│    ~/.mobyclaw/  ─── memory, config, schedules, sessions │
│    /workspace/* ─── your project folders (bind mounts)   │
└──────────────────────────────────────────────────────────┘
```

Powered by [cagent](https://github.com/docker/cagent) for the agent loop -
LLM inference, tool execution, and session management are all handled by
cagent. Mobyclaw adds orchestration, messaging, scheduling, and persistent
memory on top.

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
- Messaging channels - Telegram (optional, more coming)
- Service credentials - GitHub, AWS, custom (all optional)
- Workspace folders - mount host directories into the agent (optional)

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
./mobyclaw init    # prompts for GitHub, AWS, custom credentials

# Or edit directly:
vim ~/.mobyclaw/credentials.env
```

Format is standard `KEY=value`:

```
GH_TOKEN=ghp_xxxxxxxxxxxx
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

Credentials are injected as environment variables into the agent container.
The agent is instructed never to display credential values.

---

## Configuration

Everything lives in two places:

### Project root (git-tracked infrastructure)

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Static compose manifest |
| `.env` | API keys, messaging tokens, settings (gitignored) |
| `agents/moby/soul.yaml` | Default agent personality |

### `~/.mobyclaw/` (user data, portable)

| File | Purpose |
|------|---------|
| `soul.yaml` | Agent personality + config (user-editable) |
| `MEMORY.md` | Long-term curated memory |
| `TASKS.md` | Task and reminder list |
| `HEARTBEAT.md` | Heartbeat checklist |
| `credentials.env` | Service credentials (GH_TOKEN, AWS, etc.) |
| `workspaces.conf` | Workspace folder mappings |
| `memory/` | Daily logs (YYYY-MM-DD.md) |
| `sessions/` | Session persistence |

**Portability:** Copy `~/.mobyclaw/` to a new machine and your agent comes
with you - memory, personality, credentials, everything.

### Customize the personality

Edit `~/.mobyclaw/soul.yaml` - the `instruction:` block is the agent's
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
├── mobyclaw                   # CLI (bash script)
├── docker-compose.yml         # Compose manifest
├── Dockerfile                 # Agent image: Debian + cagent + dev tools
├── agents/moby/
│   ├── soul.yaml              # Agent personality, model, tools
│   └── defaults/              # Templates copied to ~/.mobyclaw/ on init
├── gateway/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js           # Express app + REST API
│       ├── agent-client.js    # HTTP client for cagent with SSE streaming
│       ├── sessions.js        # Single session with FIFO queue
│       ├── scheduler.js       # Schedules, reminders, heartbeat
│       ├── tool-labels.js     # Tool name formatting for Telegram
│       └── adapters/
│           └── telegram.js    # Telegram bot with streaming message edits
├── site/                      # GitHub Pages landing page + mkdocs source
├── docs/                      # Architecture documentation
├── architecture.md            # Design document
└── README.md
```

---

## Architecture

See [architecture.md](architecture.md) for the full design document, or browse
the [online docs](https://nunocoracao.github.io/mobyclaw/docs/).

### Key design choices

- **cagent native** - uses cagent's YAML format directly, no wrapper layer
- **Docker Compose** - right-sized for personal deployment (not Kubernetes)
- **Single agent** - one agent, one container, one personality
- **Plain files** - memory is Markdown, config is YAML, secrets are `.env`
- **Bind mounts** - all state at `~/.mobyclaw/`, not Docker volumes (survives `docker system prune`)

---

## Roadmap

- [x] **Phase 1** - Agent in a box (CLI, memory, Docker Compose)
- [x] **Phase 2** - Gateway + Telegram streaming, heartbeat, scheduling, reminders
- [ ] **Phase 3** - More messaging channels, webhook ingress, vector memory search
- [ ] **Phase 4** - Production hardening (seccomp, network policy, monitoring)

---

## License

MIT
