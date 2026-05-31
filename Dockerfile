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
  && mkdir -p /data/home /data/pi-sessions /data/operator-state /data/artifacts \
  && npm install pi-mcp-adapter --prefix /app/.pi/npm --omit=dev \
  && npm cache clean --force \
  && rm -rf /root/.npm

ENV NODE_ENV=production
ENV HOME=/data/home
ENV PI_WORKDIR=/app
ENV PI_SESSION_DIR=/data/pi-sessions
ENV OPERATOR_STATE_DB_PATH=/data/operator-state/operator.sqlite
ENV TELEGRAM_ATTACHMENT_ROOTS=/data/artifacts,/app/artifacts

CMD ["bun", "run", "start"]
