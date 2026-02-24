FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY src/ src/

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# MCP Streamable HTTP port
EXPOSE 8081
# Admin API port
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:3100/health || exit 1

CMD ["node", "src/index.js"]
