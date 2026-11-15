import { describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { recordBalance } from '../db/runs.js';
import { openDb } from '../db/db.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { createManual, deleteManual, netWorthOverview, setManualValue, updateManual } from './networth.js';

const row = (date: string, amount: number, description: string, chargeDate?: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {}, ...(chargeDate ? { chargeDate } : {}) });

function seed() {
  const db = openDb(':memory:');
  const bank = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  const fx = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b-fx', type: 'foreign_currency' }).accountId;
  const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
  recordBalance(db, { accountId: bank, runId: null, balanceMinor: 9_000_000, takenAt: '2026-10-01T21:59:59.000Z', source: 'riseup:history' });
  recordBalance(db, { accountId: bank, runId: null, balanceMinor: 9_358_989, takenAt: '2026-11-09T21:59:59.000Z', source: 'scraper:beinleumi' });
  recordBalance(db, { accountId: fx, runId: null, balanceMinor: 13_235, takenAt: '2026-11-09T10:00:00.000Z', source: 'scraper:beinleumi:summary' });
  // card: one bill already taken (charged 2 Nov), one still ahead (2 Dec), one refund ahead
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: card, rows: [row('2026-10-20', -50_000, 'OLD', '2026-11-02'), row('2026-11-05', -80_500, 'ESCAPE ROOM', '2026-12-02'), row('2026-11-07', -11_235, 'WOLT', '2026-12-02'), row('2026-11-08', 5_000, 'REFUND', '2026-12-02'), row('2026-11-20', -10_000, 'INSTALLMENT 2/6', '2026-12-02')] });
  return { db, bank, fx, card };
}

describe('net worth', () => {
  it('adds balances, subtracts what the cards still owe, and includes manual holdings', () => {
    const { db } = seed();
    const today = '2026-11-09';
    const nw0 = netWorthOverview(db, { today });
    expect(nw0.assets).toBe(9_358_989 + 13_235);
    expect(nw0.liabilities).toBe(80_500 + 11_235 - 5_000 + 10_000); // the slice dated ahead is already booked
    expect(nw0.total).toBe(nw0.assets - nw0.liabilities);
    expect(nw0.lines.find((l) => l.kind === 'credit_card')).toMatchObject({ side: 'liability', value: 96_735, source: 'cards' });

    const pension = createManual(db, { name: 'Pension Fund A', kind: 'pension', value: 18_000_000, date: '2026-11-01' });
    expect(pension).toMatchObject({ side: 'asset', value: 18_000_000, asOf: '2026-11-01' });
    const loan = createManual(db, { name: 'Car loan', kind: 'loan', value: 4_000_000, date: '2026-11-01' });
    expect(loan.side).toBe('liability');
    const nw = netWorthOverview(db, { today });
    expect(nw.assets).toBe(nw0.assets + 18_000_000);
    expect(nw.liabilities).toBe(nw0.liabilities + 4_000_000);

    // history: a point per recorded day, the card debt rebuilt as of that day
    const oct = nw.history.find((h) => h.date === '2026-10-01');
    expect(oct).toBeDefined();
    expect(oct!.assets).toBe(9_000_000); // no FX snapshot yet, no pension yet
    expect(oct!.liabilities).toBe(0); // OLD was bought on 20 Oct, after this point
    const last = nw.history[nw.history.length - 1]!;
    expect(last.date).toBe(today);
    expect(last.total).toBe(nw.total);
    expect(nw.history.map((h) => h.date)).toEqual([...nw.history.map((h) => h.date)].sort());
  });

  it('values are one per day and replace; archive hides, delete removes', () => {
    const { db } = seed();
    const p = createManual(db, { name: 'Pension', kind: 'pension', value: 100, date: '2026-11-01' });
    setManualValue(db, p.id, { value: 150, date: '2026-11-01' });
    const again = setManualValue(db, p.id, { value: 200, date: '2026-11-09' });
    expect(again.history).toEqual([
      { date: '2026-11-01', value: 150 },
      { date: '2026-11-09', value: 200 },
    ]);
    expect(() => setManualValue(db, p.id, { value: -1, date: '2026-11-09' })).toThrow();
    updateManual(db, p.id, { archived: true });
    expect(netWorthOverview(db, { today: '2026-11-09' }).lines.some((l) => l.manualId === p.id)).toBe(false);
    deleteManual(db, p.id);
    expect(netWorthOverview(db, { today: '2026-11-09' }).manual).toHaveLength(0);
  });
});
