# finc worker image: Node 26 + Debian Chromium for israeli-bank-scrapers (Puppeteer).
# Pinned by digest (security audit 2026-11-09, L1); refresh with: docker buildx imagetools inspect node:26-bookworm-slim --format '{{.Manifest.Digest}}'
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    TZ=Asia/Jerusalem
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-noto fonts-noto-color-emoji ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*
# Node 25+ no longer ships corepack: install pnpm with npm, at the version in package.json's packageManager.
RUN npm install -g pnpm@10.34.9 && pnpm --version
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

# The running image (security research P2-03): production dependencies of the worker only, plus the built output.
# No TypeScript sources, compilers, Vite, test files or the web app's build tooling; same paths as before, so the
# launchers keep running apps/worker/dist/cli.js.
FROM base AS runtime
ENV NODE_ENV=production FINC_DATA_DIR=/data FINC_PORT=7733
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --prod --frozen-lockfile --filter @finc/worker... && rm -rf /pnpm/store /root/.cache /root/.npm
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/drizzle packages/core/drizzle
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/apps/web/dist apps/web/dist
# the same load check as the build stage, now with production dependencies only: a dev-only import fails here
RUN cd apps/worker && node --input-type=module -e "for (const m of ['api/app.js','scheduler.js','backup.js','offsite.js','alerts.js','connectors/scrape.js','cli/backup.js','alarm.js','cli/alerts.js','cli/vault.js','cli/guard.js','cli/sync.js','cli/worker-client.js','tlswatch.js','lockdown.js','alarm-poller.js','cli/panic.js','cli/events.js','prices.js','insights.js','sec.js','insights-panel.js','holding-rules.js','finnhub.js']) await import('./dist/' + m); console.log('worker modules load (runtime)')"
RUN mkdir -p /data && chown node:node /data
# the day this image was built: the worker reminds the owner to rebuild after 35 days, so Debian's Chromium (which
# opens the bank sites) keeps getting security updates (security research P2-03)
RUN date -u +%Y-%m-%d > /etc/finc-image-built
USER node
VOLUME ["/data"]
EXPOSE 7733
# --disable-sigusr1: no signal can open the Node inspector inside the running worker, which holds the unlocked vault
# (security research P0-06).
CMD ["node", "--disable-sigusr1", "apps/worker/dist/main.js"]
