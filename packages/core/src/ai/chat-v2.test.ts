/**
 * chat-v2 step 2: an answer-first assistant. spend_summary on a hand-computed fixture, the prompt rules and group
 * names, lookups carried across turns, and the 2026-11-13 car question answered in one turn.
 */
import { describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { openDb } from '../db/db.js';
import { runEngine } from '../engine/run.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { CHAT_TOOLS, chat, chatSystemPrompt, isForeignCurrency } from './chat.js';
import type { AiProvider } from './provider.js';

const TODAY = '2026-11-13';
const row = (date: string, amount: number, description: string, fx?: [string, number]): NormalizedRow => ({
  externalAccountId: 'x',
  date,
  amount,
  description,
  ...(fx ? { originalCurrency: fx[0], originalAmount: fx[1] } : {}),
  status: 'completed',
  type: 'normal',
  identifier: `${description}${date}${amount}`,
  payload: {},
});

/**
 * Car spending in the default window (2025-11..2026-10), in shekels:
 *   fuel 300 (2026-01) + 200 (2026-02) + 100 (2026-10); parking 50 in EUR (2026-03); car insurance 1,200 (2026-04);
 *   maintenance 600 minus a 100 refund (2026-05); 50 paid back to the owner (2026-03, counted against car fuel);
 *   an excluded 400 (2026-06), 999 before the window, 70 in the current month.
 *   all = 2,300 over 7 rows; ILS only = 2,250 over 6 rows; foreign = 50 over 1 row.
 * Outside the car group: Wolt 50 (eating out), Amazon 80 in USD (shopping).
 */
function seed() {
  const db = openDb(':memory:');
  const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max ****1234', source: 'scraper:max', externalId: 'm', type: 'credit_card', last4: '1234' }).accountId;
  const bank = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: 'b', type: 'checking' }).accountId;
  ingestBatch(db, {
    source: 'scraper:max',
    runId: null,
    accountId: card,
    rows: [
      row('2025-10-10', -99900, 'PAZ YELLOW'),
      row('2026-01-10', -30000, 'PAZ YELLOW'),
      row('2026-02-10', -20000, 'PAZ YELLOW'),
      row('2026-10-05', -10000, 'SONOL'),
      row('2026-03-03', -5000, 'EASYPARK', ['EUR', -1300]),
      row('2026-04-01', -120000, 'CARINS LTD'),
      row('2026-05-01', -60000, 'GARAGE PRO'),
      row('2026-05-08', 10000, 'GARAGE PRO'),
      row('2026-06-10', -40000, 'PAZ EXCLUDED'),
      row('2026-11-05', -7000, 'PAZ YELLOW'),
      row('2026-01-15', -5000, 'WOLT'),
      row('2026-02-20', -8000, 'AMAZON', ['USD', -2200]),
    ],
  });
  ingestBatch(db, { source: 'scraper:beinleumi', runId: null, accountId: bank, rows: [row('2026-03-15', 5000, 'העברה מדני כהן 12345678')] });
  runEngine(db);
  const c = db.$client;
  const catId = (key: string) => (c.prepare('select id from category where key = ?').get(key) as { id: number }).id;
  const txn = (d: string, amount?: number) => (c.prepare(`select id from "transaction" where description_raw = ? ${amount !== undefined ? 'and amount_ils = ?' : ''}`).get(...(amount !== undefined ? [d, amount] : [d])) as { id: number }).id;
  const setCat = (d: string, key: string) => c.prepare('update "transaction" set category_id = ?, kind = null, excluded = 0 where description_raw = ?').run(catId(key), d);
  setCat('PAZ YELLOW', 'car.fuel');
  setCat('SONOL', 'car.fuel');
  setCat('EASYPARK', 'car.parking');
  setCat('CARINS LTD', 'car.insurance');
  setCat('GARAGE PRO', 'car.maintenance');
  setCat('WOLT', 'lifestyle.eating_out');
  setCat('AMAZON', 'lifestyle.shopping');
  setCat('PAZ EXCLUDED', 'car.fuel');
  c.prepare('update "transaction" set excluded = 1 where description_raw = ?').run('PAZ EXCLUDED');
  // the refund, linked to its purchase (whatever the engine decided)
  const purchase = txn('GARAGE PRO', -60000);
  const refund = txn('GARAGE PRO', 10000);
  c.prepare('delete from link where from_txn_id in (?, ?) or to_txn_id in (?, ?)').run(purchase, refund, purchase, refund);
  c.prepare(`update "transaction" set kind = 'refund', excluded = 1 where id = ?`).run(refund);
  c.prepare(`insert into link (type, from_txn_id, to_txn_id, amount, confidence, zone, source, explanation_json, created_at) values ('refund', ?, ?, 10000, 1, 'auto', 'auto', '[]', '2026-05-08')`).run(refund, purchase);
  // money paid back to the owner for a shared fuel bill: reduces car spending
  c.prepare(`update "transaction" set kind = 'paid_back', excluded = 0, category_id = ? where id = ?`).run(catId('car.fuel'), txn('העברה מדני כהן 12345678'));
  return db;
}

const spend = (db: ReturnType<typeof seed>, args: Record<string, unknown>) => CHAT_TOOLS.find((t) => t.name === 'spend_summary')!.run(db, args, TODAY) as Record<string, any>;

function scripted(script: Array<string | ((user: string) => string)>): AiProvider & { prompts: string[]; systems: string[] } {
  const prompts: string[] = [];
  const systems: string[] = [];
  let i = 0;
  return {
    name: 'fake',
    model: 'fake-chat',
    prompts,
    systems,
    async complete({ system, user }) {
      systems.push(system);
      prompts.push(user);
      const s = script[Math.min(i++, script.length - 1)]!;
      return typeof s === 'function' ? s(user) : s;
    },
  };
}

describe('spend_summary', () => {
  it('the car group over the last 12 full months, refunds netted, paid back subtracted, excluded ignored', () => {
    const db = seed();
    const r = spend(db, { category: 'car' });
    expect(r).toMatchObject({ from: '2025-11', to: '2026-10', months: 12, total: 2300, monthlyAverage: 191.67, yearlyEstimate: 2300, count: 7, currencyFilter: 'all', category: { kind: 'group', key: 'car' }, paidBackSubtracted: 50 });
    expect(r.currentMonthSoFar).toBeUndefined();
    // a range into the current month: the month so far is reported apart, never in the totals or the average
    expect(spend(db, { category: 'car', to: '2026-11' })).toMatchObject({ months: 12, total: 2300, currentMonthSoFar: { month: '2026-11', total: 70, count: 1 } });
    expect(r.method).toContain('12 full months 2025-11..2026-10');
    // the group by its Hebrew name, its English name and the everyday word give the same answer
    for (const name of ['רכב', 'רכב ותחבורה', 'Car & transport', 'CAR']) expect(spend(db, { category: name }).total).toBe(2300);
    // one category by key / Hebrew name
    expect(spend(db, { category: 'car.maintenance' })).toMatchObject({ total: 500, count: 1, category: { kind: 'category' } });
    expect(spend(db, { category: 'ביטוח רכב' }).total).toBe(1200);
    expect(spend(db, { category: 'boats' }).error).toMatch(/unknown category or group/);
  });

  it('currency: ILS only and foreign only', () => {
    const db = seed();
    expect(spend(db, { category: 'car', currency: 'ils' })).toMatchObject({ total: 2250, monthlyAverage: 187.5, yearlyEstimate: 2250, count: 6, currencyFilter: 'ils' });
    expect(spend(db, { category: 'car', currency: 'foreign' })).toMatchObject({ total: 50, count: 1, currencyFilter: 'foreign' });
    expect(spend(db, { currency: 'foreign' })).toMatchObject({ total: 130, count: 2 });
    expect(spend(db, { category: 'car', currency: 'ils' }).method).toContain('ILS charges only (foreign = charged in a foreign currency)');
  });

  it('groupBy month lists every full month; groupBy merchant and category rank by total', () => {
    const db = seed();
    const m = spend(db, { category: 'car', currency: 'ils', groupBy: 'month' });
    expect(m.groups.map((g: { name: string }) => g.name)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    const byMonth = Object.fromEntries(m.groups.map((g: { name: string; total: number }) => [g.name, g.total]));
    expect(byMonth).toMatchObject({ '2026-01': 300, '2026-02': 200, '2026-03': -50, '2026-04': 1200, '2026-05': 500, '2026-06': 0, '2026-10': 100 });
    const c = spend(db, { category: 'car', groupBy: 'category' });
    expect(c.groups.map((g: { name: string; total: number }) => [g.name, g.total])).toEqual([
      ['Car insurance', 1200],
      ['Fuel', 550],
      ['Maintenance', 500],
      ['Parking & tolls', 50],
    ]);
    expect(c.groups[0]).toMatchObject({ he: 'ביטוח רכב', count: 1, monthlyAverage: 100 });
    const mer = spend(db, { category: 'car', groupBy: 'merchant', limit: 2 });
    expect(mer.groups).toHaveLength(2);
    expect(mer.groups[0]).toMatchObject({ total: 1200, count: 1 });
    expect(mer.otherGroups).toMatchObject({ total: 600 });
    expect(mer.groups[0].total + mer.groups[1].total + mer.otherGroups.total).toBe(2300);
  });

  it('merchant search, explicit ranges, buckets', () => {
    const db = seed();
    expect(spend(db, { merchant: 'wolt' })).toMatchObject({ total: 50, count: 1 });
    expect(spend(db, { merchant: 'x' }).error).toMatch(/at least 2/);
    expect(spend(db, { category: 'car', from: '2026-01', to: '2026-03' })).toMatchObject({ from: '2026-01', to: '2026-03', months: 3, total: 500, monthlyAverage: 166.67 });
    expect(spend(db, { category: 'car', from: '2026-01-15', to: '2026-02-03' })).toMatchObject({ months: 2, total: 500 });
    expect(spend(db, { category: 'car', from: '2025-10', to: '2025-10' })).toMatchObject({ months: 1, total: 999 });
    // only the current month: no full month, the month so far separately
    expect(spend(db, { category: 'car', from: '2026-11', to: '2026-11' })).toMatchObject({ months: 0, total: null, monthlyAverage: null, currentMonthSoFar: { total: 70 } });
    expect(spend(db, { category: 'car', bucket: 'installments' })).toMatchObject({ total: 0, count: 0 });
    expect(spend(db, { category: 'car', bucket: 'variable' }).total).toBe(2300);
  });

  it('sends no raw descriptions, digit runs or people\'s names', async () => {
    const db = seed();
    const model = scripted([
      '{"tool": "spend_summary", "args": {"groupBy": "merchant", "limit": 30}}',
      '{"tool": "spend_summary", "args": {"category": "car", "groupBy": "category"}}',
      '{"tool": "find_transactions", "args": {"currency": "foreign"}}',
      '{"answer": "done"}',
    ]);
    const r = await chat(db, model, [{ role: 'user', content: 'where did it go?' }], { today: TODAY });
    expect(r.steps).toHaveLength(3);
    const all = r.lookups.join('\n');
    for (const leak of ['דני', 'כהן', '12345678', 'העברה מדני', 'PAZ YELLOW', 'GARAGE PRO', '1234', 'descriptionRaw']) expect(all).not.toContain(leak);
    expect(all).toContain('"currencyFilter":"foreign"');
    expect(all).toContain('"countAll":2');
    expect(all).toContain('"totalAll":130');
    expect(all).toContain('"currency":"EUR"');
  });
});

describe('spend_summary: ranges and unknown currencies (review)', () => {
  it('half-given ranges and the 36-month cut', () => {
    const db = seed();
    // only `to`: the 12 months ending there
    expect(spend(db, { category: 'car', to: '2026-06' })).toMatchObject({ from: '2025-07', to: '2026-06', months: 12, total: 3199 });
    // only `from`, before the current month: up to the last full month
    expect(spend(db, { category: 'car', from: '2026-09' })).toMatchObject({ from: '2026-09', to: '2026-10', months: 2, total: 100 });
    // only `from`, the current month: the month so far
    expect(spend(db, { category: 'car', from: '2026-11' })).toMatchObject({ months: 0, total: null, currentMonthSoFar: { month: '2026-11', total: 70 } });
    // a long range up to the current month: the last 36 full months, said so
    const long = spend(db, { category: 'car', from: '2020-01', to: '2026-11' });
    expect(long).toMatchObject({ from: '2023-11', to: '2026-10', months: 36, currentMonthSoFar: { total: 70 } });
    expect(long.method).toContain('range cut to the last 36 full months');
  });

  it('RiseUp history without a currency: counted as ILS, reported apart', () => {
    const db = seed();
    db.$client.prepare(`update "transaction" set source = 'riseup' where description_raw = 'SONOL'`).run();
    const ilsOnly = spend(db, { category: 'car', currency: 'ils' });
    expect(ilsOnly).toMatchObject({ total: 2250, count: 6, currencyUnknown: { count: 1, total: 100, months: '2026-10', counted: 'as ILS' } });
    expect(ilsOnly.method).toContain('1 charge in 2026-10 comes from RiseUp history without a currency and is counted as ILS');
    const foreign = spend(db, { category: 'car', currency: 'foreign' });
    expect(foreign).toMatchObject({ total: 50, count: 1, currencyUnknown: { count: 1, counted: 'not in foreign' } });
    expect(foreign.method).toContain('so they are not in these totals');
    expect(spend(db, { category: 'car' }).currencyUnknown).toBeUndefined();
    const find = CHAT_TOOLS.find((t) => t.name === 'find_transactions')!;
    expect(find.run(db, { currency: 'ils', q: 'fuel' }, TODAY)).toMatchObject({ currencyUnknown: { count: 1, total: 100, months: '2026-10' } });
    for (const c of ['ILS', 'nis', '₪', 'ש"ח', 'ש״ח', '']) expect(isForeignCurrency(c)).toBe(false);
    for (const c of ['USD', 'eur']) expect(isForeignCurrency(c)).toBe(true);
  });
});

describe('find_transactions and spend_by_category (chat v2)', () => {
  it('find_transactions: currency filter, totals over all matches while rows stay capped', () => {
    const db = seed();
    const find = CHAT_TOOLS.find((t) => t.name === 'find_transactions')!;
    const f = find.run(db, { currency: 'foreign', from: '2026-01-01', to: '2026-10-31' }, TODAY) as Record<string, any>;
    expect([f.countAll, f.totalAll, f.rows.length]).toEqual([2, 130, 2]);
    // totalAll is spending only: income, transfers and the like among the matches do not add to it
    const withIncome = find.run(db, { from: '2026-03-01', to: '2026-03-31' }, TODAY) as Record<string, any>;
    expect(withIncome.rows.some((r: { amount: number }) => r.amount > 0)).toBe(true);
    expect(withIncome.totalAll).toBe(0); // 50 parking minus 50 paid back
    const capped = find.run(db, { from: '2025-01-01', to: '2026-11-30', limit: 2 }, TODAY) as Record<string, any>;
    expect(capped.rows).toHaveLength(2);
    expect(capped.countAll).toBeGreaterThan(2);
    expect(find.run(db, { currency: 'ils', q: 'easypark' }, TODAY)).toMatchObject({ countAll: 0 });
  });

  it('spend_by_category takes a group', () => {
    const db = seed();
    const s = CHAT_TOOLS.find((t) => t.name === 'spend_by_category')!.run(db, { from: '2026-01-01', to: '2026-12-31', group: 'רכב' }, TODAY) as { group: string; categories: Array<{ category: { group: string } }> };
    expect(s.group).toBe('car');
    expect(s.categories.length).toBeGreaterThan(0);
    expect(s.categories.every((c) => c.category.group === 'car')).toBe(true);
  });
});

describe('the prompt and lookups across turns', () => {
  it('the system prompt carries the answer-first rules and the group names', () => {
    const sys = chatSystemPrompt('he', TODAY);
    for (const s of ['Answer first', 'use these defaults without asking', 'Never recite this list of defaults', '"this year" = 1 January of this year to today', 'not a 12-month average', 'never ask which year', 'Spending only: never income or savings', 'at most one question', 'never ask the user to confirm what they already said', 'When the user says "both", do both', 'prefer spend_summary', 'the numbers first', 'the language of the user\'s latest question', 'gershayim', 'car = Car & transport / רכב ותחבורה', 'Fuel', 'Car insurance', 'lifestyle = Lifestyle / פנאי וסגנון חיים', 'spend_summary'])
      expect(sys).toContain(s);
  });

  it('the 2026-11-13 car question: one lookup, one answer; the follow-up sees the earlier lookup', async () => {
    const db = seed();
    const q1 = 'תן לי את הממוצע של ההוצאות על הרכב, בלי עסקאות חו"ל — חודשי ושנתי';
    const turn1 = scripted([
      (user) => {
        expect(user).not.toContain('Lookups from earlier');
        return '{"tool": "spend_summary", "args": {"category": "car", "currency": "ils", "groupBy": "month"}, "answer": null}';
      },
      (user) => {
        expect(user).toContain('"monthlyAverage":187.5');
        expect(user).toContain('"yearlyEstimate":2250');
        return '{"tool": null, "args": {}, "answer": "ממוצע חודשי: 188 ₪, שנתי: 2,250 ₪. (12 חודשים מלאים 11/2025–10/2026, בלי חיובים במטבע זר)"}';
      },
    ]);
    const r1 = await chat(db, turn1, [{ role: 'user', content: q1 }], { today: TODAY });
    expect(r1.rounds).toBe(2);
    expect(r1.steps.map((s) => s.tool)).toEqual(['spend_summary']);
    expect(r1.answer).toContain('188');
    expect(r1.lookups).toHaveLength(1);
    expect(r1.lookups[0]).toMatch(/^\{"tool":"spend_summary","args":\{"category":"car","currency":"ils","groupBy":"month"\}\} → \{"from":"2025-11"/);

    const turn2 = scripted([
      (user) => {
        expect(user).toContain('Lookups from earlier in this conversation (exact when made; may predate a sync since):');
        expect(user).toContain(`e1. ${r1.lookups[0]}`);
        expect(user).toContain('No lookups yet in this turn.');
        return '{"tool": "spend_summary", "args": {"category": "car", "currency": "ils", "groupBy": "merchant"}, "answer": null}';
      },
      (user) => {
        expect(user).toContain('e1. ');
        expect(user).toContain('1. {"tool":"spend_summary","args":{"category":"car","currency":"ils","groupBy":"merchant"}}');
        return '{"tool": null, "args": {}, "answer": "לפי בית עסק: ..."}';
      },
    ]);
    const history = [
      { role: 'user' as const, content: q1 },
      { role: 'assistant' as const, content: r1.answer },
      { role: 'user' as const, content: 'ולפי בית עסק?' },
    ];
    const r2 = await chat(db, turn2, history, { today: TODAY, previousLookups: r1.lookups });
    expect(r2.rounds).toBe(2);
    expect(r2.lookups).toHaveLength(1);
    expect(r2.lookups[0]).not.toBe(r1.lookups[0]);
  });
});
