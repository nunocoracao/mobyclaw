#!/bin/bash
# Cloudflare Tunnel for Dashboard
# Usage: start-tunnel.sh [MOBY_DIR] [PORT]
# No account needed - uses trycloudflare.com quick tunnels

MOBY_DIR="${1:-/data/.mobyclaw}"
DASHBOARD_PORT="${2:-7777}"
TUNNEL_LOG="$MOBY_DIR/data/tunnel.log"
TUNNEL_URL_FILE="$MOBY_DIR/data/tunnel-url.txt"

mkdir -p "$MOBY_DIR/data"

# Kill any existing tunnel
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 1

echo "Starting Cloudflare tunnel to localhost:$DASHBOARD_PORT..."
cloudflared tunnel --url "http://localhost:$DASHBOARD_PORT" --no-autoupdate > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
echo $TUNNEL_PID > "$MOBY_DIR/data/tunnel.pid"

# Wait for URL to appear in log
for i in $(seq 1 30); do
  URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
  if [ -n "$URL" ]; then
    echo "$URL" > "$TUNNEL_URL_FILE"
    echo "{\"url\": \"$URL\", \"pid\": $TUNNEL_PID, \"started\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$MOBY_DIR/data/tunnel-info.json"
    echo "Tunnel active: $URL"

    # Notify via gateway if available
    GATEWAY_URL="${GATEWAY_URL:-http://gateway:3000}"
    curl -sf -X POST "$GATEWAY_URL/api/deliver" \
      -H "Content-Type: application/json" \
      -d "{\"message\": \"🔗 Dashboard tunnel is up: $URL\"}" 2>/dev/null || true

    # Keep running to maintain the tunnel
    wait $TUNNEL_PID
    exit $?
  fi
  sleep 1
done

echo "ERROR: Tunnel failed to start within 30s"
exit 1
