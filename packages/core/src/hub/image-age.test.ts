import { describe, expect, it } from 'vitest';
import { setSetting } from '../ai/settings.js';
import { alertText } from '../alerts/index.js';
import { openDb } from '../db/db.js';
import { IMAGE_BUILT_SETTING, IMAGE_MAX_AGE_DAYS, hubOverview } from './overview.js';

// security research P2-03: remind the owner to rebuild the worker image so Debian's Chromium gets security updates

const NOW = new Date('2026-11-16T10:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

describe('rebuild reminder', () => {
  it(`an image older than ${IMAGE_MAX_AGE_DAYS} days asks for a rebuild, once per build`, () => {
    const db = openDb(':memory:');
    setSetting(db, IMAGE_BUILT_SETTING, daysAgo(40));
    const item = hubOverview(db, '2026-11', 'purchase', { now: NOW }).attention.find((i) => i.kind === 'image_old');
    expect(item).toMatchObject({ key: `image:${daysAgo(40)}`, severity: 'warn', count: 40, date: daysAgo(40) });
    expect(alertText(item!, 'en')).toContain('docker compose build worker');
    expect(alertText(item!, 'he')).toContain('40');
  });

  it('a fresh image, or no build day (a host run), asks for nothing', () => {
    const db = openDb(':memory:');
    setSetting(db, IMAGE_BUILT_SETTING, daysAgo(10));
    expect(hubOverview(db, '2026-11', 'purchase', { now: NOW }).attention.some((i) => i.kind === 'image_old')).toBe(false);
    setSetting(db, IMAGE_BUILT_SETTING, null);
    expect(hubOverview(db, '2026-11', 'purchase', { now: NOW }).attention.some((i) => i.kind === 'image_old')).toBe(false);
  });
});
