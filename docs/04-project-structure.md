## 4. Project Structure

mobyclaw follows a strict separation: **code lives in the repo, data lives in the user folder.**

```
mobyclaw/                          # CODE — git-tracked, versioned, ships as containers
├── Dockerfile                     # Agent image: Debian + cagent + Node.js + mcp-bridge
├── docker-compose.yml             # Compose manifest (4 services)
├── docker-compose.override.yml    # GENERATED: credentials + workspace mounts (gitignored)
├── .env.example                   # Template for API keys and config
├── .env                           # Actual secrets (gitignored, created by init)
├── mobyclaw                       # CLI script (bash)
│
├── agents/                        # Agent definitions
│   └── moby/                      # The default "moby" agent
│       ├── soul.yaml              # All-in-one: personality, model, tools, behavior
│       └── defaults/              # Templates copied to ~/.mobyclaw/ on first init
│           ├── MEMORY.md          # Initial memory template
│           ├── TASKS.md           # Initial task list template
│           ├── HEARTBEAT.md       # Initial heartbeat checklist
│           ├── credentials.env    # Credential file template (comments only)
│           └── workspaces.conf    # Workspace config template (comments only)
│
├── gateway/                       # Gateway orchestrator service
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js               # Express app composition root
│       ├── orchestrator.js        # Session routing, collect mode, debounce, /stop
│       ├── agent-client.js        # HTTP client for cagent API with SSE streaming
│       ├── sessions.js            # Session store with lifecycle + queue modes
│       ├── routes.js              # API routes including /api/stop
│       ├── heartbeat.js           # Heartbeat with skip guard
│       ├── channels.js            # Persistent channel store
│       ├── scheduler.js           # Schedule store + scheduler loop
│       ├── tool-labels.js         # Tool name -> human-readable label formatting
│       ├── adapter-registry.js    # Platform -> sendFn dispatch
│       └── adapters/              # Messaging platform adapters
│           └── telegram.js        # Telegraf bot with streaming, typing, /stop, /status
│
├── tool-gateway/                  # External tool gateway (MCP)
│   ├── Dockerfile                 # Node.js 22 + Playwright + Chromium
│   ├── package.json               # MCP SDK, Playwright, cheerio, readability, jsdom
│   ├── mcp-bridge                 # Node.js stdio-to-HTTP bridge (also copied into moby)
│   └── src/
│       ├── index.js               # Stateless MCP server + admin API
│       └── tools/
│           ├── browser.js         # browser_fetch + browser_search (lightweight, no browser)
│           ├── weather.js         # weather_get (Open-Meteo, free)
│           └── playwright.js      # 16 browser automation tools (Playwright + Chromium)
│
├── dashboard/                     # Dashboard + task API + maintenance scripts service
│   ├── Dockerfile                 # Python 3.11 + cloudflared
│   ├── server.py                  # HTTP server + Task API (deps, auto-retry) + Soul.yaml API
│   ├── start.sh                   # Entrypoint: self-heal, boot context, tunnel, server
│   ├── static/                    # Dashboard web pages
│   │   ├── index.html             # Status overview page
│   │   ├── tasks.html             # Task management page
│   │   └── settings.html          # Settings and config page
│   └── scripts/                   # Maintenance scripts (run inside dashboard container)
│       ├── self-heal.sh           # Boot-time health checks + auto-fix
│       ├── generate-boot.sh       # Generate compact BOOT.md from MEMORY.md
│       ├── start-tunnel.sh        # Cloudflare quick tunnel for remote access
│       ├── check-repos.sh         # Monitor GitHub repos for new activity
│       └── compress-memory.sh     # Archive old completed tasks from MEMORY.md
│
├── site/                          # GitHub Pages landing page + docs site
│   ├── index.html                 # Landing page (static HTML)
│   └── docs/                      # MkDocs-style documentation
│
├── docs/                          # Architecture documentation (15 files)
│   ├── README.md                  # Index with table of contents
│   ├── 01-vision.md through 15-integrations.md
│
├── architecture.md                # Index -> points to docs/ directory
└── README.md                      # User-facing documentation
```

### What lives WHERE

The key architectural principle: **code in the repo, data in the user folder.**

#### Code (repo, `/source/`)

Everything that defines *how* mobyclaw works:
- Container images (Dockerfiles)
- Service logic (gateway, dashboard, tool-gateway)
- Agent definition (soul.yaml, defaults/)
- Scripts (maintenance, health checks)
- CLI tool
- Documentation and landing page

#### Data (user folder, `~/.mobyclaw/`)

Everything specific to *this user* and *this agent instance*:

```
~/.mobyclaw/                       # DATA — user-specific, portable, survives rebuilds
├── soul.yaml                      # Agent personality + config (user's working copy)
├── MEMORY.md                      # Long-term curated memory
├── TASKS.md                       # Task and reminder tracking
├── HEARTBEAT.md                   # Heartbeat checklist (user-customizable)
├── LESSONS.md                     # Lessons learned from experience
├── BOOT.md                        # Auto-generated compact boot context
├── credentials.env                # Service credentials (AWS, NPM, etc.)
├── workspaces.conf                # Workspace folder mappings
├── channels.json                  # Known messaging channels
├── schedules.json                 # Persistent schedule store
├── session.json                   # Current session state
├── gh/                            # GitHub CLI OAuth config
│   ├── config.yml
│   └── hosts.yml
├── data/                          # Service data (databases, tunnel state)
│   ├── tasks.db                   # SQLite task database (dashboard service)
│   ├── tunnel-info.json           # Cloudflare tunnel URL + PID
│   └── tunnel-url.txt             # Quick-access tunnel URL
├── memory/                        # Daily logs and archives
│   ├── YYYY-MM-DD.md             # Daily activity logs
│   └── archives/                  # Compressed old task entries
├── state/                         # Transient state files
│   └── last-check-*              # Repo monitoring timestamps
├── logs/                          # Service logs
│   └── watcher.log               # Container watcher log
└── sessions/                      # Session persistence
```

**Why this separation matters:**
- `~/.mobyclaw/` is **portable** — copy it to a new machine and your agent comes with you
- Rebuilding containers (`echo "rebuild-all"`) never touches user data
- Code changes are versioned in git; data is backed up separately
- The user folder is the agent's "brain" — memory, personality, preferences
- The repo is the agent's "body" — infrastructure, capabilities, features

### What's NOT in the product

- `mobyclaw.yaml` — This is the cagent config for the **development agent** that
  helps build mobyclaw. It is not part of the product runtime.
