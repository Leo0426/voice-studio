FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node scripts/setup-code.mjs ./scripts/
COPY --chown=node:node web/backend ./web/backend/
COPY --chown=node:node web/public ./web/public/
COPY --chown=node:node web/server.mjs ./web/
USER node
CMD ["node", "web/server.mjs"]
