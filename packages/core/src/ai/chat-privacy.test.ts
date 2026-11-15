/**
 * P1-14: the chat never sends people's names or bank descriptions. The fixture holds every format
 * an independent review found leaking, on bank and card accounts.
 */
import { describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { openDb } from '../db/db.js';
import { setStreamState } from '../engine/recurring.js';
import { runEngine } from '../engine/run.js';
import { createEvent } from '../hub/events.js';
import { listTransactions } from '../hub/transactions.js';
import { ingestBatch } from '../ingest/ingest.js';
import { normalizeDescription } from '../ingest/normalize.js';
import type { NormalizedRow } from '../ingest/types.js';
import { CHAT_TOOLS, chat } from './chat.js';
import { MODEL_LABELS, cleanMerchantName, guardEgress, modelName, processorLabel } from './model-names.js';
import type { AiProvider } from './provider.js';

const row = (date: string, amount: number, description: string, memo?: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, ...(memo ? { memo } : {}), status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });

/** Every name part that must never be sent. */
const NAME_PARTS = [
  ...['דני', 'כהן', 'מיכל', 'לוי', 'יוסי', 'מזרחי', 'רונית', 'אברהם', 'אבי', 'ששון', 'גיל', 'שרה', 'גולן', 'נועה', 'ברק', 'ישראל', 'ישראלי', 'רונן', 'רון', 'גיא', 'אלון', 'מור'],
  ...['john', 'smith', 'jane', 'doe', 'alice', 'cohen', 'roy', 'mike', 'ross', 'kate', 'bell', 'adam', 'green', 'tom', 'hall'],
];

/** Bank-account rows that carry a person (or a raw bank description) and their amounts. */
const BANK_RISKY: Array<[string, number]> = [
  ['העברה בBIT דני כהן', -10000],
  ['ביט מיכל לוי', 5000],
  ['PAYBOX יוסי מזרחי', -3000],
  ['פייבוקס רונית אברהם', 2000],
  ['העברה לאבי ששון', -50000],
  ['העברה מהחשבון 12-345-678901 גיל רז', -40000],
  ['משהו פרטי נועה ברק', -7000],
  ['ישראל ישראלי', -11000],
  ['ה.ק. שרה גולן', -12000],
  ['מס"ב - דני כהן', -13000],
  ['העבר-נייד מיכל לוי', -14000],
  ['Pay Box יוסי מזרחי', -1500],
  ['לביט אבי ששון', -1600],
  ['ביט:נועה ברק', -1700],
  ['TRF TO JOHN SMITH', -21000],
  ['SWIFT JOHN SMITH', -22000],
  ["צ'ק 123 אבי ששון", -23000],
  ['המחאה אבי ששון', -24000],
  ['שכר דירה רונן לוי', -400000],
  ['תשלום', -9900],
];
const STANDING_ORDER = 'הוראת קבע שרה גולן';
const PAYER = 'ישראל ישראלי בעמ';
const CARD_RISKY = ['PAYPAL *JANE DOE', 'GOOGLE *ALICE COHEN', 'PEPPER PAY ROY', 'פפר רון', 'PAYPAL JANE DOE', 'VENMO *MIKE ROSS', 'REVOLUT*KATE BELL', 'WISE ADAM GREEN', 'CASH APP*TOM HALL'];
/** Same name on the card and at the bank: the bank side is a person paid, so neither side is sent by name. */
const BOTH_SIDES: Array<[string, string]> = [
  ['רון לוי בעמ', 'רון לוי'],
  ['גיא כהן תל אביב', 'גיא כהן'],
  ['אלון מור', 'אלון מור'],
];
const MONTHLY_PERSON = 'אלון מור';
const RISKY = [...BANK_RISKY.map(([d]) => d), STANDING_ORDER, PAYER, ...CARD_RISKY, ...BOTH_SIDES.flat()];

function seed() {
  const db = openDb(':memory:');
  const bank = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max ****1234', source: 'scraper:max', externalId: 'm', type: 'credit_card', last4: '1234' }).accountId;
  const months = ['2026-08', '2026-09', '2026-10', '2026-11'];
  ingestBatch(db, {
    source: 'scraper:beinleumi',
    runId: null,
    accountId: bank,
    rows: [
      ...BANK_RISKY.map(([d, a], i) => row(`2026-11-${String(2 + (i % 20)).padStart(2, '0')}`, a, d, d === 'תשלום' ? 'דני כהן חשבון 12-345-678901' : undefined)),
      ...months.map((m) => row(`${m}-01`, -250000, STANDING_ORDER)),
      ...months.map((m) => row(`${m}-10`, 1200000, PAYER)),
      row('2026-11-12', -8000, 'SUPER-PHARM'),
      row('2026-11-13', -30000, 'חברת החשמל'),
      row('2026-11-14', -16000, BOTH_SIDES[0]![1]),
      row('2026-11-15', -17000, BOTH_SIDES[1]![1]),
      ...months.map((m) => row(`${m}-20`, -350000, MONTHLY_PERSON)),
    ],
  });
  ingestBatch(db, {
    source: 'scraper:max',
    runId: null,
    accountId: card,
    rows: [
      row('2026-11-02', -5000, 'WOLT'),
      row('2026-11-06', -7000, 'WOLT*123'),
      row('2026-11-03', -320000, 'SKYWAYAIR*51837260913'),
      row('2026-11-04', -45000, 'מרפאת שיניים ד"ר דוגמה'),
      row('2026-11-04', -12000, 'SUPERMARKET'),
      row('2026-11-05', -6000, 'SUPER-PHARM'),
      ...CARD_RISKY.map((d, i) => row(`2026-11-${String(7 + i).padStart(2, '0')}`, i === 0 ? -2000 : i === 1 ? -1500 : -1000 - i, d)),
      ...BOTH_SIDES.map(([d], i) => row(`2026-11-${String(16 + i).padStart(2, '0')}`, -2600 - i, d)),
      ...['2026-08-15', '2026-09-15', '2026-10-15'].map((d) => row(d, -5490, 'NETFLIX')),
    ],
  });
  runEngine(db);
  const c = db.$client;
  const catId = (key: string) => (c.prepare('select id from category where key = ?').get(key) as { id: number }).id;
  c.prepare(`update "transaction" set merchant_id = null where description_raw = ?`).run('משהו פרטי נועה ברק');
  c.prepare(`update "transaction" set category_id = ? where description_raw = ?`).run(catId('fixed.utilities'), 'חברת החשמל');
  c.prepare(`update "transaction" set category_id = ? where description_raw = ?`).run(catId('income.salary'), PAYER);
  c.prepare(`update "transaction" set category_id = ? where description_raw = ?`).run(catId('daily.pharm'), 'SUPER-PHARM');
  const streamOf = (name: string) => (c.prepare('select rs.id from recurring_stream rs join merchant m on m.id = rs.merchant_id where m.name like ?').get(`${name}%`) as { id: number } | undefined)?.id;
  const so = streamOf('הוראת קבע');
  const nf = streamOf('Netflix');
  const sal = streamOf('ישראל ישראלי');
  const alon = streamOf(MONTHLY_PERSON);
  if (so === undefined || nf === undefined || sal === undefined || alon === undefined) throw new Error('fixture: four streams expected');
  setStreamState(db, alon, 'confirmed');
  c.prepare('update recurring_stream set category_id = ? where id = ?').run(catId('income.salary'), sal);
  setStreamState(db, so, 'confirmed', 'שכר דירה לשרה גולן');
  setStreamState(db, nf, 'confirmed', 'Netflix family');
  setStreamState(db, sal, 'confirmed');
  createEvent(db, { name: 'טיול 2026 לאילת', fromDate: '2026-11-01', toDate: '2026-11-05' });
  return db;
}

/** Records every string sent; asks for each scripted lookup in turn, then answers. */
function recorder(calls: Array<{ tool: string; args: Record<string, unknown> }>): AiProvider & { sent: string[] } {
  const sent: string[] = [];
  let i = 0;
  return {
    name: 'fake',
    model: 'fake-chat',
    sent,
    async complete({ system, user }) {
      sent.push(system, user);
      const c = calls[i++];
      return c ? JSON.stringify(c) : '{"answer": "done"}';
    },
  };
}

const ALL_CALLS = [
  { tool: 'month_summary', args: { month: '2026-11' } },
  { tool: 'spend_by_category', args: { month: '2026-11' } },
  { tool: 'spend_by_category', args: { from: '2026-08-01', to: '2026-11-30' } },
  { tool: 'top_merchants', args: { from: '2026-08-01', to: '2026-11-30', limit: 30 } },
  { tool: 'find_transactions', args: { from: '2026-08-01', to: '2026-11-30', limit: 50 } },
  { tool: 'recurring', args: {} },
  { tool: 'trends', args: { months: 6 } },
  { tool: 'events', args: {} },
  { tool: 'net_worth', args: {} },
  { tool: 'find_transactions', args: { q: 'payment', limit: 50 } },
  // chat v2: aggregates by name and by category, over the fixture's months
  { tool: 'spend_summary', args: { from: '2026-08', to: '2026-11', groupBy: 'merchant', limit: 30 } },
  { tool: 'spend_summary', args: { from: '2026-08', to: '2026-11', groupBy: 'category', limit: 30 } },
  { tool: 'spend_summary', args: { from: '2026-08', to: '2026-11', merchant: 'payment', groupBy: 'month' } },
  { tool: 'find_transactions', args: { from: '2026-08-01', to: '2026-11-30', currency: 'ils', limit: 50 } },
];

/** What lookups sent back from the tools (the part after the arrow). */
const resultParts = (sent: string[]): string[] => sent.flatMap((s) => s.split('\n').filter((l) => l.includes(' → ')).map((l) => l.slice(l.indexOf(' → ') + 3)));

/** A name part as a word of its own ("לוי" is inside "בילויים", a category name), with a Hebrew one-letter prefix. */
const wordRe = (w: string) => new RegExp(`(^|[^\\p{L}])[בלמהו]?${w}($|[^\\p{L}])`, 'iu');

const tool = (name: string) => CHAT_TOOLS.find((t) => t.name === name)!;
type Found = { total: number; shown: number; rows: Array<{ date: string; merchant: string; amount: number; category: string | null }> };
const TODAY = '2026-11-30';
const FROM = '2026-08-01';
const TO = '2026-11-30';

describe('ask my money: no names of people, no bank descriptions (P1-14)', () => {
  it('runs every tool through the chat loop and sends no person name or risky description', async () => {
    const db = seed();
    const sent: string[] = [];
    // MAX_ROUNDS allows five lookups per turn
    for (const calls of [ALL_CALLS.slice(0, 5), ALL_CALLS.slice(5, 10), ALL_CALLS.slice(10)]) {
      const model = recorder(calls);
      const r = await chat(db, model, [{ role: 'user', content: 'how is my month going?' }], { today: TODAY });
      expect(r.steps.map((s) => s.tool)).toEqual(calls.map((c) => c.tool));
      sent.push(...model.sent);
    }
    const all = sent.join('\n');
    for (const p of NAME_PARTS) expect(all).not.toMatch(wordRe(p));
    for (const d of RISKY) {
      expect(all).not.toContain(d);
      expect(all).not.toContain(normalizeDescription(d));
    }
    for (const leak of ['678901', '51837260913', '1234', 'שכר דירה', 'Jane Doe', 'Alice Cohen', 'Super Pharm']) expect(all).not.toContain(leak);
    for (const ok of ['"Wolt"', '"Skywayair"', 'מרפאת שיניים', '"Supermarket"', '"Pharmacy & care"', '"Utilities"', '"Salary"', '"Netflix family"', '"טיול לאילת"', '"PayPal payment"', '"Google payment"', '"Pepper payment"', '"Venmo payment"', '"Revolut payment"', '"Wise payment"', '"Cash App payment"', MODEL_LABELS.sentToPerson, MODEL_LABELS.receivedFromPerson, MODEL_LABELS.bankTransfer, MODEL_LABELS.unnamed]) expect(all).toContain(ok);
    // recurring: the standing order to a person, the person paying a salary, a monthly bank payment to a person, the user's own label
    const rec = JSON.parse(resultParts(sent).find((l) => l.startsWith('[{"name"'))!) as Array<{ name: string; amount: number }>;
    expect(rec.map((s) => [s.name, s.amount]).sort()).toEqual([['Netflix family', -54.9], ['Salary', 12000], [MODEL_LABELS.bankTransfer, -2500], [MODEL_LABELS.unnamed, -3500]].sort());
  });

  it('spend_summary by merchant: only names that may be sent, totals as local data says (chat v2)', () => {
    const db = seed();
    // a month later, so November (where most risky rows are) is a full month
    const r = tool('spend_summary').run(db, { from: '2026-08', to: '2026-11', groupBy: 'merchant', limit: 30 }, '2026-12-15') as { total: number; groups: Array<{ name: string; total: number }> };
    const out = JSON.stringify(r);
    for (const p of NAME_PARTS) expect(out).not.toMatch(wordRe(p));
    for (const d of RISKY) expect(out).not.toContain(d);
    for (const leak of ['678901', '51837260913', '1234', 'Super Pharm']) expect(out).not.toContain(leak);
    const names = r.groups.map((g) => g.name);
    for (const ok of ['Wolt', 'PayPal payment', MODEL_LABELS.sentToPerson, 'Pharmacy & care']) expect(names).toContain(ok);
    expect(Math.round(r.groups.reduce((a, g) => a + g.total, 0) * 100)).toBe(Math.round(r.total * 100));
    // a search by a person's name finds nothing
    for (const q of ['דני כהן', 'JOHN', 'אלון']) expect((tool('spend_summary').run(db, { from: '2026-08', to: '2026-11', merchant: q }, '2026-12-15') as { count: number }).count).toBe(0);
  });

  it('top_merchants: totals and counts exact, one line per name sent', () => {
    const db = seed();
    const local = db.$client.prepare(`select sum(amount_ils) s, count(*) n from "transaction" where status = 'completed' and excluded = 0 and amount_ils < 0 and txn_date between ? and ?`).get(FROM, TO) as { s: number; n: number };
    const top = tool('top_merchants').run(db, { from: FROM, to: TO, limit: 30 }, TODAY) as { merchants: Array<{ merchant: string; spent: number; count: number }> };
    expect(top.merchants.length).toBeLessThan(30);
    expect(Math.round(top.merchants.reduce((a, m) => a + m.spent, 0) * 100)).toBe(-local.s);
    expect(top.merchants.reduce((a, m) => a + m.count, 0)).toBe(local.n);
    const names = top.merchants.map((m) => m.merchant.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const by = new Map(top.merchants.map((m) => [m.merchant, m]));
    // "WOLT" and "WOLT*123" are two merchants, one name
    expect(by.get('Wolt')).toEqual({ merchant: 'Wolt', spent: 120, count: 2 });
    // bank-side expenses go out as their category; the same merchant on the card too
    expect(by.get('Super Pharm')).toBeUndefined();
    expect(by.get('Pharmacy & care')).toEqual({ merchant: 'Pharmacy & care', spent: 140, count: 2 });
    expect(by.get('Utilities')).toEqual({ merchant: 'Utilities', spent: 300, count: 1 });
    // wallets and processors: never the name behind them
    expect(by.get('PayPal payment')).toEqual({ merchant: 'PayPal payment', spent: 30.04, count: 2 });
    expect(by.get('Google payment')).toEqual({ merchant: 'Google payment', spent: 15, count: 1 });
    expect(by.get('Pepper payment')).toEqual({ merchant: 'Pepper payment', spent: 20.05, count: 2 });
    for (const w of ['Venmo', 'Revolut', 'Wise', 'Cash App']) expect(by.get(`${w} payment`)?.count).toBe(1);
  });

  it('find_transactions: rows and totals as local data says, search only over names that may be sent', () => {
    const db = seed();
    const all = tool('find_transactions').run(db, { from: FROM, to: TO, limit: 50 }, TODAY) as Found;
    const page = listTransactions(db, { from: FROM, to: TO, limit: 500, sort: 'date' });
    expect(all.total).toBe(page.total);
    expect(all.rows.map((r) => [r.date, Math.round(r.amount * 100)])).toEqual(page.items.slice(0, 50).map((t) => [t.date, t.amount]));
    // income never names the payer
    const salary = tool('find_transactions').run(db, { min: 12000 }, TODAY) as Found;
    expect([salary.total, ...salary.rows.map((r) => r.merchant)]).toEqual([4, 'Salary', 'Salary', 'Salary', 'Salary']);
    // q, dates and amount filters all count towards total
    const wolt = tool('find_transactions').run(db, { q: 'wolt' }, TODAY) as Found;
    expect([wolt.total, wolt.shown]).toEqual([2, 2]);
    const woltBig = tool('find_transactions').run(db, { q: 'wolt', min: 60 }, TODAY) as Found;
    expect([woltBig.total, woltBig.rows.map((r) => r.amount)]).toEqual([1, [-70]]);
    const people = tool('find_transactions').run(db, { q: 'to a person', limit: 50 }, TODAY) as Found;
    expect(people.total).toBeGreaterThanOrEqual(5);
    // names of people, descriptions and memos are not searchable
    // (a hit on a category name is fine: "לוי" is inside "פנאי ובילויים"; a hit on a row whose description or memo holds q is not)
    const local = listTransactions(db, { from: '2025-11-30', to: TODAY, limit: 1000, sort: 'date' }).items;
    for (const q of ['דני כהן', 'דני', 'JOHN', 'Jane', '678901', 'תשלום', 'חשבון', 'לוי', 'כהן', 'אלון', 'מור', 'Ross', 'roy', 'רון']) {
      const f = tool('find_transactions').run(db, { q, limit: 50 }, TODAY) as Found;
      const holders = new Set(local.filter((t) => `${t.descriptionRaw} ${t.memo ?? ''}`.toLowerCase().includes(q.toLowerCase())).map((t) => `${t.date}|${t.amount}`));
      expect(holders.size).toBeGreaterThan(0);
      expect([q, f.rows.filter((r) => holders.has(`${r.date}|${Math.round(r.amount * 100)}`)).map((r) => r.merchant)]).toEqual([q, []]);    }
    expect(tool('find_transactions').run(db, { q: 'ד' }, TODAY)).toEqual({ error: 'q needs at least 2 characters' });
  });

  it('a search by a person\'s name through the chat sends nothing about the person', async () => {
    const db = seed();
    const model = recorder([{ tool: 'find_transactions', args: { q: 'דני כהן' } }]);
    await chat(db, model, [{ role: 'user', content: 'how much did I send?' }], { today: TODAY });
    const results = resultParts(model.sent);
    expect(results).toEqual(['{"from":"2025-11-30","to":"2026-11-30","total":0,"shown":0,"countAll":0,"totalAll":0,"rows":[]}']);
  });

  it('modelName: card merchants only, generic labels otherwise', () => {
    const bank = { onCard: false, merchantOnBank: true };
    const card = { onCard: true, merchantOnBank: false };
    for (const d of ['ה.ק. שרה גולן', 'מס"ב - דני כהן', 'העבר-נייד מיכל לוי', 'TRF TO JOHN SMITH', 'SWIFT JOHN SMITH', "צ'ק 123 אבי", 'המחאה אבי ששון', 'הוראת קבע שרה'])
      expect(modelName({ merchantName: d, descriptions: [d], amount: -1, ...card })).toBe(MODEL_LABELS.bankTransfer);
    for (const d of ['Pay Box יוסי', 'פיי בוקס יוסי', 'לביט אבי', 'ביט:נועה', 'העברה בbit דני כהן'])
      expect(modelName({ merchantName: d, descriptions: [d], amount: -1, ...card })).toBe(MODEL_LABELS.sentToPerson);
    expect(modelName({ merchantName: 'ישראל ישראלי', amount: -1, ...bank })).toBe(MODEL_LABELS.unnamed);
    expect(modelName({ merchantName: 'שכר דירה רונן', categoryName: 'Rent', amount: -1, ...bank })).toBe('Rent');
    expect(modelName({ merchantName: 'Super Pharm', categoryName: 'Pharmacy & care', amount: -1, ...bank })).toBe('Pharmacy & care');
    expect(modelName({ merchantName: 'Super Pharm', amount: -1, ...bank })).toBe(MODEL_LABELS.unnamed);
    expect(modelName({ merchantName: 'רון לוי', categoryName: 'Shopping', amount: -1, onCard: true, merchantOnBank: true })).toBe('Shopping');
    expect(modelName({ merchantName: 'Super Pharm', amount: -1, ...card })).toBe('Super Pharm');
    for (const [d, p] of [['PEPPER PAY ROY', 'Pepper'], ['פפר רון', 'Pepper'], ['PAYPAL JANE DOE', 'PayPal'], ['VENMO *MIKE ROSS', 'Venmo'], ['REVOLUT*KATE BELL', 'Revolut'], ['WISE ADAM GREEN', 'Wise'], ['CASH APP*TOM HALL', 'Cash App'], ['ZELLE JOHN', 'Zelle'], ['ACMEPAY*JOHN SMITH', 'card'], ['SP* STREAMLY', 'card'], ['GROW*רון', 'Grow'], ['PAY2HOUSE AVI', 'Pay2House'], ['BITPAY NOA', 'BitPay']])
      expect(modelName({ merchantName: 'x', descriptions: [d], amount: -1, ...card })).toBe(`${p} payment`);
    // review round 3: the word before '*' can itself be a person; a processor written with a space is still one
    for (const d of ['DANI*COHEN', 'דני*כהן', 'JOHNSMITH* REF', 'SP JANE DOE']) {
      const sent = modelName({ merchantName: 'x', descriptions: [d], amount: -1, ...card });
      expect(sent, d).toBe('card payment');
    }
    expect(processorLabel('WOLT*123')).toBeNull();
    expect(processorLabel('SKYWAYAIR*51837260913')).toBeNull();
    expect(modelName({ merchantName: 'ישראל ישראלי', categoryName: 'Salary', amount: 1, ...card })).toBe('Salary');
    expect(modelName({ merchantName: 'Somebody', amount: 1, ...card })).toBe(MODEL_LABELS.otherIncome);
    expect(modelName({ merchantName: 'ישראל ישראלי', label: 'My salary', amount: 1, ...bank })).toBe('My salary');
    expect(modelName({ merchantName: 'Jane Doe', descriptions: ['PAYPAL *JANE DOE'], amount: -1, ...card })).toBe('PayPal payment');
    expect(modelName({ merchantName: 'Something', kind: 'transfer', amount: -1, ...card })).toBe(MODEL_LABELS.bankTransfer);
    expect(modelName({ merchantName: 'Max', kind: 'settlement', amount: -1, ...bank })).toBe(MODEL_LABELS.cardBill);
    expect(modelName({ merchantName: 'דני כהן', categoryKey: 'lifestyle.people', amount: -1, ...card })).toBe(MODEL_LABELS.sentToPerson);
    expect(modelName({ merchantName: 'ביטוח ישיר', amount: -1, ...card })).toBe('ביטוח ישיר');
    expect(modelName({ merchantName: '123456', amount: -1, ...card })).toBe(MODEL_LABELS.unnamed);
    expect(processorLabel('GOOGLE *ALICE COHEN')).toBe('Google payment');
    expect(processorLabel('WOLT')).toBeNull();
    expect(cleanMerchantName('Booking.com * 4471 ref x')).toBe('Booking.com');
    expect(cleanMerchantName('Skywayair51837260913')).toBe('Skywayair');
  });

  it('the egress guard drops long digit runs and exact descriptions, keeps numbers and approved names', () => {
    const ctx = { allowed: new Set(['Wolt']), descriptions: () => ({ raw: new Set(['ACME LTD 55']), norm: new Set(['wolt', 'acme ltd 55']) }) };
    expect(guardEgress({ a: 'ref 1234567 ok', n: 1400000, m: 'Wolt', d: 'ACME LTD 55', e: 'acme ltd 55', list: ['x'] }, ctx)).toEqual({ a: 'ref … ok', n: 1400000, m: 'Wolt', d: MODEL_LABELS.unnamed, e: MODEL_LABELS.unnamed, list: ['x'] });
  });
});
