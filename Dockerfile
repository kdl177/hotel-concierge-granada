# Hotel concierge — one container: builds the pages and runs the Node server (API + map proxies).
FROM node:24-alpine
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npx vite build
ENV NODE_ENV=production PORT=4180 HOST=0.0.0.0 CONCIERGE_DB=/data/concierge.sqlite
VOLUME ["/data"]
EXPOSE 4180
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4180/api/h/default/config >/dev/null || exit 1
CMD ["node", "server/app/main.js"]
