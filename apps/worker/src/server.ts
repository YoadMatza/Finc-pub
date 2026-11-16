/**
 * The worker's HTTP server: hub API, CLI control endpoints and the built web app, on one port.
 * Binds to 127.0.0.1 by default; set FINC_BIND to a Tailscale address (or 0.0.0.0 inside Docker,
 * where compose decides what is published) to reach it from the phone. See api/app.ts.
 */
import type { Db, Vault } from '@finc/core';
import { serve } from '@hono/node-server';
import { type ApiOptions, type PanicFn, createApp } from './api/app.js';
import { ensureControlToken } from './api/auth.js';
import { webDistExists } from './api/static.js';
import { log } from './logger.js';
import type { HoldingRulesService } from './holding-rules.js';
import type { FinnhubService } from './finnhub.js';
import type { InsightsService } from './insights.js';
import type { SecService } from './sec.js';
import type { PriceService } from './prices.js';
import type { Scheduler } from './scheduler.js';
import type { TlsWatch } from './tlswatch.js';

export { healthPayload } from './api/app.js';

export interface WorkerState {
  db: Db;
  vault: Vault | null;
  scheduler: Scheduler;
  startedAt: number;
  /** the TLS key watchdog (P1-10); absent in tests that do not need it */
  tls?: Pick<TlsWatch, 'status'>;
  /** live quotes for the holdings; absent when FINC_LIVE_PRICES=off and in tests that do not need it */
  prices?: Pick<PriceService, 'cache' | 'demand'>;
  /** price histories for the stock-insights panel; absent when FINC_LIVE_PRICES=off and in tests that do not need it */
  insights?: Pick<InsightsService, 'histories' | 'history' | 'noteCrossCheck'>;
  /** SEC EDGAR for the panel's company sections; absent when insights are off or FINC_SEC_CONTACT is empty */
  sec?: Pick<SecService, 'company'>;
  /** Finnhub for the panel's analysts and earnings sections; absent when insights are off (the key is in the vault) */
  finnhub?: Pick<FinnhubService, 'lookup' | 'news'>;
  /** the insights panel's deadlines (insights-panel.ts); tests shorten them */
  panelDeadlines?: { secMs?: number; finnhubMs?: number };
  /** the owner's holding rules (daily and after-sync evaluation); absent in tests that do not need it */
  holdingRules?: Pick<HoldingRulesService, 'evaluateSymbols'>;
}

/**
 * Node's own limits for receiving a request (security research P2-12, with the body limit in api/app.ts). These bound
 * how long a client may take to SEND its request, never how long the worker takes to answer: Node clears the timer once
 * the request has arrived, so a long /sync or /api/sync (a scrape runs for minutes) or a slow /api/chat answer is not
 * affected. No route streams a request body or long-polls. Node checks these every `connectionsCheckingInterval`.
 * keepAliveTimeout stays at Node's 5 s; Caddy drops its idle connections to the worker after 4 s (Caddyfile), so it
 * never sends a request on a connection the worker is closing.
 */
export const SERVER_LIMITS = {
  /** the whole request (headers and body), defaults to 300 s; a 1 MiB body over a slow phone link still fits */
  requestTimeout: 30_000,
  /** the headers alone (slowloris), defaults to 60 s; must not exceed requestTimeout */
  headersTimeout: 15_000,
  /** how often Node looks for expired requests, defaults to 30 s */
  connectionsCheckingInterval: 5_000,
} as const;

export function startServer(
  state: WorkerState,
  port: number,
  bind: string,
  onListening?: () => void,
  extra: Pick<ApiOptions, 'alarmPause' | 'lockdownTelegram'> = {},
): { close(): void; panic: PanicFn } {
  const controlToken = ensureControlToken();
  const { app, panic } = createApp(state, { controlToken, ...extra });
  const server = serve({ fetch: app.fetch, port, hostname: bind, serverOptions: { ...SERVER_LIMITS } }, () => {
    log.info({ port, bind, hub: webDistExists() ? 'served' : 'not built' }, 'http: listening');
    onListening?.();
  });
  return { close: () => server.close(), panic };
}
