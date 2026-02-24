# Mobyclaw Architecture

> **Source of truth** for all design decisions. Every significant pattern,
> trade-off, and rationale lives here. Consult before making changes; update
> after making decisions.

## Contents

| # | Document | Description |
|---|---|---|
| 1 | [Vision](01-vision.md) | What mobyclaw is, what it isn't, OpenClaw comparison |
| 2 | [Core Concepts](02-core-concepts.md) | Personal agent, triggers, memory, workspaces, sessions, self-modification |
| 3 | [Architecture Overview](03-architecture.md) | System diagram, container roles, service connections |
| 4 | [Project Structure](04-project-structure.md) | File layout and what's in each directory |
| 5 | [Agent Definition](05-agent-definition.md) | soul.yaml format, runtime config, cagent integration |
| 6 | [Gateway](06-gateway.md) | Message flow, streaming, scheduler, heartbeat, channels, TASKS.md |
| 7 | [Docker Compose](07-docker-compose.md) | Compose manifests, override generation, volume mounts, secrets |
| 8 | [CLI](08-cli.md) | `mobyclaw` commands, init flow, design decisions |
| 9 | [Agent Loop](09-agent-loop.md) | How cagent powers the agent loop |
| 10 | [Security](10-security.md) | Security model (current and planned) |
| 11 | [Roadmap](11-roadmap.md) | Phased roadmap with status |
| 12 | [Decisions](12-decisions.md) | Architectural Decision Records (ADR log) |
| 13 | [Open Questions](13-open-questions.md) | Unresolved and resolved questions |
| 14 | [Tool Gateway](14-tool-gateway.md) | MCP aggregator, browser automation, external service integration, auth |
| 15 | [Integrations](15-integrations.md) | Read-only Slack, Notion, Gmail, Google Calendar design |

## Quick Reference

**Three services:**
- **moby** — AI brain (cagent serve api, port 8080)
- **gateway** — Orchestrator (Node.js/Express, port 3000)
- **tool-gateway** — External tools + browser (Node.js/Playwright, port 8081 MCP + port 3100 admin)

**19 MCP tools** via tool-gateway:
- 3 quick tools: `browser_fetch`, `browser_search`, `weather_get`
- 16 browser automation: `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_hover`, `browser_press_key`, `browser_scroll`, `browser_back`, `browser_forward`, `browser_wait`, `browser_tabs`, `browser_close`, `browser_eval`

**Key paths:**
- `~/.mobyclaw/` — All agent state (memory, config, schedules)
- `/source/` — Project source (mounted in agent container)
- `/workspace/` — User projects (bind-mounted from host)

**Gateway modules:** index → orchestrator → agent-client → sessions, with scheduler, heartbeat, channels, adapter-registry, and routes as peers.

*Last updated: 2026-02-24*
