# finc worker image: Node 24 + Debian Chromium for israeli-bank-scrapers (Puppeteer).
# Pinned by digest (security audit 2026-11-09, L1); refresh with: docker buildx imagetools inspect node:24-bookworm-slim --format '{{.Manifest.Digest}}'
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    TZ=Asia/Jerusalem
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-noto fonts-noto-color-emoji ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages ./packages
COPY apps ./apps
RUN pnpm -r build
# Load every worker module with real Node, so an import that only works under vitest (a CommonJS package's named
# exports, 2026-11-10: the worker crash-looped) fails the BUILD instead of the running hub. Nothing is started.
RUN cd apps/worker && node --input-type=module -e "for (const m of ['api/app.js','scheduler.js','backup.js','offsite.js','alerts.js','connectors/scrape.js','cli/backup.js','alarm.js','cli/alerts.js','cli/vault.js','cli/guard.js','cli/sync.js','cli/worker-client.js','tlswatch.js','lockdown.js','alarm-poller.js','cli/panic.js','cli/events.js','prices.js','insights.js','sec.js','insights-panel.js','holding-rules.js','finnhub.js']) await import('./dist/' + m); console.log('worker modules load')"

FROM build AS runtime
ENV NODE_ENV=production FINC_DATA_DIR=/data FINC_PORT=7733
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 7733
# --disable-sigusr1: no signal can open the Node inspector inside the running worker, which holds the unlocked vault
# (security research P0-06).
CMD ["node", "--disable-sigusr1", "apps/worker/dist/main.js"]
