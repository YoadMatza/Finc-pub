import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { type Db, nowIso, openDb } from '../db/db.js';
import { counterpartyRule, transactions } from '../db/schema.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { applyCounterpartyRules, classifyRemaining, likeContains, seedDefaultRules } from './rules.js';

let db: Db;
let bank: number;
let card: number;
const row = (over: Partial<NormalizedRow> & Pick<NormalizedRow, 'date' | 'amount' | 'description'>): NormalizedRow => ({ externalAccountId: 'x', status: 'completed', type: 'normal', payload: {}, ...over });
const byDesc = () => Object.fromEntries(db.select().from(transactions).all().map((x) => [`${x.descriptionRaw}|${x.amountIls}|${x.accountId}`, [x.kind, x.excluded]]));

beforeEach(() => {
  db = openDb(':memory:');
  bank = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
});

describe('counterparty rule scope (P1-02)', () => {
  beforeEach(() => {
    ingestBatch(db, {
      source: 'scraper:beinleumi',
      runId: null,
      accountId: bank,
      rows: [
        row({ date: '2026-11-01', amount: -170000, description: 'העברה מהחשבון', identifier: 'debit' }),
        row({ date: '2026-11-02', amount: 50000, description: 'העברה מהחשבון', identifier: 'credit' }),
      ],
    });
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: card, rows: [row({ date: '2026-11-03', amount: -9000, description: 'העברה מהחשבון', identifier: 'card' })] });
    seedDefaultRules(db);
  });

  it('tags a bank debit as an excluded transfer', () => {
    applyCounterpartyRules(db);
    expect(byDesc()[`העברה מהחשבון|-170000|${bank}`]).toEqual(['transfer', true]);
  });

  it('does not exclude a credit carrying the transfer text', () => {
    applyCounterpartyRules(db);
    classifyRemaining(db);
    expect(byDesc()[`העברה מהחשבון|50000|${bank}`]).toEqual(['income', false]);
  });

  it('does not touch a card row carrying the transfer text', () => {
    applyCounterpartyRules(db);
    expect(byDesc()[`העברה מהחשבון|-9000|${card}`]).toEqual([null, false]);
  });

  it("never undoes a transfer mark on an out-of-scope row (the user's own decision survives an engine run)", () => {
    // e.g. the user marked an incoming transfer as an internal transfer from the transaction sheet
    db.update(transactions).set({ kind: 'transfer', excluded: true }).run();
    expect(applyCounterpartyRules(db)).toMatchObject({ transactionsTagged: 0 });
    classifyRemaining(db);
    const t = byDesc();
    expect(t[`העברה מהחשבון|-170000|${bank}`]).toEqual(['transfer', true]);
    expect(t[`העברה מהחשבון|50000|${bank}`]).toEqual(['transfer', true]);
    expect(t[`העברה מהחשבון|-9000|${card}`]).toEqual(['transfer', true]);
  });
});

describe('counterparty rule patterns are literal', () => {
  it('escapes LIKE wildcards', () => {
    expect(likeContains('A_b%c!')).toBe('%a!_b!%c!!%');
  });

  it('a pattern with % or _ does not act as a wildcard', () => {
    ingestBatch(db, {
      source: 'scraper:beinleumi',
      runId: null,
      accountId: bank,
      rows: [
        row({ date: '2026-11-01', amount: -1000, description: 'abc shop', identifier: '1' }),
        row({ date: '2026-11-02', amount: -2000, description: 'a_c shop', identifier: '2' }),
        row({ date: '2026-11-03', amount: -3000, description: 'anything at all', identifier: '3' }),
      ],
    });
    db.insert(counterpartyRule).values({ pattern: 'a_c', kind: 'transfer', createdAt: nowIso() }).run();
    db.insert(counterpartyRule).values({ pattern: '%', kind: 'ignore', createdAt: nowIso() }).run();
    expect(applyCounterpartyRules(db)).toMatchObject({ rules: 2, transactionsTagged: 1 });
    const t = byDesc();
    expect(t[`a_c shop|-2000|${bank}`]).toEqual(['transfer', true]);
    expect(t[`abc shop|-1000|${bank}`]).toEqual([null, false]);
    expect(t[`anything at all|-3000|${bank}`]).toEqual([null, false]);
  });
});
