import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dumpReport, safeMemo, sampleName } from './dump-report.js';

const dir = mkdtempSync(path.join(tmpdir(), 'finc-dump-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const txn = (description: string, chargedAmount: number, extra: Record<string, unknown> = {}) => ({
  type: 'normal',
  status: 'completed',
  date: '2026-10-05T00:00:00.000Z',
  processedDate: '2026-11-02T00:00:00.000Z',
  originalAmount: chargedAmount,
  originalCurrency: 'ILS',
  chargedAmount,
  description,
  memo: '',
  ...extra,
});

function write(name: string, body: unknown): string {
  const f = path.join(dir, name);
  writeFileSync(f, JSON.stringify(body));
  return f;
}

describe('dump report (security research P2-11)', () => {
  it('never prints a raw bank-side description, a balance or an unmasked account number', () => {
    const f = write('beinleumi-2026-11-16T07-00-00.json', {
      success: true,
      accounts: [
        {
          accountNumber: '12-345-678901',
          balance: 54321.09,
          txns: [txn('העברה לדנה כהן 987654321', -120000), txn('משכורת חברת דוגמה', 1500000), txn('בביט לאבי', -5000, { status: 'pending' })],
        },
      ],
    });
    const out = dumpReport(f);
    for (const secret of ['דנה', 'כהן', '987654321', 'חברת דוגמה', 'אבי', '54321', '678901']) expect(out).not.toContain(secret);
    expect(out).toContain('balance: present');
    expect(out).not.toMatch(/sum of charged/);
    expect(out).toMatch(/read it before sharing/);
  });

  it('keeps a card merchant name without its digit runs', () => {
    expect(sampleName({ description: 'SUPER YUDA 0042117', chargedAmount: -8900 }, true)).toBe('SUPER YUDA');
    expect(sampleName({ description: 'SUPER YUDA 0042117', chargedAmount: -8900 }, false)).not.toContain('YUDA');
    expect(sampleName({ description: 'PAYBOX דני', chargedAmount: -3000 }, true)).not.toContain('דני');
  });

  it('cleans the error message', () => {
    const f = write('max-2026-11-16T07-00-00.json', { success: false, errorType: 'GENERIC', errorMessage: 'failed at https://x.example/login?user=4580123412341234&t=abc' });
    const out = dumpReport(f);
    expect(out).not.toContain('4580123412341234');
    expect(out).not.toContain('user=');
  });

  it('hides memos unless they are a known safe shape', () => {
    expect(safeMemo('תשלום 2 מתוך 6')).toBe('תשלום 2 מתוך 6');
    expect(safeMemo('לדנה על הארוחה')).toBe('[memo 14 chars]');
  });
});
