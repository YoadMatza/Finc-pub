import { describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { openDb } from '../db/db.js';
import { recordBalance } from '../db/runs.js';
import { runEngine } from '../engine/run.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { billCalendar } from './calendar.js';

// wave 5, research_notes/proposals/bill-calendar.md; a made-up household

const row = (date: string, amount: number, description: string, extra: Partial<NormalizedRow> = {}): NormalizedRow => ({
  externalAccountId: 'x',
  date,
  amount,
  description,
  status: 'completed',
  type: 'normal',
  identifier: `${description}|${date}|${amount}|${extra.installmentN ?? ''}`,
  payload: {},
  ...extra,
});

const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];

function seed() {
  const db = openDb(':memory:');
  const bank = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'Bank', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Card', source: 'scraper:max', externalId: 'c', type: 'credit_card', displayName: 'Card 1234' }).accountId;
  const bankRows: NormalizedRow[] = [];
  const cardRows: NormalizedRow[] = [];
  const next10 = (m: string) => {
    const [y, mo] = m.split('-').map(Number) as [number, number];
    return `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}-10`;
  };
  for (const m of [...MONTHS, '2026-11']) {
    bankRows.push(row(`${m}-01`, -500000, 'DEMO LANDLORD'), row(`${m}-10`, 1500000, 'DEMO EMPLOYER SALARY'));
    // the card's charges of the month, billed on the 10th of the next one
    cardRows.push(row(`${m}-03`, -12000, 'DEMO GROCER', { chargeDate: next10(m) }), row(`${m}-05`, -8000, 'DEMO CAFE', { chargeDate: next10(m) }));
    // the phone, on the card on the 25th
    if (m !== '2026-11') cardRows.push(row(`${m}-25`, -9900, 'DEMO MOBILE', { chargeDate: next10(m) }));
  }
  // a four-payment purchase on the card, two slices seen so far (October and November)
  cardRows.push(row('2026-10-15', -30000, 'DEMO ELECTRO', { installmentN: 1, installmentTotal: 4, chargeDate: '2026-11-10' }));
  cardRows.push(row('2026-11-15', -30000, 'DEMO ELECTRO', { installmentN: 2, installmentTotal: 4, chargeDate: '2026-12-10' }));
  // the bank pays each card bill exactly, up to November's
  const bills = new Map<string, number>();
  for (const r of cardRows) bills.set(r.chargeDate!, (bills.get(r.chargeDate!) ?? 0) + r.amount);
  for (const [d, total] of bills) if (d <= '2026-11-10') bankRows.push(row(d, total, 'MAX IT DEMO')); // a settlement pattern of the card company (institutions.ts)
  ingestBatch(db, { source: 'scraper:beinleumi', runId: null, accountId: bank, rows: bankRows });
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: card, rows: cardRows });
  runEngine(db);
  recordBalance(db, { accountId: bank, runId: null, balanceMinor: 400000, source: 'scraper:beinleumi', takenAt: '2026-11-12T05:00:00.000Z' });
  return { db, bank, card };
}

describe('bill calendar', () => {
  it('a past month: every fixed payment and the card bill paid, on its day, nothing to come', () => {
    const { db } = seed();
    const cal = billCalendar(db, '2026-10', { today: '2026-11-16' });
    expect(cal.days).toHaveLength(31);
    const day = (d: string) => cal.days.find((x) => x.date === `2026-10-${d}`)!;
    expect(day('01').items.map((i) => [i.kind, i.status, i.amount])).toEqual([['fixed', 'paid', -500000]]);
    expect(day('10').items.map((i) => i.kind).sort()).toEqual(['card_bill', 'income']);
    expect(day('10').in).toBe(1500000);
    expect(cal.totals.toComeOut).toBe(0);
    expect(cal.balance).toBeUndefined(); // the balance line is for the current month only
  });

  it('the current month: what came, what is still to come, the card bill, instalments, and the balance line', () => {
    const { db } = seed();
    const cal = billCalendar(db, '2026-12', { today: '2026-12-02' });
    expect(cal.isCurrentMonth).toBe(true);
    // rent and salary still expected this month; the card bill on the 10th covers November's charges and the 2nd slice
    const items = cal.days.flatMap((d) => d.items);
    expect(items.filter((i) => i.kind === 'fixed' && i.via === 'bank').map((i) => [i.date, i.status])).toEqual([['2026-12-01', 'upcoming']]);
    expect(items.find((i) => i.kind === 'income')).toMatchObject({ date: '2026-12-10', status: 'upcoming', amount: 1500000 });
    const bill = items.find((i) => i.kind === 'card_bill')!;
    expect(bill).toMatchObject({ date: '2026-12-10', status: 'upcoming', amount: -50000, via: 'bank', count: 3 });
    // the 3rd slice of the plan is projected on the card in December
    expect(items.some((i) => i.kind === 'installment' && i.status === 'upcoming' && i.via === 'card' && i.name.endsWith('3/4'))).toBe(true);
    // the balance line starts from the bank balance and walks the bank-side items still to come
    expect(cal.balance?.start).toBe(400000);
    const on = (d: string) => cal.balance!.points.find((p) => p.date === d)?.balance;
    // the rent due on the 1st and not seen yet still leaves: it counts from today
    expect(on('2026-12-02')).toBe(400000 - 500000);
    expect(on('2026-12-09')).toBe(400000 - 500000);
    expect(on('2026-12-10')).toBe(400000 - 500000 + 1500000 - 50000);
    expect(cal.balance!.lowest).toEqual({ date: '2026-12-02', balance: -100000 });
  });

  it('a card item is not counted twice: its day shows it, but the money leaves in the card bill', () => {
    const { db } = seed();
    const cal = billCalendar(db, '2026-11', { today: '2026-11-30' });
    const day25 = cal.days.find((d) => d.date === '2026-11-15')!;
    expect(day25.items.some((i) => i.via === 'card')).toBe(true);
    expect(day25.out).toBe(0);
  });

  it('a payment that is late shows as missing after the grace days', () => {
    const { db } = seed();
    // December's rent (expected on the 1st) not seen by the 8th
    const late = billCalendar(db, '2026-12', { today: '2026-12-08' }).days.flatMap((d) => d.items).find((i) => i.kind === 'fixed' && i.via === 'bank');
    expect(late?.status).toBe('missing');
  });
});
