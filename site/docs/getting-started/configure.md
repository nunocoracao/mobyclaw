# Configuration

All configuration lives in simple files. Edit with any text editor — Moby picks up changes on restart.

## Files Overview

| File | Location | Purpose |
|---|---|---|
| `.env` | Project root | API keys, messaging tokens, settings |
| `soul.yaml` | `~/.mobyclaw/` | Agent personality, model, behavior |
| `credentials.env` | `~/.mobyclaw/` | Service tokens (GitHub, AWS, etc.) |
| `workspaces.conf` | `~/.mobyclaw/` | Workspace folder mappings |
| `MEMORY.md` | `~/.mobyclaw/` | Agent's long-term memory |
| `HEARTBEAT.md` | `~/.mobyclaw/` | Heartbeat checklist |
| `TASKS.md` | `~/.mobyclaw/` | Agent's task/reminder list |

## API Keys

Set your LLM provider in `.env`:

=== "Anthropic"
    ```bash
    ANTHROPIC_API_KEY=sk-ant-api03-...
    ```

=== "OpenAI"
    ```bash
    OPENAI_API_KEY=sk-...
    ```

## Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Add the token to `.env`:
```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNO...
```

## Personality

Edit `~/.mobyclaw/soul.yaml` to customize Moby:

```yaml
agents:
  root:
    name: moby
    model: sonnet          # or opus, gpt-4o, etc.
    instruction: |
      # Moby — Your Personal AI Agent

      You are **Moby**, a personal AI agent...

      ## Identity
      - **Name:** Moby
      - **Tone:** Conversational but precise...
```

!!! info "Restart required"
    After editing `soul.yaml`, restart with `./mobyclaw down && ./mobyclaw up`.
    Memory files (MEMORY.md, TASKS.md) don't require a restart.

## Workspaces

Mount host folders so Moby can access your projects:

```bash
# Add a workspace
./mobyclaw workspace add ~/projects/myapp

# List workspaces
./mobyclaw workspace list

# Remove
./mobyclaw workspace remove myapp
```

Inside the container, workspaces appear at `/workspace/<name>`.

## Service Credentials

Give Moby access to external tools:

### GitHub (OAuth device flow)

No token needed - GitHub uses OAuth:

```bash
# After starting Moby, just ask:
mobyclaw run "authenticate with GitHub"
# Moby runs `gh auth login` and gives you a code + URL
```

The OAuth session is persisted at `~/.mobyclaw/gh/` and survives restarts.

### Other Services

```bash
# ~/.mobyclaw/credentials.env
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
NPM_TOKEN=npm_...
```

These are injected as environment variables into the agent container. Moby can use `aws`, `npm`, etc.

!!! warning "Security"
    Moby never displays credential values. They're only available as env vars inside the container.

## Heartbeat

Configure periodic wake-ups:

```bash
# .env
MOBYCLAW_HEARTBEAT_INTERVAL=15m       # How often (default: 15m)
MOBYCLAW_ACTIVE_HOURS=07:00-23:00     # When (default: 07:00-23:00)
```

During active hours, Moby wakes up every interval to:

- Review pending tasks
- Check the heartbeat checklist
- Notify you if anything needs attention

## Environment Variables Reference

| Variable | Container | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | moby | — | Anthropic API key |
| `OPENAI_API_KEY` | moby | — | OpenAI API key |
| `TELEGRAM_BOT_TOKEN` | gateway | — | Telegram bot token |
| `MOBYCLAW_HEARTBEAT_INTERVAL` | gateway | `15m` | Heartbeat frequency |
| `MOBYCLAW_ACTIVE_HOURS` | gateway | `07:00-23:00` | Heartbeat active window |
| `AGENT_URL` | gateway | `http://moby:8080` | Agent container URL |
| `RUN_TIMEOUT_MS` | gateway | `600000` | Agent request timeout (ms) |
