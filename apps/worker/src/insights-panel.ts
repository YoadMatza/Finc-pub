/**
 * Builds one holding's stock-insights panel (research_notes/proposals/stock-insights.md, steps 1 and 2): price
 * analytics and the bank cross-check from Yahoo (insights.ts), the company's numbers, filings and sector fund from SEC
 * (sec.ts), and (stock-decision-aids.md, Part B) the analysts' ratings and earnings dates from Finnhub (finnhub.ts),
 * all within the panel's deadlines. Used by GET /api/holdings/:id/insights and by the holding-rules
 * evaluation (holding-rules.ts), which reuses the same caches and limits. Never throws.
 */
import {
  type CompanySection,
  type FilingEvent,
  type HoldingInsights,
  type InsightsRow,
  type PriceInput,
  type UnavailableCode,
  buildCompany,
  buildInsights,
  recentFilings,
  sectorForSic,
  unavailableInsights,
  validSymbol,
  withAnalysts,
  withCompany,
} from '@finc/core';
import { FINNHUB_DEADLINE_MS, type FinnhubLookup, type FinnhubService } from './finnhub.js';
import type { InsightsService } from './insights.js';
import { type CompanyResult, SEC_DEADLINE_MS, type SecService } from './sec.js';

export interface PanelDeps {
  insights?: Pick<InsightsService, 'histories' | 'history' | 'noteCrossCheck'> | undefined;
  sec?: Pick<SecService, 'company'> | undefined;
  /** Finnhub (analysts, earnings dates); absent when insights are off: the section answers 'off' */
  finnhub?: Pick<FinnhubService, 'lookup'> | undefined;
  /** the panel's limits (tests shorten them): SEC (and the whole panel) 8 s, Finnhub 4 s */
  deadlines?: { secMs?: number; finnhubMs?: number } | undefined;
}

/** `p`, or `fallback` when it takes longer than `ms` (p still runs: it fills the caches) */
export function withinMs<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((res) => {
    timer = setTimeout(() => res(fallback), Math.max(0, ms));
    timer.unref?.();
  });
  return Promise.race([p, late]).finally(() => timer && clearTimeout(timer));
}

/** Sections E and F from SEC's answer; without submissions the figures stand alone (no filings, a note says so). */
function companySection(c: Extract<CompanyResult, { ok: true }>, price: PriceInput, today: string): { company: CompanySection; filings: FilingEvent[] } {
  const s = c.submissions;
  const company = buildCompany({ cik: c.cik, name: s?.name ?? (c.title || c.facts?.entityName || ''), sic: s?.sic ?? null, sicDescription: s?.sicDescription ?? null }, c.facts, price);
  if (!s) company.notes.push({ code: 'filings_unavailable', figure: null, text: 'The filing list could not be fetched from SEC; recent filings and the sector are missing.' });
  return { company, filings: s ? recentFilings(s, today) : [] };
}

const INSIGHTS_UNAVAILABLE: Record<'invalid_symbol' | 'rate_limited' | 'server' | 'network' | 'not_found' | 'bad_answer', UnavailableCode> = {
  invalid_symbol: 'not_covered',
  rate_limited: 'busy',
  server: 'unreachable',
  network: 'unreachable',
  not_found: 'unknown_symbol',
  bad_answer: 'invalid',
};

/**
 * The panel for one holding row of an account's latest snapshot. Only the ticker goes to Yahoo and only the CIK to
 * SEC; the answer carries the bank's price per unit, never a quantity or amount.
 */
export async function buildPanel(deps: PanelDeps, r: InsightsRow, now: () => number): Promise<HoldingInsights> {
  const symbol = r.symbol.trim().toUpperCase();
  if (!deps.insights) return unavailableInsights(r, 'off', now());
  if (!validSymbol(symbol) || !/^[A-Z]{3}$/.test(r.currency) || r.currency === 'ILS') return withAnalysts(withCompany(unavailableInsights(r, 'not_covered', now()), { code: 'not_covered' }), { analysts: null, code: 'not_covered', earnings: null });
  const insights = deps.insights;
  // step 2: SEC (company numbers, filings, the SIC code naming the sector fund) side by side with Yahoo, both within
  // the panel's deadline; only the CIK goes to SEC (the ticker list is downloaded whole)
  // a fund (ETF) has no company sections: SEC is asked once the holding's own history says what it is (a failed
  // history leaves the type unknown, and SEC is asked); the whole SEC part stays within the panel's 8 s
  const started = Date.now();
  const secMs = deps.deadlines?.secMs ?? SEC_DEADLINE_MS;
  const finnhubMs = deps.deadlines?.finnhubMs ?? FINNHUB_DEADLINE_MS;
  // SEC and Finnhub cover US listings: only holdings priced in dollars go there (else not_covered)
  const usd = r.currency === 'USD';
  const sec = deps.sec;
  const own = insights.history(symbol, r.currency);
  const companyP: Promise<CompanyResult> = !sec
    ? Promise.resolve({ ok: false, code: 'off' })
    : !usd
      ? Promise.resolve({ ok: false, code: 'not_covered' })
      : withinMs(
        own.then((h) => (h.ok && h.history.instrumentType === 'ETF' ? { ok: false as const, code: 'not_covered' as const } : sec.company(symbol, secMs - (Date.now() - started)))),
        secMs,
        { ok: false, code: 'busy' },
      );
  // Part B: Finnhub for stocks only, side by side, once the history says what the holding is (an ETF is not asked; a
  // failed history leaves the type unknown and Finnhub is asked): up to 4 s from then, all within the panel's 8 s;
  // only the ticker goes there
  const fh = deps.finnhub;
  const finnhubP: Promise<FinnhubLookup> = !fh
    ? Promise.resolve({ analysts: null, code: 'off', earnings: null })
    : !usd
      ? Promise.resolve({ analysts: null, code: 'not_covered', earnings: null })
      : withinMs(
        own.then((h) => (h.ok && h.history.instrumentType === 'ETF' ? { analysts: null, code: 'not_covered' as const, earnings: null } : fh.lookup(symbol, Math.min(finnhubMs, secMs - (Date.now() - started))))),
        secMs,
        { analysts: null, code: 'busy', earnings: null },
      );
  const sectorP = companyP.then((x) => (x.ok && x.submissions ? (sectorForSic(x.submissions.sic)?.symbol ?? null) : null));
  const { history, spy, sector } = await insights.histories(symbol, r.currency, { sector: sectorP });
  const company = await companyP;
  const finnhub = await finnhubP;
  const fund = company.ok && company.submissions ? sectorForSic(company.submissions.sic) : null;
  const base = history.ok ? buildInsights(r, history.history, spy, now(), fund ? { fund, history: sector } : null) : unavailableInsights(r, INSIGHTS_UNAVAILABLE[history.reason], now());
  const withCo = withCompany(
    base,
    company.ok ? companySection(company, { price: base.trend.price, currency: r.currency, splits: history.ok ? history.history.splits : null }, new Date(now()).toISOString().slice(0, 10)) : { code: company.code },
  );
  const out = withAnalysts(withCo, finnhub);
  if (history.ok) insights.noteCrossCheck(symbol, out.crossCheck.yahooDate, out.crossCheck.ok);
  return out;
}
