# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# mobyclaw Dashboard Service
# Web dashboard + Task API + Cloudflare Tunnel
# ─────────────────────────────────────────────────────────────

FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install cloudflared for tunnel access
ARG TARGETARCH
RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") && \
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}" \
      -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

# Create app user
RUN groupadd -r dashboard && useradd -r -g dashboard -m -d /home/dashboard dashboard

# Copy application
COPY server.py /app/server.py
COPY static/ /app/static/
COPY scripts/ /app/scripts/
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh /app/scripts/*.sh

# Data directory (mounted volume)
RUN mkdir -p /data/.mobyclaw/data /data/.mobyclaw/memory/archives && \
    chown -R dashboard:dashboard /data

USER dashboard
WORKDIR /app

EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:7777/api/status || exit 1

ENTRYPOINT ["/app/start.sh"]
