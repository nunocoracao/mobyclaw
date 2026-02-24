#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Dashboard entrypoint
# Starts: self-heal check, dashboard server, optional tunnel
# ─────────────────────────────────────────────────────────────

set -e

MOBY_DIR="${MOBYCLAW_DATA:-/data/.mobyclaw}"
DASHBOARD_PORT="${DASHBOARD_PORT:-7777}"
ENABLE_TUNNEL="${ENABLE_TUNNEL:-false}"

echo "=== mobyclaw Dashboard Service ==="
echo "  Data dir: $MOBY_DIR"
echo "  Port: $DASHBOARD_PORT"
echo "  Tunnel: $ENABLE_TUNNEL"

# Ensure data directories exist
mkdir -p "$MOBY_DIR/data" "$MOBY_DIR/memory/archives" "$MOBY_DIR/dashboard"

# Run self-healing checks
echo "Running self-heal checks..."
bash /app/scripts/self-heal.sh "$MOBY_DIR" || true

# Generate boot context if script exists and MEMORY.md is present
if [ -f "$MOBY_DIR/MEMORY.md" ]; then
  echo "Generating boot context..."
  bash /app/scripts/generate-boot.sh "$MOBY_DIR" || true
fi

# Start tunnel in background if enabled
if [ "$ENABLE_TUNNEL" = "true" ]; then
  echo "Starting Cloudflare tunnel..."
  /app/scripts/start-tunnel.sh "$MOBY_DIR" "$DASHBOARD_PORT" &
fi

# Start dashboard server (foreground)
echo "Starting dashboard server on port $DASHBOARD_PORT..."
exec python3 /app/server.py
