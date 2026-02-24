# 🐋 Mobyclaw

**A long-lived personal AI agent that runs in Docker on your machine.**

Always on, always remembering, always ready to help. Chat via Telegram, browse the web, get proactive reminders, and let it work on your projects — all with persistent memory.

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
| 🐳 **Runs in Docker** | One `./mobyclaw up` — isolated, reproducible, portable |
| 💬 **Chat via Telegram** | Streaming responses with real-time tool status |
| 🌐 **Full Web Browser** | Navigate pages, fill forms, click buttons, take screenshots — powered by Playwright |
| 🔍 **Web Search & Reading** | Search DuckDuckGo, fetch and extract clean text from any URL |
| ⏰ **Proactive & Scheduled** | Reminders, recurring tasks, periodic heartbeat checks |
| 📁 **Workspace Access** | Mount your project folders — Moby reads and edits your actual code |
| 🔄 **Self-Improving** | Moby can modify its own config, personality, and source code |

---

## How It Works

Three Docker containers working together:

- **gateway** — Handles messaging (Telegram), sessions, scheduling, heartbeat, REST API
- **moby** — AI brain powered by [cagent](https://github.com/docker/cagent) with shell, filesystem, and fetch tools
- **tool-gateway** — External tools: headless browser (Playwright + Chromium), web search, fetch, weather — exposed via MCP

The agent reads/writes memory and workspace files via bind mounts. All state lives at `~/.mobyclaw/` on your host — visible, editable, portable.

### 19 MCP Tools

| Category | Tools |
|---|---|
| **Quick tools** | `browser_fetch` (extract readable text), `browser_search` (DuckDuckGo), `weather_get` |
| **Browser automation** | `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_hover`, `browser_press_key`, `browser_scroll`, `browser_back`, `browser_forward`, `browser_wait`, `browser_tabs`, `browser_close`, `browser_eval` |

---

<div class="grid cards" markdown>

- :material-rocket-launch: **[Getting Started](getting-started/install.md)**

    Install, configure, and start chatting with Moby in under 2 minutes.

- :material-cog: **[Configuration](getting-started/configure.md)**

    API keys, Telegram, personality, workspaces, credentials, heartbeat.

- :material-console: **[CLI Reference](getting-started/cli.md)**

    All `mobyclaw` commands explained.

- :material-sitemap: **[Architecture](architecture/overview.md)**

    System design, three containers, gateway modules, tool gateway, MCP bridge.

</div>
