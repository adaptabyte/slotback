# Slotback: one Node.js process with an embedded, field-encrypted SQLite database.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    SLOTBACK_ENV=production \
    SLOTBACK_DATABASE=/app/data/slotback.db \
    PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server/main.ts"]
