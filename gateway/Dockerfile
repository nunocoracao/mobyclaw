# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# Gateway — message routing, sessions, and scheduling
# ─────────────────────────────────────────────────────────────

FROM node:22-slim

# Need curl for health check
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (caching)
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy source
COPY src/ src/

# Non-root
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
