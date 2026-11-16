import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { externalMerchantId } from '../engine/merchant.js';
import { ensureAccount } from './accounts.js';
import { openDb } from './db.js';
import { pruneData, RETENTION, slimPayload } from './retention.js';

// security research P2-10: data kept only as long as finc needs it (limits chosen 2026-11-16)

const NOW = new Date('2026-11-16T03:20:00Z');
const dir = mkdtempSync(path.join(tmpdir(), 'finc-retention-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const maxPayload = {
  status: 'completed',
  date: '2024-05-01T00:00:00.000Z',
  chargedAmount: -120.5,
  originalAmount: -120.5,
  originalCurrency: 'ILS',
  type: 'normal',
  description: 'העברה לדנה כהן',
  memo: 'שכירות מאי',
  identifier: 'abc123',
  rawTransaction: { planName: 'חיוב עסקות מיידי', merchantData: { merchantNumber: 'SKY1', merchant: 'SKYWAY' }, cardUniqueId: '4580000011112222', comments: 'personal note' },
};

function setup() {
  const db = openDb(':memory:');
  const acc = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
  const c = db.$client;
  const raw = c.prepare(`insert into raw_transaction (account_id, source, source_hash, payload_json, first_seen_at, last_seen_at) values (?, 'scraper:max', ?, ?, ?, ?)`);
  raw.run(acc, 'old', JSON.stringify(maxPayload), '2024-05-02T00:00:00Z', '2024-06-01T00:00:00Z');
  raw.run(acc, 'new', JSON.stringify(maxPayload), '2026-05-02T00:00:00Z', '2026-06-01T00:00:00Z');
  const alert = c.prepare(`insert into alert_log (type, key, channel, text, ok, sent_at) values ('big_purchase', ?, 'telegram', 'x', 1, ?)`);
  alert.run('a-old', '2025-10-01T00:00:00Z');
  alert.run('a-new', '2026-10-01T00:00:00Z');
  const ai = c.prepare(`insert into ai_suggestion (merchant_id, provider, model, category_id, confidence, sent_json, created_at) values (1, 'p', 'm', null, 0.9, '{"key":"shop"}', ?)`);
  ai.run('2026-07-01T00:00:00Z');
  ai.run('2026-11-01T00:00:00Z');
  return db;
}

describe('data retention', () => {
  it('slims raw payloads older than 24 months to what the engine reads, and keeps the row', () => {
    const db = setup();
    const r = pruneData(db, NOW, dir);
    expect(r.rawSlimmed).toBe(1);
    const rows = db.$client.prepare('select source_hash h, payload_json p from raw_transaction order by id').all() as Array<{ h: string; p: string }>;
    expect(rows).toHaveLength(2);
    const old = JSON.parse(rows[0]!.p);
    for (const secret of ['דנה', 'שכירות', 'abc123', '4580000011112222', 'personal note']) expect(rows[0]!.p).not.toContain(secret);
    expect(old).toMatchObject({ _slim: true, status: 'completed', chargedAmount: -120.5, rawTransaction: { planName: 'חיוב עסקות מיידי' } });
    expect(externalMerchantId('scraper:max', old)).toBe('SKY1');
    expect(JSON.parse(rows[1]!.p).description).toBe('העברה לדנה כהן'); // newer than 24 months: untouched
    expect(pruneData(db, NOW, dir).rawSlimmed).toBe(0); // idempotent
  });

  it('keeps 12 months of alerts and clears what was sent to the AI after 90 days, keeping the answer', () => {
    const db = setup();
    const r = pruneData(db, NOW, dir);
    expect(r).toMatchObject({ alertsDeleted: 1, aiSentCleared: 1 });
    expect((db.$client.prepare('select key from alert_log').all() as Array<{ key: string }>).map((x) => x.key)).toEqual(['a-new']);
    const ai = db.$client.prepare('select sent_json s, confidence c from ai_suggestion order by id').all() as Array<{ s: string; c: number }>;
    expect(ai.map((x) => x.s)).toEqual(['{"pruned":true}', '{"key":"shop"}']);
    expect(ai[0]!.c).toBe(0.9);
  });

  it('deletes an import file only 30 days after an import of those exact bytes succeeded', () => {
    const db = setup();
    const imports = mkdtempSync(path.join(dir, 'imports-'));
    const write = (name: string, body: string) => {
      writeFileSync(path.join(imports, name), body);
      return createHash('sha256').update(body).digest('hex').slice(0, 12);
    };
    const run = db.$client.prepare(`insert into sync_run (institution_id, source, trigger, started_at, ended_at, status, meta_json) values ('max', 'import:max', 'import', ?, ?, ?, ?)`);
    run.run('2026-09-01T00:00:00Z', '2026-09-01T00:01:00Z', 'ok', JSON.stringify({ fileHash: write('old-ok.csv', 'a,b\n1,2\n') }));
    run.run('2026-11-10T00:00:00Z', '2026-11-10T00:01:00Z', 'ok', JSON.stringify({ fileHash: write('recent.csv', 'c,d\n3,4\n') }));
    run.run('2026-09-01T00:00:00Z', '2026-09-01T00:01:00Z', 'error', JSON.stringify({ fileHash: write('failed.csv', 'e,f\n5,6\n') }));
    write('never-imported.csv', 'g,h\n7,8\n');
    expect(pruneData(db, NOW, imports).importFilesDeleted).toBe(1);
    expect(existsSync(path.join(imports, 'old-ok.csv'))).toBe(false);
    for (const kept of ['recent.csv', 'failed.csv', 'never-imported.csv']) expect(existsSync(path.join(imports, kept)), kept).toBe(true);
  });

  it('the limits are the ones the owner chose', () => {
    expect(RETENTION).toEqual({ rawPayloadMonths: 24, alertLogMonths: 12, aiSentDays: 90, importFileDays: 30 });
    expect(slimPayload(null)).toEqual({ _slim: true });
  });
});
