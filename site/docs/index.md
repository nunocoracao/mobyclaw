# 🐋 Mobyclaw

**A long-lived personal AI agent that runs in Docker on your machine.**

Always on, always remembering, always ready to help. Chat via Telegram, get proactive reminders, and let it work on your projects — all with persistent memory.

---

## Quick Start

```bash
git clone https://github.com/nunocoracao/mobyclaw.git
cd mobyclaw
./mobyclaw init    # interactive setup
./mobyclaw up      # start Moby
./mobyclaw chat    # talk to Moby
```

---

## What makes Mobyclaw different?

| Feature | Description |
|---|---|
| 🧠 **Persistent Memory** | Remembers your name, preferences, projects, conversations — in plain Markdown files |
| 🐳 **Runs in Docker** | One `docker compose up` — isolated, reproducible, portable |
| 💬 **Chat via Telegram** | Streaming responses with real-time tool status |
| ⏰ **Proactive & Scheduled** | Reminders, recurring tasks, periodic heartbeat checks |
| 📁 **Workspace Access** | Mount your project folders — Moby reads and edits your actual code |
| 🔄 **Self-Improving** | Moby can modify its own config, personality, and source code |

---

## How It Works

Two Docker containers working together:

- **gateway** — Handles messaging (Telegram), sessions, scheduling, heartbeat, REST API
- **moby** — AI brain powered by [cagent](https://github.com/cagent-ai/cagent) with shell, filesystem, and fetch tools

The agent reads/writes memory and workspace files via bind mounts. All state lives at `~/.mobyclaw/` on your host — visible, editable, portable.

---

<div class="grid cards" markdown>

- :material-rocket-launch: **[Getting Started](getting-started/install.md)**

    Install, configure, and start chatting with Moby in under 2 minutes.

- :material-cog: **[Configuration](getting-started/configure.md)**

    API keys, Telegram, personality, workspaces, credentials, heartbeat.

- :material-console: **[CLI Reference](getting-started/cli.md)**

    All `mobyclaw` commands explained.

- :material-sitemap: **[Architecture](architecture/overview.md)**

    System design, containers, gateway modules, data flow.

</div>
