import { describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { openDb } from '../db/db.js';
import { runEngine } from '../engine/run.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { setSetting } from '../ai/settings.js';
import { currentMonth } from '../riseup/client.js';
import { MONEY_SINCE_SETTING, alertConfig, alertText, collectAlerts, dispatchAlerts, inQuietHours, setAlertConfig, weeklySummaryText } from './index.js';

const row = (date: string, amount: number, description: string): NormalizedRow => ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} });

function seed() {
  const db = openDb(':memory:');
  const acc = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
  const month = new Date().toISOString().slice(0, 7);
  ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: [row(`${month}-02`, -5000, 'WOLT'), row(`${month}-03`, -250000, 'BIG SHOP'), row(`${month}-04`, -12000, 'SUPER')] });
  runEngine(db);
  return db;
}

describe('alerts', () => {
  it('has sensible defaults and persists changes', () => {
    const db = seed();
    const cfg = alertConfig(db);
    expect(cfg.matrix.missing_fixed.telegram).toBe(true);
    expect(cfg.matrix.uncategorised.telegram).toBe(false);
    expect(cfg.quiet).toEqual({ from: '23:00', to: '07:00' });
    expect(cfg.weekly).toEqual({ day: 0, hour: 8 });
    const next = setAlertConfig(db, { matrix: { uncategorised: { telegram: true } }, quiet: 'off', weekly: { hour: 9 }, telegramChatId: '123' });
    expect(next.matrix.uncategorised.telegram).toBe(true);
    expect(next.quiet).toBeNull();
    expect(next.weekly).toEqual({ day: 0, hour: 9 });
    expect(next.telegramChatId).toBe('123');
  });

  it('knows quiet hours across midnight', () => {
    const q = { from: '23:00', to: '07:00' };
    expect(inQuietHours(q, new Date('2026-11-09T21:30:00Z'), 'Asia/Jerusalem')).toBe(true); // 23:30 local
    expect(inQuietHours(q, new Date('2026-11-09T10:00:00Z'), 'Asia/Jerusalem')).toBe(false); // 12:00 local
    expect(inQuietHours(null, new Date(), 'Asia/Jerusalem')).toBe(false);
  });

  it('turns the hub attention items into sentences and never sends a key twice', async () => {
    const db = seed();
    // big_purchase now comes from the per-transaction money alerts, which start at alerts.moneySince
    setSetting(db, MONEY_SINCE_SETTING, '2000-01-01T00:00:00.000Z');
    const alerts = collectAlerts(db, { lang: 'en' });
    const big = alerts.find((a) => a.type === 'big_purchase');
    expect(big?.key.startsWith('out:')).toBe(true);
    expect(big?.text).toContain('Big Shop');
    expect(big?.text).toContain('₪2,500');
    const he = alertText({ key: 'x', kind: 'missing_fixed', severity: 'warn', name: 'Rent <co>', amount: -520000, date: '2026-11-03' }, 'he') ?? '';
    expect(he).toContain('Rent &lt;co&gt;');
    // Latin names and amounts are direction-isolated inside Hebrew text; Hebrew puts the sign after the number
    expect(he).toContain('⁨Rent &lt;co&gt;⁩');
    expect(he).toContain('⁦5,200 ₪⁩');
    // a bank's doubled merchant name collapses
    expect(alertText({ key: 'y', kind: 'big_purchase', severity: 'info', name: 'Streamly Streamly', amount: -30000 }, 'en')).toContain('⁨Streamly⁩');
    // no Telegram configured → everything enabled is skipped for that reason, nothing is logged as sent
    const r1 = await dispatchAlerts(db, { telegramToken: null, now: new Date('2026-11-09T10:00:00Z') });
    expect(r1.sent).toHaveLength(0);
    expect(r1.skipped.some((s) => s.type === 'big_purchase' && s.reason === 'telegram not configured')).toBe(true);
    // quiet hours hold everything except a code request
    const r2 = await dispatchAlerts(db, { telegramToken: 'x', now: new Date('2026-11-09T22:00:00Z') });
    expect(r2.skipped.every((s) => s.reason === 'quiet' || s.reason === 'off')).toBe(true);
  });

  it('writes a weekly summary with last week, the month and what is due', () => {
    const db = seed();
    // pin "today" to the Sunday among days 5–11 of this month, so last week always holds a seed row (days 2–4)
    const month = new Date().toISOString().slice(0, 7);
    const day = [5, 6, 7, 8, 9, 10, 11].find((n) => new Date(`${month}-${String(n).padStart(2, '0')}T00:00:00Z`).getUTCDay() === 0)!;
    const today = `${month}-${String(day).padStart(2, '0')}`;
    const w = weeklySummaryText(db, { lang: 'en', today });
    expect(w.key.startsWith('weekly:')).toBe(true);
    expect(w.text).toContain('Weekly summary');
    expect(w.text).toContain('variable spending');
    // categories by their display name, one per line, never the raw key; unknown ones say so
    expect(w.text).not.toMatch(/\b[a-z]+\.[a-z_]+\b/);
    expect(w.text).toContain('\n• ');
    const h = weeklySummaryText(db, { lang: 'he' });
    expect(h.text).toContain('סיכום שבועי');
    expect(h.text).not.toContain(' ?');
    expect(h.text).toMatch(/⁦[\d,]+ ₪⁩/);
  });

  it('the spending limit line: only when a limit is set, descriptive', () => {
    const db = seed();
    expect(weeklySummaryText(db, { lang: 'en' }).text).not.toContain('Spending limit');
    setSetting(db, `spend.limit.${currentMonth()}`, '1000000');
    const w = weeklySummaryText(db, { lang: 'en' }).text;
    // variable spent 267,000 of 1,000,000 → 26.7%
    expect(w).toMatch(/Spending limit ⁦₪10,000⁩: spent ⁦₪2,670⁩ \(26\.7%\), (on pace|⁦₪[\d,]+⁩ (ahead of|under) pace), ⁦₪7,330⁩ left within it/);
    expect(weeklySummaryText(db, { lang: 'he' }).text).toMatch(/מסגרת הוצאות ⁦10,000 ₪⁩: יצאו ⁦2,670 ₪⁩ \(26\.7%\), .*נשארו ⁦7,330 ₪⁩ במסגרת/);
  });

  it('the offsite line: shown once there is a copy, a warning when older than OFFSITE_STALE_DAYS', () => {
    const db = seed();
    expect(weeklySummaryText(db, { lang: 'en', today: '2026-11-10' }).text).not.toMatch(/offsite/i);
    setSetting(db, 'offsite.lastOkAt', '2026-11-09T01:45:00.000Z');
    expect(weeklySummaryText(db, { lang: 'en', today: '2026-11-10' }).text).toContain('Offsite copy: 2026-11-09');
    expect(weeklySummaryText(db, { lang: 'he', today: '2026-11-10' }).text).toContain('✓ עותק בגיבוי חיצוני: 09.11');
    setSetting(db, 'offsite.lastOkAt', '2026-11-06T01:45:00.000Z');
    expect(weeklySummaryText(db, { lang: 'en', today: '2026-11-10' }).text).toContain('⚠️ No offsite copy since 2026-11-06');
    expect(weeklySummaryText(db, { lang: 'he', today: '2026-11-10' }).text).toContain('⚠️ אין עותק בגיבוי חיצוני מאז 06.11');
    setSetting(db, 'offsite.lastOkAt', '2026-11-07T01:45:00.000Z'); // exactly 3 days: not stale yet
    expect(weeklySummaryText(db, { lang: 'en', today: '2026-11-10' }).text).toContain('Offsite copy: 2026-11-07');
  });
});

describe('binding the Telegram chat (security research P0-02)', () => {
  it('takes only the private chat that sent the one-time code, after the code was made; the latest message alone is not enough', async () => {
    const { vi } = await import('vitest');
    const { telegramFindChatByCode } = await import('./telegram.js');
    const since = 1_800_000_000;
    const updates = [
      { update_id: 1, message: { message_id: 1, date: since - 60, text: '/start CODE123', chat: { id: 11, type: 'private', first_name: 'old' } } },
      { update_id: 2, message: { message_id: 2, date: since + 5, text: '/start CODE123', chat: { id: 22, type: 'private', username: 'alex' } } },
      { update_id: 3, message: { message_id: 3, date: since + 9, text: '/start CODE123', chat: { id: 33, type: 'group', first_name: 'g' } } },
      { update_id: 4, message: { message_id: 4, date: since + 20, text: 'hello', chat: { id: 44, type: 'private', first_name: 'stranger' } } },
      { update_id: 5, message: { message_id: 5, date: since + 30, text: '/start WRONG', chat: { id: 55, type: 'private', first_name: 'guess' } } },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: updates })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await telegramFindChatByCode('t', 'CODE123', since)).toEqual({ chatId: '22', from: '@alex' });
      expect(await telegramFindChatByCode('t', 'NOPE', since)).toBeNull();
      expect(await telegramFindChatByCode('t', 'CODE123', since + 100)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('spending limit alerts (dispatcher)', () => {
  it('sends 100% once, never 80% after it, and respects the matrix', async () => {
    const { vi } = await import('vitest');
    const { setSpendLimit } = await import('../hub/limit.js');
    const sent: string[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      sent.push((JSON.parse(init.body) as { text: string }).text);
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });
    try {
      const db = openDb(':memory:');
      const acc = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
      const row = (date: string, amount: number, description: string): NormalizedRow =>
        ({ externalAccountId: 'x', date, amount, description, status: 'completed', type: 'normal', identifier: `${description}${date}${amount}`, payload: {} }) as unknown as NormalizedRow;
      ingestBatch(db, { source: 'scraper:max', runId: null, accountId: acc, rows: [row('2026-11-02', -500000, 'SUPER A'), row('2026-11-03', -150000, 'SUPER B')] });
      runEngine(db);
      setSetting(db, 'ui.language', 'en');
      setAlertConfig(db, { telegramChatId: '1', quiet: 'off' });
      const now = new Date('2026-11-20T10:00:00Z');
      const limitSent = async () => (await dispatchAlerts(db, { telegramToken: 't', now })).sent.filter((s) => s.type === 'spend_limit').map((s) => s.key);

      setSpendLimit(db, '2026-11', 600000, '2026-11'); // spent 6,500 of 6,000
      expect(await limitSent()).toEqual(['spend_limit:100:2026-11']);
      expect(await limitSent()).toEqual([]); // once
      setSpendLimit(db, '2026-11', 800000, '2026-11'); // now 81%: 80% would read backwards after "reached"
      expect(await limitSent()).toEqual([]);
      expect(sent.filter((t) => t.includes('80%'))).toEqual([]);

      setAlertConfig(db, { matrix: { spend_limit: { telegram: false } } });
      db.$client.prepare(`delete from alert_log where key like 'spend_limit:%'`).run();
      const r = await dispatchAlerts(db, { telegramToken: 't', now });
      expect(r.skipped.filter((s) => s.type === 'spend_limit').map((s) => s.reason)).toEqual(['off']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
