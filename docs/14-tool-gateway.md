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
│  │  POST /servers/:id/auth/start  — begin OAuth flow    │    │
│  │  GET  /servers/:id/auth/status — check auth state    │    │
│  │  GET  /auth/callback           — OAuth redirect      │    │
│  │  GET  /servers         — list configured servers     │    │
│  │  POST /servers/:id/connect    — connect a server     │    │
│  │  POST /servers/:id/disconnect — disconnect           │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  Auth flow (chat-mediated):                                 │
│    1. User tells Moby: "connect notion"                     │
│    2. Moby calls POST /servers/notion/auth/start            │
│    3. Gateway returns { auth_url }                          │
│    4. Moby sends auth_url to user via Telegram              │
│    5. User clicks → authorizes → redirect to /auth/callback │
│    6. Gateway stores tokens                                 │
│    7. Moby polls auth/status → confirms to user             │
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

## Recommendation: Stateless MCP Streamable HTTP (Model B variant)

After implementation, we chose a **stateless** variant of Model B:

**Why stateless:** The MCP SDK's `StreamableHTTPServerTransport` in stateful
mode has a race condition where `notifications/initialized` arrives before
the transport marks itself as "initialized". Stateless mode (`sessionIdGenerator:
undefined`) avoids this entirely — each POST creates a fresh server+transport
pair. Since our tools are stateless (fetch a URL, check weather), this is
perfect.

**Implemented architecture:**
```
cagent ──stdio──▸ mcp-bridge (Node.js) ──HTTP──▸ tool-gateway:8081
                  (McpServer+StdioTransport)    (McpServer+StreamableHTTP)
                  (in moby container)            (separate container)
```

The mcp-bridge:
1. Connects to tool-gateway via `StreamableHTTPClientTransport`
2. Discovers remote tools via `client.listTools()`
3. Re-registers each tool locally via `McpServer.tool()`
4. Serves them to cagent via `StdioServerTransport`

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

All auth flows are **chat-mediated** — the user never needs to SSH into the
server, run CLI commands, or open admin UIs. Moby handles it conversationally
through whatever channel the user is already on (Telegram, CLI, etc.).

### Pattern 1: Device Code Flow (GitHub-style)

Services that support OAuth device code flow (RFC 8628).
No callback URL needed — works from any device.

```
User: "connect to github"
Moby: "Open https://github.com/login/device and enter code: ABCD-1234"
User: [does it on phone/desktop, any device]
Moby: "✅ GitHub connected! I can now access your repos."
```

**How it works internally:**
1. Moby (or tool-gateway) calls the service's device authorization endpoint
2. Gets back: `verification_uri` + `user_code`
3. Sends both to user via the active messaging channel
4. Polls the token endpoint until user completes auth
5. Stores tokens

**Services:** GitHub (`gh auth login` already works this way)

### Pattern 2: Chat-Mediated OAuth Redirect (Notion-style)

Services that only support authorization_code + PKCE (no device code).
Requires a callback URL, but the flow is still initiated through chat.

```
User: "connect notion"
Moby: "Click this link to authorize Notion:
       https://mcp.notion.com/authorize?client_id=...&redirect_uri=...
       (opens in your browser)"
User: [clicks link, authorizes on Notion's consent screen]
      [browser redirects to tool-gateway callback URL]
Moby: "✅ Notion connected! I can now search and manage your workspace."
```

**How it works internally:**
1. User tells Moby to connect a service
2. Moby calls tool-gateway: `POST /servers/notion/auth/start`
3. Tool-gateway:
   a. Discovers OAuth endpoints (RFC 9470 → RFC 8414)
   b. Registers as OAuth client (dynamic registration, RFC 7591)
   c. Generates PKCE code_verifier + code_challenge
   d. Returns `{ auth_url: "https://...", state: "..." }`
4. Moby sends the auth_url to the user via Telegram/CLI
5. User clicks, authorizes, browser redirects to callback
6. Tool-gateway receives callback at `/auth/callback?code=...`
7. Tool-gateway exchanges code for tokens, stores them
8. Moby polls `GET /servers/notion/auth/status` → `{ connected: true }`
9. Moby confirms to user

**Callback URL handling:**
- Default: `http://localhost:3100/auth/callback` (works when user's browser
  is on the same machine as Docker)
- For remote Docker hosts: user can set `TOOL_GATEWAY_CALLBACK_URL` env var,
  or use a tunnel (e.g., ngrok) temporarily
- Fallback: callback page displays the auth code with instructions to
  paste it back to Moby ("copy-paste mode") — works from any device

**Services:** Notion remote MCP, Google (no device code support)

**Notion-specific findings:**
- OAuth metadata: `https://mcp.notion.com/.well-known/oauth-authorization-server`
- Grant types: `authorization_code`, `refresh_token` (NO device code)
- Supports PKCE: S256 and plain
- Supports dynamic client registration at `/register`
- Access tokens expire after 1 hour
- Refresh tokens rotate on use (keep max 2 valid at a time)

### Pattern 3: API Key (simple)

Services that use a static token. User tells Moby the key, or it's in the
environment.

```
User: "connect to my custom MCP server, the API key is sk-abc123"
Moby: [stores key via tool-gateway]
Moby: "✅ Connected! I see 5 tools available."
```

**Services:** Self-hosted MCP servers, custom APIs

### Auth Store

All credentials are stored by the tool-gateway in `~/.mobyclaw/tool-auth/`:

```
~/.mobyclaw/tool-auth/
  notion.json     # { access_token, refresh_token, expires_at, client_id, ... }
  gdrive.json     # { access_token, refresh_token, ... }
  custom.json     # { api_key: "..." }
```

- Tokens encrypted at rest (AES-256 with key from `TOOL_GATEWAY_SECRET` env var)
- Auto-refresh: gateway refreshes tokens 5 min before expiry
- Revocation detection: if refresh fails with `invalid_grant`, gateway marks
  server as disconnected and Moby notifies user on next heartbeat
- Re-auth: user just says "reconnect notion" and the flow repeats

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

### Phase 1: Foundation ✅ COMPLETE
- [x] Create `tool-gateway/` directory structure
- [x] Build MCP aggregator server (Node.js, @modelcontextprotocol/sdk)
- [x] Build mcp-bridge (Node.js, McpServer↔StreamableHTTPClient)
- [x] Wire into docker-compose.yml
- [x] Browser tools: `browser_fetch` (Readability), `browser_search` (DuckDuckGo)
- [x] Weather tool: `weather_get` (Open-Meteo, no API key)
- [x] Tested end-to-end: agent searched web and summarized results

### Phase 1.5: Browser Automation ✅ COMPLETE
- [x] Full headless browser via Playwright + Chromium in tool-gateway
- [x] Accessibility snapshot with ref-based element targeting (Playwright internal `_snapshotForAI`)
- [x] 16 browser tools: navigate, snapshot, screenshot, click, type, fill_form, select_option, hover, press_key, scroll, back, forward, wait, tabs, close, eval
- [x] mcp-bridge updated: recursive JSON Schema → Zod conversion (handles arrays, objects, enums)
- [x] Persistent browser context with 10min idle auto-close
- [x] Tested end-to-end: navigated pages, filled/submitted forms, took screenshots
- [x] Agent max_iterations raised to 15 (browser tasks need more steps)
- [x] **Snapshot trimming**: Tree-based `trimSnapshot()` — parses indentation tree, strips /url metadata, unwraps noise wrappers, removes separator text, collapses repeated siblings, hard-caps at 5000 chars. Real-world results: HN 59KB→1.4KB (98%), GitHub 53KB→5KB (91%), Wikipedia 135KB→5KB (96%). `browser_snapshot` accepts `full=true` for uncompacted output.

### Phase 2: Notion Integration
- [ ] Add Notion remote MCP as upstream server
- [ ] Implement OAuth 2.0 + PKCE flow (chat-mediated)
- [ ] Auth start/status/callback API endpoints on tool-gateway
- [ ] Teach Moby (via soul.yaml) how to initiate "connect notion" flow
- [ ] Test: user says "connect notion" → gets link via Telegram → authorizes → Moby confirms
- [ ] Test: agent searches Notion, reads pages, creates pages

### Phase 3: Auth Lifecycle
- [ ] Encrypted token storage (AES-256)
- [ ] Auto-refresh logic (5 min before expiry)
- [ ] Re-auth notification on heartbeat when token is revoked
- [ ] Copy-paste fallback for remote Docker hosts

### Phase 4: More Servers
- [ ] Google Drive MCP (OAuth redirect pattern)
- [ ] Other MCP servers as needed
- [ ] Dynamic connect/disconnect via chat

## Open Questions

- ~~**mcp-bridge complexity**~~: **RESOLVED** — Required full Node.js + MCP SDK,
  not a shell script. McpServer on stdio side, StreamableHTTPClientTransport
  on HTTP side. ~100 lines of JavaScript.
- ~~**Tool list caching**~~: **RESOLVED** — Bridge discovers tools once at startup
  and re-registers them. Tool list is static for the lifetime of the bridge
  process (which is per-cagent-session).
- **Notion OAuth callback from phone**: If user clicks Notion auth link from
  Telegram on their phone, the redirect to `localhost:3100` won't work.
  Copy-paste fallback needed: callback page shows auth code, user sends
  it back to Moby. Or: Moby detects channel is mobile and uses copy-paste
  mode by default.
- **Rate limiting**: Notion has 180 req/min. Should the gateway enforce this or
  let the upstream handle errors?
- **Soul.yaml dynamic update**: When tool-gateway connects a new server, the
  agent's tool list changes. Does cagent pick this up automatically via MCP
  tools/list, or does the session need a restart?
