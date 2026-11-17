/** Long-running worker: scheduler + local control port. The vault is unlocked via `finc unlock`. */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { type Db, type DbOwner, DbOwnedError, FINC_VERSION, type Vault, alertConfig, claimDb, cleanStoredErrors, dataDir, emptyPriceCache, flushSecurityEvents, getSetting, holdingSymbols, IMAGE_BUILT_SETTING, setSetting, listDevices, listSecurityEvents, openDb, readOwner, recordSecurityEvent, scrubSecretEnv, telegramSend } from '@finc/core';
import { MAIN_BOT_ID_SETTING, readAlarmBot } from './alarm.js';
import { AlarmPoller, statusText } from './alarm-poller.js';
import { securityAlert, sendSecurityAlert } from './alerts.js';
import { otherWorkerAnswers } from './cli/guard.js';
import { workerUp } from './cli/worker-client.js';
import { log } from './logger.js';
import { HoldingRulesService } from './holding-rules.js';
import { FinnhubService, finnhubKeyFromVault } from './finnhub.js';
import { YahooNewsService } from './yahoo-news.js';
import { InsightsService } from './insights.js';
import { SecService, secContactFromEnv } from './sec.js';
import { PriceService, livePricesEnabled } from './prices.js';

scrubSecretEnv(); // secrets come from the vault only, never from the environment
// New files (database, backups, debug dumps) are owner-only on Linux and the Pi (security research P2-10).
process.umask(0o077);
import { Scheduler, configFromEnv } from './scheduler.js';
import { type WorkerState, startServer } from './server.js';
import { TlsWatch, tlsConfigFromEnv } from './tlswatch.js';

const port = Number(process.env.FINC_PORT ?? '7733');
const bind = process.env.FINC_BIND ?? '127.0.0.1';

// Filled in as the worker comes up; shutdown() closes whatever exists (a conflict can arrive before the DB is open).
let db: Db | null = null;
let state: WorkerState | null = null;
let server: ReturnType<typeof startServer> | null = null;
let owner: { release(): void } | null = null;
let tlsWatch: TlsWatch | null = null;
let alarmPoller: AlarmPoller | null = null;
let prices: PriceService | null = null;
let holdingRules: HoldingRulesService | null = null;
let stopping = false;
/** set as soon as a conflict starts the stop (shutdown() itself runs only once the alert went out) */
let conflicted = false;

const shutdown = (sig: string, code = 0): void => {
  if (stopping) return;
  stopping = true;
  log.info({ sig }, 'worker shutting down');
  void alarmPoller?.stop();
  tlsWatch?.stop();
  prices?.stop();
  holdingRules?.stop();
  state?.scheduler.stop();
  server?.close();
  state?.vault?.lock();
  if (db) flushSecurityEvents(db, Date.now(), true); // counts of aggregated failures not written yet
  db?.$client.close();
  owner?.release();
  process.exit(code);
};

/**
 * Someone else took the owner file while we run (P1-13): another host is writing the database. Say so on the alarm
 * channel (waiting a little for it to go out), then stop at once to protect the file.
 */
const onConflict = (other: DbOwner): void => {
  if (stopping || conflicted) return;
  conflicted = true;
  log.error({ owner: other }, 'finc worker: another process claimed the database; stopping to protect it');
  if (!db) return shutdown('conflict', 1);
  const he = (getSetting(db, 'ui.language') ?? 'he') === 'he';
  const who = other.role === 'worker' ? 'a worker' : other.role === 'cli' ? 'the CLI' : 'another process';
  const text = he
    ? `מישהו אחר כותב למסד הנתונים של finc (${who}); ה-worker נעצר כדי להגן עליו. הפרטים בלוג`
    : `someone else is writing the finc database (${who}); the worker stopped to protect it. Details in the log`; // the host name stays in the log (P2-09)
  log.warn({ text }, 'security');
  // Stop writing first, then tell: the alert goes through the alarm bot only (data/alarm-bot.json, no database),
  // because the normal path records its status in the database the other process now owns.
  server?.close(); // no new requests (a sync, an import) while we stop
  server = null;
  void alarmPoller?.stop();
  tlsWatch?.stop();
  prices?.stop();
  holdingRules?.stop();
  state?.scheduler.stop();
  // the database is still open here: the conflict goes into the security log before we let go of it (P1-08)
  recordSecurityEvent(db, { kind: 'worker.db_owner_conflict', actor: 'system', detail: { role: other.role === 'worker' || other.role === 'cli' ? other.role : 'other' } }); // the host name stays in the log (P2-09)
  flushSecurityEvents(db, Date.now(), true);
  db.$client.close();
  db = null;
  const bot = readAlarmBot();
  const sent = bot?.chatId ? telegramSend(bot.token, bot.chatId, `finc: ${text}`, { parseMode: null }).catch(() => undefined) : Promise.resolve();
  const cap = new Promise((r) => setTimeout(r, 10_000).unref());
  void Promise.race([sent, cap]).finally(() => shutdown('conflict', 1));
};

// While stopping (a conflict whose alert is still on its way), a late error from a closed DB or server is expected:
// log it and let the stop finish. Any other time it is a crash: log it and exit.
const onFatal = (kind: string) => (e: unknown): void => {
  const err = e instanceof Error ? e.message : String(e);
  if (stopping || conflicted) {
    log.warn({ err, kind }, 'worker: error while stopping (ignored)');
    return;
  }
  log.error({ err, kind }, 'worker: fatal error');
  process.exit(1);
};
process.on('unhandledRejection', onFatal('unhandledRejection'));
process.on('uncaughtException', onFatal('uncaughtException'));

// Another host's worker that is alive but whose heartbeat looks stale (WSL2's clock can lag after sleep) would let
// claimDb take over: ask its control port first, no clock involved (P1-13).
let prior: DbOwner | null;
try {
  prior = readOwner();
} catch (e) {
  log.error({ err: e instanceof Error ? e.message : String(e) }, 'finc worker: the database owner file cannot be read; not starting');
  process.exit(1);
}
if (await otherWorkerAnswers(prior, os.hostname(), () => workerUp(3000))) {
  log.error({ owner: prior }, 'finc worker: another finc worker answers on the control port; not starting');
  process.exit(1);
}

// One writer per database (P1-13): claim data/ before opening it. A fresh owner from another host (a CLI on the PC,
// or another worker) is waited out for up to 75 s (a CLI's last heartbeat stays fresh 30 s, then a 15 s liveness check), then the worker refuses to start rather than share the file.
try {
  owner = await claimDb({ role: 'worker', waitMs: 75_000, onConflict });
} catch (e) {
  const err = e instanceof Error ? e.message : String(e);
  const holder = e instanceof DbOwnedError ? e.owner : undefined;
  log.error({ err, owner: holder }, 'finc worker: the database is in use by another process; not starting (stop it, then start the worker again)');
  process.exit(1);
}

const liveDb = openDb();
db = liveDb;
// P2-09: error text stored before it was cleaned on write goes through cleanErrorText once
try {
  const n = cleanStoredErrors(liveDb);
  if (n) log.info({ changed: n }, 'stored error text cleaned');
} catch (e) {
  log.error({ err: e }, 'stored error text could not be cleaned');
}
recordSecurityEvent(liveDb, { kind: 'worker.started', actor: 'system', detail: { version: FINC_VERSION } });
// the image's build day (Dockerfile): the hub's "rebuild the image" reminder reads it (P2-03); a host run has none
try {
  const built = readFileSync('/etc/finc-image-built', 'utf8').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(built)) setSetting(liveDb, IMAGE_BUILT_SETTING, built);
} catch {
  setSetting(liveDb, IMAGE_BUILT_SETTING, null);
}
const live: WorkerState = { db: liveDb, vault: null as Vault | null, scheduler: null as unknown as Scheduler, startedAt: Date.now() };
state = live;
live.scheduler = new Scheduler(liveDb, () => live.vault, configFromEnv());
live.scheduler.start();
// Live quotes for the holdings (Yahoo Finance; only ticker symbols and the FX pair leave the machine). See prices.ts.
if (livePricesEnabled()) {
  prices = new PriceService({ symbols: () => holdingSymbols(liveDb) });
  live.prices = prices;
  prices.start();
  // the stock-insights panel's histories (same source and switch; fetched only when a panel is opened). See insights.ts.
  live.insights = new InsightsService();
  // the panel's company sections from SEC EDGAR (step 2): only with a contact for SEC's User-Agent. See sec.ts.
  const secContact = secContactFromEnv();
  if (secContact) live.sec = new SecService({ contact: secContact });
  else log.info({ sec: process.env.FINC_SEC_CONTACT?.trim() ? 'invalid' : 'empty' }, 'stock insights: SEC contact not set, company sections off');
  // the panel's analysts and earnings dates from Finnhub (stock-decision-aids.md, Part B): the key is read from the
  // vault at each fetch (finc vault set finnhub); while it is locked the last cached view shows. See finnhub.ts.
  live.finnhub = new FinnhubService({ db: liveDb, key: () => finnhubKeyFromVault(live.vault) });
  // company news from Yahoo (no key) when Finnhub has none for a stock, e.g. foreign listings. See yahoo-news.ts.
  live.yahooNews = new YahooNewsService({ db: liveDb });
}
// The owner's holding rules (stock-decision-aids.md, Part A): daily at 23:30 Israel time and after each successful
// sync, through the panel's own caches and limits (no new data source). See holding-rules.ts.
holdingRules = new HoldingRulesService({ db: liveDb, panel: () => ({ insights: live.insights, sec: live.sec, finnhub: live.finnhub }), prices: () => live.prices?.cache() ?? emptyPriceCache() });
live.holdingRules = holdingRules;
const rulesService = holdingRules;
live.scheduler.onSynced = () => void rulesService.runAll('sync');
rulesService.start();
// P1-10: is Caddy still serving the key the phone app pins? Alerts go through the security path (the alarm bot works
// while the vault is locked). Disabled when FINC_TLS_PINS or FINC_PUBLIC_HOST is empty.
const watch = new TlsWatch(tlsConfigFromEnv(), {
  send: async (text) => (await sendSecurityAlert(liveDb, live.vault, text)).ok,
  hebrew: () => (getSetting(liveDb, 'ui.language') ?? 'he') === 'he',
  record: ({ from, to, reason }) => recordSecurityEvent(liveDb, { kind: 'tls.state_changed', actor: 'system', detail: { from, to, reason } }),
});
tlsWatch = watch;
live.tls = watch;
watch.start();
// P1-05: a restart locks the vault, so say so at once (through the alarm bot; without one this reaches only the log)
const started = startServer(
  live,
  port,
  bind,
  () => {
    if (live.vault && !live.vault.locked) return;
    const he = (getSetting(liveDb, 'ui.language') ?? 'he') === 'he';
    securityAlert(liveDb, live.vault, he ? 'ה-worker של finc הופעל; הכספת נעולה עד שתריץ finc unlock' : 'the finc worker started; the vault is locked until you run finc unlock', null); // worker.started is recorded above
  },
  // setting up or removing the alarm bot pauses its poller (getUpdates has one consumer per bot)
  { alarmPause: () => alarmPoller?.pause() ?? (() => undefined), lockdownTelegram: () => alarmPoller?.live ?? false },
);
server = started;
// P1-09: /lockdown and /status on the alarm bot, from the bound chat only; idle while no alarm bot is set up and bound
alarmPoller = new AlarmPoller({
  readBot: readAlarmBot,
  boundChatId: () => alertConfig(liveDb).telegramChatId,
  mainBotId: () => getSetting(liveDb, MAIN_BOT_ID_SETTING),
  panic: (who) => started.panic(who, { actor: 'telegram' }),
  status: () =>
    statusText(
      { vaultUnlocked: !!live.vault && !live.vault.locked, devices: listDevices(liveDb).length, events: listSecurityEvents(liveDb, { limit: 5 }).events },
      process.env.TZ || undefined,
    ),
  record: (kind, detail) => recordSecurityEvent(liveDb, { kind, actor: 'telegram', detail: detail ?? null }),
});
alarmPoller.start();

log.info({ version: FINC_VERSION, dataDir: dataDir(), port, bind, tz: process.env.TZ ?? 'system' }, 'finc worker started; vault locked until `finc unlock`');

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
