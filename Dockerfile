FROM node:20-slim

RUN npm install -g bun@1.3.10 \
  && npm cache clean --force \
  && rm -rf /root/.npm

WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile --production \
  && rm -rf /root/.bun/install/cache

COPY . .
RUN cp .mcp.json.example .mcp.json \
  && mkdir -p /data/home /data/pi-sessions /data/operator-state /data/artifacts /data/operator-context \
  && ln -s /data/operator-context /app/operator-context \
  && npm install pi-mcp-adapter --prefix /app/.pi/npm --omit=dev \
  && npm cache clean --force \
  && rm -rf /root/.npm

ENV NODE_ENV=production
ENV PORT=8080
ENV HOME=/data/home
ENV PI_WORKDIR=/app
ENV PI_SESSION_DIR=/data/pi-sessions
ENV OPERATOR_STATE_DB_PATH=/data/operator-state/operator.sqlite
ENV OPERATOR_CONTEXT_DIR=/app/operator-context
ENV TELEGRAM_ATTACHMENT_ROOTS=/data/artifacts,/app/artifacts

CMD ["sh", "-lc", "mkdir -p /data/home /data/pi-sessions /data/operator-state /data/artifacts /data/operator-context && bun run start"]
