## 11. Security Model

### Phase 1 (Simple)

| Concern | Mitigation |
|---|---|
| Agent isolation | Runs in its own container |
| Workspace access | Volume mounts control what agent can see |
| API key exposure | `.env` file, not baked into images; least-privilege per container (§7.4) |
| Network access | Agent can reach internet (needed for LLM APIs) |
| Resource limits | Compose `deploy.resources` caps memory + CPU |
| Host access | Non-root container user, no privileged mode |

### Phase 2 (Hardened)

- Read-only root filesystem with tmpfs for `/tmp`
- Network policy: agent can only reach LLM APIs + gateway
- DM access control: allowlists per messaging channel
- Agent-specific API key scoping
- Workspace access tiers: `none`, `ro`, `rw`
