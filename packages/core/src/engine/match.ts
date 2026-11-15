/**
 * The shared matching engine (§7a): every "is this the same thing?" decision combines several
 * signals, keeps each signal's contribution, and resolves competition between candidates with a
 * global assignment rather than first-come-first-served.
 */
export interface Signal {
  signal: string;
  /** 0..1 how strongly this signal says "match" (can be negative to veto). */
  score: number;
  weight: number;
  note: string;
}

export interface Scored {
  score: number; // 0..1 weighted average
  signals: Signal[];
}

export const ZONES = { auto: 0.85, suggest: 0.55 } as const;
export type Zone = 'auto' | 'suggest' | 'ignore';

export function combine(signals: Signal[]): Scored {
  const w = signals.reduce((s, x) => s + x.weight, 0);
  if (w === 0) return { score: 0, signals };
  const raw = signals.reduce((s, x) => s + x.score * x.weight, 0) / w;
  return { score: Math.max(0, Math.min(1, raw)), signals };
}

export function zoneOf(score: number): Zone {
  if (score >= ZONES.auto) return 'auto';
  if (score >= ZONES.suggest) return 'suggest';
  return 'ignore';
}

export interface Pair<A, B> {
  a: A;
  b: B;
  scored: Scored;
}

/**
 * Greedy global assignment: best pairs first, each side used at most `capacity` times (default 1).
 * For refunds a purchase may absorb several partial credits, so capacity can be a function.
 */
export function assign<A, B>(
  pairs: Array<Pair<A, B>>,
  keyA: (a: A) => string | number,
  keyB: (b: B) => string | number,
  opts: { minScore?: number; capacityA?: (a: A) => number; capacityB?: (b: B) => number } = {},
): Array<Pair<A, B>> {
  const min = opts.minScore ?? ZONES.suggest;
  const usedA = new Map<string | number, number>();
  const usedB = new Map<string | number, number>();
  const out: Array<Pair<A, B>> = [];
  for (const p of [...pairs].sort((x, y) => y.scored.score - x.scored.score)) {
    if (p.scored.score < min) break;
    const ka = keyA(p.a);
    const kb = keyB(p.b);
    const ca = opts.capacityA?.(p.a) ?? 1;
    const cb = opts.capacityB?.(p.b) ?? 1;
    if ((usedA.get(ka) ?? 0) >= ca || (usedB.get(kb) ?? 0) >= cb) continue;
    usedA.set(ka, (usedA.get(ka) ?? 0) + 1);
    usedB.set(kb, (usedB.get(kb) ?? 0) + 1);
    out.push(p);
  }
  return out;
}

// ---------- reusable signal helpers ----------

/** 1 at zero days, falls linearly to 0 at `window` days; negative days (b before a) get `backWindow`. */
export function dateSignal(days: number, window: number, backWindow = 3, weight = 1): Signal {
  let score: number;
  if (days < 0) score = days >= -backWindow ? 0.6 : -1;
  else score = Math.max(0, 1 - days / window);
  return { signal: 'date', score, weight, note: `${days} day(s) apart` };
}

/** Exact amount, within tolerance, or partial (credit smaller than purchase). Amounts in minor units, absolute. */
export function amountSignal(a: number, b: number, opts: { tolerancePct?: number; allowPartial?: boolean; weight?: number } = {}): Signal {
  const weight = opts.weight ?? 1.5;
  if (a === b) return { signal: 'amount', score: 1, weight, note: 'same amount' };
  const pct = Math.abs(a - b) / Math.max(a, b);
  if (pct <= (opts.tolerancePct ?? 0.05)) return { signal: 'amount', score: 0.85, weight, note: `within ${(pct * 100).toFixed(1)}%` };
  if (opts.allowPartial && a < b) return { signal: 'amount', score: 0.75, weight, note: `partial: ${(a / 100).toFixed(2)} of ${(b / 100).toFixed(2)}` };
  return { signal: 'amount', score: 0, weight, note: 'different amount' };
}

export function merchantSignal(sameMerchantId: boolean, similarity: number, weight = 2): Signal {
  if (sameMerchantId) return { signal: 'merchant', score: 1, weight, note: 'same merchant' };
  return { signal: 'merchant', score: similarity, weight, note: `name similarity ${similarity.toFixed(2)}` };
}

export function keywordSignal(text: string, words: string[], weight = 0.5): Signal {
  const hit = words.find((w) => text.toLowerCase().includes(w.toLowerCase()));
  return hit ? { signal: 'keyword', score: 1, weight, note: `"${hit}"` } : { signal: 'keyword', score: 0, weight: weight / 2, note: 'no keyword' };
}

/** Shared reference number (cheque number, authorization id) inside the two descriptions: a strong "same thing" signal (§7a). */
export function referenceSignal(a: string, b: string, weight = 1.5): Signal | null {
  const refs = (s: string) => new Set((s.match(/\d{5,}/g) ?? []).map((x) => x.replace(/^0+/, '')));
  const ra = refs(a);
  const rb = refs(b);
  if (!ra.size || !rb.size) return null;
  for (const r of ra) if (rb.has(r)) return { signal: 'reference', score: 1, weight, note: `same reference ${r}` };
  return { signal: 'reference', score: 0, weight: weight / 3, note: 'different reference numbers' };
}

export function fxSignal(currencyA: string, originalA: number | null, currencyB: string, originalB: number | null, weight = 1): Signal | null {
  if (currencyA === 'ILS' && currencyB === 'ILS') return null;
  if (currencyA !== currencyB) return { signal: 'fx', score: 0, weight, note: `${currencyA} vs ${currencyB}` };
  if (originalA !== null && originalB !== null && Math.abs(originalA) === Math.abs(originalB)) return { signal: 'fx', score: 1, weight, note: `same ${currencyA} amount` };
  return { signal: 'fx', score: 0.5, weight, note: `same currency ${currencyA}` };
}
