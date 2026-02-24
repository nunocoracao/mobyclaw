## 5. Agent Definition Format

### 5.1 Agent Config (`agents/<name>/soul.yaml`)

This is a **standard cagent agent YAML** with the full personality inlined.
Example for moby:

```yaml
agents:
  root:
    name: moby
    model: opus

    instruction: |
      # Moby — Your Personal AI Agent

      You are **Moby**, a personal AI agent running in a Docker container...

      ## Identity
      - **Name:** Moby
      - **Tone:** Conversational but precise...

      ## Memory
      ...

      ## Constraints
      ...

    toolsets:
      - type: shell
      - type: filesystem
      - type: fetch
      - type: think

    add_date: true
    add_environment_info: true
```

**Design decision:** We use cagent's native YAML format directly. No wrapper,
no abstraction. This means:
- Zero translation layer between mobyclaw config and cagent config
- Users can leverage any cagent feature without mobyclaw needing to know about it
- cagent docs apply directly

The personality lives inside the `instruction:` field as a YAML block scalar (`|`).
This keeps everything in one file while remaining readable — the `instruction`
block is effectively Markdown inside YAML.

**Why not a separate soul.md?** cagent's `instruction` field is string-only —
it doesn't support `file:` references. While `add_prompt_files` can inject file
contents into the prompt, having the personality inline means:
- One file to understand the whole agent
- One file to copy to a new machine
- One file to edit when customizing
- No hidden dependencies between files

### 5.2 Runtime File (`~/.mobyclaw/soul.yaml`)

At runtime, the agent's `soul.yaml` is loaded from `~/.mobyclaw/soul.yaml` (the
user's copy), not from the repo. On first run, `mobyclaw init` copies the
default `agents/moby/soul.yaml` to `~/.mobyclaw/soul.yaml` as a starting point.

```
~/.mobyclaw/
├── soul.yaml           # Active agent config (user-editable)
├── MEMORY.md           # Long-term curated memory
├── TASKS.md            # Agent's task/reminder list
├── HEARTBEAT.md        # Heartbeat checklist
├── schedules.json      # Scheduled reminders (gateway-managed)
├── channels.json       # Known messaging channels (gateway-managed)
├── credentials.env     # Service credentials (AWS, NPM, etc.)
├── gh/                 # GitHub CLI OAuth config (persisted)
├── workspaces.conf     # Workspace folder mappings
├── memory/
│   ├── 2026-02-23.md   # Daily log
│   └── ...
├── sessions/           # Conversation history
└── logs/               # Agent logs
```

These are just files on the host. The agent reads and writes them via
cagent's built-in filesystem tools. They persist across container restarts
because they're bind-mounted from the host filesystem.
