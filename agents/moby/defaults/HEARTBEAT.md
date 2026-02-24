# Heartbeat Checklist

> This file is read by the agent on every heartbeat wake-up.
> Edit it to control what the agent checks periodically.
> If nothing below needs attention, the agent responds HEARTBEAT_OK silently.

## On Every Heartbeat

- [ ] Check dashboard health: `curl -sf http://dashboard:7777/api/status`
- [ ] Check MEMORY.md for any `IN PROGRESS` tasks - decide: continue, retry, or notify user
- [ ] Review today's daily log - anything left unfinished?

## Daily (once per day, morning heartbeat)

- [ ] Write a brief summary of the day to today's memory daily log
- [ ] Archive completed tasks (via `curl -X POST http://dashboard:7777/api/memory/compress`)

## Weekly (Monday morning)

- [ ] Generate a weekly summary of activity

## Custom Checks

<!-- Add your own periodic checks here. Examples: -->
<!-- - [ ] Check if the deployment pipeline is green -->
<!-- - [ ] Summarize unread emails -->
<!-- - [ ] Review calendar for upcoming meetings -->
