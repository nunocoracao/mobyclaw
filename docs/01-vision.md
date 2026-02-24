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
