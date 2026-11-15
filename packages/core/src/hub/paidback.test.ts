import { beforeEach, describe, expect, it } from 'vitest';
import { getSetting, setSetting } from '../ai/settings.js';
import { ensureAccount } from '../db/accounts.js';
import { type Db, openDb } from '../db/db.js';
import { buildRecurringStreams } from '../engine/recurring.js';
import { applyCounterpartyRules } from '../engine/rules.js';
import { runEngine } from '../engine/run.js';
import { monthSummary } from '../engine/summary.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { markTransfer, setExcluded } from './actions.js';
import { setIncomeKindOverride } from './now.js';
import { hubOverview } from './overview.js';
import { PaidBackError, answerPaidBack } from './paidback.js';
import { listTransactions, transactionDetail } from './transactions.js';

// Paid back to me (build step 3). Fictional people and amounts (agorot). 2026-11-12 is a Thursday; its week runs
// Sun 8 – Sat 14 November.
const row = (date: string, amount: number, description: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });
const NOW = new Date('2026-11-12T10:00:00Z');

let db: Db;
const run = (sql: string, ...p: unknown[]) => db.$client.prepare(sql).run(...p);
const hub = (month = '2026-11') => hubOverview(db, month, 'purchase', { now: NOW });
const id = (description: string, date?: string): number =>
  (db.$client.prepare(`select id from "transaction" where description_raw = ? ${date ? 'and txn_date = ?' : ''} order by id`).get(...(date ? [description, date] : [description])) as { id: number }).id;
const kindOf = (txnId: number) => (db.$client.prepare('select kind from "transaction" where id = ?').get(txnId) as { kind: string | null }).kind;
const rules = () => db.$client.prepare('select pattern, kind, account_id from counterparty_rule where kind in (?, ?) order by id').all('income', 'paid_back') as Array<{ pattern: string; kind: string; account_id: number | null }>;
const snapshot = () => JSON.stringify([db.$client.prepare('select id, kind, excluded, income_kind_override, recurring_stream_id from "transaction" order by id').all(), db.$client.prepare('select * from counterparty_rule order by id').all()]);
const sumTerms = (h: ReturnType<typeof hub>) => h.explain.reduce((a, t) => a + t.amount, 0);

beforeEach(() => {
  db = openDb(':memory:');
  const bank = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'Bank', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
  ingestBatch(db, {
    source: 'scraper:beinleumi',
    runId: null,
    accountId: bank,
    rows: [
      row('2026-11-01', 1500000, 'EMPLOYER LTD'),
      row('2026-11-03', 30000, 'BIT FROM DANA'),
      row('2026-11-10', 12000, 'BIT FROM DANA'),
      row('2026-11-04', 20000, 'BIT FROM OMER'),
      row('2026-11-06', 80000, 'CLIENT ALPHA'),
      row('2026-11-05', -52000, 'SUPERMARKET'),
      row('2026-11-09', -25000, 'GADGET STORE'),
      row('2026-11-07', -9000, 'BIT FROM DANA'), // the same words on money going out: never claimed by a paid_back rule
    ],
  });
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: card, rows: [row('2026-11-08', 5000, 'BIT FROM DANA')] });
  runEngine(db);
  run(`delete from link`);
  run(`update "transaction" set kind = case when amount_ils > 0 then 'income' else 'expense' end, excluded = 0, recurring_stream_id = null, installment_plan_id = null, category_id = null`);
  run(`delete from recurring_stream`);
  run(`delete from installment_plan`);
  const cat = (k: string) => (db.$client.prepare('select id from category where key = ?').get(k) as { id: number }).id;
  run(`update "transaction" set category_id = ?, category_source = 'user' where description_raw = 'EMPLOYER LTD'`, cat('income.salary'));
  run(`update "transaction" set category_id = ?, category_source = 'user' where description_raw = 'CLIENT ALPHA'`, cat('income.freelance'));
  run(`update "transaction" set category_id = ?, category_source = 'user' where description_raw = 'BIT FROM DANA' and amount_ils > 0`, cat('income.other'));
  run(`update "transaction" set category_source = 'user' where category_id is null`);
});

describe('paid back to me: who finc asks about', () => {
  it('asks about extra "other" or uncategorised income on a bank account, nothing else', () => {
    const h = hub();
    const ask = new Map(h.incomeSplit.extra.items.map((i) => [i.id, i.askPaidBack]));
    expect(ask.get(id('BIT FROM DANA', '2026-11-03'))).toBe(true);
    expect(ask.get(id('BIT FROM DANA', '2026-11-10'))).toBe(true);
    expect(ask.get(id('BIT FROM OMER'))).toBe(true);
    expect(ask.get(id('CLIENT ALPHA'))).toBe(false); // freelance: a named income category
    const card = db.$client.prepare(`select t.id from "transaction" t join account a on a.id = t.account_id where a.type = 'credit_card'`).get() as { id: number };
    expect(ask.get(card.id)).toBe(false); // a card credit
    expect(h.paidBack).toEqual({ total: 0, items: [] });
    const items = new Map(listTransactions(db, { month: '2026-11' }).items.map((t) => [t.id, t]));
    expect(items.get(id('BIT FROM OMER'))).toMatchObject({ paidBack: false, paidBackByRule: false, askPaidBack: true });
    expect(items.get(id('EMPLOYER LTD'))).toMatchObject({ askPaidBack: false });
    expect(items.get(id('SUPERMARKET'))).toMatchObject({ askPaidBack: false, paidBack: false });
    expect(items.get(card.id)).toMatchObject({ askPaidBack: false });
    // a payment re-tagged regular is not asked about
    setIncomeKindOverride(db, id('BIT FROM OMER'), 'regular');
    expect(transactionDetail(db, id('BIT FROM OMER'))!.askPaidBack).toBe(false);
  });
});

describe('paid back to me: counting', () => {
  it('"once": the payment leaves income and nets day-to-day spending everywhere, exactly once', () => {
    setSetting(db, 'spend.limit.2026-11', '600000');
    const before = hub();
    const dana = id('BIT FROM DANA', '2026-11-03');
    setIncomeKindOverride(db, dana, 'extra');
    expect(answerPaidBack(db, dana, 'once')).toEqual({ changed: 1 });
    expect(kindOf(dana)).toBe('paid_back');
    expect((db.$client.prepare('select income_kind_override o from "transaction" where id = ?').get(dana) as { o: string | null }).o).toBeNull();

    const s = monthSummary(db, '2026-11');
    // variable: −520.00 − 250.00 − 90.00 (Bit out) + 300.00 = −560.00
    expect(s.variable.sum).toBe(-52000 - 25000 - 9000 + 30000);
    expect(s.income.sum).toBe(before.summary.income.sum - 30000);
    expect(s.income.count).toBe(before.summary.income.count - 1);
    expect(s.variable.count).toBe(before.summary.variable.count + 1);
    expect(s.integrity.ok).toBe(true);
    expect(s.net).toBe(before.summary.net); // the same money, counted in another bucket

    const h = hub();
    expect(h.forecast.variableSpent).toBe(56000);
    expect(h.forecast.left).toBe(before.forecast.left); // income −300, spending −300: the headline does not move
    expect(sumTerms(h)).toBe(h.forecast.left);
    const v = h.explain.find((t) => t.key === 'variable_spent')!;
    expect(v.amount).toBe(-56000);
    expect(v.items.find((i) => i.id === dana)).toMatchObject({ amount: 30000, status: 'paid' });
    expect(h.explain.find((t) => t.key === 'income_extra_received')!.items.some((i) => i.id === dana)).toBe(false);
    expect(h.incomeSplit.extra.items.some((i) => i.id === dana)).toBe(false);
    expect(h.limit!.spent).toBe(56000);
    expect(h.limit!.week!.spent).toBe(25000); // 9 Nov gadget; the 3 Nov payment is before this week
    expect(h.paidBack).toEqual({ total: 30000, items: [{ id: dana, name: expect.any(String), amount: 30000, date: '2026-11-03', byRule: false }] });
    // the second payment from the same payer is still asked about ("once" is one payment)
    expect(h.incomeSplit.extra.items.find((i) => i.id === id('BIT FROM DANA', '2026-11-10'))!.askPaidBack).toBe(true);
    const t = transactionDetail(db, dana)!;
    expect(t).toMatchObject({ bucket: 'variable', paidBack: true, paidBackByRule: false, askPaidBack: false, kind: 'paid_back' });
    expect(listTransactions(db, { month: '2026-11', bucket: 'variable' }).items.some((i) => i.id === dana)).toBe(true);
    expect(listTransactions(db, { month: '2026-11', bucket: 'income' }).items.some((i) => i.id === dana)).toBe(false);
    // answering again changes nothing
    expect(answerPaidBack(db, dana, 'once')).toEqual({ changed: 0 });
  });

  it('"always": a rule for the payer marks every incoming bank payment from them, this week too; undo forgets it', () => {
    setSetting(db, 'spend.limit.2026-11', '600000');
    const before = hub();
    const d1 = id('BIT FROM DANA', '2026-11-03');
    const d2 = id('BIT FROM DANA', '2026-11-10');
    const out = id('BIT FROM DANA', '2026-11-07');
    const card = (db.$client.prepare(`select t.id from "transaction" t join account a on a.id = t.account_id where a.type = 'credit_card'`).get() as { id: number }).id;
    expect(answerPaidBack(db, d1, 'always')).toEqual({ changed: 3 }); // the rule and two payments
    expect(rules()).toEqual([{ pattern: 'bit from dana', kind: 'paid_back', account_id: null }]);
    expect([kindOf(d1), kindOf(d2), kindOf(out), kindOf(card)]).toEqual(['paid_back', 'paid_back', 'expense', 'income']);

    const h = hub();
    expect(h.forecast.variableSpent).toBe(before.forecast.variableSpent - 42000);
    expect(sumTerms(h)).toBe(h.forecast.left);
    expect(h.limit!.spent).toBe(before.limit!.spent - 42000);
    expect(h.limit!.week!.spent).toBe(25000 - 12000);
    expect(h.paidBack.total).toBe(42000);
    expect(h.paidBack.items.map((i) => [i.id, i.amount, i.byRule])).toEqual([
      [d1, 30000, true],
      [d2, 12000, true],
    ]);
    expect(monthSummary(db, '2026-11').integrity.ok).toBe(true);
    expect(transactionDetail(db, d2)).toMatchObject({ paidBack: true, paidBackByRule: true, askPaidBack: false });
    // a second "always" adds no duplicate rule
    expect(answerPaidBack(db, d2, 'always')).toEqual({ changed: 0 });
    expect(rules()).toHaveLength(1);

    // undo: the rule goes and every payment it marked returns to income
    expect(answerPaidBack(db, d2, 'undo')).toEqual({ changed: 3 });
    expect(rules()).toEqual([]);
    expect([kindOf(d1), kindOf(d2)]).toEqual(['income', 'income']);
    const back = hub();
    expect(back.forecast.variableSpent).toBe(before.forecast.variableSpent);
    expect(back.forecast.left).toBe(before.forecast.left);
    expect(back.paidBack).toEqual({ total: 0, items: [] });
    expect(back.incomeSplit.extra.items.find((i) => i.id === d1)!.askPaidBack).toBe(true);
  });

  it('"no": an income rule stops the asking and the payment stays income; "no" on a paid-back payment returns it', () => {
    const omer = id('BIT FROM OMER');
    const before = snapshot();
    expect(answerPaidBack(db, omer, 'no')).toEqual({ changed: 1 });
    expect(rules()).toEqual([{ pattern: 'bit from omer', kind: 'income', account_id: null }]);
    expect(kindOf(omer)).toBe('income');
    expect(snapshot()).not.toBe(before);
    expect(hub().incomeSplit.extra.items.find((i) => i.id === omer)!.askPaidBack).toBe(false);
    expect(transactionDetail(db, omer)!.askPaidBack).toBe(false);
    expect(answerPaidBack(db, omer, 'no')).toEqual({ changed: 0 });

    // "always" later replaces the "no" for the same payer
    expect(answerPaidBack(db, omer, 'always')).toEqual({ changed: 3 }); // income rule removed, paid_back rule added, one payment
    expect(rules()).toEqual([{ pattern: 'bit from omer', kind: 'paid_back', account_id: null }]);
    // and "no" again forgets the paid_back rule and returns the payment
    expect(answerPaidBack(db, omer, 'no')).toEqual({ changed: 3 });
    expect(rules()).toEqual([{ pattern: 'bit from omer', kind: 'income', account_id: null }]);
    expect(kindOf(omer)).toBe('income');
  });

  it('refuses a card credit, money going out, an excluded row, a missing row; nothing is written', () => {
    const card = (db.$client.prepare(`select t.id from "transaction" t join account a on a.id = t.account_id where a.type = 'credit_card'`).get() as { id: number }).id;
    run(`update "transaction" set excluded = 1, kind = 'transfer' where description_raw = 'CLIENT ALPHA'`);
    const before = snapshot();
    const refused = (txnId: number, answer: 'always' | 'once' | 'no' | 'undo') => {
      try {
        answerPaidBack(db, txnId, answer);
      } catch (e) {
        return e instanceof PaidBackError ? e.status : 'other';
      }
      return 'accepted';
    };
    for (const a of ['always', 'once', 'no', 'undo'] as const) {
      expect(refused(card, a)).toBe(400);
      expect(refused(id('SUPERMARKET'), a)).toBe(400);
      expect(refused(id('BIT FROM DANA', '2026-11-07'), a)).toBe(400);
      expect(refused(id('CLIENT ALPHA'), a)).toBe(400);
      expect(refused(999999, a)).toBe(404);
    }
    // a savings-kind income row is not income now
    run(`update "transaction" set kind = 'savings' where description_raw = 'BIT FROM OMER'`);
    const before2 = snapshot();
    expect(refused(id('BIT FROM OMER'), 'once')).toBe(400);
    expect(snapshot()).toBe(before2);
    run(`update "transaction" set kind = 'income' where description_raw = 'BIT FROM OMER'`);
    expect(snapshot()).toBe(before);
  });
});

describe('paid back to me: later engine runs keep the kind', () => {
  it('runEngine, an income rule for the same words, and refund linking leave a paid-back payment as it is', () => {
    const d1 = id('BIT FROM DANA', '2026-11-03');
    const omer = id('BIT FROM OMER');
    answerPaidBack(db, d1, 'once');
    answerPaidBack(db, omer, 'always');
    // an income rule that also matches the once-marked payment
    run(`insert into counterparty_rule (pattern, kind, account_id, note, created_at) values ('bit from', 'income', null, 'test', '2026-11-12T00:00:00Z')`);
    applyCounterpartyRules(db);
    expect([kindOf(d1), kindOf(omer)]).toEqual(['paid_back', 'paid_back']);
    expect(kindOf(id('BIT FROM DANA', '2026-11-10'))).toBe('income'); // the income rule did tag the unanswered one
    runEngine(db);
    expect([kindOf(d1), kindOf(omer)]).toEqual(['paid_back', 'paid_back']);
    const h = hub();
    expect(h.paidBack.total).toBe(50000);
    expect(sumTerms(h)).toBe(h.forecast.left);
    expect(monthSummary(db, '2026-11').integrity.ok).toBe(true);
  });

  it('a payer who pays back every month: answered before a stream forms, it never becomes one; inside a confirmed stream, "always" marks only the answered payment', () => {
    const bank = (db.$client.prepare(`select id from account where type = 'checking'`).get() as { id: number }).id;
    ingestBatch(db, {
      source: 'scraper:beinleumi',
      runId: null,
      accountId: bank,
      rows: ['2026-07-02', '2026-08-02', '2026-09-02', '2026-10-02', '2026-11-02'].map((d) => row(d, 150000, 'RENT SHARE NOA')),
    });
    runEngine(db);
    const noa = () => db.$client.prepare(`select id, kind, recurring_stream_id s from "transaction" where description_raw = 'RENT SHARE NOA' order by txn_date`).all() as Array<{ id: number; kind: string; s: number | null }>;
    expect(noa().every((r) => r.s !== null)).toBe(true); // without an answer, it is a (confirmed) income stream
    // inside the confirmed income stream the rule does not claim the other payments (the ask criteria)
    expect(answerPaidBack(db, noa()[4]!.id, 'always').changed).toBe(2); // the rule and the answered payment
    expect(noa().map((r) => r.kind)).toEqual(['income', 'income', 'income', 'income', 'paid_back']);
    expect(noa()[4]!.s).toBeNull();
    expect(answerPaidBack(db, noa()[4]!.id, 'undo').changed).toBe(2);

    // the stream gone (as before it formed): "always" claims every payment, and they never form a stream again
    run(`update "transaction" set recurring_stream_id = null`);
    run(`delete from recurring_stream`);
    expect(answerPaidBack(db, noa()[4]!.id, 'always').changed).toBe(6);
    expect(noa().every((r) => r.kind === 'paid_back' && r.s === null)).toBe(true);
    buildRecurringStreams(db, { today: '2026-11-12' });
    runEngine(db);
    expect(noa().every((r) => r.kind === 'paid_back' && r.s === null)).toBe(true);
    expect((db.$client.prepare('select count(*) n from recurring_stream').get() as { n: number }).n).toBe(0);
    const h = hub();
    expect(h.paidBack.items.filter((i) => i.amount === 150000)).toHaveLength(1);
    expect(sumTerms(h)).toBe(h.forecast.left);
  });
});

describe('paid back to me: review fixes', () => {
  const override = (txnId: number) => (db.$client.prepare('select income_kind_override o from "transaction" where id = ?').get(txnId) as { o: string | null }).o;
  const refusal = (txnId: number, answer: 'always' | 'once' | 'no' | 'no_once' | 'undo') => {
    try {
      answerPaidBack(db, txnId, answer);
    } catch (e) {
      return e instanceof PaidBackError ? `${e.status} ${e.code}` : 'other';
    }
    return 'accepted';
  };
  const bankId = () => (db.$client.prepare(`select id from account where type = 'checking'`).get() as { id: number }).id;

  it('an income rule never un-excludes a transfer or ignored row and never touches refund, savings or paid-back rows', () => {
    ingestBatch(db, {
      source: 'scraper:beinleumi',
      runId: null,
      accountId: bankId(),
      rows: [row('2026-11-03', 30000, 'BIT TRANSFER'), row('2026-11-04', 500000, 'BIT TRANSFER FROM SAVINGS'), row('2026-11-05', 40000, 'BIT TRANSFER REFUNDED'), row('2026-11-06', 7000, 'BIT TRANSFER BACK'), row('2026-11-07', 6000, 'BIT TRANSFER POOL')],
    });
    runEngine(db);
    markTransfer(db, id('BIT TRANSFER FROM SAVINGS'), true);
    setExcluded(db, id('BIT TRANSFER REFUNDED'), true);
    run(`update "transaction" set kind = 'refund', excluded = 1 where description_raw = 'BIT TRANSFER BACK'`);
    run(`update "transaction" set kind = 'savings', excluded = 0 where description_raw = 'BIT TRANSFER POOL'`);
    const before = monthSummary(db, '2026-11').income.sum;
    // "no" on a description several payers share is refused: it would be remembered for all of them
    expect(refusal(id('BIT TRANSFER'), 'no')).toBe('400 generic_payer');
    // an income rule written anyway (e.g. an older "no") leaves every one of them as it is
    run(`insert into counterparty_rule (pattern, kind, account_id, note, created_at) values ('bit transfer', 'income', null, 'test', '2026-11-12T00:00:00Z')`);
    applyCounterpartyRules(db);
    runEngine(db);
    const q = (d: string) => db.$client.prepare('select kind, excluded from "transaction" where description_raw = ?').get(d);
    expect(q('BIT TRANSFER FROM SAVINGS')).toEqual({ kind: 'transfer', excluded: 1 });
    expect(q('BIT TRANSFER REFUNDED')).toEqual({ kind: 'ignore', excluded: 1 });
    expect(q('BIT TRANSFER BACK')).toEqual({ kind: 'refund', excluded: 1 });
    expect(q('BIT TRANSFER POOL')).toEqual({ kind: 'savings', excluded: 0 });
    expect(q('BIT TRANSFER')).toEqual({ kind: 'income', excluded: 0 });
    expect(monthSummary(db, '2026-11').income.sum).toBe(before);
  });

  it('a generic description cannot be remembered, and a paid_back rule only claims what finc would ask about', () => {
    ingestBatch(db, { source: 'scraper:beinleumi', runId: null, accountId: bankId(), rows: [row('2026-11-02', 30000, 'BIT'), row('2026-11-06', 800000, 'BIT CLIENT ALPHA INVOICE')] });
    runEngine(db);
    const cat = (k: string) => (db.$client.prepare('select id from category where key = ?').get(k) as { id: number }).id;
    run(`update "transaction" set category_id = ?, category_source = 'user', kind = 'income' where description_raw = 'BIT CLIENT ALPHA INVOICE'`, cat('income.freelance'));
    run(`update "transaction" set category_id = ?, category_source = 'user', kind = 'income' where description_raw = 'BIT'`, cat('income.other'));
    const bit = id('BIT');
    expect(transactionDetail(db, bit)).toMatchObject({ askPaidBack: true, canRemember: false }); // shorter than 6 and shared
    expect(hub().incomeSplit.extra.items.find((i) => i.id === bit)).toMatchObject({ askPaidBack: true, canRemember: false });
    const before = snapshot();
    expect(refusal(bit, 'always')).toBe('400 generic_payer');
    expect(refusal(bit, 'no')).toBe('400 generic_payer');
    expect(snapshot()).toBe(before);
    expect(answerPaidBack(db, bit, 'once')).toEqual({ changed: 1 });

    // a paid_back rule written anyway: the freelance payment and a regular re-tag stay income
    setIncomeKindOverride(db, id('BIT FROM OMER'), 'regular');
    for (const pattern of ['bit', 'bit client alpha invoice', 'bit from omer', 'bit from dana'])
      run(`insert into counterparty_rule (pattern, kind, account_id, note, created_at) values (?, 'paid_back', null, 'test', '2026-11-12T00:00:00Z')`, pattern);
    applyCounterpartyRules(db);
    expect(kindOf(id('BIT CLIENT ALPHA INVOICE'))).toBe('income'); // freelance
    expect(kindOf(id('BIT FROM OMER'))).toBe('income'); // re-tagged regular
    expect(kindOf(id('BIT FROM DANA', '2026-11-03'))).toBe('paid_back'); // income.other: what finc asks about
    const s = monthSummary(db, '2026-11');
    expect(s.variable.sum).toBeLessThan(0);
    expect(s.integrity.ok).toBe(true);
  });

  it('canRemember turns false once another payer shares the description', () => {
    const d1 = id('BIT FROM DANA', '2026-11-03');
    expect(transactionDetail(db, d1)).toMatchObject({ askPaidBack: true, canRemember: true });
    // a longer description (another person) is not the same payer under the exact match
    ingestBatch(db, { source: 'scraper:beinleumi', runId: null, accountId: bankId(), rows: [row('2026-11-11', 9000, 'BIT FROM DANAH LEVI')] });
    expect(transactionDetail(db, d1)!.canRemember).toBe(true);
    // the very same text from a second merchant is
    ingestBatch(db, { source: 'scraper:beinleumi', runId: null, accountId: bankId(), rows: [row('2026-11-11', 8000, 'BIT FROM DANA')] });
    const other = Number(db.$client.prepare(`insert into merchant (key, name, created_at) values ('other-dana', 'Other Dana', '2026-01-01')`).run().lastInsertRowid);
    run(`update "transaction" set merchant_id = ? where description_raw = 'BIT FROM DANA' and amount_ils = 8000`, other);
    expect(transactionDetail(db, d1)!.canRemember).toBe(false);
    expect(refusal(d1, 'always')).toBe('400 generic_payer');
    expect(listTransactions(db, { month: '2026-11' }).items.find((i) => i.id === d1)!.canRemember).toBe(false);
    // money going out is never offered the remembering answers
    expect(transactionDetail(db, id('SUPERMARKET'))!.canRemember).toBe(false);
  });

  it('no_once: this payment stays income and is not asked about again, without a rule; undo asks again', () => {
    const omer = id('BIT FROM OMER');
    expect(answerPaidBack(db, omer, 'no_once')).toEqual({ changed: 1 });
    expect(rules()).toEqual([]);
    expect(kindOf(omer)).toBe('income');
    expect(getSetting(db, `paidBack.notAsked.${omer}`)).toBe('true');
    expect(transactionDetail(db, omer)!.askPaidBack).toBe(false);
    expect(hub().incomeSplit.extra.items.find((i) => i.id === omer)!.askPaidBack).toBe(false);
    expect(answerPaidBack(db, omer, 'no_once')).toEqual({ changed: 0 });
    expect(answerPaidBack(db, omer, 'undo')).toEqual({ changed: 1 });
    expect(getSetting(db, `paidBack.notAsked.${omer}`)).toBeNull();
    expect(transactionDetail(db, omer)!.askPaidBack).toBe(true);
    // on a paid-back payment: back to income and not asked
    answerPaidBack(db, omer, 'once');
    expect(answerPaidBack(db, omer, 'no_once')).toEqual({ changed: 2 });
    expect(kindOf(omer)).toBe('income');
  });

  it('undo restores the income re-tag a payment had before it was marked (by the owner or by a rule)', () => {
    const d1 = id('BIT FROM DANA', '2026-11-03');
    const d2 = id('BIT FROM DANA', '2026-11-10');
    setIncomeKindOverride(db, d1, 'extra');
    answerPaidBack(db, d1, 'once');
    expect(override(d1)).toBeNull();
    expect(getSetting(db, `paidBack.prevKind.${d1}`)).toBe('extra');
    answerPaidBack(db, d1, 'undo');
    expect(override(d1)).toBe('extra');
    expect(getSetting(db, `paidBack.prevKind.${d1}`)).toBeNull();

    setIncomeKindOverride(db, d2, 'extra');
    answerPaidBack(db, d1, 'always');
    expect([kindOf(d2), override(d2)]).toEqual(['paid_back', null]);
    answerPaidBack(db, d1, 'undo');
    expect([kindOf(d2), override(d2), override(d1)]).toEqual(['income', 'extra', 'extra']);

    // a payment re-tagged regular is not claimed by the rule
    setIncomeKindOverride(db, d2, 'regular');
    expect(answerPaidBack(db, d1, 'always')).toEqual({ changed: 2 });
    expect([kindOf(d1), kindOf(d2)]).toEqual(['paid_back', 'income']);
  });
});

describe('paid back to me: payer specificity on bank texts', () => {
  const refusal = (txnId: number, answer: 'always' | 'no') => {
    try {
      answerPaidBack(db, txnId, answer);
    } catch (e) {
      return e instanceof PaidBackError ? `${e.status} ${e.code}` : 'other';
    }
    return 'accepted';
  };

  beforeEach(() => {
    const bank = (db.$client.prepare(`select id from account where type = 'checking'`).get() as { id: number }).id;
    ingestBatch(db, {
      source: 'scraper:beinleumi',
      runId: null,
      accountId: bank,
      rows: [
        row('2026-11-02', 11000, 'זיכוי מביט'),
        row('2026-11-03', 12000, 'זיכוי מפייבוקס'),
        row('2026-11-04', 13000, 'זיכוי מביט דנה'),
        row('2026-11-05', 14000, 'זיכוי מביט דנה כהן'),
        row('2026-11-06', 15000, 'זיכוי מביט דנהיה'),
      ],
    });
    run(`update "transaction" set kind = 'income' where amount_ils in (11000, 12000, 13000, 14000, 15000)`);
  });

  it('a bare "זיכוי מביט" or "זיכוי מפייבוקס" names no payer: canRemember false, always / no refused with nothing written', () => {
    for (const d of ['זיכוי מביט', 'זיכוי מפייבוקס']) {
      const t = id(d);
      expect(transactionDetail(db, t)).toMatchObject({ askPaidBack: true, canRemember: false });
      const before = snapshot();
      expect(refusal(t, 'always')).toBe('400 generic_payer');
      expect(refusal(t, 'no')).toBe('400 generic_payer');
      expect(snapshot()).toBe(before);
    }
    expect(transactionDetail(db, id('זיכוי מביט דנה'))!.canRemember).toBe(true);
  });

  it('"always" for "זיכוי מביט דנה" claims only that exact text, not "דנה כהן" nor "דנהיה", also on later engine runs', () => {
    const dana = id('זיכוי מביט דנה');
    expect(answerPaidBack(db, dana, 'always')).toEqual({ changed: 2 });
    expect(rules()).toEqual([{ pattern: 'זיכוי מביט דנה', kind: 'paid_back', account_id: null }]);
    expect([kindOf(dana), kindOf(id('זיכוי מביט דנה כהן')), kindOf(id('זיכוי מביט דנהיה')), kindOf(id('זיכוי מביט'))]).toEqual(['paid_back', 'income', 'income', 'income']);
    runEngine(db);
    expect([kindOf(dana), kindOf(id('זיכוי מביט דנה כהן')), kindOf(id('זיכוי מביט דנהיה'))]).toEqual(['paid_back', 'income', 'income']);
    expect(transactionDetail(db, dana)!.paidBackByRule).toBe(true);
    expect(transactionDetail(db, id('זיכוי מביט דנה כהן'))).toMatchObject({ paidBackByRule: false, askPaidBack: true });
    // undo forgets only that payer
    expect(answerPaidBack(db, dana, 'undo')).toEqual({ changed: 2 });
  });

  it('"no" for "זיכוי מביט דנה" stops asking about that exact text only; the rule is marked and matched exactly', () => {
    const dana = id('זיכוי מביט דנה');
    expect(answerPaidBack(db, dana, 'no')).toEqual({ changed: 1 });
    const r = db.$client.prepare(`select pattern, kind, note from counterparty_rule where kind = 'income'`).all();
    expect(r).toEqual([{ pattern: 'זיכוי מביט דנה', kind: 'income', note: 'paid_back:no' }]);
    expect(transactionDetail(db, dana)!.askPaidBack).toBe(false);
    expect(transactionDetail(db, id('זיכוי מביט דנה כהן'))!.askPaidBack).toBe(true);
    expect(transactionDetail(db, id('זיכוי מביט דנהיה'))!.askPaidBack).toBe(true);
  });
});
