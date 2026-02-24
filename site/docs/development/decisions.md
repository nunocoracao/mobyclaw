## 13. Key Architectural Decisions Log

| # | Decision | Rationale | Date |
|---|---|---|---|
| ADR-001 | Use cagent native YAML, no wrapper format | Zero translation layer, users get full cagent features | 2026-02-23 |
| ADR-002 | `soul.yaml` as single identity file per agent | Simpler than OpenClaw's 6+ bootstrap files. Can add more via `add_prompt_files` | 2026-02-23 |
| ADR-003 | `cagent serve api` as primary container entrypoint | HTTP API is the natural interface for containerized agents | 2026-02-23 |
| ADR-004 | Bash CLI, not compiled binary | Minimal dependencies (docker, curl, jq). Ship fast, iterate. | 2026-02-23 |
| ADR-005 | Debian slim base image | Better cagent/tool compat than Alpine. Acceptable size trade-off. | 2026-02-23 |
| ADR-006 | `mobyclaw.yaml` is dev-only, not product config | Separation of concerns: dev agent ≠ product agent | 2026-02-23 |
| ADR-007 | "moby" as the default/reference agent | Clear identity, easy onboarding, extensible pattern | 2026-02-23 |
| ADR-008 | Docker Compose over Kubernetes | Right-sized for personal agent deployment. K8s is overkill. | 2026-02-23 |
| ADR-009 | Delegate agent loop entirely to cagent | Focus on orchestration, not reimplementing inference + tool execution | 2026-02-23 |
| ADR-010 | Memory as plain Markdown files (OpenClaw pattern) | Simple, portable, agent can read/write with filesystem tools. No DB needed. | 2026-02-23 |
| ADR-011 | Gateway as separate container from agent | Clean separation: gateway handles I/O + routing, agent handles thinking + acting | 2026-02-23 |
| ADR-012 | Messaging adapters inside gateway, not separate containers | Simpler (one container), all JS libs anyway, enable/disable via env vars. Matches OpenClaw. | 2026-02-23 |
| ADR-013 | Docker volumes for persistence | Workspace (memory) and data (sessions, cron) survive container restarts | 2026-02-23 |
| ADR-014 | 4-service separation: moby, gateway, workspace, memory | Each concern in its own container. Clean ownership. Independent scaling/failure. | 2026-02-23 |
| ADR-015 | Workspace + memory as MCP servers | cagent's `type: mcp` toolset connects moby to services. No direct host mounts on agent. | 2026-02-23 |
| ADR-016 | Separate workspace and memory volumes | Workspace = host files (projects, code). Memory = agent state (MEMORY.md, daily logs). Different lifecycles, different owners. | 2026-02-23 |
| ADR-017 | `~/.mobyclaw/` as user data directory, bind-mounted | User-visible, editable, portable, survives `docker system prune`. Not a Docker volume. | 2026-02-23 |
| ADR-018 | Messaging adapters inside gateway, not separate bridge containers | Simpler, less config, matches OpenClaw. Enable via env var presence. | 2026-02-23 |
| ADR-019 | Single agent only — no multi-agent support | Mobyclaw is a personal agent, not a platform. One agent (moby), one container. Simplifies routing, config, and mental model. Can always revisit. | 2026-02-23 |
| ADR-020 | Sessions created with `tools_approved: true` | `cagent serve api` pauses at `tool_call_confirmation` unless the session has `tools_approved: true`. Gateway sets this on session creation. Container isolation provides the safety boundary. | 2026-02-23 |
| ADR-021 | `.env` file for secrets management | Single file, Docker Compose native, no Swarm/Vault needed. Least-privilege: per-service `environment` blocks control which container sees which var. | 2026-02-23 |
| ADR-022 | End-to-end streaming via SSE PassThrough | cagent emits tokens in real-time. Gateway streams them through via PassThrough piped to HTTP response. Critical: use `res.on('close')` not `req.on('close')` for disconnect detection. Telegram adapter edits message every ~1s. CLI prints tokens to stdout. | 2026-02-23 |
| ADR-023 | `docker-compose.override.yml` for per-user config | Base compose stays static + git-committed. Override is auto-generated from `credentials.env` + `workspaces.conf` on every `mobyclaw up`. Docker Compose merges them automatically. Gitignored. | 2026-02-23 |
| ADR-024 | Separate `credentials.env` from `.env` | `.env` = mobyclaw infra (LLM keys, messaging). `credentials.env` = user service tokens (gh, aws). Different owners, different lifecycle. credentials.env lives in `~/.mobyclaw/` (portable with agent state). | 2026-02-23 |
| ADR-025 | Workspaces as host bind mounts via `workspaces.conf` | Simple `name=path` format in `~/.mobyclaw/workspaces.conf`. CLI manages it (`workspace add/remove/list`). Override generation maps to Docker volumes. Changes require restart. | 2026-02-23 |
| ADR-026 | Gateway-side scheduler with agent-created schedules via REST API | Agent calls `POST /api/schedules` via curl. Gateway owns timing, persistence, and delivery. Separation: agent composes messages, gateway delivers at the right time. No agent involvement at fire time (pre-composed messages). | 2026-02-23 |
| ADR-027 | Heartbeat as periodic agent prompt, separate from scheduler | Scheduler = precise dumb timer (30s resolution). Heartbeat = intelligent agent review (15m interval). Different concerns: scheduler delivers pre-composed messages; heartbeat invokes full LLM reasoning. Agent uses `/api/deliver` to proactively message users from heartbeat. | 2026-02-23 |
| ADR-028 | TASKS.md as agent-managed task store (Markdown) | Flexible Markdown file. Agent writes entries via filesystem tools. `[scheduled]` marker prevents double-scheduling. Channel stored per-task. Heartbeat reviews it. Complements schedules.json (gateway-owned) — TASKS.md is the agent's view, schedules.json is the gateway's execution state. | 2026-02-23 |
| ADR-029 | Channel context injected as message prefix by gateway | Gateway prepends `[context: channel=telegram:123, time=...]` to every user message. Only mechanism available since cagent API has no per-message metadata. Agent extracts channel for schedule creation. Never displayed to user. | 2026-02-23 |
| ADR-030 | Last active channel for fallback delivery | Gateway tracks last messaging channel used. Fallback when heartbeat/agent needs to deliver without a specific channel target. Resets on restart (acceptable for personal agent). | 2026-02-23 |
| ADR-031 | Source code mounted at `/source` for self-modification | Agent needs to modify its own Dockerfile, gateway source, compose config, CLI, and documentation. Bind-mounting the project root gives full read-write access. Safety via: git (revert), permission-before-modify policy, syntax checks before rebuild. Four signal types: `restart`, `rebuild`, `rebuild-gateway`, `rebuild-all`. | 2026-02-23 |
