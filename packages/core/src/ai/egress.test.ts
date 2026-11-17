/**
 * MCP design §5.2–5.3: what leaves finc through a tool (the chat's lookups and the MCP server) never carries an
 * account number, a card number or ending, an IBAN, an ID number, a phone or an email, wherever the bank put it.
 * Every value below is made up.
 */
import { describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { openDb } from '../db/db.js';
import { setStreamState } from '../engine/recurring.js';
import { runEngine } from '../engine/run.js';
import { createEvent } from '../hub/events.js';
import { createManual } from '../hub/networth.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { CHAT_TOOLS, accountIdentifiers, privateToolSession, runPrivateTool } from './chat.js';
import { TOOL_SHAPES, project, projectToolResult } from './egress.js';
import { scrubIdentifiers } from './model-names.js';

const TODAY = '2026-11-17';

/** Each canary, as the bank might write it. None may appear in anything a tool returns. */
const CANARY = {
  bankAccount: '12-345-678901',
  bankExternal: 'IL620108000000099999999',
  cardExternal: 'MX-77001234',
  cardLast4: '4580',
  cardNumber: '4580 1234 5678 9012',
  phone: '052-7654321',
  phoneIntl: '+972 52 765 4321',
  email: 'dana.k@example.co.il',
  idNumber: '039337423',
  iban: 'IL62 0108 0000 0009 9999 999',
} as const;

/** The digits that must not survive in any form (separators removed). */
const CANARY_DIGITS = ['345678901', '0108000000099999999', '77001234', '4580123456789012', '0527654321', '972527654321', '039337423', '6201080000000999'];

const row = (date: string, amount: number, description: string, memo?: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, ...(memo ? { memo } : {}), status: 'completed', type: 'normal', identifier: `${description}|${date}|${amount}|${memo ?? ''}`, payload: {} });

function seed() {
  const db = openDb(':memory:');
  const bank = ensureAccount(db, { institutionId: 'beinleumi', institutionKind: 'bank', institutionDisplayName: 'FIBI', source: 'scraper:beinleumi', externalId: CANARY.bankExternal, type: 'checking' }).accountId;
  const card = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: `Max ****${CANARY.cardLast4}`, source: 'scraper:max', externalId: CANARY.cardExternal, type: 'credit_card', last4: CANARY.cardLast4 }).accountId;
  const months = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
  ingestBatch(db, {
    source: 'scraper:beinleumi',
    runId: null,
    accountId: bank,
    rows: [
      ...months.map((m) => row(`${m}-10`, 1_150_000, `משכורת ${CANARY.idNumber}`, `ת.ז. ${CANARY.idNumber}`)),
      ...months.map((m) => row(`${m}-02`, -320_000, `הוראת קבע ${CANARY.bankAccount}`, `לחשבון ${CANARY.bankAccount}`)),
      row('2026-11-03', -50_000, `העברה ${CANARY.iban}`, `IBAN ${CANARY.iban}`),
      row('2026-11-04', -12_300, `ביט ${CANARY.phone}`),
      row('2026-11-05', -9_900, `חיוב כרטיס ${CANARY.cardLast4}`, `כרטיס מסתיים ב ${CANARY.cardLast4}`),
      row('2026-10-05', -7_700, `SERVICE ${CANARY.email}`),
    ],
  });
  ingestBatch(db, {
    source: 'scraper:max',
    runId: null,
    accountId: card,
    rows: [
      ...months.map((m) => row(`${m}-15`, -5_490, 'NETFLIX')),
      row('2026-11-06', -8_800, `PIZZA ${CANARY.phone}`),
      row('2026-11-07', -6_600, `SHOP ${CANARY.email}`),
      row('2026-11-08', -4_400, `CARD ${CANARY.cardNumber}`),
      row('2026-11-09', -3_300, `STORE ${CANARY.phoneIntl}`),
      row('2026-10-09', -2_200, `ACME card ${CANARY.cardLast4}`),
      row('2026-11-10', -1_100, `WOLT`, `ordered for ${CANARY.email}`),
    ],
  });
  runEngine(db);
  const c = db.$client;
  // the owner's own words can hold identifiers too: a stream label, an event name, a manual name
  const nf = (c.prepare(`select rs.id from recurring_stream rs join merchant m on m.id = rs.merchant_id where m.name like 'Netflix%'`).get() as { id: number } | undefined)?.id;
  if (nf === undefined) throw new Error('fixture: a Netflix stream expected');
  setStreamState(db, nf, 'confirmed', `Netflix on card ****${CANARY.cardLast4}`);
  for (const r of c.prepare(`select id from recurring_stream where id <> ?`).all(nf) as Array<{ id: number }>) setStreamState(db, r.id, 'confirmed');
  createEvent(db, { name: `תיקון, מתקין ${CANARY.phone}`, fromDate: '2026-11-01', toDate: '2026-11-09' });
  // a manual holding named by the owner: only the last guard stands between this name and the model (the name
  // cleaning drops long digit runs but not an email or a separated card number)
  createManual(db, { name: `Pension ${CANARY.email} ${CANARY.cardNumber}`, kind: 'pension', value: 100_000_00 });
  return db;
}

/** A spread of arguments per tool, including searches for each canary and pieces of it. */
function argSets(): Array<[string, Record<string, unknown>]> {
  const needles = [...Object.values(CANARY), '052', '4580', '7654321', 'example', 'dana', 'IL62', '678901', 'משכורת', 'העברה', 'ביט'];
  const sets: Array<[string, Record<string, unknown>]> = [];
  for (const t of CHAT_TOOLS) sets.push([t.name, {}]);
  for (const m of ['2026-08', '2026-10', '2026-11']) {
    sets.push(['month_summary', { month: m }], ['spend_by_category', { month: m }], ['compare_periods', { month: m }], ['compare_periods', { month: m, against: 'last_year' }]);
  }
  sets.push(['spend_by_category', { from: '2026-07-01', to: '2026-11-30' }], ['top_merchants', { from: '2026-07-01', to: '2026-11-30', limit: 30 }], ['trends', { months: 6 }]);
  for (const g of ['none', 'month', 'category', 'merchant']) sets.push(['spend_summary', { from: '2026-07', to: '2026-11', groupBy: g, limit: 30 }]);
  sets.push(['find_transactions', { from: '2026-07-01', to: '2026-11-30', limit: 50 }]);
  for (const q of needles) sets.push(['find_transactions', { q, from: '2026-01-01', to: '2026-11-30', limit: 50 }], ['spend_summary', { merchant: q, groupBy: 'merchant' }], ['top_merchants', { category: q }]);
  return sets;
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

describe('egress canaries: no bank identifier leaves through any tool', () => {
  const db = seed();
  const session = privateToolSession(db);
  const results = argSets().map(([tool, args]) => ({ tool, args, ...runPrivateTool(db, tool, args, TODAY, session) }));

  it('every tool ran and returned something', () => {
    for (const t of CHAT_TOOLS) expect(results.some((r) => r.tool === t.name && !(r.value as { error?: string }).error)).toBe(true);
    expect(results.length).toBeGreaterThan(60);
  });

  it('the identifiers are known to the guard', () => {
    const ids = accountIdentifiers(db);
    expect(ids.long).toEqual(expect.arrayContaining([CANARY.bankExternal, CANARY.cardExternal]));
    expect(ids.last4).toContain(CANARY.cardLast4);
  });

  it('no canary, written any way, appears in any result', () => {
    for (const r of results) {
      // the method line repeats the caller's own search words ("names matching ..."); the caller already has them
      const q = typeof r.args.q === 'string' ? r.args.q : typeof r.args.merchant === 'string' ? r.args.merchant : null;
      const text = strings(r.value)
        .map((s) => (q ? s.split(`names matching "${q}"`).join('') : s))
        .join('\n');
      const bare = text.replace(/[\s\-./+]/g, '');
      for (const c of Object.values(CANARY)) expect(text, `${r.tool} ${JSON.stringify(r.args)}`).not.toContain(c);
      for (const d of CANARY_DIGITS) expect(bare, `${r.tool} ${JSON.stringify(r.args)}`).not.toContain(d);
      expect(text).not.toMatch(/@example/);
      // the card ending never shows next to a card word or a mask
      expect(text).not.toMatch(/(\*{2,}|card|כרטיס)\s*4580/i);
    }
  });

  it('every normal result fits its allow-list: nothing dropped', () => {
    for (const r of results) expect(r.dropped, `${r.tool} ${JSON.stringify(r.args)}`).toEqual([]);
  });

  it('a tool is still useful: totals and names that are not identifiers come through', () => {
    const top = results.find((r) => r.tool === 'top_merchants' && r.args.limit === 30)!.value as { merchants: Array<{ merchant: string }> };
    expect(top.merchants.map((m) => m.merchant)).toEqual(expect.arrayContaining(['Netflix']));
    const rec = results.find((r) => r.tool === 'recurring')!.value as Array<{ name: string }>;
    expect(rec.some((s) => s.name.startsWith('Netflix on card'))).toBe(true);
  });
});

describe('the allow-list', () => {
  it('drops keys it does not list and values of the wrong type, and says where', () => {
    const dropped: string[] = [];
    const out = project({ from: '2026-01', accountNumber: '12-345', merchants: [{ merchant: 'Wolt', spent: 12, iban: 'x' }, { merchant: 7, spent: 1, count: 1 }] }, TOOL_SHAPES.top_merchants!, dropped);
    expect(out).toEqual({ from: '2026-01', merchants: [{ merchant: 'Wolt', spent: 12 }, { spent: 1, count: 1 }] });
    expect(dropped).toEqual(['$.accountNumber', '$.merchants[0].iban', '$.merchants[1].merchant']);
  });

  it('an array tool that answers with an error keeps only the error; an unknown tool gets nothing', () => {
    expect(projectToolResult('events', { error: 'boom', detail: 'secret' })).toEqual({ value: { error: 'boom' }, dropped: [] });
    expect(projectToolResult('raw_sql', { rows: [1] }).value).toEqual({ error: 'unknown tool' });
  });

  it('every chat tool has a shape', () => {
    for (const t of CHAT_TOOLS) expect(TOOL_SHAPES[t.name], t.name).toBeDefined();
  });
});

describe('scrubIdentifiers', () => {
  const ids = { long: ['MX-77001234'], last4: ['4580'] };
  it.each([
    ['call 052-7654321', 'call …'],
    ['+972 52 765 4321 ok', '+… ok'],
    ['card 4580 1234 5678 9012', 'card …'],
    ['to dana.k@example.co.il now', 'to … now'],
    ['IBAN IL62 0108 0000 0009 9999 999', 'IBAN …'],
    ['ref 039337423', 'ref …'],
    ['acct MX-77001234', 'acct …'],
    ['Netflix on card ****4580', 'Netflix on card ****…'],
    ['כרטיס 4580', 'כרטיס …'],
  ])('%s', (input, want) => expect(scrubIdentifiers(input, ids)).toBe(want));

  it('dates, ranges, short numbers and plain amounts stay', () => {
    for (const s of ['12 full months 2025-12..2026-11', '2026-11-17', 'average of the 6 full months before', 'Paid 4580 times', 'room 101, floor 3', '2026-08..2026-10; all currencies'])
      expect(scrubIdentifiers(s, ids)).toBe(s);
  });
});
