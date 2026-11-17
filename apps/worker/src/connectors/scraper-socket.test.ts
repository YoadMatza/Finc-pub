import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScrapeJob, ScrapeOutput, Scraper } from './scrape.js';
import { checkJob, scraperClient, serveScraper } from './scraper-socket.js';

// The scraper container's job protocol (scraper-container.md step 2), over a real socket: a Unix socket on Linux, a
// named pipe on Windows. Made-up fields only.

const sockPath = () => (process.platform === 'win32' ? `\\\\.\\pipe\\finc-scraper-test-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(mkdtempSync(path.join(tmpdir(), 'finc-scr-')), 's.sock'));
const JOB: ScrapeJob = { institutionId: 'max', fields: { username: 'demo-user', password: 'demo-pass' }, monthsBack: 3, showBrowser: false, explore: false, debug: false };
const OUT: ScrapeOutput = { scraped: { success: true, accounts: [{ accountNumber: '0000', txns: [] }] } as never };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function serve(scrape: Scraper) {
  const p = sockPath();
  const s = await serveScraper(scrape, p);
  closers.push(s.close);
  return p;
}

describe('scraper socket', () => {
  it('runs a job and returns the result; the fields reach the scraper and nothing else does', async () => {
    let seen: ScrapeJob | null = null;
    const p = await serve(async (job) => {
      seen = { ...job, fields: { ...job.fields } };
      return OUT;
    });
    const out = await scraperClient(p)(JOB, async () => '000000');
    expect(out).toEqual(OUT);
    expect(seen).toEqual(JOB);
  });

  it('relays a one-time code from the worker to the scraper', async () => {
    const p = await serve(async (_job, otp) => {
      const code = await otp({ institutionId: 'max' });
      return { scraped: { success: code === '123456' } as never };
    });
    const asked: string[] = [];
    const out = await scraperClient(p)(JOB, async ({ institutionId }) => {
      asked.push(institutionId);
      return '123456';
    });
    expect(asked).toEqual(['max']);
    expect(out.scraped.success).toBe(true);
  });

  it('a scraper failure comes back as an error; a missing scraper says so', async () => {
    const p = await serve(async () => {
      throw new Error('navigation timeout');
    });
    await expect(scraperClient(p)(JOB, async () => '1')).rejects.toThrow(/scraper: navigation timeout/);
    await expect(scraperClient(sockPath())(JOB, async () => '1')).rejects.toThrow(/not running|scraper connection/);
  });

  it('one job at a time: a second connection while busy is refused', async () => {
    let release: () => void = () => undefined;
    const p = await serve(() => new Promise((r) => (release = () => r(OUT))));
    const first = scraperClient(p)(JOB, async () => '1');
    await new Promise((r) => setTimeout(r, 50));
    await expect(scraperClient(p)(JOB, async () => '1')).rejects.toThrow(/busy/);
    release();
    await expect(first).resolves.toEqual(OUT);
  });

  it('a job is checked strictly before it runs', () => {
    expect(checkJob(JOB)).toEqual(JOB);
    for (const bad of [
      { ...JOB, institutionId: 'riseup' },
      { ...JOB, fields: { 'bad key': 'x' } },
      { ...JOB, fields: { password: 'x'.repeat(500) } },
      { ...JOB, fields: { a: 1 } },
      { ...JOB, monthsBack: 999 },
      { ...JOB, showBrowser: 'yes' },
      { ...JOB, timeoutMs: 10 },
      null,
      [JOB],
    ])
      expect(checkJob(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
  });
});
