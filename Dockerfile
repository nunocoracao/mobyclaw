# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# Moby — Agent container
# Runs cagent in API server mode with tools
# ─────────────────────────────────────────────────────────────

FROM debian:bookworm-slim

# Install common tools the agent needs for shell/filesystem work
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Create agent user (non-root)
RUN groupadd -r agent && useradd -r -g agent -m -d /home/agent agent

# Copy cagent binary (pre-built)
COPY --chmod=755 cagent /usr/local/bin/cagent

# Create working directories
RUN mkdir -p /agent /workspace && chown agent:agent /workspace

# Switch to non-root user
USER agent

# Working directory for agent operations
WORKDIR /workspace

# cagent API server port
EXPOSE 8080

# Health check — hit cagent's health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:8080/api/ping || exit 1

# Start cagent in API server mode with debug logging, listen on all interfaces
ENTRYPOINT ["cagent", "serve", "api", "--listen", "0.0.0.0:8080", "--debug", "--log-file", "/dev/stderr"]
CMD ["/home/agent/.mobyclaw/soul.yaml"]
