# Mobyclaw Architecture

This document has been split into smaller, focused files for easier navigation and maintenance.

**📂 See [`docs/`](docs/README.md) for the full architecture documentation.**

| Document | Description |
|---|---|
| [Vision](docs/01-vision.md) | What mobyclaw is and isn't |
| [Core Concepts](docs/02-core-concepts.md) | Agent, triggers, memory, workspaces, sessions |
| [Architecture Overview](docs/03-architecture.md) | System diagram, containers, connections |
| [Project Structure](docs/04-project-structure.md) | File layout, code vs data separation |
| [Agent Definition](docs/05-agent-definition.md) | soul.yaml format and config |
| [Gateway](docs/06-gateway.md) | Messaging, streaming, scheduler, heartbeat |
| [Docker Compose](docs/07-docker-compose.md) | Compose config, secrets, volumes |
| [CLI](docs/08-cli.md) | Commands and init flow |
| [Agent Loop](docs/09-agent-loop.md) | cagent integration |
| [Security](docs/10-security.md) | Security model |
| [Roadmap](docs/11-roadmap.md) | Phased roadmap |
| [Decisions](docs/12-decisions.md) | ADR log |
| [Open Questions](docs/13-open-questions.md) | Resolved and open questions |
| [Tool Gateway](docs/14-tool-gateway.md) | MCP aggregator, external service integration, auth |
| [Integrations](docs/15-integrations.md) | Read-only Slack, Notion, Gmail, Calendar design |

### Key Architecture Principle

**Code in the repo, data in the user folder.**

- `mobyclaw/` (the repo) contains all service code, Dockerfiles, scripts, and documentation
- `~/.mobyclaw/` (the user folder) contains all user-specific data: memory, tasks, schedules, credentials
- Containers read/write user data via bind mounts but never store code in the user folder
- Rebuilding containers never touches user data. Copying `~/.mobyclaw/` to a new machine preserves the agent's full state.

*Last updated: 2026-02-24*
