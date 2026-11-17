import type { Key } from './i18n';
import type { HoldingNews, NewsHeadline } from './types';

/**
 * Decision aids C, the News section's pure parts: citation marks, the "not available" texts, the tone dot and the
 * link check. Every field of a headline is untrusted third-party text: the view renders it as plain text only.
 */

export type NewsFactKey = 'trend' | 'market' | 'company' | 'analysts' | 'filing';

/** One citation mark after a summary sentence: a headline number ([3]) or a short fact label. */
export type CiteMark = { kind: 'headline'; id: string; n: number } | { kind: 'fact'; key: NewsFactKey; n: number | null };

const FACTS: readonly NewsFactKey[] = ['trend', 'market', 'company', 'analysts'];

/**
 * 'h3' -> headline 3 (only when that headline is in the list); 'f:trend' / 'f:market' / 'f:company' / 'f:analysts' ->
 * a fact label; 'f:filing:<n>' -> filing n. Anything else is dropped (a cite the hub should not have passed).
 */
export function citeMark(cite: string, headlineIds: ReadonlySet<string>): CiteMark | null {
  const h = /^h([1-9]\d{0,2})$/.exec(cite);
  if (h) return headlineIds.has(cite) ? { kind: 'headline', id: cite, n: Number(h[1]) } : null;
  const f = /^f:([a-z]+)(?::(\d{1,3}))?$/.exec(cite);
  if (!f) return null;
  if (f[1] === 'filing') return { kind: 'fact', key: 'filing', n: f[2] === undefined ? null : Number(f[2]) };
  if (f[2] !== undefined) return null;
  const key = FACTS.find((k) => k === f[1]);
  return key ? { kind: 'fact', key, n: null } : null;
}

/** The marks for one sentence, in the order cited, without repeats. */
export function citeMarks(cites: readonly string[], headlineIds: ReadonlySet<string>): CiteMark[] {
  const seen = new Set<string>();
  const out: CiteMark[] = [];
  for (const c of cites) {
    if (seen.has(c)) continue;
    seen.add(c);
    const m = citeMark(c, headlineIds);
    if (m) out.push(m);
  }
  return out;
}

/** 'h3' -> 3, anything else -> null (the number shown before a headline's title). */
export function headlineNumber(id: string): number | null {
  const h = /^h([1-9]\d{0,2})$/.exec(id);
  return h ? Number(h[1]) : null;
}

/** The i18n key of a fact mark's label. */
export const factKey = (k: NewsFactKey): Key => `news_fact_${k}` as Key;

/** The DOM id a headline citation scrolls to (headline ids are 'h1', 'h2', ... so safe in an id). */
export const headlineAnchor = (symbol: string, id: string): string => `news-${symbol.replace(/[^A-Za-z0-9_-]/g, '_')}-${id}`;

const HEADLINE_CODES = ['off', 'no_key', 'vault_locked', 'not_covered', 'busy', 'unreachable', 'invalid', 'none'] as const;
const SUMMARY_CODES = ['off', 'no_provider', 'vault_locked', 'too_few', 'busy', 'unreachable', 'rejected', 'limited'] as const;

/** Why there are no headlines; an unknown or missing code reads as "none found". */
export function headlinesUnavailableKey(code: HoldingNews['headlinesUnavailableCode'] | string | undefined): Key {
  const c = HEADLINE_CODES.find((x) => x === code) ?? 'none';
  return `news_h_${c}` as Key;
}

/** Why there is no summary; an unknown or missing code reads as "not available". */
export function summaryUnavailableKey(code: HoldingNews['summaryUnavailableCode'] | string | undefined): Key {
  const c = SUMMARY_CODES.find((x) => x === code);
  return (c ? `news_s_${c}` : 'news_s_unknown') as Key;
}

/** The tone dot: filled green / red / grey, or hollow when not toned. */
export function toneDot(tone: NewsHeadline['tone']): { className: string; label: Key } {
  switch (tone) {
    case 'positive':
      return { className: 'bg-pos border-pos', label: 'news_tone_positive' };
    case 'negative':
      return { className: 'bg-neg border-neg', label: 'news_tone_negative' };
    case 'neutral':
      return { className: 'bg-muted border-muted', label: 'news_tone_neutral' };
    default:
      return { className: 'bg-transparent border-muted', label: 'news_tone_none' };
  }
}

/**
 * The link only when it is a plain https URL (printable ASCII, no backslash, no user info, the default port, a host
 * name with a dot); otherwise not opened. The phone checks the same rule again (ExternalLinkRules.newsUrl).
 */
export function newsLink(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2048 || !url.startsWith('https://')) return null;
  if (/[^\x21-\x7e]|\\/.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username !== '' || u.password !== '' || u.port !== '') return null;
  if (u.hostname.indexOf('.') <= 0 || u.hostname.endsWith('.')) return null;
  return url;
}
