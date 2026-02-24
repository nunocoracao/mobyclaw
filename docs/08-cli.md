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
  │     ├─ GitHub?  → OAuth device flow (after first start)
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
