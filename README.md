# 🐋 mobyclaw

Your personal AI agent, containerized.

Mobyclaw is a long-lived personal AI agent that runs in Docker containers.
You deploy it, connect your messaging apps, and it becomes your always-on AI
companion — with persistent memory, a personality, and the ability to take
action on your behalf.

**One command to start. Remembers everything. Always running.**

```
./mobyclaw up
```

---

## What it does

- **Always on** — runs as a Docker Compose stack, restarts automatically
- **Persistent memory** — remembers who you are, what you've discussed, your preferences (plain Markdown files)
- **Multiple channels** — talk to it via CLI, Telegram, Discord, Slack, or WhatsApp
- **Takes action** — runs shell commands, reads/writes files, fetches URLs
- **Workspaces** — mount your project folders so the agent can read and edit your code
- **Service credentials** — give it your GitHub token, AWS keys, etc. and it uses CLIs on your behalf
- **Proactive** — heartbeats and cron jobs let it wake itself up and check on things
- **Your machine, your data** — runs locally, no SaaS, your API keys

## How it works

```
┌─────────────────────────────────────────────────┐
│              Docker Compose Stack                │
│                                                  │
│  ┌────────────────┐      ┌───────────────────┐  │
│  │    gateway      │ HTTP │      moby         │  │
│  │   (Node.js)     │─────▶│   (cagent API)    │  │
│  │                 │      │                   │  │
│  │ Telegram, CLI,  │      │ LLM inference,    │  │
│  │ Discord, Slack  │      │ tool execution,   │  │
│  │                 │      │ memory read/write  │  │
│  └────────────────┘      └───────────────────┘  │
│                                                  │
│  Volumes: ~/.mobyclaw/ (memory, config, logs)    │
│           /workspace/* (your project folders)    │
└─────────────────────────────────────────────────┘
```

Powered by [cagent](https://github.com/docker/cagent) for the agent loop —
LLM inference, tool execution, and session management are all handled by
cagent. Mobyclaw adds orchestration, messaging, and persistent memory on top.

---

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (with Compose v2)
- An LLM API key ([Anthropic](https://console.anthropic.com/) or [OpenAI](https://platform.openai.com/))
- `curl` and `jq`
- The `cagent` binary (place in project root — see [cagent releases](https://github.com/docker/cagent))

### 1. Clone and start

```bash
git clone https://github.com/nunocoracao/mobyclaw.git
cd mobyclaw

# Download cagent binary for your platform and place it in the project root
# chmod +x cagent

./mobyclaw up    # interactive setup on first run, then starts containers
```

The first run walks you through setup:
- LLM provider and API key (required)
- Messaging channels — Telegram, Discord, Slack, WhatsApp (all optional)
- Service credentials — GitHub, AWS, custom (all optional)
- Workspace folders — mount host directories into the agent (optional)

### 2. Talk to Moby

```bash
# One-shot prompt
./mobyclaw run "Hello Moby, who are you?"

# Interactive chat
./mobyclaw chat

# Send via Telegram (if configured)
# Just message your bot on Telegram!
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

Mount your project folders so Moby can read and edit your files:

```bash
./mobyclaw workspace add ~/projects/myapp
./mobyclaw workspace add ~/Documents/notes docs
./mobyclaw workspace list
./mobyclaw workspace remove myapp
```

Workspaces appear at `/workspace/<name>` inside the agent container.
Changes are bidirectional and immediate (bind mounts). Requires a restart
to take effect.

You can also edit `~/.mobyclaw/workspaces.conf` directly:

```
myapp=/Users/you/projects/myapp
notes=/Users/you/Documents/notes
```

## Service Credentials

Give Moby access to CLIs like `gh`, `aws`, etc.:

```bash
# During init:
./mobyclaw init    # prompts for GitHub, AWS, custom credentials

# Or edit directly:
vim ~/.mobyclaw/credentials.env
```

Format is standard `KEY=value`:

```
GH_TOKEN=ghp_xxxxxxxxxxxx
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
NPM_TOKEN=npm_...
```

Credentials are injected as environment variables into the agent container.
Moby's instructions prohibit it from displaying credential values.

---

## Configuration

Everything lives in two places:

### Project root (git-committed infrastructure)

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Static compose manifest |
| `.env` | API keys, messaging tokens, settings (gitignored) |
| `.env.example` | Template for `.env` |
| `agents/moby/soul.yaml` | Default agent personality |

### `~/.mobyclaw/` (user data, portable)

| File | Purpose |
|------|---------|
| `soul.yaml` | Agent personality + config (user-editable) |
| `MEMORY.md` | Long-term curated memory |
| `HEARTBEAT.md` | Heartbeat checklist |
| `credentials.env` | Service credentials (GH_TOKEN, AWS, etc.) |
| `workspaces.conf` | Workspace folder mappings |
| `memory/` | Daily logs (YYYY-MM-DD.md) |
| `sessions/` | Conversation history |
| `logs/` | Agent activity logs |

**Portability:** Copy `~/.mobyclaw/` to a new machine and your agent comes
with you — memory, personality, credentials, everything.

### Customize Moby's personality

Edit `~/.mobyclaw/soul.yaml` — the `instruction:` block is Moby's personality
in Markdown. Changes take effect on the next message (no restart needed).

---

## CLI Reference

```
Usage: mobyclaw <command> [options]

Commands:
  init                          Interactive setup
  up                            Start Moby (runs init if needed)
  down                          Stop everything
  logs [service]                Tail container logs
  status                        Show health and services
  run "<prompt>"                Send a one-shot prompt
  chat                          Interactive chat session
  exec                          Shell into the agent container
  workspace list                Show mounted workspaces
  workspace add <path> [name]   Mount a host folder
  workspace remove <name>       Unmount a folder
  help                          Show this help
  version                       Show version
```

---

## Architecture

See [architecture.md](architecture.md) for the full design document, including:

- Container roles and how they connect
- cagent HTTP API reference and SSE event types
- Memory system design
- Streaming architecture (gateway → Telegram progressive edits)
- Security model
- All architectural decision records (ADRs)

### Key design choices

- **cagent native** — uses cagent's YAML format directly, no wrapper layer
- **Docker Compose** — right-sized for personal deployment (not Kubernetes)
- **Single agent** — one agent (Moby), one container, one personality
- **Plain files** — memory is Markdown, config is YAML, secrets are `.env`
- **Bind mounts** — all state at `~/.mobyclaw/`, not Docker volumes (survives `docker system prune`)

---

## Project Structure

```
mobyclaw/
├── agents/moby/
│   ├── soul.yaml              # Agent personality, model, tools, behavior
│   └── defaults/              # Templates copied to ~/.mobyclaw/ on init
│       ├── MEMORY.md
│       ├── HEARTBEAT.md
│       ├── credentials.env
│       └── workspaces.conf
├── gateway/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js           # Express app, /prompt and /prompt/stream
│       ├── agent-client.js    # HTTP client for cagent with SSE streaming
│       ├── sessions.js        # Session store with per-channel queuing
│       ├── tool-labels.js     # Tool name → human-readable label formatting
│       └── adapters/
│           └── telegram.js    # Telegraf bot with progressive message editing
├── Dockerfile                 # Agent image: Debian + cagent + dev tools
├── docker-compose.yml         # Static compose manifest
├── .env.example               # Config template
├── mobyclaw                   # CLI (bash)
├── architecture.md            # Full design document
└── README.md
```

---

## Roadmap

- [x] **Phase 1** — Agent in a box (CLI, memory, Docker Compose)
- [x] **Phase 2** — Gateway + Telegram streaming
- [ ] **Phase 3** — More messaging channels, webhook ingress, vector memory search
- [ ] **Phase 4** — Production hardening (seccomp, network policy, monitoring)

---

## License

Private project.
