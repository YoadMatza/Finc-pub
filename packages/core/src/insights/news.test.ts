import { describe, expect, it } from 'vitest';
import { adviceIn, checkNewsSummary, newsFacts, newsSummaryPrompt, newsToneReading, parseCompanyNews, selectHeadlines } from './news.js';
import { unavailableInsights } from './panel.js';
import { signalsBoard } from './signals.js';

// stock decision aids Part C: made-up headlines only

const NOW = Date.parse('2026-11-16T10:00:00Z');
const sec = (iso: string) => Date.parse(iso) / 1000;
const item = (headline: string, iso: string, extra: Record<string, unknown> = {}) => ({ headline, source: 'Demo Wire', url: `https://news.example/${encodeURIComponent(headline)}`, datetime: sec(iso), summary: 'A short summary.', ...extra });

describe('company news', () => {
  it('keeps real https items as plain text, newest first, last 14 days, duplicates once, at most 10', () => {
    const body = [
      item('Demo Corp beats estimates', '2026-11-14T12:00:00Z'),
      item('Demo Corp beats estimates!', '2026-11-14T13:00:00Z', { url: 'https://other.example/a' }), // same words
      item('Old story', '2026-10-01T12:00:00Z'),
      item('<b>Demo</b> opens a plant ‮', '2026-11-15T09:00:00Z'),
      { headline: 'No link', source: 'X', url: 'http://insecure.example/a', datetime: sec('2026-11-15T09:00:00Z') },
      { headline: 'Bad time', source: 'X', url: 'https://x.example/b', datetime: 'yesterday' },
      ...Array.from({ length: 12 }, (_, i) => item(`Item ${i}`, `2026-11-${String(3 + i).padStart(2, '0')}T08:00:00Z`)),
    ];
    const rows = parseCompanyNews(body)!;
    expect(rows.some((r) => r.title.includes('<'))).toBe(false);
    expect(rows.some((r) => r.url.startsWith('http:'))).toBe(false);
    const h = selectHeadlines(rows, NOW);
    expect(h).toHaveLength(10);
    expect(h[0]).toMatchObject({ id: 'h1', title: 'Demo opens a plant' });
    expect(h.filter((x) => x.title.startsWith('Demo Corp beats'))).toHaveLength(1);
    expect(h.some((x) => x.title === 'Old story')).toBe(false);
    expect(parseCompanyNews({ not: 'an array' })).toBeNull();
  });
});

describe('the AI summary is checked by code before it is shown', () => {
  const headlines = selectHeadlines(parseCompanyNews([item('Demo Corp revenue up 12% in Q3', '2026-11-14T12:00:00Z'), item('Demo Corp names a new CFO', '2026-11-13T12:00:00Z'), item('Demo Corp delays a product', '2026-11-12T12:00:00Z')])!, NOW);
  const facts = [{ id: 'f:trend', text: 'Price 120 USD; 4.5% vs its 50-day average, 11.2% vs its 200-day average.' }];
  const sent = newsSummaryPrompt('DEMO', 'Demo Corp', headlines, facts);
  const ids = { headlines: headlines.map((h) => h.id), facts: facts.map((f) => f.id) };
  const answer = (sentences: Array<{ text: string; cites: string[] }>, tones = [{ id: 'h1', tone: 'positive' }, { id: 'h2', tone: 'neutral' }, { id: 'h3', tone: 'negative' }]) => JSON.stringify({ tones, sentences });
  const good = [
    { text: 'Revenue rose 12% in the third quarter.', cites: ['h1'] },
    { text: 'A new finance chief was named.', cites: ['h2'] },
    { text: 'A product launch slipped.', cites: ['h3'] },
    { text: 'The price is 11.2% above its 200-day average.', cites: ['f:trend'] },
  ];

  it('the request marks the headlines as untrusted data and holds nothing private', () => {
    expect(sent.system).toMatch(/untrusted/i);
    expect(sent.user).toContain('<DATA>');
    expect(sent.user).not.toMatch(/quantity|cost|gain|account/i);
  });

  it('accepts a clean answer, with tones for known headlines only', () => {
    const r = checkNewsSummary(`Here you go:\n${answer(good, [{ id: 'h1', tone: 'positive' }, { id: 'h9', tone: 'negative' }, { id: 'h2', tone: 'great' }])}`, sent, ids);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.tones.entries()]).toEqual([['h1', 'positive']]);
      expect(r.sentences).toHaveLength(4);
    }
  });

  it('news words are not advice: sell-off, selling pressure, a holding company pass (found live 2026-11-16)', () => {
    const news = [
      { text: 'A sell-off hit the shares as selling pressure grew.', cites: ['h1'] },
      { text: 'The holding company reported a buyback.', cites: ['h2'] },
      { text: 'Analysts kept a cautious tone after the delay.', cites: ['h3'] },
      { text: 'The price is 11.2% above its 200-day average.', cites: ['f:trend'] },
    ];
    expect(checkNewsSummary(answer(news), sent, ids).ok).toBe(true);
    expect(adviceIn('Investors should consider trimming.')).toBe('should_act');
    expect(adviceIn('The stock looks like a buy.')).toBe('is_a_buy');
    expect(adviceIn('Analysts raised their price target.')).toBe('target');
    // a price-target sentence is left out and the rest stands; finc never shows the target
    const withTarget = checkNewsSummary(answer([...news, { text: 'An analyst raised the price target.', cites: ['h1'] }]), sent, ids);
    expect(withTarget.ok && withTarget.sentences.some((x) => /target/i.test(x.text))).toBe(false);
    expect(withTarget.ok && withTarget.sentences).toHaveLength(4);
  });

  it('refuses advice, links, invented numbers, unknown citations, a bad shape', () => {
    const bad = (s: typeof good) => checkNewsSummary(answer(s), sent, ids);
    expect(bad([...good, { text: 'Investors should buy now.', cites: ['h1'] }])).toMatchObject({ ok: false, check: 'advice' });
    expect(bad([...good.slice(0, 3), { text: 'כדאי לקנות את המניה.', cites: ['h1'] }])).toMatchObject({ ok: false, check: 'advice' });
    expect(bad([...good, { text: 'More at https://evil.example', cites: ['h1'] }])).toMatchObject({ ok: false, check: 'link' });
    expect(bad([...good.slice(0, 3), { text: 'Revenue rose 45% this year.', cites: ['h1'] }])).toMatchObject({ ok: false, check: 'number' });
    expect(bad([...good.slice(0, 3), { text: 'Something else happened.', cites: ['h7'] }])).toMatchObject({ ok: false, check: 'cites' });
    // unknown ids are dropped, known ones kept (any case); a sentence left with none is refused
    const mixed = checkNewsSummary(answer([...good.slice(0, 3), { text: 'The delay matters.', cites: ['H3', 'section-2'] }]), sent, ids);
    expect(mixed.ok && mixed.sentences[3]!.cites).toEqual(['h3']);
    expect(bad([...good.slice(0, 3), { text: 'Uncited.', cites: [] }])).toMatchObject({ ok: false, check: 'cites' });
    expect(bad(good.slice(0, 1))).toMatchObject({ ok: false, check: 'sentence_count' });
    expect(checkNewsSummary('I cannot help with that.', sent, ids)).toMatchObject({ ok: false, check: 'not_json' });
  });
});

describe('news tone on the signals board', () => {
  it('needs 3 toned headlines; 60% one way decides', () => {
    expect(newsToneReading([{ tone: 'positive' }, { tone: 'positive' }]).reading).toBe('unavailable');
    expect(newsToneReading([{ tone: 'positive' }, { tone: 'positive' }, { tone: 'neutral' }]).reading).toBe('positive');
    expect(newsToneReading([{ tone: 'negative' }, { tone: 'positive' }, { tone: 'neutral' }, { tone: null }]).reading).toBe('mixed');
    const d = unavailableInsights({ id: 1, symbol: 'X', name: 'X', currency: 'USD', price: null, takenAt: '2026-11-16T05:00:00Z' }, 'unreachable', NOW);
    expect(signalsBoard(d, [], [{ tone: 'negative' }, { tone: 'negative' }, { tone: 'negative' }]).signals.find((s) => s.key === 'news')).toMatchObject({ reading: 'negative', direction: -1 });
    expect(signalsBoard(d).signals.find((s) => s.key === 'news')?.reading).toBe('unavailable');
  });

  it('facts carry public market figures with ids, never the position', () => {
    const d = unavailableInsights({ id: 1, symbol: 'X', name: 'X', currency: 'USD', price: 100, takenAt: '2026-11-16T05:00:00Z' }, 'unreachable', NOW);
    expect(newsFacts(d, NOW)).toEqual([]);
  });
});
