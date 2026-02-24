# CLI Reference

The `mobyclaw` CLI is a bash script that wraps Docker Compose with agent-aware commands.

## Commands

### Setup & Lifecycle

| Command | Description |
|---|---|
| `./mobyclaw init` | Interactive setup wizard — API keys, messaging, workspaces |
| `./mobyclaw up` | Start Moby (runs init automatically if needed) |
| `./mobyclaw down` | Stop all containers |
| `./mobyclaw status` | Show running services, channels, agent health |
| `./mobyclaw version` | Show version |

### Chatting

| Command | Description |
|---|---|
| `./mobyclaw chat` | Interactive chat session (streaming) |
| `./mobyclaw run "<prompt>"` | Send a one-shot prompt and get the response |

### Logs & Debugging

| Command | Description |
|---|---|
| `./mobyclaw logs` | Tail all container logs |
| `./mobyclaw logs moby` | Tail agent container logs only |
| `./mobyclaw logs gateway` | Tail gateway logs only |
| `./mobyclaw exec` | Shell into the agent container |

### Workspaces

| Command | Description |
|---|---|
| `./mobyclaw workspace list` | Show mounted workspaces |
| `./mobyclaw workspace add <path> [name]` | Mount a host folder |
| `./mobyclaw workspace remove <name>` | Unmount a folder |

## Examples

```bash
# Start Moby
./mobyclaw up

# Quick question
./mobyclaw run "What's the weather like today?"

# Interactive session
./mobyclaw chat

# Check what's running
./mobyclaw status

# Mount a project
./mobyclaw workspace add ~/projects/myapp
./mobyclaw run "Review the code in /workspace/myapp"

# View logs
./mobyclaw logs

# Shell in for debugging
./mobyclaw exec
```

## How Streaming Works

Both `chat` and `run` connect to the gateway's SSE endpoint (`POST /prompt/stream`). Tokens are printed to stdout as they arrive (~1-2s to first token). Tool call status is shown on stderr:

```
$ ./mobyclaw run "Remember my name is Alice"
⏳ Writing file: ~/.mobyclaw/MEMORY.md
✅ Writing file: ~/.mobyclaw/MEMORY.md
Got it! I'll remember that your name is Alice. 👋
```
