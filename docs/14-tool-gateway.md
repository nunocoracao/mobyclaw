# Tool Gateway Architecture

## Problem

Moby needs access to external services (Notion, Google Docs, GitHub, etc.) via
MCP servers. Each service has its own auth model (API keys, OAuth 2.0), its own
MCP server (local or remote), and its own lifecycle. We need a clean separation
between the agent and tool management.

**Constraints discovered:**
- cagent's `mcp` toolset only supports **stdio transport** (`command` + `args`),
  NOT HTTP/SSE
- The moby container has no Node.js runtime (only cagent, git, gh CLI)
- Notion's remote MCP server (`https://mcp.notion.com/mcp`) uses
  Streamable HTTP/SSE with OAuth 2.0 + PKCE
- The open-source `notion-mcp-server` (npm) uses stdio and a simple API token,
  but is deprecated by Notion in favor of the remote server

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  moby container (cagent)                                    │
│                                                             │
│  soul.yaml toolsets:                                        │
│    - type: shell          (direct)                          │
│    - type: filesystem     (direct)                          │
│    - type: fetch          (direct)                          │
│    - type: mcp            ←── stdio to tool-gateway ───┐    │
│                                                        │    │
│  CLI tools (installed directly):                       │    │
│    - gh (GitHub CLI)                                   │    │
│    - curl, jq, git                                     │    │
│                                                        │    │
└────────────────────────────────────────────────────────┼────┘
                                                         │
                                                         │ stdio pipe
                                                         │ (or HTTP within compose network)
                                                         ▼
┌─────────────────────────────────────────────────────────────┐
│  tool-gateway container (Node.js)                           │
│                                                             │
│  MCP Aggregator — presents itself as ONE MCP server         │
│  that proxies to N upstream MCP servers.                    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Upstream MCP Connections                            │    │
│  │                                                      │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐          │    │
│  │  │  Notion   │  │  Google  │  │  Custom  │  ...     │    │
│  │  │  Remote   │  │  Drive   │  │  Server  │          │    │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘          │    │
│  │       │              │              │                │    │
│  │  OAuth 2.0      OAuth 2.0      API Key              │    │
│  │  + PKCE         + consent       simple               │    │
│  └───────┼──────────────┼──────────────┼───────────────┘    │
│          │              │              │                     │
│  ┌───────┼──────────────┼──────────────┼───────────────┐    │
│  │  Auth Store (encrypted JSON on disk)                │    │
│  │  - tokens, refresh tokens, client registrations     │    │
│  │  - auto-refresh before expiry                       │    │
│  │  - revocation cleanup                               │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Config: servers.yaml                                │    │
│  │  - which MCP servers are available                   │    │
│  │  - auth type + credentials for each                  │    │
│  │  - enabled/disabled state                            │    │
│  │  - connect-on-demand vs always-connected             │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Admin API (Express, port 3100)                      │    │
│  │  GET  /servers         — list configured servers     │    │
│  │  POST /servers/:id/connect    — connect a server     │    │
│  │  POST /servers/:id/disconnect — disconnect           │    │
│  │  GET  /servers/:id/auth/status — auth state          │    │
│  │  GET  /servers/:id/auth/start  — begin OAuth flow    │    │
│  │  GET  /auth/callback           — OAuth redirect      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  Exposes: MCP server on stdio (primary) or HTTP :8081       │
│  Tool namespace: notion:search, notion:fetch, gdrive:search │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Connection Models

### Model A: Sidecar with stdio pipe (cagent native MCP)

cagent's `type: mcp` toolset spawns a subprocess. The tool-gateway runs as
that subprocess (started by cagent) and communicates over stdin/stdout using
the MCP stdio transport.

```yaml
# soul.yaml
toolsets:
  - type: mcp
    command: /tool-gateway/bin/gateway
    args: ["--config", "/tool-gateway/servers.yaml"]
    env:
      GATEWAY_AUTH_DIR: /data/.mobyclaw/tool-auth
```

**Problem:** cagent spawns the process inside the moby container. The
tool-gateway binary would need to be mounted/copied into the moby container,
AND Node.js would need to be installed there. This defeats the separation goal.

### Model B: HTTP bridge in separate container (★ RECOMMENDED)

The tool-gateway runs in its own container on the compose network. It exposes
an MCP-over-HTTP endpoint. A tiny stdio bridge binary runs inside moby
(started by cagent's `type: mcp` toolset) that proxies stdio ↔ HTTP.

```
cagent ──stdio──▸ mcp-bridge (tiny binary) ──HTTP──▸ tool-gateway:8081
                  (in moby container)                 (separate container)
```

The bridge is a ~50-line shell script or small Go binary that:
1. Reads MCP JSON-RPC from stdin
2. POSTs to `http://tool-gateway:8081/mcp`
3. Writes MCP JSON-RPC responses to stdout

```yaml
# soul.yaml
toolsets:
  - type: mcp
    command: /usr/local/bin/mcp-bridge
    args: ["http://tool-gateway:8081"]
```

```yaml
# docker-compose.yml
services:
  tool-gateway:
    build: ./tool-gateway
    volumes:
      - mobyclaw_home:/data/.mobyclaw
    environment:
      - AUTH_STORE_PATH=/data/.mobyclaw/tool-auth
    ports:
      - "3100:3100"  # admin API (host access for OAuth)
    expose:
      - "8081"       # MCP endpoint (internal only)
```

### Model C: OpenAPI toolset pointing at gateway REST API

cagent supports `type: openapi` with a URL. The tool-gateway could expose
an OpenAPI spec that maps each MCP tool to a REST endpoint.

```yaml
# soul.yaml
toolsets:
  - type: openapi
    url: http://tool-gateway:8081/openapi.json
    headers:
      Authorization: Bearer ${GATEWAY_TOKEN}
```

**Pros:** No bridge needed, native cagent support
**Cons:** OpenAPI is static — tool list doesn't change dynamically as MCP
servers connect/disconnect. Would need to regenerate the spec.

### Model D: Agent uses shell/fetch to call gateway API

No MCP integration at all. The agent just calls the tool-gateway's REST API
using its existing `fetch` or `shell` tools.

```
moby: curl http://tool-gateway:8081/api/call -d '{"server":"notion","tool":"search","args":{...}}'
```

**Pros:** Zero infrastructure, works today
**Cons:** No tool discovery, agent must know API format, not structured

## Recommendation: Model B (HTTP bridge)

**Why:**
1. **Clean separation** — tool-gateway is its own container with its own Node.js
   runtime, auth management, and lifecycle
2. **Native MCP** — cagent sees real MCP tools with proper schemas via `type: mcp`
3. **Dynamic** — when servers connect/disconnect, the tools/list response changes
4. **Tiny bridge** — the mcp-bridge is a trivial HTTP-to-stdio relay, easy to
   maintain
5. **OAuth on host** — admin API on port 3100 handles OAuth flows via browser

**Fallback:** If the bridge proves fragile, Model C (OpenAPI) is a solid
alternative that's fully native to cagent.

## Tool Namespacing

MCP servers can have colliding tool names (both Notion and Google have "search").
The tool-gateway prefixes all tools with the server name:

| Upstream Tool | Namespaced Tool |
|---|---|
| `notion-search` | `notion:search` |
| `notion-fetch` | `notion:fetch` |
| `notion-create-pages` | `notion:create-pages` |
| `gdrive-search` | `gdrive:search` |
| `gdrive-read-file` | `gdrive:read-file` |

The agent sees these as distinct tools with full JSON Schema descriptions.

## Auth Models

### API Key (simple)
- Stored in `servers.yaml` or environment variable
- Examples: self-hosted Notion MCP, custom servers

### OAuth 2.0 + PKCE (Notion remote, Google)
- One-time browser flow via admin API
- Tokens stored encrypted in `tool-auth/` directory
- Auto-refresh before expiry
- Re-auth notification on token revocation

### OAuth flow for headless Docker:
1. User runs `./mobyclaw auth notion` (or visits admin API URL)
2. Gateway returns auth URL → user opens in browser
3. Browser redirects to `http://localhost:3100/auth/callback`
4. Gateway stores tokens, confirms success
5. Agent can now use Notion tools

## servers.yaml Format

```yaml
servers:
  notion:
    name: Notion
    type: remote-mcp
    url: https://mcp.notion.com/mcp
    auth:
      type: oauth2-pkce
      # tokens managed by gateway, not in config
    enabled: true
    connect: on-demand    # connect when first tool is called

  notion-local:
    name: Notion (self-hosted)
    type: stdio-mcp
    command: npx
    args: ["-y", "@notionhq/notion-mcp-server"]
    auth:
      type: api-key
      env: NOTION_API_KEY
    enabled: false

  gdrive:
    name: Google Drive
    type: remote-mcp
    url: https://some-gdrive-mcp-server/mcp
    auth:
      type: oauth2
    enabled: false

  custom:
    name: Custom Server
    type: stdio-mcp
    command: python3
    args: ["-m", "my_mcp_server"]
    auth:
      type: api-key
      env: CUSTOM_API_KEY
    enabled: false
```

## CLI Tools (Direct Install)

Some tools don't need MCP — they're just CLI binaries that cagent can call
via its `shell` toolset. These go directly in the moby container Dockerfile:

```dockerfile
# Already installed
RUN apt-get install -y git curl jq
# GitHub CLI (already present)
RUN ... install gh ...

# Future CLI tools:
# RUN apt-get install -y ...
```

The agent uses these via `shell` tool calls:
- `gh issue list --repo owner/repo`
- `gh pr create --title "..." --body "..."`
- `curl -H "Authorization: Bearer $TOKEN" https://api.example.com/...`

**Rule of thumb:**
- If the service has a good CLI → install in moby container
- If the service has an MCP server → route through tool-gateway
- If neither → teach the agent the REST API via soul.yaml instructions

## Implementation Phases

### Phase 1: Foundation
- [ ] Create `tool-gateway/` directory structure
- [ ] Build MCP aggregator server (Node.js, @modelcontextprotocol/sdk)
- [ ] Build mcp-bridge (shell script or Go binary for moby container)
- [ ] Wire into docker-compose.yml
- [ ] Test with a trivial "echo" MCP server

### Phase 2: Notion Integration
- [ ] Add Notion remote MCP as upstream server
- [ ] Implement OAuth 2.0 + PKCE flow
- [ ] Add `./mobyclaw auth notion` CLI command
- [ ] Test: agent searches Notion, reads pages, creates pages

### Phase 3: Auth & Admin
- [ ] Admin API for server management
- [ ] Encrypted token storage
- [ ] Auto-refresh logic
- [ ] Re-auth notification flow

### Phase 4: More Servers
- [ ] Google Drive MCP
- [ ] Other MCP servers as needed
- [ ] Dynamic connect/disconnect

## Open Questions

- **mcp-bridge complexity**: Can we get away with a shell script (jq + curl),
  or do we need a real binary for proper MCP JSON-RPC streaming?
- **Tool list caching**: Should cagent's MCP toolset re-discover tools on each
  session, or does the bridge need to cache the tool list?
- **OAuth in Docker**: The callback redirect to localhost:3100 works if the user
  is on the same machine. For remote Docker hosts, we'd need to expose the port
  or use a tunnel.
- **Rate limiting**: Notion has 180 req/min. Should the gateway enforce this or
  let the upstream handle errors?
