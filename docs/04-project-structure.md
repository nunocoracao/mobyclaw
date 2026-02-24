## 4. Project Structure

```
mobyclaw/
├── architecture.md            # Index → points to docs/ directory
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
│       ├── index.js           # Express app composition root
│       ├── orchestrator.js    # Session routing, collect mode, debounce, /stop
│       ├── agent-client.js    # HTTP client for cagent API with SSE streaming
│       ├── sessions.js        # Session store with lifecycle + queue modes
│       ├── routes.js          # API routes including /api/stop
│       ├── heartbeat.js       # Heartbeat with skip guard
│       ├── channels.js        # Persistent channel store
│       ├── scheduler.js       # Schedule store + scheduler loop
│       ├── tool-labels.js     # Tool name → human-readable label formatting
│       ├── adapter-registry.js # Platform→sendFn dispatch
│       └── adapters/          # Messaging platform adapters
│           └── telegram.js    # Telegraf bot with streaming, typing, /stop, /status
│
├── tool-gateway/              # External tool gateway (MCP)
│   ├── Dockerfile             # Node.js 22 + Playwright + Chromium
│   ├── package.json           # MCP SDK, Playwright, cheerio, readability, jsdom
│   ├── mcp-bridge             # Node.js stdio↔HTTP bridge (also copied into moby)
│   └── src/
│       ├── index.js           # Stateless MCP server + admin API
│       └── tools/
│           ├── browser.js     # browser_fetch + browser_search (lightweight, no browser)
│           ├── weather.js     # weather_get (Open-Meteo, free)
│           └── playwright.js  # 16 browser automation tools (Playwright + Chromium)
│
├── site/                      # GitHub Pages landing page + docs site
│   ├── index.html             # Landing page (static HTML)
│   └── docs/                  # MkDocs-style documentation
│
├── docs/                      # Architecture documentation (14 files)
│   ├── README.md              # Index with table of contents
│   ├── 01-vision.md           # What mobyclaw is and isn't
│   ├── 02-core-concepts.md    # Agent, triggers, memory, workspaces, sessions
│   ├── 03-architecture.md     # System diagram, containers, connections
│   ├── 04-project-structure.md # This file
│   ├── 05-agent-definition.md # soul.yaml format and config
│   ├── 06-gateway.md          # Messaging, streaming, scheduler, heartbeat
│   ├── 07-docker-compose.md   # Compose config, secrets, volumes
│   ├── 08-cli.md              # Commands and init flow
│   ├── 09-agent-loop.md       # cagent integration
│   ├── 10-security.md         # Security model
│   ├── 11-roadmap.md          # Phased roadmap
│   ├── 12-decisions.md        # ADR log (ADR-001 through ADR-051)
│   ├── 13-open-questions.md   # Resolved and open questions
│   └── 14-tool-gateway.md     # MCP aggregator, browser automation, auth
│
├── Dockerfile                 # Agent image: Debian + cagent + Node.js + mcp-bridge
├── docker-compose.yml         # Compose manifest (3 services: moby, gateway, tool-gateway)
├── docker-compose.override.yml # GENERATED: credentials + workspace mounts (gitignored)
├── .env.example               # Template for API keys and config
├── .env                       # Actual secrets (gitignored, created by init)
│
├── mobyclaw                   # CLI script (bash)
│
└── README.md                  # User-facing documentation
```

### What's NOT in the product

- `mobyclaw.yaml` — This is the cagent config for the **development agent** that
  helps build mobyclaw. It is not part of the product runtime.
