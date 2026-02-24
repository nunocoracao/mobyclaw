#!/bin/bash
# Self-Healing Boot - Checks and fixes common issues on startup
# Usage: self-heal.sh [MOBY_DIR]

MOBY_DIR="${1:-/data/.mobyclaw}"
HEAL_LOG="$MOBY_DIR/memory/$(date -u +%Y-%m-%d)-heal.log"
ISSUES_FOUND=0

log() { echo "[$(date -u +%H:%M:%S)] $1" | tee -a "$HEAL_LOG"; }
fix() { log "FIX: $1"; ISSUES_FOUND=$((ISSUES_FOUND + 1)); }

mkdir -p "$MOBY_DIR/memory"
echo "=== Self-Healing Boot $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$HEAL_LOG"

# 1. Check critical files exist
for f in MEMORY.md TASKS.md LESSONS.md HEARTBEAT.md; do
  if [ ! -f "$MOBY_DIR/$f" ]; then
    fix "$f missing, creating..."
    touch "$MOBY_DIR/$f"
    case "$f" in
      MEMORY.md) printf "# Memory\n> Agent long-term memory\n" > "$MOBY_DIR/$f" ;;
      TASKS.md) printf "# Tasks\n> Agent task tracking\n" > "$MOBY_DIR/$f" ;;
      LESSONS.md) printf "# Lessons Learned\n> What the agent has learned from experience\n" > "$MOBY_DIR/$f" ;;
      HEARTBEAT.md) printf "# Heartbeat Checklist\n> Reviewed on each heartbeat\n" > "$MOBY_DIR/$f" ;;
    esac
  fi
done

# 2. Check directories exist
for d in memory memory/archives data dashboard scripts state journal; do
  if [ ! -d "$MOBY_DIR/$d" ]; then
    fix "Directory $d missing, creating..."
    mkdir -p "$MOBY_DIR/$d"
  fi
done

# 3. Check tasks.db exists and is valid
if [ -f "$MOBY_DIR/data/tasks.db" ]; then
  if ! python3 -c "import sqlite3; c=sqlite3.connect('$MOBY_DIR/data/tasks.db'); c.execute('SELECT count(*) FROM tasks')" 2>/dev/null; then
    fix "tasks.db corrupted, backing up..."
    mv "$MOBY_DIR/data/tasks.db" "$MOBY_DIR/data/tasks.db.corrupt.$(date +%s)"
  fi
else
  log "tasks.db not found - will be created on server start"
fi

# 4. Check for stale IN PROGRESS tasks in MEMORY.md
STALE=$(grep -c "Status:\*\* IN PROGRESS" "$MOBY_DIR/MEMORY.md" 2>/dev/null || echo 0)
if [ "$STALE" -gt 0 ]; then
  log "WARN: Found $STALE IN PROGRESS tasks in MEMORY.md - may need agent attention"
fi

# 5. Check MEMORY.md isn't too large (>50KB = time to compress)
if [ -f "$MOBY_DIR/MEMORY.md" ]; then
  SIZE=$(wc -c < "$MOBY_DIR/MEMORY.md")
  if [ "$SIZE" -gt 51200 ]; then
    log "WARN: MEMORY.md is ${SIZE} bytes (>50KB) - compression recommended"
  fi
fi

# 6. Clean up old heal logs (keep last 7 days)
find "$MOBY_DIR/memory/" -name "*-heal.log" -mtime +7 -delete 2>/dev/null

# Summary
if [ "$ISSUES_FOUND" -eq 0 ]; then
  log "All checks passed - system healthy"
else
  log "Fixed $ISSUES_FOUND issues"
fi

echo "$ISSUES_FOUND"
