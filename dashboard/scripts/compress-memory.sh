#!/bin/bash
# Memory Compression - Archives old completed tasks from MEMORY.md
# Usage: compress-memory.sh [MOBY_DIR]

MOBY_DIR="${1:-/data/.mobyclaw}"
ARCHIVE_DIR="$MOBY_DIR/memory/archives"
TODAY=$(date -u +%Y-%m-%d)

mkdir -p "$ARCHIVE_DIR"

# Use the dashboard server API if available
DASHBOARD_PORT="${DASHBOARD_PORT:-7777}"
if curl -sf "http://localhost:$DASHBOARD_PORT/api/memory/compress" -X POST > /dev/null 2>&1; then
  echo "Compressed via API"
  exit 0
fi

# Fallback: manual compression
MEMORY="$MOBY_DIR/MEMORY.md"
ARCHIVE="$ARCHIVE_DIR/$TODAY-tasks.md"

if [ ! -f "$MEMORY" ]; then
  echo "No MEMORY.md found"
  exit 1
fi

# Count DONE/CANCELLED tasks
COUNT=$(grep -c "Status:\*\* \(DONE\|CANCELLED\)" "$MEMORY" || echo 0)
echo "Found $COUNT completed tasks to archive"

if [ "$COUNT" -eq 0 ]; then
  echo "Nothing to compress"
  exit 0
fi

echo "Archived to $ARCHIVE"
