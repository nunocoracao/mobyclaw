# Read-Only Integration Tools — Design Document

> **Status:** Planning (not yet implemented)
> **Date:** 2026-02-24
> **Goal:** Give Moby read-only access to Slack, Notion, Gmail, and Google Calendar

---

## Overview

Four integrations, all **read-only for beta**. The agent can read, search, and summarize content from these services but cannot modify anything (no sending messages, creating pages, updating events, etc.).

Write capabilities will be considered in a future phase after read-only is battle-tested.

## Architecture Decision: Native Tools, Not Upstream MCP

**Decision:** Implement these as native tool-gateway tools (like `browser_fetch`, `weather_get`, `playwright.js`) rather than proxying to upstream MCP servers.

**Rationale:**
- We only need 3-5 read-only endpoints per service — not the full API surface
- No dependency on third-party MCP server packages (stability, maintenance)
- Direct REST calls are simpler, faster, and easier to debug
- We control the tool schemas, descriptions, and response formatting
- The tool-gateway already has the Express app, auth store design, etc.
- Upstream MCP servers can be added later if we need full read/write

**Consequence:** Each integration is a file in `tool-gateway/src/tools/` (like `slack.js`, `notion.js`, `google.js`), registered in `src/index.js`.

---

## Auth Architecture

### Token Storage

```
~/.mobyclaw/tokens/
  slack.json       # { access_token, team_id, team_name, user_id, scopes[], expires_at? }
  notion.json      # { access_token, refresh_token, workspace_name, bot_id, expires_at }
  google.json      # { access_token, refresh_token, email, scopes[], expires_at }
```

Volume mount: `~/.mobyclaw/tokens` → `/data/.mobyclaw/tokens` in tool-gateway container.

**Encryption:** Tokens encrypted at rest with AES-256-GCM. Key derived from `TOOL_GATEWAY_SECRET` env var (user sets once in `.env`). If not set, tokens stored in plaintext with a warning on startup.

### Unified Auth Flow (Chat-Mediated OAuth)

All four services use OAuth 2.0 with authorization_code grant. The flow is identical for all:

```
User: "connect slack" (or "connect notion", "connect google")
Moby: calls POST http://tool-gateway:3100/auth/start?service=slack
Gateway: returns { auth_url: "https://slack.com/oauth/v2/authorize?..." }
Moby: sends clickable link to user via Telegram
User: clicks → authorizes → browser redirects to callback
Gateway: receives callback, exchanges code for tokens, stores them
Moby: polls GET http://tool-gateway:3100/auth/status?service=slack → { connected: true }
Moby: "✅ Slack connected! I can now read your channels and messages."
```

### Auth Admin API Endpoints

Added to tool-gateway's admin API (port 3100):

```
POST /auth/start?service={name}         → { auth_url, state }
GET  /auth/status?service={name}        → { connected, service_info }
GET  /auth/callback?code=...&state=...  → handles OAuth redirect
POST /auth/disconnect?service={name}    → revoke + delete tokens
GET  /auth/services                     → list all services + connection status
```

### OAuth Setup Requirements

Each service needs a developer app/project created **once** by the user:

| Service | Setup Location | Credentials Needed | Env Vars |
|---|---|---|---|
| **Slack** | https://api.slack.com/apps | Client ID, Client Secret | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` |
| **Notion** | https://www.notion.so/my-integrations | ~~OAuth~~ Internal integration token | `NOTION_TOKEN` |
| **Google** | https://console.cloud.google.com | Client ID, Client Secret | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |

**Note on Notion:** For read-only access, an **internal integration** (API token) is far simpler than OAuth. The user creates it at notion.so/my-integrations, shares the pages/databases they want Moby to access, and pastes the token. No OAuth flow needed. This matches the user's "read Notion pages/databases" use case perfectly.

**Note on Google:** One Google Cloud project + one OAuth consent screen serves both Gmail and Calendar. User enables both APIs, creates OAuth credentials once. Scopes requested during auth: `gmail.readonly` + `calendar.readonly`.

### Callback URL

Default: `http://localhost:3100/auth/callback`

Works when Docker runs on the user's machine (which it does for mobyclaw). For remote hosts, configurable via `OAUTH_CALLBACK_URL` env var.

**Copy-paste fallback:** If callback redirect fails (e.g., user clicks from phone), the callback page shows the auth code and instructs: "Send this code to Moby: `AUTH:abc123`". Moby accepts this format in chat and completes the flow.

---

## Service-Specific Design

### 1. Slack

**Auth:** OAuth 2.0 (User Token)
- Scopes: `search:read`, `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `users:read`, `users.profile:read`
- Using User Token (not Bot Token) because we need to read private channels and DMs the user is in

**Tools (4):**

| Tool | Description | Slack API |
|---|---|---|
| `slack_channels` | List channels the user is in (with unread counts) | `conversations.list` + `conversations.info` |
| `slack_history` | Read recent messages from a channel | `conversations.history` + `conversations.replies` |
| `slack_search` | Search messages across all channels | `search.messages` |
| `slack_profile` | Look up a user's profile | `users.info` / `users.profile.get` |

**Response formatting:** Messages formatted as:
```
#general — 3 unread
  @alice (2h ago): Has anyone tried the new Docker build system?
    @bob (1h ago): Yes! It's much faster with BuildKit.
    @alice (45m ago): Great, will switch today.
  @charlie (30m ago): Reminder: standup in 30 minutes
```

### 2. Notion

**Auth:** Internal Integration Token (API key, no OAuth)
- User creates integration at https://www.notion.so/my-integrations
- User shares specific pages/databases with the integration
- Token set as `NOTION_TOKEN` env var or provided via chat ("connect notion, my token is ntn_...")

**Tools (4):**

| Tool | Description | Notion API |
|---|---|---|
| `notion_search` | Search across pages and databases | `POST /v1/search` |
| `notion_page` | Read a page's content (blocks) | `GET /v1/pages/{id}` + `GET /v1/blocks/{id}/children` |
| `notion_database` | Query a database (with optional filters) | `POST /v1/databases/{id}/query` |
| `notion_list` | List all accessible pages and databases | `POST /v1/search` (no query) |

**Response formatting:** Notion blocks converted to Markdown for easy LLM consumption. Rich text → plain text. Page properties → YAML-like header.

### 3. Gmail

**Auth:** Google OAuth 2.0
- Scope: `https://www.googleapis.com/auth/gmail.readonly`
- Shared Google Cloud project with Calendar

**Tools (4):**

| Tool | Description | Gmail API |
|---|---|---|
| `gmail_inbox` | List recent emails (subject, from, date, snippet) | `messages.list` + `messages.get` (headers only) |
| `gmail_read` | Read full email content | `messages.get` (full format) |
| `gmail_search` | Search emails (Gmail search syntax) | `messages.list` with `q` parameter |
| `gmail_labels` | List labels with message counts | `labels.list` |

**Response formatting:** Emails formatted as:
```
From: Alice Smith <alice@example.com>
To: you@example.com
Date: 2026-02-24 10:30 AM
Subject: Re: Q1 Planning

Hey! Just wanted to follow up on the budget discussion...
[body truncated at 2000 chars — use gmail_read with full=true for complete email]
```

**Important:** HTML emails are converted to plain text. Attachments listed by name/size but not downloaded.

### 4. Google Calendar

**Auth:** Google OAuth 2.0 (same token as Gmail)
- Scope: `https://www.googleapis.com/auth/calendar.readonly`
- Both scopes requested together during single auth flow

**Tools (3):**

| Tool | Description | Calendar API |
|---|---|---|
| `calendar_today` | Get today's events (or a specific date) | `events.list` with timeMin/timeMax |
| `calendar_upcoming` | Get upcoming events (next N days) | `events.list` with timeMin/timeMax |
| `calendar_search` | Search events by text query | `events.list` with `q` parameter |

**Response formatting:**
```
📅 Today — Monday, February 24, 2026

09:00-09:30  Team Standup (Google Meet)
             Attendees: Alice, Bob, Charlie
10:00-11:00  1:1 with Manager
             Location: Room 4B
12:00-13:00  Lunch (blocked)
14:00-15:30  Sprint Planning
             Attendees: Full team (12 people)

4 events today. Next free slot: 11:00-12:00
```

---

## Tool Summary

| # | Tool | Service | Description |
|---|---|---|---|
| 1 | `slack_channels` | Slack | List channels with unread counts |
| 2 | `slack_history` | Slack | Read channel messages |
| 3 | `slack_search` | Slack | Search messages |
| 4 | `slack_profile` | Slack | Look up user profile |
| 5 | `notion_search` | Notion | Search pages and databases |
| 6 | `notion_page` | Notion | Read page content |
| 7 | `notion_database` | Notion | Query a database |
| 8 | `notion_list` | Notion | List accessible pages/databases |
| 9 | `gmail_inbox` | Gmail | List recent emails |
| 10 | `gmail_read` | Gmail | Read full email |
| 11 | `gmail_search` | Gmail | Search emails |
| 12 | `gmail_labels` | Gmail | List labels |
| 13 | `calendar_today` | Calendar | Today's events |
| 14 | `calendar_upcoming` | Calendar | Upcoming events |
| 15 | `calendar_search` | Calendar | Search events |

**Total: 15 new tools** (19 existing + 15 = 34 total MCP tools)

---

## Implementation Order

### Phase 1: Auth Infrastructure
1. Token store (`tool-gateway/src/auth/store.js`) — read/write/encrypt tokens
2. Auth routes (`tool-gateway/src/auth/routes.js`) — `/auth/start`, `/auth/status`, `/auth/callback`, `/auth/services`
3. Google OAuth flow (authorization_code + PKCE, auto-refresh)
4. Slack OAuth flow
5. Notion token input (simple API key, no OAuth needed)
6. Copy-paste fallback for callback

### Phase 2: Notion Tools (simplest, no OAuth)
1. `notion.js` — 4 tools, direct REST to api.notion.com
2. Notion block → Markdown converter
3. Update soul.yaml with Notion tool descriptions
4. Test end-to-end: search, read page, query database

### Phase 3: Google Tools
1. `google.js` — 7 tools (4 Gmail + 3 Calendar)
2. HTML email → plain text converter
3. Calendar event formatter
4. Token auto-refresh (Google tokens expire in 1 hour)
5. Test end-to-end: read inbox, check calendar

### Phase 4: Slack Tools
1. `slack.js` — 4 tools, direct REST to slack.com/api
2. Message thread formatter
3. Test end-to-end: list channels, read history, search

### Phase 5: Soul.yaml + UX
1. Update soul.yaml with all integration tool descriptions
2. Teach Moby the "connect {service}" conversational flow
3. Add connection status to `/status` command
4. Add integration health to heartbeat checks

---

## File Changes

```
tool-gateway/
  src/
    auth/
      store.js           # Token storage (read/write/encrypt/refresh)
      routes.js          # Auth admin API routes
      google-oauth.js    # Google-specific OAuth logic
      slack-oauth.js     # Slack-specific OAuth logic
    tools/
      notion.js          # 4 Notion tools
      google.js          # 7 Google tools (Gmail + Calendar)
      slack.js           # 4 Slack tools
    index.js             # Updated to register new tools + auth routes
  package.json           # Add googleapis dependency (if using client lib)
```

```
docker-compose.yml       # Add OAUTH_CALLBACK_URL, new env vars
.env                     # Add SLACK_CLIENT_ID, GOOGLE_CLIENT_ID, etc.
agents/moby/soul.yaml    # Add integration tool descriptions
docs/12-decisions.md     # ADR-053: Native tools over upstream MCP
docs/14-tool-gateway.md  # Update implementation phases
docs/11-roadmap.md       # Phase 3.0: Read-only integrations
```

---

## Security Considerations

1. **Read-only scopes only** — No write permissions requested. Gmail: `gmail.readonly`, not `gmail.modify`. Calendar: `calendar.readonly`. Slack: `*:read`/`*:history`, no `*:write`.

2. **Token encryption at rest** — AES-256-GCM with key from `TOOL_GATEWAY_SECRET`

3. **No token logging** — Tokens never appear in logs, tool responses, or error messages

4. **User controls access** — Notion: user explicitly shares pages with integration. Slack: user authorizes specific scopes. Google: consent screen shows exactly what's being accessed.

5. **Revocation** — User can say "disconnect slack" and tokens are deleted + revoked at the provider

6. **No data caching** — Tool-gateway is stateless for data. Each tool call fetches fresh from the API. (Token refresh caching is fine.)

---

## Open Questions

1. **Slack workspace selection** — If user is in multiple Slack workspaces, which one? → Start with single workspace. Can extend later with `slack_workspaces` tool.

2. **Gmail pagination** — Inbox can have thousands of emails. Default to 20 most recent. `gmail_inbox` accepts `count` parameter (max 50).

3. **Notion block depth** — Pages can be deeply nested. Default to 3 levels of child blocks. `notion_page` accepts `depth` parameter.

4. **Google project setup complexity** — Creating a Google Cloud project + OAuth consent screen + enabling APIs is ~10 steps. Consider writing a setup guide or script. The `./mobyclaw setup google` CLI command could walk through it.

5. **Rate limits** — Slack: 1 req/sec (Tier 1-4 vary). Google: varies per API. Notion: 3 req/sec average. Tool-gateway should handle 429 with retry-after. Simple exponential backoff.
