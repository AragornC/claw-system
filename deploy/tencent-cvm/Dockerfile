FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Runtime deps for OpenClaw + report server.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates bash \
  && rm -rf /var/lib/apt/lists/*

# Install app deps (ccxt etc.)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev \
  && npm cache clean --force

# Install OpenClaw CLI globally (used by serve-report bridge).
RUN npm install -g openclaw@latest \
  && npm cache clean --force

# Copy runtime assets.
COPY scripts ./scripts
COPY memory ./memory
COPY deploy/tencent-cvm/entrypoint.sh ./deploy/tencent-cvm/entrypoint.sh

EXPOSE 8765

CMD ["bash", "/app/deploy/tencent-cvm/entrypoint.sh"]
