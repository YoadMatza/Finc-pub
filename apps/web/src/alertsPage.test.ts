import { describe, expect, it } from 'vitest';
import { cleanCode, countdown, mergeRecent, otpPollMs, pushStatus, stripTags, validCode, type RecentAlert } from './alertsPage';

const row = (o: Partial<RecentAlert> & { id: number }): RecentAlert => ({ type: 'big_purchase', key: `k${o.id}`, channel: 'telegram', text: 'x', ok: true, error: null, sentAt: '2026-11-17T10:00:00Z', ...o });

describe('stripTags', () => {
  it('drops simple tags and decodes entities', () => {
    expect(stripTags('<b>₪1,200</b> at <i>Shop &amp; Co</i>')).toBe('₪1,200 at Shop & Co');
    expect(stripTags('<a href="https://x">open</a>')).toBe('open');
    expect(stripTags('line one<br/>line two')).toBe('line one\nline two');
  });
  it('keeps a lone < that is not a tag', () => {
    expect(stripTags('spent < 100 &lt;b&gt;')).toBe('spent < 100 <b>');
  });
});

describe('mergeRecent', () => {
  it('newest first; the same key on both channels is one row with both marks', () => {
    const r = mergeRecent([
      row({ id: 1, key: 'a', channel: 'telegram', sentAt: '2026-11-17T09:00:00Z', text: '<b>A</b>' }),
      row({ id: 2, key: 'a', channel: 'push', sentAt: '2026-11-17T09:00:01Z', text: '<b>A</b>' }),
      row({ id: 3, key: 'b', channel: 'push', sentAt: '2026-11-17T11:00:00Z' }),
    ]);
    expect(r.map((m) => m.key)).toEqual(['b', 'a']);
    expect(r[1]?.text).toBe('A');
    expect(r[1]?.id).toBe(2);
    expect(r[1]?.channels.map((c) => c.channel)).toEqual(['push', 'telegram']);
    expect(r[1]?.failed).toBe(false);
  });
  it('failed only when no channel delivered; a channel retried ok counts as ok', () => {
    const r = mergeRecent([
      row({ id: 1, key: 'a', channel: 'push', ok: false, error: 'no device' }),
      row({ id: 2, key: 'a', channel: 'telegram', ok: false, error: '429' }),
      row({ id: 3, key: 'b', channel: 'push', ok: false, error: 'x', sentAt: '2026-11-17T08:00:00Z' }),
      row({ id: 4, key: 'b', channel: 'push', ok: true, sentAt: '2026-11-17T08:01:00Z' }),
    ]);
    const a = r.find((m) => m.key === 'a');
    const b = r.find((m) => m.key === 'b');
    expect(a?.failed).toBe(true);
    expect(a?.channels.every((c) => !c.ok)).toBe(true);
    expect(b?.failed).toBe(false);
    expect(b?.channels).toEqual([{ channel: 'push', ok: true, error: null }]);
  });
  it('rows without a key are never merged', () => {
    expect(mergeRecent([row({ id: 1, key: '' }), row({ id: 2, key: '' })])).toHaveLength(2);
  });
});

describe('codes', () => {
  it('4 to 8 digits, spaces ignored', () => {
    expect(validCode('1234')).toBe(true);
    expect(validCode('12345678')).toBe(true);
    expect(validCode('123 456')).toBe(true);
    expect(cleanCode(' 12 34 ')).toBe('1234');
    expect(validCode('123')).toBe(false);
    expect(validCode('123456789')).toBe(false);
    expect(validCode('12a4')).toBe(false);
    expect(validCode('')).toBe(false);
    expect(validCode('١٢٣٤')).toBe(false); // Arabic-Indic digits are not what the bank expects
  });
});

describe('countdown', () => {
  const now = Date.parse('2026-11-17T10:00:00Z');
  it('m:ss, h:mm:ss, null when expired', () => {
    expect(countdown('2026-11-17T10:04:05Z', now)).toBe('4:05');
    expect(countdown('2026-11-17T10:00:00.400Z', now)).toBe('0:01');
    expect(countdown('2026-11-17T11:02:03Z', now)).toBe('1:02:03');
    expect(countdown('2026-11-17T10:00:00Z', now)).toBeNull();
    expect(countdown('2026-11-17T09:59:00Z', now)).toBeNull();
    expect(countdown('not a date', now)).toBeNull();
  });
  it('polls fast only while a code is awaited', () => {
    expect(otpPollMs(1)).toBe(5_000);
    expect(otpPollMs(0)).toBe(30_000);
  });
});

describe('pushStatus', () => {
  it('not set up, no device, N devices', () => {
    expect(pushStatus(undefined)).toEqual({ key: 'push_status_none' });
    expect(pushStatus({ configured: false, devices: 2 })).toEqual({ key: 'push_status_none' });
    expect(pushStatus({ configured: true, devices: 0 })).toEqual({ key: 'push_status_nodevice' });
    expect(pushStatus({ configured: true, devices: 2 })).toEqual({ key: 'push_status_devices', n: 2 });
  });
});
