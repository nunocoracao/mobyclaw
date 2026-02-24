## 10. Agent Loop (Powered by cagent)

We do NOT implement our own agent loop. cagent handles the full cycle:

```
Prompt (from gateway, CLI, or scheduler)
  │
  ▼
cagent serve api
  │
  ├─ Assembles system prompt (soul.yaml instruction + context)
  ├─ Model inference (Anthropic/OpenAI/etc.)
  ├─ Tool execution (shell, filesystem, fetch, etc.)
  │   ├─ Read MEMORY.md, memory/*.md
  │   ├─ Write new memories
  │   ├─ Execute shell commands
  │   ├─ Tool results fed back to model
  │   └─ Loop until model produces final response
  ├─ Response streaming
  └─ Session persistence (managed by cagent)
```

**Design decision:** Delegating the agent loop entirely to cagent means:
- We get tool execution, streaming, retries, context management for free
- We focus on what matters: orchestration, messaging, and memory
- Upgrades to cagent automatically improve all mobyclaw agents
