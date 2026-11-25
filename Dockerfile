# Samo Coffee — single container: site + admin + API + Mini App + Telegram bot
FROM node:22-slim

# Everything that must survive a redeploy (SQLite database + uploaded media) lives in DATA_DIR.
# Mount a persistent volume there: docker-compose does it, on Railway add a Volume mounted at /data.
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN mkdir -p /data && chown node:node /data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# The app runs as the unprivileged "node" user. The entry script starts as root only to make the
# mounted volume writable (volumes are often root-owned), then drops privileges before the server
# starts — see scripts/container-start.mjs. `docker run --user node …` works as well.
CMD ["node", "scripts/container-start.mjs"]
