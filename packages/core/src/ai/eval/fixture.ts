/**
 * The chat eval's fixture (chat v2 step 3): a fictional household, 14 months of data ending at EVAL_TODAY, built in
 * memory. The eval never opens the live database; every name here is made up (merchants are generic "… DEMO" names,
 * the one person is fictional) and so are the account numbers.
 *
 * What is in it (amounts in ILS, all deterministic):
 *  - bank: salary 14,500 on the 10th (confirmed stream), freelance 2,500 in 2025-12 / 2026-03 / 2026-07 / 2026-10,
 *    rent 5,500 on the 1st (confirmed stream), savings 1,000 on the 5th, one excluded transfer to another account,
 *    a Bit payment of 120 from a fictional person on 2026-09-22 marked as paid back (counted against eating out).
 *  - card: health insurance 180 on the 20th (confirmed stream); the car group: fuel on the 20th (EVAL_FUEL_ILS below),
 *    parking 50 on the 6th, maintenance 900 (2026-02) and 1,250 (2026-08), car insurance 3,600 once (2026-03);
 *    foreign charges: fuel 280 EUR-charged and parking 60 EUR-charged and a hotel 1,900 (2026-06), parking 45 and
 *    an online store 260 in USD (2025-12), the online store 350 (2026-02) and 420 (2026-09) in USD; groceries on the
 *    3rd and 17th, eating out on the 14th and 26th; an electronics purchase of 1,200 with a 300 refund (2026-07);
 *    an instalment purchase of 10 × 480 from 2026-06-08 (6 slices seen).
 *  Nothing foreign and no fuel in the current month (2026-11, up to the 13th), so "this year" and "the last 3 months"
 *  have one reading.
 */
import { ensureAccount } from '../../db/accounts.js';
import { type Db, openDb } from '../../db/db.js';
import { setStreamState } from '../../engine/recurring.js';
import { runEngine } from '../../engine/run.js';
import { ingestBatch } from '../../ingest/ingest.js';
import type { NormalizedRow } from '../../ingest/types.js';

export const EVAL_TODAY = '2026-11-13';
/** The fixture's months, oldest first: 2025-10 … 2026-11 (14). */
export const EVAL_MONTHS: readonly string[] = Array.from({ length: 14 }, (_, i) => {
  const d = new Date(Date.UTC(2025, 9 + i, 1));
  return d.toISOString().slice(0, 7);
});

/** The fictional person behind the Bit payment and the fictional account number of the excluded transfer. */
export const EVAL_PERSON = { he: 'יעל דוגמאי', first: 'יעל', last: 'דוגמאי', en: 'Yael Dugmai' } as const;
export const EVAL_ACCOUNT_NUMBER = '87-654-321098';

/** Fuel per month, 2025-10 … 2026-10 (none in 2026-11 so far). */
export const EVAL_FUEL_ILS: readonly number[] = [310, 280, 300, 320, 290, 270, 330, 300, 310, 280, 340, 300, 290];

export const EVAL_DESC = {
  salary: 'משכורת חברה דוגמה בעמ',
  freelance: 'FREELANCE CLIENT DEMO',
  rent: 'ניהול נכסים דוגמה בעמ',
  savings: 'הפקדה לחיסכון דוגמה',
  transfer: `העברה לחשבון ${EVAL_ACCOUNT_NUMBER}`,
  bit: `BIT העברה מ${EVAL_PERSON.he}`,
  insurance: 'DEMO HEALTH INSURANCE',
  fuel: 'FUEL STATION DEMO',
  fuelAbroad: 'TANKSTELLE DEMO',
  parking: 'PARKING DEMO',
  parkingAbroad: 'PARKPLATZ DEMO',
  parkingUs: 'US PARKING DEMO',
  garage: 'GARAGE DEMO',
  carInsurance: 'CAR INSURANCE DEMO',
  hotel: 'HOTEL DEMO EUROPE',
  online: 'ONLINE STORE DEMO',
  grocery: 'SUPER DEMO',
  cafe: 'CAFE DEMO',
  pizza: 'PIZZA DEMO',
  electro: 'ELECTRO DEMO',
  furniture: 'FURNITURE DEMO',
} as const;

const row = (date: string, ils: number, description: string, extra: Partial<NormalizedRow> = {}): NormalizedRow => ({
  externalAccountId: 'x',
  date,
  amount: Math.round(ils * 100),
  description,
  status: 'completed',
  type: 'normal',
  identifier: `${description}|${date}|${ils}`,
  payload: {},
  ...extra,
});
const fx = (currency: string, original: number): Partial<NormalizedRow> => ({ originalCurrency: currency, originalAmount: Math.round(original * 100) });
const day = (month: string, d: number) => `${month}-${String(d).padStart(2, '0')}`;

/** Groceries and eating out vary by month index i (0 = 2025-10) so "by month" answers differ month to month. */
export const evalGroceryAmounts = (i: number): [number, number] => [380 + ((i * 37) % 90), 290 + ((i * 53) % 110)];
export const evalEatingOutAmounts = (i: number): [number, number] => [150 + 10 * (i % 5), 120 + 15 * (i % 3)];

function rows(): { bank: NormalizedRow[]; card: NormalizedRow[] } {
  const bank: NormalizedRow[] = [];
  const card: NormalizedRow[] = [];
  EVAL_MONTHS.forEach((m, i) => {
    bank.push(row(day(m, 1), -5500, EVAL_DESC.rent));
    bank.push(row(day(m, 5), -1000, EVAL_DESC.savings));
    bank.push(row(day(m, 10), 14500, EVAL_DESC.salary));
    card.push(row(day(m, 20), -180, EVAL_DESC.insurance));
    card.push(row(day(m, 6), -50, EVAL_DESC.parking));
    const [g1, g2] = evalGroceryAmounts(i);
    card.push(row(day(m, 3), -g1, EVAL_DESC.grocery), row(day(m, 17), -g2, EVAL_DESC.grocery));
    const [e1, e2] = evalEatingOutAmounts(i);
    card.push(row(day(m, 14), -e1, EVAL_DESC.cafe), row(day(m, 26), -e2, EVAL_DESC.pizza));
    const fuel = EVAL_FUEL_ILS[i];
    if (fuel !== undefined) card.push(row(day(m, 20), -fuel, EVAL_DESC.fuel));
  });
  for (const m of ['2025-12', '2026-03', '2026-07', '2026-10']) bank.push(row(day(m, 15), 2500, EVAL_DESC.freelance));
  bank.push(row('2026-04-18', -3000, EVAL_DESC.transfer));
  bank.push(row('2026-09-22', 120, EVAL_DESC.bit));
  card.push(
    row('2026-02-15', -900, EVAL_DESC.garage),
    row('2026-08-15', -1250, EVAL_DESC.garage),
    row('2026-03-01', -3600, EVAL_DESC.carInsurance),
    // abroad (charged in a foreign currency)
    row('2025-12-05', -45, EVAL_DESC.parkingUs, fx('USD', -12)),
    row('2025-12-08', -260, EVAL_DESC.online, fx('USD', -70)),
    row('2026-02-11', -350, EVAL_DESC.online, fx('USD', -95)),
    row('2026-06-12', -280, EVAL_DESC.fuelAbroad, fx('EUR', -70)),
    row('2026-06-13', -60, EVAL_DESC.parkingAbroad, fx('EUR', -15)),
    row('2026-06-14', -1900, EVAL_DESC.hotel, fx('EUR', -480)),
    row('2026-09-09', -420, EVAL_DESC.online, fx('USD', -112)),
    // a purchase and its partial refund
    row('2026-07-12', -1200, EVAL_DESC.electro),
    row('2026-07-20', 300, EVAL_DESC.electro),
  );
  // 10 instalments of 480 from 2026-06-08; slices 1..6 seen by 2026-11-13
  for (let n = 1; n <= 6; n++) card.push(row(day(EVAL_MONTHS[7 + n]!, 8), -480, EVAL_DESC.furniture, { type: 'installments', installmentN: n, installmentTotal: 10, originalAmount: -480000, identifier: `ARNDEMO77_${n}` }));
  const upToToday = (r: NormalizedRow) => r.date <= EVAL_TODAY;
  return { bank: bank.filter(upToToday), card: card.filter(upToToday) };
}

/** Category key per description (set after the engine, so the fixture does not depend on its guesses). */
const CATEGORY: Record<string, string> = {
  [EVAL_DESC.salary]: 'income.salary',
  [EVAL_DESC.freelance]: 'income.freelance',
  [EVAL_DESC.rent]: 'fixed.housing',
  [EVAL_DESC.savings]: 'savings.investments',
  [EVAL_DESC.transfer]: 'transfers',
  [EVAL_DESC.bit]: 'lifestyle.eating_out',
  [EVAL_DESC.insurance]: 'fixed.insurance',
  [EVAL_DESC.fuel]: 'car.fuel',
  [EVAL_DESC.fuelAbroad]: 'car.fuel',
  [EVAL_DESC.parking]: 'car.parking',
  [EVAL_DESC.parkingAbroad]: 'car.parking',
  [EVAL_DESC.parkingUs]: 'car.parking',
  [EVAL_DESC.garage]: 'car.maintenance',
  [EVAL_DESC.carInsurance]: 'car.insurance',
  [EVAL_DESC.hotel]: 'lifestyle.travel',
  [EVAL_DESC.online]: 'lifestyle.shopping',
  [EVAL_DESC.grocery]: 'daily.supermarket',
  [EVAL_DESC.cafe]: 'lifestyle.eating_out',
  [EVAL_DESC.pizza]: 'lifestyle.eating_out',
  [EVAL_DESC.electro]: 'lifestyle.shopping',
  [EVAL_DESC.furniture]: 'daily.home',
};

/** A fresh in-memory fixture database. Deterministic: the same data and the same totals every time. */
export function buildEvalFixture(): Db {
  const db = openDb(':memory:');
  const bank = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'Demo bank', source: 'scraper:beinleumi', externalId: 'eval-bank', type: 'checking' }).accountId;
  const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Demo card', source: 'scraper:max', externalId: 'eval-card', type: 'credit_card', last4: '0000' }).accountId;
  const r = rows();
  const now = new Date(`${EVAL_TODAY}T12:00:00Z`);
  ingestBatch(db, { source: 'scraper:beinleumi', runId: null, accountId: bank, rows: r.bank, now });
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: card, rows: r.card, now });
  runEngine(db);

  const c = db.$client;
  const catId = (key: string) => {
    const x = c.prepare('select id from category where key = ?').get(key) as { id: number } | undefined;
    if (!x) throw new Error(`eval fixture: no category ${key}`);
    return x.id;
  };
  const setCat = c.prepare('update "transaction" set category_id = ?, kind = ?, excluded = ? where description_raw = ?');
  for (const [desc, key] of Object.entries(CATEGORY)) {
    const kind = key.startsWith('income.') ? 'income' : key.startsWith('savings.') ? 'savings' : key === 'transfers' ? 'transfer' : desc === EVAL_DESC.bit ? 'paid_back' : null;
    setCat.run(catId(key), kind, key === 'transfers' ? 1 : 0, desc);
  }
  // the refund, linked to its purchase (whatever the engine decided)
  const txn = (d: string, minor: number) => (c.prepare('select id from "transaction" where description_raw = ? and amount_ils = ?').get(d, minor) as { id: number }).id;
  const purchase = txn(EVAL_DESC.electro, -120000);
  const refund = txn(EVAL_DESC.electro, 30000);
  c.prepare('delete from link where from_txn_id in (?, ?) or to_txn_id in (?, ?)').run(purchase, refund, purchase, refund);
  c.prepare(`update "transaction" set kind = 'refund', excluded = 1 where id = ?`).run(refund);
  c.prepare(`insert into link (type, from_txn_id, to_txn_id, amount, confidence, zone, source, explanation_json, created_at) values ('refund', ?, ?, 30000, 1, 'auto', 'auto', '[]', '2026-07-20')`).run(refund, purchase);

  // confirmed fixed streams: rent, salary, health insurance
  const streamOf = (desc: string) => {
    const s = c.prepare('select recurring_stream_id id from "transaction" where description_raw = ? and recurring_stream_id is not null limit 1').get(desc) as { id: number } | undefined;
    if (!s) throw new Error(`eval fixture: no recurring stream for ${desc}`);
    return s.id;
  };
  for (const [desc, key] of [
    [EVAL_DESC.rent, 'fixed.housing'],
    [EVAL_DESC.salary, 'income.salary'],
    [EVAL_DESC.insurance, 'fixed.insurance'],
  ] as const) {
    const id = streamOf(desc);
    c.prepare('update recurring_stream set category_id = ? where id = ?').run(catId(key), id);
    setStreamState(db, id, 'confirmed');
  }
  // the instalment purchase must be a plan, or "instalments" questions have no answer
  const plan = c.prepare('select count(*) n from "transaction" where description_raw = ? and installment_plan_id is not null').get(EVAL_DESC.furniture) as { n: number };
  if (plan.n !== 6) throw new Error(`eval fixture: expected 6 instalment slices on a plan, got ${plan.n}`);
  return db;
}
