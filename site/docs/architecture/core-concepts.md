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
- `defaults/` — Default files copied to ~/.mobyclaw/ on init (MEMORY.md, HEARTBEAT.md, TASKS.md)

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
├── TASKS.md             # Agent's task/reminder list
├── HEARTBEAT.md         # Heartbeat checklist
├── schedules.json       # Scheduled reminders (gateway-managed)
├── channels.json        # Known messaging channels (gateway-managed)
├── credentials.env      # Service credentials (AWS, NPM, etc.)
├── gh/                  # GitHub CLI OAuth config (persisted)
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

### 2.9 Self-Modification

Moby can **modify its own configuration** and trigger a restart to load
the changes. This enables the agent to evolve its own personality,
switch models, or adjust behavior based on user feedback.

**Mechanism:** File-signal pattern.

```
Agent edits files (soul.yaml, Dockerfile, gateway/src/*.js, etc.)
  │
  ├─ echo "<signal>" > ~/.mobyclaw/.restart
  │
  ▼
Host-side watcher (spawned by `mobyclaw up`)
  │
  ├─ Polls every 5 seconds
  ├─ Sees .restart file
  ├─ Reads signal
  ├─ Removes file
  ├─ Executes appropriate docker compose command
  └─ Logs to ~/.mobyclaw/logs/watcher.log
```

**Signal types:**

| Signal | Command | When to use |
|---|---|---|
| `restart` | `dc restart moby` | Config changes (soul.yaml) — ~5s |
| `rebuild` | `dc up -d --build moby` | Moby Dockerfile/image changes — ~30s |
| `rebuild-gateway` | `dc up -d --build gateway` | Gateway source code changes — ~20s |
| `rebuild-all` | `dc up -d --build` | Multi-service changes — ~45s |

**Why a file signal, not an API or Docker socket?**
- No Docker socket inside containers (security)
- No new dependencies (just a file + poll loop)
- Works on any platform
- The CLI already knows how to run docker compose
- The file is in the bind-mounted directory — both host and container can see it

### Source Code Access

The mobyclaw project root is **bind-mounted at `/source`** in the moby
container. This gives the agent read-write access to all project files:

```
/source/                          ← host's mobyclaw project root
├── Dockerfile                    # Agent container image
├── docker-compose.yml            # Service definitions
├── mobyclaw                      # CLI bash script
├── agents/moby/soul.yaml         # Default soul (master copy)
├── gateway/
│   ├── Dockerfile                # Gateway image
│   ├── package.json              # Gateway dependencies
│   └── src/
│       ├── index.js              # Main entry — wires modules (~144 lines)
│       ├── agent-client.js       # HTTP client for cagent API + SSE
│       ├── orchestrator.js       # Session lifecycle + overflow sessions
│       ├── routes.js             # Express route handlers
│       ├── sessions.js           # Session store (channel→session mapping)
│       ├── scheduler.js          # Schedule CRUD + scheduler loop
│       ├── heartbeat.js          # Periodic agent wake-up
│       ├── channels.js           # Persistent known-channel store
│       ├── adapter-registry.js   # Platform adapter routing
│       ├── tool-labels.js        # Tool name formatting
│       └── adapters/telegram.js  # Telegram adapter
├── architecture.md               # Design documentation
└── README.md                     # User docs
```

**What the agent can modify:**
- `Dockerfile` — change its own image (install packages, etc.)
- `gateway/src/*.js` — add features, fix bugs, add adapters
- `gateway/Dockerfile` — change gateway image
- `docker-compose.yml` — service config, volumes, networking
- `mobyclaw` — CLI script (takes effect immediately, no rebuild)
- `agents/moby/soul.yaml` — master copy (the runtime copy is at `~/.mobyclaw/`)
- `architecture.md`, `README.md` — documentation

**What the agent must NOT modify:**
- `.env` — contains API keys and secrets
- `.gitignore` — without explicit permission
- `cagent` binary — pre-built, not modifiable

**Why mount the source?**
- The agent can improve itself beyond just personality tweaks
- Gateway bugs can be fixed without user intervention
- New features (adapters, API endpoints) can be added by the agent
- Documentation can be kept in sync with actual behavior
- Git provides safety net: `git stash`, `git checkout -- .`

**Safety model:**
- Agent must explain changes before making them
- Agent must `git diff` to show what changed before triggering rebuild
- Agent must ask permission before modifying code (unless explicitly asked)
- Small, focused changes preferred (one concern per rebuild)
- `node -c file.js` syntax check before rebuilding gateway
- User can always revert: `cd ~/path/to/mobyclaw && git checkout -- .`

**Watcher lifecycle:**
- Spawned as a background process by `mobyclaw up`
- PID stored in `~/.mobyclaw/.watcher.pid`
- Killed by `mobyclaw down`
- Idempotent — `mobyclaw up` kills any existing watcher before spawning a new one

**cagent does NOT hot-reload soul.yaml.** Confirmed by testing: the instruction
is read once at process start. A container restart is required for config
changes to take effect. Memory files (MEMORY.md, TASKS.md) are unaffected
by restarts since they're bind-mounted from the host.
