import { ensureAccount, flushSecurityEvents, ingestBatch, listSecurityEvents, openDb, runEngine } from '@finc/core';
import type { NormalizedRow } from '@finc/core';
import { describe, expect, it } from 'vitest';
import type { WorkerState } from '../server.js';
import { PAID_BACK_OUTSIDE_PER_HOUR, createApp } from './app.js';

// Now screen, build step 3: paid back to me. POST /api/transactions/:id/paid-back, `paidBack` on /api/hub,
// askPaidBack on the extra items and paidBack / paidBackByRule / askPaidBack on transaction rows. Fictional values.

const TOKEN = 'c'.repeat(64);
const HOME = { authorization: `Bearer ${TOKEN}` };
const EDGE = { 'x-finc-edge': 'public', 'x-forwarded-for': '198.51.100.42', 'x-forwarded-proto': 'https' };
const row = (date: string, amount: number, description: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });

function setup() {
  const db = openDb(':memory:');
  const acc = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'Bank', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
  const month = new Date().toISOString().slice(0, 7);
  ingestBatch(db, {
    source: 'scraper:beinleumi',
    runId: null,
    accountId: acc,
    rows: [row(`${month}-01`, 1500000, 'EMPLOYER LTD'), row(`${month}-02`, 30000, 'BIT FROM DANA'), row(`${month}-03`, 12000, 'BIT FROM DANA'), row(`${month}-04`, 20000, 'BIT FROM OMER'), row(`${month}-05`, -52000, 'SUPERMARKET')],
  });
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: card, rows: [row(`${month}-06`, 5000, 'CARD CREDIT')] });
  runEngine(db);
  const c = db.$client;
  c.prepare(`delete from link`).run();
  c.prepare(`update "transaction" set kind = case when amount_ils > 0 then 'income' else 'expense' end, excluded = 0, recurring_stream_id = null, installment_plan_id = null, category_id = null, category_source = 'user'`).run();
  c.prepare(`delete from recurring_stream`).run();
  const cat = (k: string) => (c.prepare('select id from category where key = ?').get(k) as { id: number }).id;
  c.prepare(`update "transaction" set category_id = ? where description_raw = 'EMPLOYER LTD'`).run(cat('income.salary'));
  c.prepare(`update "transaction" set category_id = ? where description_raw = 'BIT FROM DANA'`).run(cat('income.other'));
  const id = (d: string, day?: string) => (c.prepare(`select id from "transaction" where description_raw = ? ${day ? 'and txn_date = ?' : ''}`).get(...(day ? [d, `${month}-${day}`] : [d])) as { id: number }).id;
  const vault = { locked: false, lock() {}, get: () => undefined, has: () => false, list: () => [] };
  const state: WorkerState = { db, vault: vault as never, scheduler: { config: { times: [], jitterMinutes: 0, timezone: 'UTC', monthsBack: 3 }, isRunning: false, nextRun: () => null } as never, startedAt: Date.now() };
  const { app } = createApp(state, { controlToken: TOKEN, webDist: '/nonexistent' });
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const pairOutside = async (): Promise<Record<string, string>> => {
    const code = (await call('/api/devices/pairings', { method: 'POST', headers: HOME, body: JSON.stringify({ name: 'phone' }) })).body.code as string;
    const token = (await call('/api/devices/pair', { method: 'POST', headers: EDGE, body: JSON.stringify({ code }) })).body.token as string;
    return { ...EDGE, authorization: `Bearer ${token}` };
  };
  const snapshot = () => JSON.stringify([c.prepare('select id, kind, excluded, income_kind_override from "transaction" order by id').all(), c.prepare('select * from counterparty_rule order by id').all()]);
  return { db, call, id, month, pairOutside, snapshot };
}

describe('Paid back to me API', () => {
  it('GET /api/hub: paidBack is empty, extra items carry askPaidBack; transaction rows carry the three flags', async () => {
    const { call, id } = setup();
    const b = (await call('/api/hub', { headers: HOME })).body;
    expect(b.paidBack).toEqual({ total: 0, items: [] });
    const ask = Object.fromEntries((b.incomeSplit.extra.items as Array<{ id: number; askPaidBack: boolean }>).map((i) => [i.id, i.askPaidBack]));
    expect(ask[id('BIT FROM DANA', '02')]).toBe(true);
    expect(ask[id('BIT FROM OMER')]).toBe(true);
    expect(ask[id('CARD CREDIT')]).toBe(false);
    for (const i of b.incomeSplit.extra.items as Array<Record<string, unknown>>) expect(typeof i.askPaidBack).toBe('boolean');
    const t = (await call(`/api/transactions/${id('BIT FROM OMER')}`, { headers: HOME })).body;
    expect(t).toMatchObject({ paidBack: false, paidBackByRule: false, askPaidBack: true });
    const list = (await call('/api/transactions', { headers: HOME })).body.items as Array<Record<string, unknown>>;
    for (const i of list) for (const k of ['paidBack', 'paidBackByRule', 'askPaidBack']) expect(typeof i[k]).toBe('boolean');
  });

  it('POST once / always / undo from a paired phone: counted against spending, explain sums to left, logged', async () => {
    const { db, call, id, pairOutside } = setup();
    const phone = await pairOutside();
    const before = (await call('/api/hub', { headers: HOME })).body;
    const post = (txn: number, body: unknown, headers: Record<string, string> = phone) => call(`/api/transactions/${txn}/paid-back`, { method: 'POST', headers, body: JSON.stringify(body) });

    const d1 = id('BIT FROM DANA', '02');
    const d2 = id('BIT FROM DANA', '03');
    let r = await post(d1, { answer: 'once' });
    expect(r).toEqual({ status: 200, body: { changed: 1 } });
    let h = (await call('/api/hub', { headers: HOME })).body;
    expect(h.paidBack).toEqual({ total: 30000, items: [{ id: d1, name: expect.any(String), amount: 30000, date: expect.any(String), byRule: false }] });
    expect(h.forecast.variableSpent).toBe(before.forecast.variableSpent - 30000);
    expect(h.forecast.left).toBe(before.forecast.left);
    expect((h.explain as Array<{ amount: number }>).reduce((a, t) => a + t.amount, 0)).toBe(h.forecast.left);
    expect(h.summary.integrity.ok).toBe(true);
    expect((await call(`/api/transactions/${d1}`, { headers: HOME })).body).toMatchObject({ bucket: 'variable', paidBack: true, paidBackByRule: false, askPaidBack: false });

    r = await post(d2, { answer: 'always' });
    expect(r).toEqual({ status: 200, body: { changed: 2 } }); // the rule and the second payment (the first was already marked)
    h = (await call('/api/hub', { headers: HOME })).body;
    expect(h.paidBack.total).toBe(42000);
    expect((h.paidBack.items as Array<{ byRule: boolean }>).every((i) => i.byRule)).toBe(true);
    expect((await call(`/api/transactions/${d1}`, { headers: HOME })).body).toMatchObject({ paidBack: true, paidBackByRule: true });

    r = await post(d1, { answer: 'undo' }, HOME);
    expect(r).toEqual({ status: 200, body: { changed: 3 } });
    h = (await call('/api/hub', { headers: HOME })).body;
    expect(h.paidBack).toEqual({ total: 0, items: [] });
    expect(h.forecast.variableSpent).toBe(before.forecast.variableSpent);
    expect((await call(`/api/transactions/${d1}`, { headers: HOME })).body).toMatchObject({ paidBack: false, paidBackByRule: false, askPaidBack: true });

    flushSecurityEvents(db);
    const events = listSecurityEvents(db, { kind: 'transaction.paid_back' }).events.map((e) => JSON.parse(e.detail ?? '{}') as Record<string, unknown>);
    // a paired phone's events are folded to one per minute by the security log (its 'always' here); the PC's are not
    expect(events.map((e) => e.answer).sort()).toEqual(['once', 'undo']);
    for (const e of events) expect(Object.keys(e).sort()).toEqual(['answer', 'changed', 'txnId']);
  });

  it('POST no: stops the asking, the payment stays income', async () => {
    const { call, id } = setup();
    const omer = id('BIT FROM OMER');
    const r = await call(`/api/transactions/${omer}/paid-back`, { method: 'POST', headers: HOME, body: JSON.stringify({ answer: 'no' }) });
    expect(r).toEqual({ status: 200, body: { changed: 1 } });
    const t = (await call(`/api/transactions/${omer}`, { headers: HOME })).body;
    expect(t).toMatchObject({ bucket: 'income', kind: 'income', paidBack: false, askPaidBack: false });
    const h = (await call('/api/hub', { headers: HOME })).body;
    expect((h.incomeSplit.extra.items as Array<{ id: number; askPaidBack: boolean }>).find((i) => i.id === omer)!.askPaidBack).toBe(false);
  });

  it('refuses bad bodies, card credits, money going out and missing rows, writing nothing', async () => {
    const { call, id, snapshot } = setup();
    const before = snapshot();
    const post = (txn: number | string, body: unknown) => call(`/api/transactions/${txn}/paid-back`, { method: 'POST', headers: HOME, body: JSON.stringify(body) });
    expect((await post(id('BIT FROM OMER'), { answer: 'sometimes' })).status).toBe(400);
    expect((await post(id('BIT FROM OMER'), { answer: 'once', extra: true })).status).toBe(400);
    expect((await post(id('BIT FROM OMER'), {})).status).toBe(400);
    expect((await post(id('CARD CREDIT'), { answer: 'once' })).status).toBe(400);
    expect((await post(id('SUPERMARKET'), { answer: 'always' })).status).toBe(400);
    expect((await post(999999, { answer: 'once' })).status).toBe(404);
    expect((await post('abc', { answer: 'once' })).status).toBe(404);
    expect(snapshot()).toBe(before);
  });
});

describe('Paid back to me API: review fixes', () => {
  it('generic_payer: { error, code } 400 and nothing written; canRemember false on the hub item and the row; once still works', async () => {
    const { db, call, id, month, snapshot } = setup();
    const bank = (db.$client.prepare(`select id from account where type = 'checking'`).get() as { id: number }).id;
    // a bare channel text names no payer
    ingestBatch(db, { source: 'scraper:beinleumi', runId: null, accountId: bank, rows: [row(`${month}-07`, 9000, 'זיכוי מביט')] });
    db.$client.prepare(`update "transaction" set kind = 'income' where description_raw = 'זיכוי מביט'`).run();
    const omer = id('זיכוי מביט');
    expect((await call(`/api/transactions/${omer}`, { headers: HOME })).body).toMatchObject({ askPaidBack: true, canRemember: false });
    const item = ((await call('/api/hub', { headers: HOME })).body.incomeSplit.extra.items as Array<{ id: number; canRemember: boolean; askPaidBack: boolean }>).find((i) => i.id === omer)!;
    expect(item).toMatchObject({ askPaidBack: true, canRemember: false });
    expect((await call(`/api/transactions/${id('BIT FROM DANA', '02')}`, { headers: HOME })).body.canRemember).toBe(true);
    const before = snapshot();
    for (const answer of ['always', 'no']) {
      const r = await call(`/api/transactions/${omer}/paid-back`, { method: 'POST', headers: HOME, body: JSON.stringify({ answer }) });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: expect.any(String), code: 'generic_payer' });
    }
    expect(snapshot()).toBe(before);
    const missing = await call('/api/transactions/999999/paid-back', { method: 'POST', headers: HOME, body: JSON.stringify({ answer: 'once' }) });
    expect(missing).toEqual({ status: 404, body: { error: expect.any(String), code: 'not_found' } });
    const card = await call(`/api/transactions/${id('CARD CREDIT')}/paid-back`, { method: 'POST', headers: HOME, body: JSON.stringify({ answer: 'once' }) });
    expect(card).toEqual({ status: 400, body: { error: expect.any(String), code: 'not_eligible' } });
    expect((await call(`/api/transactions/${omer}/paid-back`, { method: 'POST', headers: HOME, body: JSON.stringify({ answer: 'once' }) })).body).toEqual({ changed: 1 });
  });

  it('no_once: the payment stays income and is no longer asked about; no rule is written', async () => {
    const { db, call, id } = setup();
    const omer = id('BIT FROM OMER');
    const r = await call(`/api/transactions/${omer}/paid-back`, { method: 'POST', headers: HOME, body: JSON.stringify({ answer: 'no_once' }) });
    expect(r).toEqual({ status: 200, body: { changed: 1 } });
    expect((await call(`/api/transactions/${omer}`, { headers: HOME })).body).toMatchObject({ kind: 'income', askPaidBack: false, paidBack: false });
    expect((db.$client.prepare(`select count(*) n from counterparty_rule where kind in ('income', 'paid_back')`).get() as { n: number }).n).toBe(0);
  });

  it('answers from a paired phone are rate limited per hour; home is not', async () => {
    const { call, id, pairOutside } = setup();
    const phone = await pairOutside();
    const omer = id('BIT FROM OMER');
    const post = (headers: Record<string, string>, answer: string) => call(`/api/transactions/${omer}/paid-back`, { method: 'POST', headers, body: JSON.stringify({ answer }) });
    for (let i = 0; i < PAID_BACK_OUTSIDE_PER_HOUR; i++) expect((await post(phone, i % 2 ? 'undo' : 'once')).status).toBe(200);
    const limited = await post(phone, 'once');
    expect(limited.status).toBe(429);
    expect(limited.body.retryAt).toEqual(expect.any(String));
    for (let i = 0; i < PAID_BACK_OUTSIDE_PER_HOUR + 5; i++) expect((await post(HOME, i % 2 ? 'undo' : 'once')).status).toBe(200);
  });
});
