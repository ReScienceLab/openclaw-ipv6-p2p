# Build from repo root: docker build -f gateway/Dockerfile .

# ── Stage 1: build agent-world-sdk ──────────────────────────────────────────
FROM node:22-alpine AS sdk-builder
WORKDIR /app/packages/agent-world-sdk
COPY packages/agent-world-sdk/package*.json ./
COPY packages/agent-world-sdk/src ./src
COPY packages/agent-world-sdk/tsconfig.json ./
RUN npm ci && npm run build

# ── Stage 2: gateway runtime ─────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app/gateway
COPY gateway/package*.json ./
# Pre-built SDK at the path file:../packages/agent-world-sdk resolves to
COPY --from=sdk-builder /app/packages/agent-world-sdk /app/packages/agent-world-sdk
RUN npm install --production
COPY gateway/server.mjs ./
RUN mkdir -p /data

ENV PEER_PORT=8099
ENV HTTP_PORT=8100
ENV DATA_DIR=/data
# Set PUBLIC_URL to enable Agent Card, e.g. https://gateway.example.com
ENV PUBLIC_URL=""

EXPOSE 8099 8100

CMD ["node", "server.mjs"]
