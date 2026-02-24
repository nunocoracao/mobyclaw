# Installation

## Prerequisites

- **Docker** (with Docker Compose v2)
- **curl** and **git**
- An **LLM API key** (Anthropic or OpenAI)

## Step 1: Clone

```bash
git clone https://github.com/nunocoracao/mobyclaw.git
cd mobyclaw
```

## Step 2: Interactive Setup

```bash
./mobyclaw init
```

The init wizard walks you through:

1. **LLM Provider** — Choose Anthropic or OpenAI, enter your API key
2. **Messaging** — Optionally connect Telegram (more platforms coming)
3. **Service Credentials** — Optionally add GitHub token, AWS keys, etc.
4. **Workspaces** — Optionally mount project folders
5. **Agent Settings** — Heartbeat interval, data directory

!!! tip "Minimal setup"
    You only need an API key. Everything else is optional. Press Enter through
    the defaults and you'll have a working agent.

## Step 3: Start Moby

```bash
./mobyclaw up
```

This builds the Docker images (first time only), starts the containers, and Moby is live.

## Verify It Works

```bash
# One-shot prompt
./mobyclaw run "Hello! Who are you?"

# Interactive chat
./mobyclaw chat

# Check service status
./mobyclaw status
```

## Connect Telegram

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Create a new bot with `/newbot`
3. Copy the bot token
4. Add it to your `.env`:
   ```bash
   TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
   ```
5. Restart: `./mobyclaw down && ./mobyclaw up`
6. Message your bot on Telegram — Moby responds!

## Updating

```bash
cd mobyclaw
git pull
./mobyclaw down
./mobyclaw up
```

The containers rebuild automatically when the source changes.

## Uninstall

```bash
./mobyclaw down
# Optionally remove your data:
# rm -rf ~/.mobyclaw
```
