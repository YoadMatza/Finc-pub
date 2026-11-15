import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSetting } from '../ai/settings.js';
import { ensureAccount } from '../db/accounts.js';
import { type Db, openDb } from '../db/db.js';
import { runEngine } from '../engine/run.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { collectAlerts, dispatchAlerts, setAlertConfig } from './index.js';
import { MONEY_SINCE_SETTING, collectMoneyAlerts, moneySince } from './money.js';

const SINCE = '2026-11-01T00:00:00.000Z';
const BEFORE = new Date('2026-10-20T06:00:00Z');
const AFTER = new Date('2026-11-05T06:00:00Z');

const row = (date: string, amount: number, description: string, extra: Partial<NormalizedRow> = {}): NormalizedRow => ({
  externalAccountId: 'x',
  date,
  amount,
  description,
  status: 'completed',
  type: 'normal',
  identifier: `${description}|${date}|${amount}|${extra.installmentN ?? ''}|${extra.status ?? ''}`,
  payload: {},
  ...extra,
});

function setup() {
  const db = openDb(':memory:');
  const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
  const bank = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  const ingest = (accountId: number, rows: NormalizedRow[], now: Date, source = accountId === card ? 'scraper:max' : 'scraper:beinleumi') => ingestBatch(db, { source, runId: null, accountId, rows, now });
  return { db, card, bank, ingest };
}
const kinds = (db: Db) => collectMoneyAlerts(db, { since: SINCE }).map((a) => `${a.kind}:${a.name.toUpperCase()}:${a.amount / 100}${a.pending ? ':pending' : ''}${a.urgent ? ':urgent' : ''}`);

afterEach(() => vi.unstubAllGlobals());

describe('money-out alerts (security research P1-02, P1-03)', () => {
  it('starts from the first run, never replays history', () => {
    const { db, card, ingest } = setup();
    ingest(card, [row('2026-10-19', -250000, 'OLD BIG')], BEFORE);
    expect(moneySince(db, new Date(SINCE))).toBe(SINCE); // first call stores the start point
    expect(moneySince(db, new Date('2030-01-01T00:00:00Z'))).toBe(SINCE); // and keeps it
    expect(kinds(db)).toEqual([]);
  });

  it('every new charge at or over the threshold alerts, no cap of three; smaller ones do not', () => {
    const { db, card, ingest } = setup();
    ingest(card, [row('2026-11-03', -150000, 'SHOP A'), row('2026-11-03', -120000, 'SHOP B'), row('2026-11-04', -110000, 'SHOP C'), row('2026-11-04', -100000, 'SHOP D'), row('2026-11-04', -90000, 'SMALL')], AFTER);
    runEngine(db);
    expect(kinds(db)).toEqual(['money_out:SHOP A:-1500', 'money_out:SHOP B:-1200', 'money_out:SHOP C:-1100', 'money_out:SHOP D:-1000']);
  });

  it('a pending charge alerts at once, and stays the same alert when it completes', () => {
    const { db, card, ingest } = setup();
    ingest(card, [row('2026-11-04', -200000, 'ELECTRO', { status: 'pending', identifier: undefined })], AFTER);
    const first = collectMoneyAlerts(db, { since: SINCE });
    expect(first.map((a) => [a.kind, a.pending])).toEqual([['money_out', true]]);
    ingest(card, [row('2026-11-04', -200000, 'ELECTRO', { identifier: 'arn-1' })], new Date('2026-11-06T06:00:00Z'));
    const second = collectMoneyAlerts(db, { since: SINCE });
    expect(second.map((a) => [a.key, a.pending])).toEqual([[first[0]!.key, false]]);
  });

  it('a transfer out of the bank alerts although the default rule excludes it from spending', () => {
    const { db, bank, ingest } = setup();
    ingest(bank, [row('2026-11-04', -170000, 'העברה מהחשבון 12345')], AFTER);
    runEngine(db);
    const a = collectMoneyAlerts(db, { since: SINCE });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'money_out', transfer: true, accountType: 'checking' });
  });

  it('a purchase in instalments alerts once, on its full amount, even when each payment is small', () => {
    const { db, card, ingest } = setup();
    ingest(card, [row('2026-11-02', -90000, 'ELECTRA', { installmentN: 1, installmentTotal: 6 })], AFTER);
    runEngine(db);
    expect(kinds(db)).toEqual(['instalment_purchase:ELECTRA:-5400:urgent']);
    // the second payment next month is not a new alert
    ingest(card, [row('2026-12-02', -90000, 'ELECTRA', { installmentN: 2, installmentTotal: 6 })], new Date('2026-12-03T06:00:00Z'));
    runEngine(db);
    expect(kinds(db)).toEqual(['instalment_purchase:ELECTRA:-5400:urgent']);
  });

  it('five thousand or more is urgent; card testing (four charges, one merchant, one day) is urgent', () => {
    const { db, card, ingest } = setup();
    ingest(card, [row('2026-11-04', -600000, 'JEWELLER')], AFTER);
    ingest(card, [1, 2, 3, 4].map((i) => row('2026-11-05', -5000 - i, 'TEST SHOP')), AFTER);
    runEngine(db);
    expect(kinds(db)).toEqual(['money_out:JEWELLER:-6000:urgent', 'card_testing:TEST SHOP:-200.1:urgent']);
    expect(collectMoneyAlerts(db, { since: SINCE }).find((a) => a.kind === 'card_testing')?.detail).toBe(4);
  });

  it('an exact card bill is quiet; a card bill accepted with a gap alerts with the difference', () => {
    const { db, bank, card, ingest } = setup();
    ingest(card, [row('2026-10-10', -40000, 'A'), row('2026-10-11', -60000, 'B')], BEFORE);
    ingest(bank, [row('2026-11-02', -100000, 'מקס איט פיננסים'), row('2026-11-02', -210000, 'ישראכרט')], AFTER);
    const c = db.$client;
    const id = (d: string) => (c.prepare('select id from "transaction" where description_raw = ?').get(d) as { id: number }).id;
    c.prepare(`update "transaction" set kind = 'settlement', excluded = 1 where id in (?, ?)`).run(id('מקס איט פיננסים'), id('ישראכרט'));
    const link = c.prepare(`insert into link (type, from_txn_id, to_txn_id, amount, confidence, zone, source, created_at, explanation_json) values ('card_settlement', ?, ?, ?, 1, ?, 'auto', ?, '{}')`);
    link.run(id('מקס איט פיננסים'), id('A'), 40000, 'auto', SINCE);
    link.run(id('מקס איט פיננסים'), id('B'), 60000, 'auto', SINCE);
    link.run(id('ישראכרט'), id('A'), 40000, 'suggest', SINCE);
    link.run(id('ישראכרט'), id('B'), 60000, 'suggest', SINCE);
    const a = collectMoneyAlerts(db, { since: SINCE });
    expect(a.map((x) => [x.kind, x.name, x.detail])).toEqual([['card_bill_gap', 'ישראכרט', -110000]]);
  });

  it('a charge of a confirmed recurring stream does not alert (price changes have their own alert)', () => {
    const { db, bank, ingest } = setup();
    ingest(bank, [row('2026-11-01', -520000, 'RENT')], AFTER);
    runEngine(db);
    const c = db.$client;
    const t = c.prepare(`select id, merchant_id from "transaction" where description_raw = 'RENT'`).get() as { id: number; merchant_id: number };
    expect(kinds(db)).toEqual(['money_out:RENT:-5200:urgent']); // before it is a confirmed stream
    const s = c
      .prepare(`insert into recurring_stream (account_id, merchant_id, frequency, expected_amount, amount_tolerance, amount_model, occurrences, state, direction, created_at, updated_at) values (?, ?, 'monthly', -520000, 1000, 'fixed', 5, 'confirmed', 'expense', ?, ?)`)
      .run(bank, t.merchant_id, SINCE, SINCE);
    c.prepare(`update "transaction" set recurring_stream_id = ? where id = ?`).run(Number(s.lastInsertRowid), t.id);
    expect(kinds(db)).toEqual([]);
  });
});

describe('money alerts: independent review 2026-11-10', () => {
  it('a row the engine has not processed yet (mid-sync) waits; then alerts correctly', () => {
    const { db, card, ingest } = setup();
    ingest(card, [row('2026-11-02', -150000, 'ELECTRA', { installmentN: 1, installmentTotal: 3 })], AFTER);
    // before the engine: it would look like a plain 1,500 charge
    expect(collectMoneyAlerts(db, { since: SINCE, processedUntil: '2026-11-05T05:00:00.000Z' })).toEqual([]);
    runEngine(db);
    expect(kinds(db)).toEqual(['instalment_purchase:ELECTRA:-4500']);
  });

  it('looks back a few days only, so a later change of state never replays old charges', () => {
    const { db, card, ingest } = setup();
    ingest(card, [row('2026-11-04', -300000, 'OLD ONE')], AFTER);
    runEngine(db);
    expect(collectMoneyAlerts(db, { since: SINCE, now: new Date('2026-11-06T06:00:00Z') })).toHaveLength(1);
    expect(collectMoneyAlerts(db, { since: SINCE, now: new Date('2026-11-12T06:00:00Z') })).toHaveLength(0);
  });

  it('a pending charge that completes at another amount is one alert, and is not card testing', () => {
    const { db, card, ingest } = setup();
    ingest(card, [row('2026-11-04', -200000, 'AMAZON', { status: 'pending' }), row('2026-11-04', -5000, 'AMAZON', { status: 'pending' }), row('2026-11-04', -7000, 'AMAZON', { status: 'pending' })], AFTER);
    ingest(card, [row('2026-11-04', -210000, 'AMAZON', { identifier: 'c1' }), row('2026-11-04', -5100, 'AMAZON', { identifier: 'c2' }), row('2026-11-04', -7100, 'AMAZON', { identifier: 'c3' })], new Date('2026-11-06T06:00:00Z'));
    runEngine(db);
    const a = collectMoneyAlerts(db, { since: SINCE });
    expect(a.map((x) => [x.kind, x.amount / 100, x.pending])).toEqual([['money_out', -2000, true]]);
  });

  it('but when the pending copy was under the threshold, the completed one alerts', () => {
    const { db, card, ingest } = setup();
    ingest(card, [row('2026-11-04', -95000, 'SHOP', { status: 'pending' })], AFTER);
    ingest(card, [row('2026-11-04', -105000, 'SHOP', { identifier: 'c1' })], new Date('2026-11-06T06:00:00Z'));
    runEngine(db);
    expect(kinds(db)).toEqual(['money_out:SHOP:-1050']);
  });
});

describe('flood guard', () => {
  it('more than ten new money alerts at once go out as one summary, and are not resent', async () => {
    const { db, card, ingest } = setup();
    setSetting(db, MONEY_SINCE_SETTING, SINCE);
    setSetting(db, 'telegram.chatId', '1');
    // e.g. after a DB rebuild every row has a fresh created_at
    ingest(card, Array.from({ length: 12 }, (_, i) => row('2026-11-04', -150000 - i * 100, `SHOP ${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`)), AFTER);
    runEngine(db);
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
      sent.push((JSON.parse(init.body) as { text: string }).text);
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }));
    const r = await dispatchAlerts(db, { telegramToken: 't', now: new Date('2026-11-05T07:00:00Z') });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('12');
    expect(r.sent.map((s) => s.key)[0]).toMatch(/^outbulk:/);
    expect((await dispatchAlerts(db, { telegramToken: 't', now: new Date('2026-11-05T08:00:00Z') })).sent).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });
});

describe('money alerts in the dispatcher', () => {
  it('reach Telegram once; in quiet hours only the urgent ones go; the amount is configurable', async () => {
    const { db, card, ingest } = setup();
    setSetting(db, MONEY_SINCE_SETTING, SINCE);
    setSetting(db, 'telegram.chatId', '1');
    ingest(card, [row('2026-11-04', -150000, 'MID SHOP'), row('2026-11-04', -700000, 'HUGE SHOP')], AFTER);
    runEngine(db);
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
      sent.push((JSON.parse(init.body) as { text: string }).text);
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }));
    // 02:00 Israel time: quiet hours
    const night = await dispatchAlerts(db, { telegramToken: 't', now: new Date('2026-11-05T00:00:00Z') });
    expect(night.sent.map((s) => s.type)).toEqual(['big_purchase']);
    expect(sent.join('\n').toUpperCase()).toContain('HUGE SHOP');
    expect(sent.join('\n').toUpperCase()).not.toContain('MID SHOP');
    const morning = await dispatchAlerts(db, { telegramToken: 't', now: new Date('2026-11-05T07:00:00Z') });
    expect(morning.sent.map((s) => s.key)).toHaveLength(1);
    expect(sent.at(-1)?.toUpperCase()).toContain('MID SHOP');
    expect((await dispatchAlerts(db, { telegramToken: 't', now: new Date('2026-11-05T08:00:00Z') })).sent).toHaveLength(0);
    // raising the threshold hides the 1,500 one from collection
    setAlertConfig(db, { amounts: { big: 2000 } });
    const collected = collectAlerts(db, { now: new Date('2026-11-05T09:00:00Z') }).filter((a) => a.type === 'big_purchase').map((a) => a.text).join().toUpperCase();
    expect(collected).toContain('HUGE SHOP');
    expect(collected).not.toContain('MID SHOP');
    expect(() => setAlertConfig(db, { amounts: { big: 9000, urgent: 5000 } })).toThrow();
  });
});
