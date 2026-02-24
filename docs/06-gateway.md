## 6. Gateway (Orchestrator)

The gateway is the **central nervous system** of mobyclaw. It's a long-lived
process that:

1. **Receives messages** from all connected channels (Telegram, WhatsApp, CLI, webhooks)
2. **Manages sessions** — maps channels/users to conversation threads
3. **Routes to the agent** — sends prompts to cagent's HTTP API
4. **Runs the scheduler** — heartbeats and cron jobs trigger agent turns
5. **Delivers responses** — routes agent replies back to the right channel

### 6.1 Message Flow

```
User sends "What's my schedule?" via Telegram
  │
  ▼
gateway's Telegram adapter receives message
  │
  ├─ Look up session for telegram:dm:12345
  ├─ Load session history
  ├─ Enqueue in command queue (serialize per session)
  │
  ▼
gateway sends agent turn
  │
  ├─ POST http://moby:8080/v1/run
  │   { prompt: "What's my schedule?", session_id: "..." }
  │
  ▼
cagent runs agent loop
  │
  ├─ Assembles system prompt (soul.yaml instruction + context)
  ├─ Model inference
  ├─ Tool calls (reads calendar, writes memory, etc.)
  ├─ Final response: "You have a standup at 10am and..."
  │
  ▼
gateway receives response
  │
  ├─ Store in session history
  ├─ Route back to originating channel
  │
  ▼
gateway delivers response via Telegram adapter
```

### 6.2 Heartbeat Flow

```
Scheduler timer fires (every 30 minutes)
  │
  ├─ Is it within active hours? (e.g., 8am-11pm)
  │
  ▼
gateway sends heartbeat prompt to agent
  │
  ├─ POST http://moby:8080/v1/run
  │   { prompt: "Read HEARTBEAT.md. Follow it strictly.
  │              If nothing needs attention, reply HEARTBEAT_OK.",
  │     session_id: "heartbeat:main" }
  │
  ▼
cagent runs agent loop
  │
  ├─ Reads HEARTBEAT.md
  ├─ Checks pending tasks, reviews memory
  ├─ Either: "HEARTBEAT_OK" (nothing to do)
  │   Or: "Reminder: you have a meeting in 30 minutes"
  │
  ▼
gateway processes response
  │
  ├─ If HEARTBEAT_OK → suppress, don't deliver
  └─ If actual content → deliver to user's last active channel
```

See §6.7 for the full heartbeat design.

### 6.3 Cron Flow

```
Cron job fires: "Morning brief" (every day at 7am)
  │
  ▼
gateway creates isolated session
  │
  ├─ POST http://moby:8080/v1/run
  │   { prompt: "Summarize overnight updates. Check emails and calendar.",
  │     session_id: "cron:morning-brief" }
  │
  ▼
cagent runs agent loop
  │
  ├─ Reviews overnight activity, memory, etc.
  ├─ Composes summary
  │
  ▼
gateway delivers to configured channel
  │
  └─ Sends summary to user's WhatsApp/Telegram/Slack
```

### 6.4 Message Serialization & Queue Modes

cagent can only process one request per session at a time. If the gateway
sends a second message to the same session while the first is still running,
the second request will hang until the first completes (or time out).

The gateway serializes all messages through a single session queue:

- **Busy guard:** While a message is being processed, new messages are queued
- **FIFO drain:** When processing completes, the next queued message(s) are sent
- **Session error recovery:** If a session error occurs, the session is reset and retried once
- **Queue cap:** Max 20 messages (configurable via `MAX_QUEUE_SIZE`). Oldest dropped on overflow.

**Queue Modes** (inspired by OpenClaw):

| Mode | Behavior | When to use |
|---|---|---|
| `collect` (default) | Coalesce all queued messages into one combined turn | Normal chat - prevents "continue, continue" spam |
| `followup` | Each queued message becomes a separate turn | When each message needs individual processing |

Set via `QUEUE_MODE` env var.

**Collect mode detail:**
When multiple messages queue up while the agent is busy, they're merged into
one prompt with `---` separators. All promises resolve with the same response.
A 1000ms debounce (`QUEUE_DEBOUNCE_MS`) lets rapid messages accumulate before
draining. This matches OpenClaw's `collect` mode.

**Queue feedback:**
When a message is queued, the `onQueued(position)` callback fires. The Telegram
adapter uses this to send a temporary "⏳ Queued" message that's deleted when
processing starts. The SSE endpoint emits a `queued` event.

### 6.4.1 Session Lifecycle (Daily/Idle Reset)

Sessions auto-reset to prevent unbounded context growth:

- **Daily reset** (default: 4 AM): If the session's last activity was before
  today's reset hour, the next message triggers a fresh session.
  Configurable via `DAILY_RESET_HOUR`.
- **Idle reset** (optional): If no activity for N minutes, session resets.
  Configurable via `IDLE_RESET_MINUTES`.
- **Manual reset:** `/new`, `/reset`, or `/clear` commands in Telegram
  force an immediate session reset.

The `lastActivity` timestamp is persisted to disk so it survives restarts.
Whichever reset policy triggers first wins (matches OpenClaw behavior).

### 6.4.2 /stop — Abort Current Run

Users can send `/stop` in Telegram (or `POST /api/stop`) to:
1. Clear all queued messages
2. Signal abort on the current running request (if supported)
3. Get a confirmation message with the count of cleared items

This prevents the frustration of waiting for a long-running task that
the user no longer wants.

### 6.5 Streaming Architecture

cagent's SSE stream emits `agent_choice` tokens as the model generates them.
The gateway streams these tokens through to all consumers in real-time,
making the agent feel fast even for long responses.

**Streaming pipeline:**

```
cagent SSE stream
  │
  │  agent_choice tokens (1-2s after request)
  ▼
agent-client.js (promptStream)
  │
  │  onToken(text) callback
  ▼
gateway routing (sendToAgentStream)
  │
  ├─→ POST /prompt/stream (SSE)  → CLI prints tokens to terminal
  ├─→ Telegram adapter           → edits message every ~1s
  └─→ POST /prompt (buffered)    → waits for full response (legacy)
```

**Gateway SSE endpoint** (`POST /prompt/stream`):
- Returns `text/event-stream` with events: `token`, `tool`, `done`, `error`
- Uses a `PassThrough` stream piped to the HTTP response
- Critical: disconnect detection uses `res.on('close')`, NOT `req.on('close')`
  (the request close event fires immediately when the POST body is consumed,
  not when the client disconnects — this was a subtle bug)

**Telegram streaming**: The adapter uses a **message segmentation** model.
Instead of merging everything into one message, tool status and response
text are sent as separate Telegram messages:

1. **Tool phases** get their own message, edited in-place as tools
   start (⏳), receive args, and complete (✅/❌)
2. **Text phases** get a separate message, streamed via edits as
   tokens arrive. The first text send is delayed ~2.5s so the
   notification preview shows meaningful content (not just one word).
3. If the agent does multiple tool-text cycles, each cycle produces
   new messages - so the user gets a notification for each text segment.

This matches user expectations: each distinct response triggers a
notification, tool status is visible but separate, and notification
previews show real content.

**Typing indicators** (OpenClaw-inspired):
The Telegram adapter sends `sendChatAction('typing')` immediately when
any message is received, before processing starts. This fires even when
the message is queued behind a running task. A 4-second refresh interval
keeps the indicator alive while the agent works. This matches OpenClaw's
`instant` typing mode — the user always sees the agent is "thinking"
the moment they send a message.

**CLI streaming**: `mobyclaw run` and `mobyclaw chat` connect to the SSE
endpoint and print tokens directly to stdout as they arrive. Tool call
status is shown on stderr so it doesn't pollute piped output.

### 6.6 Scheduler — Timed Reminders & Recurring Schedules

The scheduler is a **gateway-side timer loop** that delivers pre-composed
messages at exact times. It does NOT involve the agent at delivery time —
the agent composes the message upfront when creating the schedule.

#### Schedule API

The gateway exposes REST endpoints for schedule management. The agent
calls these via `curl` (shell tool). The CLI and external tools can also
use them.

| Endpoint | Method | Purpose |
|---|---|---|
| `GET /api/schedules` | List | Returns pending schedules |
| `POST /api/schedules` | Create | Creates a new schedule |
| `DELETE /api/schedules/:id` | Cancel | Cancels a pending schedule |

**Create request body:**
```json
{
  "due": "2026-02-24T09:00:00Z",
  "message": "🔔 Hey! Reminder: **Buy groceries!**",
  "channel": "telegram:123456",
  "repeat": null
}
```

Either `message` or `prompt` is required (or both):

| Field | When to use | At fire time |
|---|---|---|
| `message` | Simple reminders (content known upfront) | Delivered directly (free, instant) |
| `prompt` | Needs live data/reasoning (news, weather, summaries) | Sent to agent; agent’s response delivered |
| Both | Prompt-based with fallback | Agent runs; if it fails, `message` is delivered |

**Prompt-based example** (agent runs at fire time):
```json
{
  "due": "2026-02-24T09:00:00Z",
  "prompt": "Fetch the latest tech news and write a brief morning briefing.",
  "channel": "telegram:123456",
  "repeat": "weekdays"
}
```

**Schedule object (stored):**
```json
{
  "id": "sch_a1b2c3",
  "due": "2026-02-24T09:00:00Z",
  "message": "🔔 Hey! Reminder: **Buy groceries!**",
  "channel": "telegram:123456",
  "status": "pending",
  "repeat": null,
  "created_at": "2026-02-23T20:15:00Z",
  "delivered_at": null
}
```

**Status values:** `pending` → `delivered` | `cancelled`

**Persistence:** `~/.mobyclaw/schedules.json` — bind-mounted, survives
restarts, user-visible. Gateway reads/writes this file.

#### Repeat / Recurring Schedules

The `repeat` field controls recurrence:

| Value | Meaning | Example |
|---|---|---|
| `null` | One-shot (default) | "Remind me tomorrow at 9am" |
| `"daily"` | Every day at the same time | "Remind me every day at 9am" |
| `"weekdays"` | Mon–Fri at the same time | "Every weekday morning" |
| `"weekly"` | Same day+time each week | "Every Monday at 9am" |
| `"monthly"` | Same day+time each month | "First of every month" |
| `"0 7 * * 1-5"` | Cron expression | Full cron flexibility |

When a recurring schedule fires:
1. Gateway delivers the message
2. Marks current entry as `delivered`
3. Computes next occurrence from the `repeat` rule
4. Creates a new `pending` entry with the next `due` time

The original entry's `repeat` value is copied to the new entry, creating
an ongoing chain. Cancelling the latest pending entry stops the chain.

#### Scheduler Loop

Runs every **30 seconds** inside the gateway:

```
Every 30 seconds:
  │
  ├─ Read schedules.json
  ├─ Find entries where due <= now AND status == "pending"
  │
  ├─ For each due schedule:
  │   ├─ Parse channel (e.g., "telegram:123456")
  │   ├─ Call adapter's send function via delivery API
  │   ├─ Mark status = "delivered", set delivered_at
  │   ├─ If repeat: create next pending entry
  │   └─ Save schedules.json
  │
  └─ Done (< 1ms for most runs)
```

#### Delivery API

Internal gateway endpoint for sending proactive messages to any channel:

```
POST /api/deliver
{
  "channel": "telegram:123456",
  "message": "🔔 Reminder text"
}
```

- Parses the channel prefix (`telegram`, `discord`, `slack`, etc.)
- Routes to the appropriate adapter's proactive send function
- Returns success/failure
- Bypasses session management — this is a direct push, not an agent turn

**Adapter registry:** Gateway maintains a map of platform → send function.
Each adapter registers itself on startup:

```js
const adapters = {
  telegram: { send: (chatId, message) => bot.telegram.sendMessage(chatId, message) },
  // discord: { send: ... },
  // slack: { send: ... },
};
```

#### How the Agent Creates a Schedule

When the user says "remind me tomorrow at 9am to buy groceries":

```
User (Telegram): "Remind me tomorrow at 9am to buy groceries"
  │
  ├─ Gateway prepends channel context (see §6.8)
  │
  ▼
Agent processes message
  │
  ├─ 1. Create schedule via gateway API:
  │     curl -s -X POST http://gateway:3000/api/schedules \
  │       -H "Content-Type: application/json" \
  │       -d '{"due":"2026-02-24T09:00:00Z",
  │            "message":"🔔 Hey! Reminder: Buy groceries!",
  │            "channel":"telegram:123456"}'
  │
  ├─ 2. Write to TASKS.md for tracking:
  │     "- [ ] 2026-02-24 09:00 — Buy groceries [scheduled]"
  │
  └─ 3. Respond: "Got it! I'll remind you tomorrow at 9am. ✅"
```

### 6.7 Heartbeat — Periodic Agent Wake-Up

The heartbeat is an **intelligent periodic check** where the agent wakes
up, reviews its state, and acts if needed. Unlike the scheduler (dumb
timer, pre-composed message), the heartbeat involves full LLM reasoning.

**Trigger:** Gateway timer, every `MOBYCLAW_HEARTBEAT_INTERVAL` (default: 2h)

**Active hours:** Only fires between `MOBYCLAW_ACTIVE_HOURS` (default:
`07:00-23:00`). Timezone-aware via `TZ` env var.

**Two heartbeat modes alternate:**

| Mode | Frequency | What it does | Cost |
|---|---|---|---|
| **Reflection** | Default | Journal, inner state, brief task check | Cheap (no web) |
| **Exploration** | Every Nth beat (default: 4th) | Pick a curiosity topic, fetch 1 URL, summarize | Slightly more |

**Reflection heartbeat prompt:**
- Read inner state (`state/inner.json`) and self-model (`SELF.md`)
- Read `HEARTBEAT.md` reflection guide
- Write a journal entry (`journal/YYYY-MM-DD.md`)
- Update inner state if mood/preoccupations shifted
- Check tasks briefly; notify user if something urgent
- If nothing needs attention: reply `HEARTBEAT_OK`

**Exploration heartbeat prompt:**
- Pick ONE topic from `curiosity_queue` in `inner.json`
- Use at most 1 web fetch (browser_fetch or browser_search)
- Write a ~300 word summary to `explorations/YYYY-MM-DD-topic.md`
- Update `curiosity_queue`: remove explored, add new questions
- Also do a brief reflection (inner state, journal, task check)

**Failure handling:**
- Tracks consecutive failures. After 2 failures, pauses heartbeats.
- Auto-resumes when the session changes (user `/new` or auto-recovery).
- Prevents hammering a dead/corrupted session every 15 minutes.

**Exploration config (env vars):**
- `EXPLORATION_ENABLED` — default: `true`
- `EXPLORATION_FREQUENCY` — every Nth heartbeat (default: `4`)
- `EXPLORATION_MAX_FETCHES` — max URLs per exploration (default: `1`)
- `EXPLORATION_SUMMARY_WORDS` — target summary length (default: `300`)

### 6.11 Short-Term Memory (STM)

When cagent sessions reset (daily, turn limit, crash), all conversation
history is lost. The STM module preserves continuity:

- **`addExchange()`** saves every user↔agent exchange to
  `~/.mobyclaw/short-term-memory.json` (rolling buffer of 20)
- **`getHistoryBlock()`** formats the buffer as a `[SHORT-TERM MEMORY]`
  block for injection into the first message of a new session
- Messages are capped at 1500 chars each
- Heartbeat and system messages are excluded
- The injected STM block is stripped before being saved back (no nesting)

**Flow:**
```
Session resets (daily/turn-limit/crash) → new cagent session created
  │
  └─ First user message:
       1. consumeNewSessionFlag() → true
       2. getHistoryBlock() → formatted last 20 exchanges
       3. Prepend to message: [SHORT-TERM MEMORY]...message
       4. Agent receives full context of recent conversations
```

### 6.12 Context Optimizer

Before user messages reach the agent, the context optimizer fetches
the most relevant memory and state and prepends it. The agent doesn't
need to manually read MEMORY.md on every turn.

**What gets injected:**
- **Memory sections** — scored by keyword overlap with user message,
  fetched from dashboard API (`GET /api/context?query=...&budget=1500`)
- **Inner state** — emotional/cognitive state from `state/inner.json`
  (mood, energy, preoccupations, curiosity queue)
- **Self-model** — first 2 sections of `SELF.md`
- **Relevant explorations** — exploration files scored by keyword overlap

**Format:** `[MEMORY CONTEXT] ... [/MEMORY CONTEXT]` block prepended to message.

**Timing fix:** Context fetch is now done AFTER `setBusy(true)` in the
orchestrator (not before), preventing a race condition where heartbeats
could sneak in during the async fetch and cause double-processing.

### 6.13 Session Stability

**Turn limit:** Sessions auto-rotate after 80 exchanges (configurable
via `maxTurns`). Prevents history from growing to 100+ messages where
Anthropic API corruption becomes likely.

**Stream error detection:** When cagent returns HTTP 200 but the SSE
stream contains a `type: "error"` event with no content, the gateway
rejects the promise. `isSessionError()` recognizes corruption patterns:
`sequencing`, `tool_use_id`, `invalid_request_error`, `all models failed`.
Auto-clears the session and retries with a fresh one.

**Telegram dedup:** Tracks last 50 `message_id`s. Skips any message
already processed. Prevents double-processing when Telegraf's polling
restarts and re-delivers updates.

**Polling liveness:** Monitors Telegraf polling activity. If idle for
5+ minutes and Telegram API is reachable, restarts polling. Conservative
threshold prevents false positives.

### 6.8 Channel Context Injection

For the agent to know which channel a message came from (needed when
creating schedules), the gateway prepends a context line to every user
message:

```
[context: channel=telegram:123456, time=2026-02-23T20:15:00Z]
Remind me tomorrow at 9am to buy groceries
```

The agent's instruction tells it to:
- Extract the channel ID when creating schedules or timed tasks
- Include the channel in schedule API calls and TASKS.md entries
- Never display the context line to the user
- Ask the user which channel to use if they request a reminder from
  a non-messaging channel (e.g., CLI) and multiple channels are available

For heartbeat prompts, no channel context is included (it's a system
session, not a user message).

**Why in the message, not metadata?** cagent's API doesn't support
per-message metadata fields. The user message content is the only field
we control. A bracketed prefix is simple, reliable, and the LLM easily
parses it.

### 6.9 TASKS.md — Agent's Task Store

`TASKS.md` lives at `~/.mobyclaw/TASKS.md`. It's a Markdown file the
agent uses to track reminders, todos, and recurring tasks.

```markdown
# Tasks

> Moby's task and reminder list. Moby manages this file.
> You can also edit it directly.

## Reminders

- [ ] 2026-02-24 09:00 — Buy groceries (channel:telegram:123456) [scheduled]
- [ ] 2026-02-24 14:00 — Call the dentist (channel:telegram:123456) [scheduled]
- [x] ~~2026-02-23 15:00 — Send report to Alice~~ (delivered)

## Recurring

- [ ] weekdays 07:00 — Morning briefing (channel:telegram:123456) [scheduled]

## Todo

- [ ] Review PR #1234 on myapp
- [ ] Research vector databases for memory search
- [x] ~~Set up workspace mounts~~
```

**Design:**
- Flexible Markdown — agent uses LLM intelligence to interpret
- `[scheduled]` marker — indicates a gateway schedule was created
  (prevents double-scheduling on heartbeat)
- Channel stored per-task — reminders go back to the originating channel
- Todos without times — just tracked, agent mentions in heartbeat if relevant
- Agent marks `[x]` when done, may clean up old entries

### 6.10 Known Channels (Persistent)

The gateway persists **known messaging channels** to
`~/.mobyclaw/channels.json`. When the first message arrives from any
messaging platform, the gateway saves that channel. This means:

- **Schedules** can omit the `channel` field — the gateway defaults to
  the known channel for that platform
- **Heartbeat** includes known channels and the default channel in its
  prompt, so the agent knows where to deliver notifications
- **Survives restarts** — the file is on the bind-mounted host filesystem
- **Agent can read it** directly at `/home/agent/.mobyclaw/channels.json`
  or query `GET /api/channels`

**File format** (`~/.mobyclaw/channels.json`):
```json
{
  "telegram": "telegram:1436415037",
  "discord": "discord:9876543210"
}
```

One entry per platform. For a personal agent, there's typically one chat
per platform (your DM with the bot). If the user messages from a different
chat on the same platform, the channel is updated.

**API endpoint:**
```
GET /api/channels
→ { "channels": { "telegram": "telegram:123" }, "default": "telegram:123" }
```

**Default channel resolution** (used by schedule API and heartbeat):
1. Last active channel in current session (in-memory)
2. First known channel from `channels.json`
3. `null` (schedule API returns 400, heartbeat skips delivery)

---


```
Debian slim + cagent binary + common dev tools (git, curl, jq, etc.)
```

**Design decisions:**
- **Debian slim** over Alpine: better compatibility with cagent and dev tools
- **cagent installed at build time**: pinned version for reproducibility
- **Common tools included**: git, curl, jq, ripgrep — agents need these for
  shell tool execution
- **Non-root user**: agent runs as `agent` user (uid 1000) for security
- **Workspace at `/workspace`**: standard mount point for all agents

### 7.2 Agent Entrypoint

```bash
cagent serve api /agent/soul.yaml --working-dir /workspace
```

The container:
1. Starts cagent in API server mode
2. Loads the agent config from `/agent/soul.yaml`
3. Sets the working directory to `/workspace` (mounted from host)
4. Listens on port 8080
5. Serves the agent API (send prompts, get responses, manage sessions)

**Tool approval:** `cagent serve api` requires explicit tool approval per
session. When creating a session via `POST /api/sessions`, the gateway MUST
set `{"tools_approved": true}` in the request body. Without this, the SSE
stream will pause at `tool_call_confirmation` events and wait indefinitely
for client-side approval that never comes. This was a critical bug discovered
during development — the agent would respond to simple messages (no tools)
but hang forever on any message that triggered a tool call (e.g., writing
to memory). The fix is a single field on session creation.

### 7.3 cagent HTTP API Reference

Discovered through testing. This is the API surface of `cagent serve api`:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/ping` | GET | Health check. Returns `{"status":"ok"}` |
| `/api/agents` | GET | List available agents. Returns `[{"name":"soul",...}]` |
| `/api/sessions` | GET | List all sessions |
| `/api/sessions` | POST | Create session. Body: `{"tools_approved": true}`. Returns session object with `id`. |
| `/api/sessions/{id}` | GET | Get session details and message history |
| `/api/sessions/{id}/agent/{name}` | POST | Send messages to agent. Body: `[{"role":"user","content":"..."}]`. Returns SSE stream. |

**Agent name resolution:** The `{name}` in the agent endpoint comes from the
**config filename** (e.g., `soul.yaml` → agent name is `soul`), NOT from the
`name:` field in the YAML or the agents map key. This is a cagent convention.

**SSE stream event types:**

| Event Type | When | Contains |
|---|---|---|
| `agent_info` | Start of stream | Agent name, model, welcome message |
| `team_info` | Start of stream | Available agents list |
| `toolset_info` | Start of stream | Number of available tools |
| `stream_started` | Agent begins processing | Session ID |
| `agent_choice_reasoning` | During inference (thinking) | Reasoning text (extended thinking) |
| `agent_choice` | During inference | **Response text tokens** — this is the actual reply |
| `partial_tool_call` | Tool being called | Tool name and partial arguments (streaming) |
| `tool_call_confirmation` | Tool awaiting approval | Only if `tools_approved: false` — **blocks stream** |
| `tool_result` | After tool execution | Tool output |
| `message_added` | Message persisted | Session ID |
| `token_usage` | After each model turn | Input/output tokens, cost |
| `session_title` | Auto-generated | Session title from content |
| `stream_stopped` | End of stream | Session ID |
| `error` | On failure | Error message |

**Multi-turn tool streams:** A single SSE stream may contain multiple model
turns. When the model calls a tool, the stream continues through:
`agent_choice_reasoning` → `partial_tool_call` → (tool executes) →
`tool_result` → `agent_choice` (final response). The gateway must read the
**entire stream** to collect all `agent_choice` content.

### 7.4 Volume Mounts

| Mount | Type | Container Path | Purpose |
|---|---|---|---|
| `~/.mobyclaw/` | Bind mount | `/home/agent/.mobyclaw` | All agent state: memory, soul, sessions, logs |
| Project root (`.`) | Bind mount | `/source` | Full source code access (self-modification) |
| Agent config | Bind mount (ro) | `/agent/` | Agent YAML (from repo) |

**Key principle:** Everything lives at `~/.mobyclaw/` on the host. No Docker
volumes. This means:
- All state persists across container restarts
- `cp -r ~/.mobyclaw/ backup/` is a complete backup
- `docker system prune` won't destroy anything

### 7.4 Secrets & Environment Variables

All secrets and configuration live in a **single `.env` file** at the project
root. Docker Compose loads it via `env_file` and injects variables into the
right containers.

#### Strategy

- **One `.env` file** — single place for all secrets. No scattered config.
- **`.env.example`** — checked into git with placeholder values. Users copy to
  `.env` and fill in their keys.
- **`.env` is gitignored** — never committed. `.gitignore` includes `.env` from
  day one.
- **No secrets baked into images** — the Dockerfile never `COPY`s `.env` or
  `ARG`s secrets. They're injected at runtime via Compose.
- **Least-privilege distribution** — each container only receives the env vars
  it needs. The agent container gets LLM API keys. The gateway gets messaging
  tokens. Neither gets the other's secrets.

#### Why `.env` file (not Docker Secrets, Vault, etc.)

Mobyclaw is a **personal agent on your own machine**. Docker Secrets requires
Swarm mode. Vault/SOPS/etc. add operational complexity for zero benefit when
you're the only user. A `.env` file is:
- Simple: one file, `cp .env.example .env`, edit, done
- Standard: Docker Compose native support, every dev knows it
- Portable: copy `.env` to a new machine alongside `~/.mobyclaw/`
- Secure enough: file permissions (`chmod 600 .env`), gitignored, never in images

If someone deploys mobyclaw on a shared server or CI, they can use their
platform's native secret injection (GitHub Actions secrets, systemd credentials,
etc.) — those just set env vars, which Compose picks up the same way.

#### Variable Reference

| Variable | Container | Required | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | moby | Yes (if using Anthropic) | Anthropic model access |
| `OPENAI_API_KEY` | moby | Yes (if using OpenAI) | OpenAI model access |
| `TELEGRAM_BOT_TOKEN` | gateway | No | Enables Telegram adapter |
| `DISCORD_BOT_TOKEN` | gateway | No | Enables Discord adapter |
| `SLACK_BOT_TOKEN` | gateway | No | Enables Slack adapter |
| `WHATSAPP_AUTH` | gateway | No | Enables WhatsApp adapter |
| `MOBYCLAW_HEARTBEAT_INTERVAL` | gateway | No | Heartbeat frequency (default: `15m`) |
| `MOBYCLAW_ACTIVE_HOURS` | gateway | No | Active hours for heartbeat (default: `07:00-23:00`) |
| `MOBYCLAW_HOME` | all | No | Override `~/.mobyclaw/` path |

**Convention:** Messaging adapter tokens double as feature flags — if
`TELEGRAM_BOT_TOKEN` is unset, the Telegram adapter simply doesn't load.
No token = no adapter = no error.

#### Least-Privilege Distribution in Compose

```yaml
services:
  moby:
    environment:
      - ANTHROPIC_API_KEY         # LLM keys only
      - OPENAI_API_KEY
    # NO messaging tokens

  gateway:
    environment:
      - TELEGRAM_BOT_TOKEN        # Messaging tokens only
      - DISCORD_BOT_TOKEN
      - SLACK_BOT_TOKEN
      - WHATSAPP_AUTH
      - MOBYCLAW_HEARTBEAT_INTERVAL
    # NO LLM API keys
```

The `.env` file holds everything, but Compose's per-service `environment`
block controls which container sees which variable. This way, a compromised
gateway can't leak your Anthropic key, and a compromised agent can't access
your Telegram bot.

#### `.env.example` Template

```bash
# ─── LLM Provider Keys ───────────────────────────────────────
# At least one is required. Uncomment and fill in.
ANTHROPIC_API_KEY=
# OPENAI_API_KEY=

# ─── Messaging (all optional) ────────────────────────────────
# Set a token to enable that channel. No token = adapter disabled.
# TELEGRAM_BOT_TOKEN=
# DISCORD_BOT_TOKEN=
# SLACK_BOT_TOKEN=
# WHATSAPP_AUTH=

# ─── Agent Settings ──────────────────────────────────────────
# MOBYCLAW_HOME=~/.mobyclaw
# MOBYCLAW_HEARTBEAT_INTERVAL=30m
```

#### File Permissions

`mobyclaw init` sets `chmod 600 .env` after creating it. The `.env` file
contains API keys worth money — it should only be readable by the owner.
