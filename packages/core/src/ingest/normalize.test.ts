import { describe, expect, it } from 'vitest';
import { assignOccurrences, endOfLocalDayIso, fingerprint, isoToLocalDate, normalizeDescription, sourceHash, toMinor } from './normalize.js';

describe('toMinor', () => {
  it('is exact for 2-decimal floats', () => {
    expect(toMinor(192.6)).toBe(19260);
    expect(toMinor(-89.9)).toBe(-8990);
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor(undefined)).toBeUndefined();
  });
});

describe('isoToLocalDate', () => {
  it('converts scraper local-midnight ISO strings to the Israel calendar day', () => {
    expect(isoToLocalDate('2026-10-02T21:00:00.000Z')).toBe('2026-10-03'); // IDT, UTC+3
    expect(isoToLocalDate('2026-11-06T22:00:00.000Z')).toBe('2026-11-07'); // IST, UTC+2
    expect(isoToLocalDate('2026-11-07')).toBe('2026-11-07');
  });
});

describe('endOfLocalDayIso', () => {
  it('lands on the same Israel calendar day, summer and winter', () => {
    expect(endOfLocalDayIso('2026-08-10')).toBe('2026-08-10T20:59:59.000Z'); // IDT +3
    expect(endOfLocalDayIso('2026-12-10')).toBe('2026-12-10T21:59:59.000Z'); // IST +2
    expect(isoToLocalDate(endOfLocalDayIso('2026-08-10'))).toBe('2026-08-10');
  });
});

describe('normalizeDescription', () => {
  it('makes scraper and RiseUp spellings hash alike', () => {
    expect(normalizeDescription('חשמל כהן בע"מ')).toBe(normalizeDescription('חשמל כהן בעמ'));
    expect(normalizeDescription('  SP* STREAMLY   STREAMLY.CO US ')).toBe('sp streamly streamly.co us');
    expect(normalizeDescription('סופר אלונית -דור חולון')).toBe('סופר אלונית -דור חולון');
  });
  it('does not merge different merchants', () => {
    expect(normalizeDescription('אלונית חולון')).not.toBe(normalizeDescription('אלונית תל אביב'));
  });
});

describe('occurrences and hashes', () => {
  const base = { date: '2026-10-03', amount: -8990, descriptionNorm: 'x' };
  it('numbers identical rows 0,1,2 in order', () => {
    const rows = assignOccurrences([base, { ...base }, { ...base, amount: -1 }, { ...base }]);
    expect(rows.map((r) => r.occurrence)).toEqual([0, 1, 0, 2]);
  });
  it('sourceHash differs by identifier and occurrence; fingerprint ignores identifier', () => {
    const p = { source: 's', externalAccountId: 'a', ...base, occurrence: 0 };
    expect(sourceHash({ ...p, identifier: '1' })).not.toBe(sourceHash({ ...p, identifier: '2' }));
    expect(sourceHash(p)).not.toBe(sourceHash({ ...p, occurrence: 1 }));
    const f = { accountId: 1, ...base, occurrence: 0 };
    expect(fingerprint(f)).toBe(fingerprint(f));
    expect(fingerprint(f)).not.toBe(fingerprint({ ...f, occurrence: 1 }));
    expect(fingerprint(f)).not.toBe(fingerprint({ ...f, accountId: 2 }));
  });
});
