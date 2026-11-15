import { describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../prices/yahoo.js';
import { EIGHT_K_ITEMS, SEC_MAX_BYTES, SUBMISSIONS_MAX_FILINGS, eightKItem, eightKItemTitle, filingIndexUrl, lookupTicker, padCik, parseSubmissions, parseTickerMap, recentFilings, secContact, secGet, secTicker, secUserAgent, trimCompanyFacts } from './sec.js';
import { sectorForSic, SIC_SECTOR_TABLE } from './sector.js';

// Fictional companies, CIKs and contacts (example.com / example.org) throughout; no network.

const CONTACT = 'finc-owner@example.com';
const CIK = '0009999001';

describe('User-Agent and identifiers', () => {
  it('builds the agent from a valid contact only', () => {
    expect(secUserAgent(CONTACT)).toBe('finc personal finance app finc-owner@example.com');
    expect(secUserAgent(` ${CONTACT} `)).toBe('finc personal finance app finc-owner@example.com');
    for (const bad of ['', '   ', 'not-an-email', 'a@b', 'x@example.com\r\nX-Evil: 1', 'a b@example.com', undefined, null]) expect(secUserAgent(bad as string)).toBeNull();
    expect(secContact('x@example.com\n')).toBe('x@example.com'); // trimmed
  });

  it('pads and validates CIKs', () => {
    expect(padCik(320)).toBe('0000000320');
    expect(padCik('9999001')).toBe(CIK);
    for (const bad of [0, -1, 1.5, '12a', '', '12345678901', null, undefined, 1e11]) expect(padCik(bad)).toBeNull();
  });

  it('class shares: BRK.B and BRK/B are BRK-B at SEC; exchange suffixes stay', () => {
    expect(secTicker('BRK.B')).toBe('BRK-B');
    expect(secTicker('brk/b')).toBe('BRK-B');
    expect(secTicker('BRK-B')).toBe('BRK-B');
    expect(secTicker('TEVA.TA')).toBe('TEVA.TA');
    expect(secTicker('ORCH')).toBe('ORCH');
  });

  it('filing index pages on www.sec.gov only, from a valid CIK and accession number', () => {
    expect(filingIndexUrl(CIK, '0009999001-26-000024')).toBe('https://www.sec.gov/Archives/edgar/data/9999001/000999900126000024/');
    expect(filingIndexUrl(CIK, '../../evil')).toBeNull();
    expect(filingIndexUrl('abc', '0009999001-26-000024')).toBeNull();
  });
});

describe('ticker map', () => {
  const body = { '0': { cik_str: 9999001, ticker: 'ORCH', title: 'Orchard Devices Inc.' }, '1': { cik_str: 9999002, ticker: 'MPLE-B', title: 'Maple Holdings' }, '2': { cik_str: 'x', ticker: 'BAD', title: 'Bad' }, '3': { cik_str: 9999003, ticker: 'ORCH', title: 'Duplicate' } };
  it('parses entries, skips bad ones, the first entry of a ticker wins', () => {
    const m = parseTickerMap(body)!;
    expect(m.get('ORCH')).toEqual({ cik: CIK, title: 'Orchard Devices Inc.' });
    expect(m.has('BAD')).toBe(false);
    expect(lookupTicker(m, 'MPLE.B')).toEqual({ cik: '0009999002', title: 'Maple Holdings' });
    expect(lookupTicker(m, 'NOPE')).toBeNull();
    expect(lookupTicker(m, 'ORCH.TA')).toBeNull();
  });
  it('refuses a wrong shape', () => {
    for (const bad of [null, [], 'x', {}, { a: 1 }]) expect(parseTickerMap(bad)).toBeNull();
  });
});

describe('submissions and filings (section F)', () => {
  const recent = {
    accessionNumber: ['0009999001-26-000030', '0009999001-26-000029', '0009999001-26-000024', '0009999001-26-000020', '0009999001-25-000010', '0009999001-26-000028', 'bad'],
    filingDate: ['2026-11-05', '2026-11-01', '2026-10-31', '2026-08-01', '2025-08-02', '2026-09-15', '2026-09-01'],
    reportDate: ['2026-11-04', '2026-10-30', '2026-09-26', '2026-06-27', '2025-06-28', '', ''],
    form: ['4', '8-K', '10-K', '10-Q', '10-Q', '8-K/A', '8-K'],
    items: ['', '2.02,9.01', '', '', '', '5.02,6.99', '1.01'],
    primaryDocument: ['a.xml', 'b.htm', 'c.htm', 'd.htm', 'e.htm', 'f.htm', 'g.htm'],
  };
  const body = { cik: '9999001', name: 'Orchard Devices Inc.', sic: '3571', sicDescription: 'Electronic Computers', filings: { recent } };

  it('parses name, SIC and filings; refuses another company or a broken shape', () => {
    const s = parseSubmissions(body, CIK)!;
    expect(s).toMatchObject({ cik: CIK, name: 'Orchard Devices Inc.', sic: '3571', sicDescription: 'Electronic Computers' });
    expect(s.filings).toHaveLength(5); // the Form 4 is not kept, the bad accession number is dropped
    expect(parseSubmissions(body, '0009999002')).toBeNull();
    expect(parseSubmissions({ ...body, filings: { recent: { ...recent, form: ['10-K'] } } }, CIK)).toBeNull();
    expect(parseSubmissions({ ...body, sic: '' }, CIK)?.sic).toBeNull();
  });

  it('the last 12 months of 10-K/10-Q/8-K, newest first, 8-K items titled, links to the filing index', () => {
    const f = recentFilings(parseSubmissions(body, CIK)!, '2026-11-11');
    expect(f.map((x) => x.form)).toEqual(['8-K', '10-K', '8-K/A', '10-Q']); // the Form 4 and the 2025 10-Q are out
    expect(f[0]).toEqual({ form: '8-K', filed: '2026-11-01', reportDate: '2026-10-30', title: 'Current report', items: ['2.02 Results of operations', '9.01 Financial statements and exhibits'], url: 'https://www.sec.gov/Archives/edgar/data/9999001/000999900126000029/' });
    expect(f[1]).toMatchObject({ title: 'Annual report', items: [] });
    expect(f[2]).toMatchObject({ title: 'Current report (amended)', items: ['5.02 Director/officer change', '6.99'], reportDate: null });
    expect(f.every((x) => x.url.startsWith('https://www.sec.gov/Archives/edgar/data/9999001/'))).toBe(true);
  });

  it('foreign filers: 20-F and 6-K; at most 20, newest first', () => {
    const n = 30;
    const many = { cik: 9999001, name: 'Fjord Shipping ASA', sic: '4412', filings: { recent: { accessionNumber: Array.from({ length: n }, (_, i) => `0009999001-26-${String(i).padStart(6, '0')}`), filingDate: Array.from({ length: n }, (_, i) => `2026-${String(1 + (i % 10)).padStart(2, '0')}-${String(1 + i).padStart(2, '0')}`), form: Array.from({ length: n }, (_, i) => (i === 0 ? '20-F' : '6-K')) } } };
    const f = recentFilings(parseSubmissions(many, CIK)!, '2026-11-11');
    expect(f).toHaveLength(20);
    expect(f.every((x, i) => i === 0 || x.filed <= f[i - 1]!.filed)).toBe(true);
    expect(f.some((x) => x.title === 'Report of foreign issuer')).toBe(true);
  });

  it('a large bank-sized list (26,607 filings, mostly prospectus supplements): the section F forms are kept', () => {
    const n = 26_607;
    const day = (i: number) => new Date(Date.parse('2026-11-10') - Math.floor(i / 8) * 86_400_000).toISOString().slice(0, 10);
    const big = { cik: '9999001', name: 'Big Bank Corp', sic: '6021', filings: { recent: { accessionNumber: Array.from({ length: n }, (_, i) => `0009999001-26-${String(i).padStart(6, '0')}`), filingDate: Array.from({ length: n }, (_, i) => day(i)), reportDate: Array.from({ length: n }, () => ''), form: Array.from({ length: n }, (_, i) => (i % 3 ? '424B2' : '8-K')), items: Array.from({ length: n }, () => '8.01') } } };
    const s = parseSubmissions(big, CIK)!;
    expect(s.filings).toHaveLength(SUBMISSIONS_MAX_FILINGS); // 8,869 8-Ks, the newest 2,000 kept
    expect(s.filings.every((x) => x.form === '8-K')).toBe(true);
    expect(s.filings[0]!.filed).toBe('2026-11-10');
    const f = recentFilings(s, '2026-11-11');
    expect(f).toHaveLength(20);
    expect(f.every((x) => x.form === '8-K')).toBe(true);
  });

  it('8-K item titles', () => {
    expect(eightKItemTitle('2.02')).toBe('Results of operations');
    expect(eightKItemTitle('5.02')).toBe('Director/officer change');
    expect(eightKItemTitle('1.01')).toBe('Material agreement');
    expect(eightKItemTitle('7.01')).toBe('Reg FD disclosure');
    expect(eightKItemTitle('8.01')).toBe('Other events');
    expect(eightKItemTitle('9.99')).toBe('Item 9.99');
    expect(eightKItem('2.02')).toBe('2.02 Results of operations');
    expect(eightKItem('9.99')).toBe('9.99');
    expect(Object.values(EIGHT_K_ITEMS).every((t) => t.length <= 50)).toBe(true);
  });
});

describe('companyfacts trimming', () => {
  const fact = (o: Record<string, unknown> = {}) => ({ start: '2025-01-01', end: '2025-03-31', val: 10, accn: '0009999001-25-000001', fy: 2025, fp: 'Q1', form: '10-Q', filed: '2025-05-01', ...o });
  it('keeps the concepts used, valid facts from periodic reports, known units', () => {
    const body = {
      cik: 9999001,
      entityName: 'Orchard Devices Inc.',
      facts: {
        'us-gaap': {
          Revenues: { units: { USD: [fact(), fact({ form: '8-K' }), fact({ val: 'x' }), fact({ end: '2025-13-40' }), fact({ start: '2025-04-01' }), fact({ accn: 'nope' })], 'USD/foo': [fact()] } },
          AccountsPayableCurrent: { units: { USD: [fact()] } },
        },
        dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: '2025-04-20', val: 100, accn: '0009999001-25-000001', form: '10-Q', filed: '2025-05-01' }] } } },
      },
    };
    const t = trimCompanyFacts(body, CIK)!;
    expect(Object.keys(t.concepts).sort()).toEqual(['dei:EntityCommonStockSharesOutstanding', 'us-gaap:Revenues']);
    expect(t.concepts['us-gaap:Revenues']).toEqual({ USD: [{ start: '2025-01-01', end: '2025-03-31', val: 10, form: '10-Q', filed: '2025-05-01', accn: '0009999001-25-000001' }] });
    expect(t.concepts['dei:EntityCommonStockSharesOutstanding']!.shares![0]).not.toHaveProperty('start');
    expect(t.entityName).toBe('Orchard Devices Inc.');
  });
  it('refuses another company or a body without facts', () => {
    expect(trimCompanyFacts({ cik: 9999002, facts: {} }, CIK)).toBeNull();
    expect(trimCompanyFacts({ cik: 9999001 }, CIK)).toBeNull();
    expect(trimCompanyFacts(null, CIK)).toBeNull();
  });
});

describe('secGet', () => {
  const ok = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
  it('sends the agent, no cookies, no redirects; fixed hosts only', async () => {
    const f = vi.fn<FetchFn>(async () => ok({ a: 1 }));
    expect(await secGet('https://data.sec.gov/submissions/CIK0009999001.json', { contact: CONTACT, fetch: f, maxBytes: 1000 })).toEqual({ ok: true, body: { a: 1 } });
    const init = f.mock.calls[0]![1];
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', headers: { 'user-agent': 'finc personal finance app finc-owner@example.com', accept: 'application/json' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    for (const url of ['https://evil.example.com/x.json', 'http://data.sec.gov/x.json', 'https://data.sec.gov:8443/x.json', 'https://user@data.sec.gov/x.json', 'https://sec.gov/x.json', 'not a url']) {
      expect(await secGet(url, { contact: CONTACT, fetch: f, maxBytes: 1000 })).toMatchObject({ ok: false, reason: 'bad_answer' });
    }
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('off without a contact (nothing is sent)', async () => {
    const f = vi.fn<FetchFn>(async () => ok({}));
    expect(await secGet('https://www.sec.gov/files/company_tickers.json', { contact: '', fetch: f, maxBytes: 1000 })).toEqual({ ok: false, reason: 'off' });
    expect(f).not.toHaveBeenCalled();
  });
  it('maps statuses; refuses bodies over the cap and non-JSON', async () => {
    const run = (res: Response | Error, maxBytes = 1000) => secGet('https://www.sec.gov/files/company_tickers.json', { contact: CONTACT, fetch: async () => (res instanceof Error ? Promise.reject(res) : res), maxBytes });
    expect(await run(new Response('', { status: 429 }))).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(await run(new Response('', { status: 403 }))).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(await run(new Response('', { status: 404 }))).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run(new Response('', { status: 503 }))).toMatchObject({ ok: false, reason: 'server' });
    expect(await run(new Response('', { status: 301 }))).toMatchObject({ ok: false, reason: 'bad_answer' });
    expect(await run(new Error('boom'))).toMatchObject({ ok: false, reason: 'network' });
    expect(await run(new Response('{not json', { status: 200 }))).toMatchObject({ ok: false, reason: 'bad_answer' });
    expect(await run(new Response(JSON.stringify({ x: 'y'.repeat(2000) }), { status: 200 }))).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('SIC → SPDR sector fund', () => {
  it('maps the documented ranges, first match wins', () => {
    const s = (sic: string | null) => sectorForSic(sic)?.symbol ?? null;
    expect(s('3571')).toBe('XLK');
    expect(s('3674')).toBe('XLK');
    expect(s('7372')).toBe('XLK');
    expect(s('2834')).toBe('XLV');
    expect(s('8062')).toBe('XLV');
    expect(s('6022')).toBe('XLF');
    expect(s('6798')).toBe('XLRE'); // REITs before financials
    expect(s('6324')).toBe('XLV'); // health insurers before financials
    expect(s('3826')).toBe('XLV'); // lab instruments before industrial instruments
    expect(s('3823')).toBe('XLI');
    expect(s('1311')).toBe('XLE');
    expect(s('2911')).toBe('XLE');
    expect(s('4922')).toBe('XLE'); // gas pipelines before utilities
    expect(s('4911')).toBe('XLU');
    expect(s('2080')).toBe('XLP');
    expect(s('5411')).toBe('XLP');
    expect(s('5961')).toBe('XLY');
    expect(s('3711')).toBe('XLY');
    expect(s('4813')).toBe('XLC');
    expect(s('3721')).toBe('XLI');
    expect(s('2821')).toBe('XLB');
    expect(s('9995')).toBeNull();
    expect(s(null)).toBeNull();
    expect(s('abc')).toBeNull();
    expect(sectorForSic('3571')?.name).toBe('Technology Select Sector SPDR Fund');
  });
  it('answer caps: 32 MB for submissions and facts', () => {
    expect(SEC_MAX_BYTES.submissions).toBe(32 * 1024 * 1024);
    expect(SEC_MAX_BYTES.facts).toBe(32 * 1024 * 1024);
  });
  it('every range is well formed', () => {
    for (const [a, b] of SIC_SECTOR_TABLE) expect(a <= b && a >= 100 && b <= 9999).toBe(true);
  });
});
