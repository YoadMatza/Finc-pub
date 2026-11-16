import { describe, expect, it } from 'vitest';
import { en, he } from './i18n';
import { citeMark, citeMarks, factKey, headlineAnchor, headlineNumber, headlinesUnavailableKey, newsLink, summaryUnavailableKey, toneDot } from './insightsNews';

const ids = new Set(['h1', 'h2', 'h3']);

describe('news citations (decision aids C)', () => {
  it('a headline id becomes its number, only when that headline is listed', () => {
    expect(citeMark('h3', ids)).toEqual({ kind: 'headline', id: 'h3', n: 3 });
    expect(citeMark('h9', ids)).toBeNull();
    expect(citeMark('h0', new Set(['h0']))).toBeNull();
  });

  it('a fact id becomes a short label', () => {
    expect(citeMark('f:trend', ids)).toEqual({ kind: 'fact', key: 'trend', n: null });
    expect(citeMark('f:analysts', ids)).toEqual({ kind: 'fact', key: 'analysts', n: null });
    expect(citeMark('f:filing:2', ids)).toEqual({ kind: 'fact', key: 'filing', n: 2 });
    expect(citeMark('f:filing', ids)).toEqual({ kind: 'fact', key: 'filing', n: null });
  });

  it('anything else is dropped', () => {
    for (const c of ['f:price', 'f:trend:1', 'x', '', 'h1 ', '<b>h1</b>', 'f:market:']) expect(citeMark(c, ids)).toBeNull();
  });

  it('keeps order, drops repeats and unknown ids', () => {
    expect(citeMarks(['h2', 'f:market', 'h2', 'h7', 'h1'], ids).map((m) => (m.kind === 'headline' ? m.n : m.key))).toEqual([2, 'market', 1]);
  });

  it('every fact label exists in both languages', () => {
    for (const k of ['trend', 'market', 'company', 'analysts', 'filing'] as const) {
      expect(he[factKey(k)]).toBeTruthy();
      expect(en[factKey(k)]).toBeTruthy();
    }
  });

  it('headline numbers and anchors', () => {
    expect(headlineNumber('h12')).toBe(12);
    expect(headlineNumber('x1')).toBeNull();
    expect(headlineAnchor('BRK.B', 'h2')).toBe('news-BRK_B-h2');
  });
});

describe('news "not available" texts', () => {
  it('one text per code, in both languages', () => {
    for (const c of ['off', 'no_key', 'vault_locked', 'not_covered', 'busy', 'unreachable', 'invalid', 'none'] as const) {
      const k = headlinesUnavailableKey(c);
      expect(k).toBe(`news_h_${c}`);
      expect(he[k] && en[k]).toBeTruthy();
    }
    for (const c of ['off', 'no_provider', 'vault_locked', 'too_few', 'busy', 'unreachable', 'rejected', 'limited'] as const) {
      const k = summaryUnavailableKey(c);
      expect(k).toBe(`news_s_${c}`);
      expect(he[k] && en[k]).toBeTruthy();
    }
  });

  it('a missing or unknown code falls back', () => {
    expect(headlinesUnavailableKey(undefined)).toBe('news_h_none');
    expect(headlinesUnavailableKey('weird')).toBe('news_h_none');
    expect(summaryUnavailableKey(undefined)).toBe('news_s_unknown');
    expect(summaryUnavailableKey('weird')).toBe('news_s_unknown');
  });
});

describe('tone dot and links', () => {
  it('tone dot classes', () => {
    expect(toneDot('positive').className).toContain('bg-pos');
    expect(toneDot('negative').className).toContain('bg-neg');
    expect(toneDot('neutral').className).toContain('bg-muted');
    expect(toneDot(null).className).toContain('bg-transparent');
  });

  it('only plain https links are opened', () => {
    expect(newsLink('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    for (const u of ['http://example.com/', 'javascript:alert(1)', 'https://user:pw@example.com/', 'https://exa mple.com/', 'https://example.com\\@evil.com', 'https://', 'data:text/html,x', 42, null])
      expect(newsLink(u)).toBeNull();
  });
});
