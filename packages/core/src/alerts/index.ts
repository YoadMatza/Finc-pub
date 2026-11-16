/**
 * Alerts (§7d): a catalogue of alert types, a per-type × channel matrix with quiet hours in the
 * settings, and a dispatcher that turns the hub's attention items into messages, sends each key once
 * per channel, and remembers it in alert_log. Channels are plugins; Telegram is the first.
 */
import { and, desc, eq } from 'drizzle-orm';
import { getSetting, setSetting } from '../ai/settings.js';
import type { Db } from '../db/db.js';
import { alertLog } from '../db/schema.js';
import { type HubOverview, type Insight, hubOverview, todayLocal } from '../hub/overview.js';
import { RESTORED_AT_SETTING } from '../backup/backup.js';
import { OFFSITE_SETTINGS, OFFSITE_STALE_DAYS } from '../backup/offsite.js';
import { ENGINE_PROCESSED_SETTING } from '../engine/run.js';
import { paidBackLine } from '../engine/paidback.js';
import { listTransactions } from '../hub/transactions.js';
import { DEFAULT_AMOUNTS, MONEY_SINCE_SETTING, type MoneyAlert, UNUSUAL, collectMoneyAlerts, moneySince } from './money.js';
import { telegramSend } from './telegram.js';
import { limitAlerts } from './limit.js';
import { errorPhrase, isErrorKind } from '../errors.js';

export * from './money.js';
export * from './telegram.js';
export * from './limit.js';

/**
 * `big_purchase` is the per-transaction "money out" alert since 2026-11-10 (alerts/money.ts); the type keeps
 * its old name so an existing on/off choice keeps its meaning.
 */
export const ALERT_TYPES = ['sync_error', 'stale_sync', 'otp_needed', 'missing_fixed', 'big_purchase', 'instalment_purchase', 'card_bill_gap', 'card_testing', 'unusual_charge', 'refund_matched', 'over_target', 'price_change', 'candidate', 'uncategorised', 'weekly_summary', 'spend_limit'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
export const CHANNELS = ['telegram'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface AlertConfig {
  matrix: Record<AlertType, Record<Channel, boolean>>;
  quiet: { from: string; to: string } | null; // "HH:MM" local, from > to means over midnight
  weekly: { day: number; hour: number }; // 0 = Sunday
  /** Whole shekels: money out at `big` or more alerts; at `urgent` or more it also ignores quiet hours. */
  amounts: { big: number; urgent: number };
  /** unusual_charge: a charge more than this many times the merchant's usual (2–10, default 3) */
  unusualFactor: number;
  telegramChatId: string | null;
}

const DEFAULT_ON = new Set<AlertType>(['sync_error', 'stale_sync', 'otp_needed', 'missing_fixed', 'big_purchase', 'instalment_purchase', 'card_bill_gap', 'card_testing', 'unusual_charge', 'refund_matched', 'over_target', 'price_change', 'weekly_summary', 'spend_limit']);

export function alertConfig(db: Db): AlertConfig {
  const matrix = {} as AlertConfig['matrix'];
  let saved: Partial<Record<AlertType, Partial<Record<Channel, boolean>>>> = {};
  try {
    saved = JSON.parse(getSetting(db, 'alerts.matrix') ?? '{}') as typeof saved;
  } catch {
    /* defaults */
  }
  for (const t of ALERT_TYPES) matrix[t] = { telegram: saved[t]?.telegram ?? DEFAULT_ON.has(t) };
  let quiet: AlertConfig['quiet'] = { from: '23:00', to: '07:00' };
  const q = getSetting(db, 'alerts.quiet');
  if (q !== null) {
    try {
      quiet = q === 'off' ? null : (JSON.parse(q) as AlertConfig['quiet']);
    } catch {
      /* default */
    }
  }
  let weekly = { day: 0, hour: 8 };
  try {
    weekly = { ...weekly, ...(JSON.parse(getSetting(db, 'alerts.weekly') ?? '{}') as Partial<typeof weekly>) };
  } catch {
    /* default */
  }
  let amounts: AlertConfig['amounts'] = { ...DEFAULT_AMOUNTS };
  try {
    amounts = { ...amounts, ...(JSON.parse(getSetting(db, 'alerts.amounts') ?? '{}') as Partial<typeof amounts>) };
  } catch {
    /* default */
  }
  const f = Number(getSetting(db, 'alerts.unusualFactor'));
  const unusualFactor = Number.isInteger(f) && f >= 2 && f <= 10 ? f : UNUSUAL.factor;
  return { matrix, quiet, weekly, amounts, unusualFactor, telegramChatId: getSetting(db, 'telegram.chatId') };
}

export function setAlertConfig(db: Db, patch: { matrix?: Partial<Record<AlertType, Partial<Record<Channel, boolean>>>>; quiet?: AlertConfig['quiet'] | 'off'; weekly?: Partial<AlertConfig['weekly']>; amounts?: Partial<AlertConfig['amounts']>; unusualFactor?: number; telegramChatId?: string | null }): AlertConfig {
  const cur = alertConfig(db);
  if (patch.matrix) {
    const next = { ...cur.matrix } as AlertConfig['matrix'];
    for (const [t, chans] of Object.entries(patch.matrix) as Array<[AlertType, Partial<Record<Channel, boolean>>]>) if (ALERT_TYPES.includes(t)) next[t] = { ...next[t], ...chans };
    setSetting(db, 'alerts.matrix', JSON.stringify(next));
  }
  if (patch.quiet !== undefined) setSetting(db, 'alerts.quiet', patch.quiet === null || patch.quiet === 'off' ? 'off' : JSON.stringify(patch.quiet));
  if (patch.weekly) setSetting(db, 'alerts.weekly', JSON.stringify({ ...cur.weekly, ...patch.weekly }));
  if (patch.amounts) {
    const next = { ...cur.amounts, ...patch.amounts };
    if (!(next.big >= 1 && next.urgent >= next.big)) throw new Error('the urgent amount must be at least the alert amount, and both positive');
    setSetting(db, 'alerts.amounts', JSON.stringify(next));
  }
  if (patch.unusualFactor !== undefined) {
    if (!(Number.isInteger(patch.unusualFactor) && patch.unusualFactor >= 2 && patch.unusualFactor <= 10)) throw new Error('the unusual-charge multiplier is a whole number from 2 to 10');
    setSetting(db, 'alerts.unusualFactor', String(patch.unusualFactor));
  }
  if (patch.telegramChatId !== undefined) setSetting(db, 'telegram.chatId', patch.telegramChatId);
  return alertConfig(db);
}

export function inQuietHours(quiet: AlertConfig['quiet'], now: Date, timeZone: string): boolean {
  if (!quiet) return false;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const cur = hm.replace(':', '');
  const from = quiet.from.replace(':', '');
  const to = quiet.to.replace(':', '');
  return from > to ? cur >= from || cur < to : cur >= from && cur < to;
}

export interface Alert {
  type: AlertType;
  key: string;
  text: string;
  /** Goes out even in quiet hours (large money out, card testing). */
  urgent?: boolean;
  /** A per-transaction money alert (subject to the flood guard). */
  money?: boolean;
}

/**
 * More new money alerts than this in one dispatch are sent as one summary message (each key is still recorded as
 * handled). It guards against a flood after a database rebuild or restore, when every row gets a fresh created_at.
 */
export const MONEY_FLOOD_LIMIT = 10;

// Telegram renders a message as one bidi paragraph, so Latin merchant names and signed amounts inside
// Hebrew text get reordered unless each is isolated: LRI…PDI pins an amount left-to-right, FSI…PDI
// lets a name keep its own direction without pulling its neighbours along.
const LRI = '⁦';
const FSI = '⁨';
const PDI = '⁩';
/** Absolute amount; `signed` keeps the minus. Hebrew puts the sign after the number ("3,245 ₪"). */
const ils = (minor: number, lang: 'he' | 'en' = 'en', signed = false) => {
  const n = Math.abs(minor / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const sign = signed && minor < 0 ? '-' : '';
  return `${LRI}${lang === 'he' ? `${sign}${n} ₪` : `${sign}₪${n}`}${PDI}`;
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A merchant or stream name, HTML-escaped, direction-isolated, with a doubled word ("Streamly Streamly") collapsed. */
const name = (s: string) => `${FSI}${esc(s.replace(/\b(\S+)\s+\1\b/gi, '$1'))}${PDI}`;
/** Category display names by key, in the hub's language; the last key segment when a key is unknown. */
function categoryNames(db: Db, lang: 'he' | 'en'): (key: string | null) => string {
  const rows = db.$client.prepare('select key, name_he, name_en from category').all() as Array<{ key: string; name_he: string; name_en: string }>;
  const map = new Map(rows.map((r) => [r.key, lang === 'he' ? r.name_he : r.name_en]));
  return (key) => (key === null ? (lang === 'he' ? 'ללא קטגוריה' : 'Uncategorised') : (map.get(key) ?? key.split('.').pop() ?? key));
}

/** One sentence per insight, in the hub's language. Names and amounts only. */
export function alertText(i: Insight, lang: 'he' | 'en'): string | null {
  const nm = name(i.name ?? '');
  const amt = i.amount !== undefined ? ils(i.amount, lang) : '';
  const ref = i.reference !== undefined ? ils(i.reference, lang) : '';
  const he = lang === 'he';
  switch (i.kind) {
    case 'missing_fixed':
      return he ? `⚠️ <b>${nm}</b> ${amt} היה צפוי ב־${i.date?.slice(8, 10)}.${i.date?.slice(5, 7)} ועוד לא חויב` : `⚠️ <b>${nm}</b> ${amt} was expected on ${i.date} and has not been charged`;
    case 'big_purchase':
      return he ? `💳 הוצאה גדולה: <b>${nm}</b> ${amt}` : `💳 Big purchase: <b>${nm}</b> ${amt}`;
    case 'refund_matched':
      return he ? `↩️ זיכוי הותאם: <b>${nm}</b>, ${amt} חזרו` : `↩️ Refund matched: <b>${nm}</b>, ${amt} back`;
    case 'over_target':
      return he ? `🎯 <b>${nm}</b>: ${amt} מעל היעד ${ref}` : `🎯 <b>${nm}</b>: ${amt} over the ${ref} target`;
    case 'price_change':
      return he ? `📈 <b>${nm}</b> עלה: ${amt} במקום ${ref}` : `📈 <b>${nm}</b> went up: ${amt} instead of ${ref}`;
    case 'sync_error': {
      // institution + error kind + a fixed phrase; never the error's own text (P2-09)
      const kind = isErrorKind(i.name) ? i.name : 'other';
      return he
        ? `🔌 סנכרון ${name(i.institutionId ?? '')} נכשל (${i.count ?? 1}): ${errorPhrase(kind, 'he')} (${kind})`
        : `🔌 ${name(i.institutionId ?? '')} sync failed (${i.count ?? 1}): ${errorPhrase(kind, 'en')} (${kind})`;
    }
    case 'candidate':
      return he ? `🔁 קבועה חדשה? <b>${nm}</b> ${amt}` : `🔁 New recurring? <b>${nm}</b> ${amt}`;
    case 'uncategorised':
      return he ? `🏷️ ${i.count} תנועות צריכות קטגוריה` : `🏷️ ${i.count} transactions need a category`;
    case 'stale_sync': {
      const since = i.date ? (he ? `${i.date.slice(8, 10)}.${i.date.slice(5, 7)}` : i.date.slice(0, 10)) : he ? 'אף פעם' : 'never';
      return he ? `⏸️ ${name(i.institutionId ?? '')} לא סונכרן בהצלחה מאז ${since}. תנועות חדשות לא נראות.` : `⏸️ ${name(i.institutionId ?? '')} has not synced since ${since}. New transactions are not being seen.`;
    }
    default:
      return null;
  }
}

/** One sentence per money alert. Names, amounts and dates only. */
export function moneyAlertText(a: MoneyAlert, lang: 'he' | 'en'): string {
  const he = lang === 'he';
  const nm = name(a.name);
  const amt = ils(a.amount, lang);
  const day = he ? `${a.date.slice(8, 10)}.${a.date.slice(5, 7)}` : a.date;
  switch (a.kind) {
    case 'money_out': {
      const where = a.transfer ? (he ? 'העברה מהבנק' : 'bank transfer') : a.accountType === 'credit_card' ? (he ? 'בכרטיס' : 'card') : he ? 'מהבנק' : 'bank';
      const pending = a.pending ? (he ? ', ממתין לאישור' : ', pending') : '';
      return he ? `💸 יצא כסף: <b>${nm}</b> ${amt} (${where}${pending}, ${day})` : `💸 Money out: <b>${nm}</b> ${amt} (${where}${pending}, ${day})`;
    }
    case 'instalment_purchase':
      return he ? `🧾 רכישה בתשלומים: <b>${nm}</b> ${amt} ב־${a.detail} תשלומים (${day})` : `🧾 Instalment purchase: <b>${nm}</b> ${amt} in ${a.detail} payments (${day})`;
    case 'card_bill_gap':
      return he
        ? `⚠️ חיוב הכרטיס בבנק <b>${nm}</b> ${amt} לא תואם לסכום העסקאות בכרטיס (הפרש ${ils(a.detail ?? 0, lang)}). כדאי לבדוק.`
        : `⚠️ Card bill <b>${nm}</b> ${amt} does not match the card's charges (off by ${ils(a.detail ?? 0, lang)}). Worth a look.`;
    case 'card_testing':
      return he
        ? `🚨 ${a.detail} חיובים ב־<b>${nm}</b> באותו יום (${day}, סה״כ ${amt}). ודא שזה אתה.`
        : `🚨 ${a.detail} charges at <b>${nm}</b> on one day (${day}, ${amt} in total). Make sure it was you.`;
    case 'unusual_charge': {
      const usual = ils(a.reference ?? 0, lang);
      const pending = a.pending ? (he ? ', ממתין לאישור' : ', pending') : '';
      return he
        ? `🔎 חריג ל־<b>${nm}</b>: ${amt} (${day}${pending}), בדרך כלל בערך ${usual} (${a.detail} חיובים בשנה האחרונה). כדאי לבדוק.`
        : `🔎 Unusual for <b>${nm}</b>: ${amt} (${day}${pending}), usually about ${usual} (${a.detail} charges in the last year). Worth a look.`;
    }
  }
}

const MONEY_KIND_TO_TYPE: Record<MoneyAlert['kind'], AlertType> = {
  money_out: 'big_purchase',
  instalment_purchase: 'instalment_purchase',
  card_bill_gap: 'card_bill_gap',
  card_testing: 'card_testing',
  unusual_charge: 'unusual_charge',
};

/** Insight kinds that reach Telegram. big_purchase is not here: the per-transaction money alerts replace it. */
const KIND_TO_TYPE: Partial<Record<Insight['kind'], AlertType>> = {
  missing_fixed: 'missing_fixed',
  stale_sync: 'stale_sync',
  refund_matched: 'refund_matched',
  over_target: 'over_target',
  price_change: 'price_change',
  sync_error: 'sync_error',
  candidate: 'candidate',
  uncategorised: 'uncategorised',
};

/** The alerts the hub would raise right now, as messages: attention items plus money out since the start point. */
export function collectAlerts(db: Db, opts: { lang?: 'he' | 'en'; overview?: HubOverview; now?: Date } = {}): Alert[] {
  const lang = opts.lang ?? ((getSetting(db, 'ui.language') as 'he' | 'en' | null) ?? 'he');
  const h = opts.overview ?? hubOverview(db, undefined, 'purchase', opts.now ? { now: opts.now } : {});
  const out: Alert[] = [];
  for (const i of h.attention) {
    const type = KIND_TO_TYPE[i.kind];
    if (!type) continue;
    const text = alertText(i, lang);
    if (text) out.push({ type, key: i.key, text });
  }
  // the monthly spending limit: 80% / 100% once a month, ahead of pace at most once a week (alerts/limit.ts)
  // once "reached the limit" went out this month, an 80% message (spent fell back after a refund or paid-back money,
  // or the limit was raised) would read backwards: skip it
  for (const a of limitAlerts(h.limit, { month: h.month, today: todayLocal(opts.now), lang })) {
    if (a.key.startsWith('spend_limit:80:') && alreadySent(db, a.key.replace(':80:', ':100:'), 'telegram')) continue;
    out.push({ type: 'spend_limit', key: a.key, text: a.text });
  }
  const { amounts, unusualFactor } = alertConfig(db);
  // only rows the engine has processed (never mid-sync), and only the last few days (MONEY_LOOKBACK_DAYS)
  const processedUntil = getSetting(db, ENGINE_PROCESSED_SETTING) ?? '';
  // After a restore the first sync re-inserts everything since the backup as "new" rows (and alert_log went back in
  // time with the database): wait for that sync's engine run, then start money alerts after it and say so once
  // instead of replaying each charge (independent review 2026-11-10).
  const restoredAt = getSetting(db, RESTORED_AT_SETTING);
  if (restoredAt) {
    if (processedUntil <= restoredAt) return out;
    const missed = collectMoneyAlerts(db, { since: moneySince(db, opts.now), bigIls: amounts.big, urgentIls: amounts.urgent, unusualFactor, processedUntil, now: opts.now ?? new Date() }).length;
    setSetting(db, MONEY_SINCE_SETTING, processedUntil);
    setSetting(db, RESTORED_AT_SETTING, null);
    const he = lang === 'he';
    out.push({
      type: 'big_purchase',
      key: `restored:${restoredAt}`,
      text: he
        ? `♻️ finc שוחזר מגיבוי. ${missed ? `${missed} חיובים שהגיעו מאז לא נשלחו אחד אחד; ` : ''}בדוק את התנועות האחרונות ב־finc.`
        : `♻️ finc was restored from a backup. ${missed ? `${missed} charges that arrived since then were not sent one by one; ` : ''}check the latest transactions in finc.`,
      money: true,
    });
    return out;
  }
  for (const m of collectMoneyAlerts(db, { since: moneySince(db, opts.now), bigIls: amounts.big, urgentIls: amounts.urgent, unusualFactor, processedUntil, now: opts.now ?? new Date() })) {
    out.push({ type: MONEY_KIND_TO_TYPE[m.kind], key: m.key, text: moneyAlertText(m, lang), urgent: m.urgent, money: true });
  }
  return out;
}

/** Sunday-morning (configurable) digest: last week, where the month stands, what is due this week. */
export function weeklySummaryText(db: Db, opts: { lang?: 'he' | 'en'; today?: string } = {}): { key: string; text: string } {
  const lang = opts.lang ?? ((getSetting(db, 'ui.language') as 'he' | 'en' | null) ?? 'he');
  const today = opts.today ?? todayLocal();
  const h = hubOverview(db);
  const f = h.forecast;
  const d = new Date(`${today}T00:00:00Z`);
  const dow = d.getUTCDay();
  const thisSunday = new Date(d.getTime() - dow * 86_400_000);
  const lastSunday = new Date(thisSunday.getTime() - 7 * 86_400_000);
  const lastSaturday = new Date(thisSunday.getTime() - 86_400_000);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const lastWeek = listTransactions(db, { from: iso(lastSunday), to: iso(lastSaturday), bucket: 'variable', limit: 1000 });
  const spentLastWeek = -lastWeek.netSum;
  const byCat = new Map<string, number>();
  // a payment paid back to the owner nets the week's total above but is not spending in a category
  for (const t of lastWeek.items) if (!t.paidBack) byCat.set(t.categoryKey ?? '?', (byCat.get(t.categoryKey ?? '?') ?? 0) + Math.abs(t.netAmount));
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const weekEnd = iso(new Date(d.getTime() + 6 * 86_400_000));
  const due = h.upcoming.filter((u) => u.date >= today && u.date <= weekEnd && u.kind !== 'income');
  const dueSum = due.reduce((a, u) => a + Math.abs(u.amount), 0);
  const he = lang === 'he';
  const catName = categoryNames(db, lang);
  const money = (minor: number) => ils(minor, lang);
  const lines: string[] = [];
  lines.push(he ? `<b>סיכום שבועי · ${today.slice(8, 10)}.${today.slice(5, 7)}</b>` : `<b>Weekly summary · ${today}</b>`);
  lines.push(he ? `שבוע שעבר יצאו ${money(spentLastWeek)} על הוצאות משתנות (${lastWeek.total} תנועות)` : `Last week: ${money(spentLastWeek)} of variable spending (${lastWeek.total} transactions)`);
  if (top.length) {
    lines.push(he ? 'הכי הרבה:' : 'Most on:');
    for (const [k, v] of top) lines.push(`• ${name(catName(k === '?' ? null : k))} ${money(v)}`);
  }
  if (f.isCurrentMonth) {
    const end = ils(f.projected.end, lang, true);
    lines.push(
      f.left >= 0
        ? he
          ? `נשאר להוציא החודש: <b>${money(f.left)}</b>${f.weekly.envelope ? ` (בערך ${money(f.weekly.envelope)} לשבוע)` : ''}`
          : `Left to spend this month: <b>${money(f.left)}</b>${f.weekly.envelope ? ` (about ${money(f.weekly.envelope)} a week)` : ''}`
        : he
          ? `החודש כבר חורג ב־<b>${money(f.left)}</b>. בקצב הרגיל הוא ייגמר בסביבות ${end}`
          : `The month is already <b>${money(f.left)}</b> over. At the usual pace it ends around ${end}`,
    );
    // the large-extra rule (engine/income.ts): the envelope and the projection above are on the regular income
    if (h.spread.extraExcluded && h.spread.projectedAll) {
      const extra = h.incomeSplit.extra.received + h.incomeSplit.extra.expected;
      const all = ils(h.spread.projectedAll.end, lang, true);
      lines.push(
        he
          ? `על ההכנסה הקבועה בלבד: החודש ייגמר בסביבות ${end}; כולל ההכנסה הנוספת (${money(extra)}): בסביבות ${all}`
          : `On your regular income: the month ends around ${end}; including the extra ${money(extra)}: around ${all}`,
      );
    }
    // the monthly spending limit (hub/limit.ts), when one is set: descriptive only
    const l = h.limit;
    if (l) {
      const pace = l.pace.state === 'on' ? (he ? 'בקצב' : 'on pace') : l.pace.state === 'ahead' ? (he ? `${money(l.pace.delta)} מעל הקצב` : `${money(l.pace.delta)} ahead of pace`) : he ? `${money(l.pace.delta)} מתחת לקצב` : `${money(l.pace.delta)} under pace`;
      const left = l.leftWithin >= 0 ? (he ? `נשארו ${money(l.leftWithin)} במסגרת` : `${money(l.leftWithin)} left within it`) : he ? `${money(l.leftWithin)} מעבר למסגרת` : `${money(l.leftWithin)} over it`;
      lines.push(he ? `מסגרת הוצאות ${money(l.amount)}: יצאו ${money(l.spent)} (${l.usedPct}%), ${pace}, ${left}` : `Spending limit ${money(l.amount)}: spent ${money(l.spent)} (${l.usedPct}%), ${pace}, ${left}`);
    }
    // paid back to me (hub/paidback.ts): already netted in the day-to-day numbers above
    const pbLine = paidBackLine(h.paidBack, money, lang);
    if (pbLine) lines.push(pbLine);
  }
  if (due.length) {
    lines.push(he ? `השבוע צפויים ${due.length} חיובים קבועים, ${money(dueSum)}:` : `Due this week: ${due.length} fixed charges, ${money(dueSum)}:`);
    for (const u of due.slice(0, 4)) lines.push(`• ${name(u.name)} ${money(u.amount)}`);
    if (due.length > 4) lines.push(he ? `• ועוד ${due.length - 4}` : `• and ${due.length - 4} more`);
  }
  const backupOk = getSetting(db, 'backup.lastOkAt');
  if (backupOk) {
    const day = backupOk.slice(0, 10);
    const stale = (d.getTime() - new Date(`${day}T00:00:00Z`).getTime()) / 86_400_000 > 7;
    const shown = he ? `${day.slice(8, 10)}.${day.slice(5, 7)}` : day;
    lines.push(stale ? (he ? `⚠️ אין גיבוי מאומת מאז ${shown}` : `⚠️ No verified backup since ${shown}`) : he ? `✓ גיבוי אחרון נבדק: ${shown}` : `Last verified backup: ${shown}`);
  }
  const offsiteOk = getSetting(db, OFFSITE_SETTINGS.lastOkAt);
  if (offsiteOk) {
    const day = offsiteOk.slice(0, 10);
    const stale = (d.getTime() - new Date(`${day}T00:00:00Z`).getTime()) / 86_400_000 > OFFSITE_STALE_DAYS;
    const shown = he ? `${day.slice(8, 10)}.${day.slice(5, 7)}` : day;
    lines.push(stale ? (he ? `⚠️ אין עותק בגיבוי חיצוני מאז ${shown}` : `⚠️ No offsite copy since ${shown}`) : he ? `✓ עותק בגיבוי חיצוני: ${shown}` : `Offsite copy: ${shown}`);
  }
  return { key: `weekly:${iso(thisSunday)}`, text: lines.join('\n') };
}

export interface DispatchResult {
  sent: Array<{ type: AlertType; key: string }>;
  skipped: Array<{ type: AlertType; key: string; reason: string }>;
}

function alreadySent(db: Db, key: string, channel: Channel): boolean {
  return !!db.select({ id: alertLog.id }).from(alertLog).where(and(eq(alertLog.key, key), eq(alertLog.channel, channel), eq(alertLog.ok, true))).get();
}

function logAlert(db: Db, a: Alert, channel: Channel, ok: boolean, error?: string): void {
  db.delete(alertLog).where(and(eq(alertLog.key, a.key), eq(alertLog.channel, channel))).run();
  db.insert(alertLog).values({ type: a.type, key: a.key, channel, text: a.text, ok, error: error ?? null, sentAt: new Date().toISOString() }).run();
}

/**
 * Send what is due on Telegram: the current attention items, plus the weekly summary when its slot
 * has come and it was not sent this week. Respects the matrix and quiet hours; never sends a key twice.
 */
export async function dispatchAlerts(db: Db, opts: { telegramToken: string | null; now?: Date; timeZone?: string; force?: boolean }): Promise<DispatchResult> {
  const now = opts.now ?? new Date();
  const tz = opts.timeZone ?? 'Asia/Jerusalem';
  const cfg = alertConfig(db);
  const result: DispatchResult = { sent: [], skipped: [] };
  const alerts = collectAlerts(db, { now });
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const weeklyDue = local.getDay() === cfg.weekly.day && local.getHours() >= cfg.weekly.hour;
  if (weeklyDue || opts.force) {
    const w = weeklySummaryText(db, { today: todayLocal() });
    alerts.push({ type: 'weekly_summary', key: w.key, text: w.text });
  }
  const quiet = !opts.force && inQuietHours(cfg.quiet, now, tz);
  // flood guard: too many new money alerts at once become one summary; the rest are recorded as handled
  const dueMoney = alerts.filter((a) => a.money && cfg.matrix[a.type]?.telegram && !alreadySent(db, a.key, 'telegram'));
  if (dueMoney.length > MONEY_FLOOD_LIMIT && opts.telegramToken && cfg.telegramChatId) {
    const he = ((getSetting(db, 'ui.language') as 'he' | 'en' | null) ?? 'he') === 'he';
    const summary: Alert = {
      type: 'big_purchase',
      key: `outbulk:${dueMoney.map((a) => a.key).sort().at(-1)}`,
      text: he
        ? `💸 ${dueMoney.length} התראות כסף חדשות בבת אחת (מעל ${ils(cfg.amounts.big * 100, 'he')}). יותר מדי לפרט כאן: פתח את finc ובדוק את התנועות האחרונות.`
        : `💸 ${dueMoney.length} new money alerts at once (over ${ils(cfg.amounts.big * 100, 'en')}). Too many to list here: open finc and check the latest transactions.`,
      urgent: dueMoney.some((a) => a.urgent),
    };
    if (!quiet || summary.urgent) {
      const r = await telegramSend(opts.telegramToken, cfg.telegramChatId, summary.text);
      logAlert(db, summary, 'telegram', r.ok, r.error);
      if (r.ok) {
        result.sent.push({ type: summary.type, key: summary.key });
        for (const a of dueMoney) logAlert(db, { ...a, text: `(in a summary of ${dueMoney.length}) ${a.text}` }, 'telegram', true);
      }
    }
    const handled = new Set(dueMoney.map((a) => a.key));
    alerts.splice(0, alerts.length, ...alerts.filter((a) => !handled.has(a.key)));
  }
  for (const a of alerts) {
    if (!cfg.matrix[a.type]?.telegram) {
      result.skipped.push({ type: a.type, key: a.key, reason: 'off' });
      continue;
    }
    if (alreadySent(db, a.key, 'telegram')) continue;
    if (quiet && a.type !== 'otp_needed' && !a.urgent) {
      result.skipped.push({ type: a.type, key: a.key, reason: 'quiet' });
      continue;
    }
    if (!opts.telegramToken || !cfg.telegramChatId) {
      result.skipped.push({ type: a.type, key: a.key, reason: 'telegram not configured' });
      continue;
    }
    const r = await telegramSend(opts.telegramToken, cfg.telegramChatId, a.text);
    logAlert(db, a, 'telegram', r.ok, r.error);
    if (r.ok) result.sent.push({ type: a.type, key: a.key });
    else result.skipped.push({ type: a.type, key: a.key, reason: r.error ?? 'send failed' });
  }
  return result;
}

export function recentAlerts(db: Db, limit = 30) {
  return db.select().from(alertLog).orderBy(desc(alertLog.sentAt)).limit(limit).all();
}
