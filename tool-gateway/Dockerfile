FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY src/ src/

# MCP Streamable HTTP port
EXPOSE 8081
# Admin API port
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:3100/health || exit 1

CMD ["node", "src/index.js"]
