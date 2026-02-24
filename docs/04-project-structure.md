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
│       ├── scheduler.js       # Schedule store, scheduler loop, heartbeat timer
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
