import { describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { openDb } from '../db/db.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { listTransactions, transactionDetail } from './transactions.js';

const NOW = new Date('2026-11-12T06:00:00Z');
const row = (date: string, amount: number, description: string): NormalizedRow => ({
  externalAccountId: 'x',
  date,
  amount,
  description,
  status: 'completed',
  type: 'normal',
  identifier: `${description}|${date}|${amount}`,
  payload: {},
});

function setup() {
  const db = openDb(':memory:');
  const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card', displayName: 'Max 4321' }).accountId;
  const bank = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'Bank 9876', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: card, rows: [row('2026-11-07', -2990, 'GOOGLE FICTIFLIX'), row('2026-10-03', -40000, 'SHOP ALPHA'), row('2026-10-05', -60000, 'SHOP BETA'), row('2026-10-06', -5000, 'SHOP GAMMA'), row('2026-10-08', -12000, 'SHOP DELTA'), row('2026-10-09', -8000, 'SHOP EPSILON')], now: NOW });
  ingestBatch(db, { source: 'scraper:beinleumi', runId: null, accountId: bank, rows: [row('2026-11-10', -2990, 'מקס איט פיננסים'), row('2026-11-02', -105000, 'מקס איט פיננסים'), row('2026-11-03', -12345, 'מקס איט פיננסים'), row('2026-11-04', -8000, 'מקס איט פיננסים')], now: NOW });
  const c = db.$client;
  const id = (desc: string, amount: number) => (c.prepare('select id from "transaction" where description_raw = ? and amount_ils = ?').get(desc, amount) as { id: number }).id;
  const immediate = id('מקס איט פיננסים', -2990);
  const monthly = id('מקס איט פיננסים', -105000);
  const unlinked = id('מקס איט פיננסים', -12345);
  const unlinked2 = id('מקס איט פיננסים', -8000);
  c.prepare(`update "transaction" set kind = 'settlement', excluded = 1 where id in (?, ?, ?, ?)`).run(immediate, monthly, unlinked, unlinked2);
  const link = c.prepare(`insert into link (type, from_txn_id, to_txn_id, amount, confidence, zone, source, decision, created_at, explanation_json) values ('card_settlement', ?, ?, ?, 1, 'auto', 'auto', ?, ?, '{}')`);
  link.run(immediate, id('GOOGLE FICTIFLIX', -2990), -2990, null, NOW.toISOString());
  link.run(monthly, id('SHOP ALPHA', -40000), -40000, null, NOW.toISOString());
  link.run(monthly, id('SHOP BETA', -60000), -60000, null, NOW.toISOString());
  link.run(monthly, id('SHOP GAMMA', -5000), -5000, 'rejected', NOW.toISOString()); // a rejected link does not count
  const suggest = c.prepare(`insert into link (type, from_txn_id, to_txn_id, amount, confidence, zone, source, decision, created_at, explanation_json) values ('card_settlement', ?, ?, ?, 0.7, 'suggest', 'auto', ?, ?, '{}')`);
  suggest.run(unlinked, id('SHOP DELTA', -12000), -12000, null, NOW.toISOString()); // an unreviewed suggestion is not shown as fact
  suggest.run(unlinked2, id('SHOP EPSILON', -8000), -8000, 'confirmed', NOW.toISOString()); // a confirmed suggestion is
  return { db, immediate, monthly, unlinked, unlinked2, id };
}

describe('card settlements in the transaction list', () => {
  it('an immediate charge: the bank row names the one card row it paid, the card row names the payment', () => {
    const { db, immediate, id } = setup();
    const items = listTransactions(db, { includeExcluded: true, limit: 100 }).items;
    const bank = items.find((x) => x.id === immediate)!;
    expect(bank.settles).toEqual({ count: 1, account: 'Max', first: { txnId: id('GOOGLE FICTIFLIX', -2990), description: 'GOOGLE FICTIFLIX', date: '2026-11-07', amount: -2990 } });
    expect(bank.settledBy).toBeUndefined();
    const card = items.find((x) => x.id === id('GOOGLE FICTIFLIX', -2990))!;
    expect(card.settledBy).toEqual({ txnId: immediate, date: '2026-11-10', account: 'Bank', count: 1 }); // no digits from the name
    expect(card.settles).toBeUndefined();
  });

  it('a monthly bill: a count of the card rows and no single row; every paid card row points back', () => {
    const { db, monthly, id } = setup();
    const items = listTransactions(db, { includeExcluded: true, limit: 100 }).items;
    expect(items.find((x) => x.id === monthly)!.settles).toEqual({ count: 2, account: 'Max' });
    expect(items.find((x) => x.id === id('SHOP ALPHA', -40000))!.settledBy).toMatchObject({ txnId: monthly, date: '2026-11-02', count: 2 }); // the rejected third link is not counted
    expect(items.find((x) => x.id === id('SHOP GAMMA', -5000))!.settledBy).toBeUndefined();
  });

  it('an unreviewed suggestion is not shown; a confirmed one is', () => {
    const { db, unlinked, unlinked2, id } = setup();
    const items = listTransactions(db, { includeExcluded: true, limit: 100 }).items;
    expect(items.find((x) => x.id === unlinked)!.settles).toBeUndefined();
    expect(items.find((x) => x.id === id('SHOP DELTA', -12000))!.settledBy).toBeUndefined();
    expect(items.find((x) => x.id === unlinked2)!.settles).toMatchObject({ count: 1, first: { description: 'SHOP EPSILON' } });
    expect(items.find((x) => x.id === id('SHOP EPSILON', -8000))!.settledBy).toMatchObject({ txnId: unlinked2, count: 1 });
  });

  it('a settlement without links has neither field; the detail carries the same fields', () => {
    const { db, unlinked, immediate } = setup();
    const items = listTransactions(db, { includeExcluded: true, limit: 100 }).items;
    const x = items.find((i) => i.id === unlinked)!;
    expect(x.settles).toBeUndefined();
    expect(x.settledBy).toBeUndefined();
    expect(transactionDetail(db, immediate)!.settles?.count).toBe(1);
    // the account display name (which may carry card digits) is never used
    expect(JSON.stringify(items.map((i) => [i.settles, i.settledBy]))).not.toMatch(/4321|9876/);
  });

  it('the links of rows outside the page still resolve (one query per page)', () => {
    const { db, monthly } = setup();
    const page = listTransactions(db, { includeExcluded: true, bucket: 'settlements', limit: 100 }).items;
    expect(page.find((x) => x.id === monthly)!.settles?.count).toBe(2);
  });

  it('a card row counts every row its debit paid, even when the debit is not on the page', () => {
    const { db, monthly, immediate, id } = setup();
    const cardOnly = listTransactions(db, { q: 'SHOP', limit: 100 }).items;
    expect(cardOnly.some((x) => x.id === monthly)).toBe(false);
    expect(cardOnly.find((x) => x.id === id('SHOP BETA', -60000))!.settledBy).toMatchObject({ txnId: monthly, count: 2 });
    expect(listTransactions(db, { q: 'FICTIFLIX', limit: 100 }).items[0]!.settledBy).toMatchObject({ txnId: immediate, count: 1 });
  });
});
