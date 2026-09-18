FROM node:20-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY migrations ./migrations
COPY public ./public
COPY shared ./shared
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3010
CMD ["node", "server/server.js"]
