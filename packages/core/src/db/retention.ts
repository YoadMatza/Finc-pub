/**
 * Data retention (security research P2-10; limits chosen by the owner 2026-11-16). Every extra copy of bank data is
 * something to leak, so what finc only needed for a while is cut back once a night:
 *
 * - raw bank payloads (raw_transaction.payload_json) older than 24 months keep only the fields the engine still reads
 *   (status, dates, amounts, currency, type, the card plan name and the source's merchant id); descriptions, memos and
 *   everything else go. The row itself stays: ingest needs it to recognise a charge it has already seen.
 * - the alert log keeps 12 months;
 * - what was sent to the AI for a merchant (ai_suggestion.sent_json) is cleared after 90 days; the answer stays;
 * - statement files in data/imports are deleted 30 days after an import of that exact file succeeded.
 *
 * The transactions themselves, balances, the security log and backups are not touched.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { importsDir } from '../config/paths.js';
import type { Db } from './db.js';

export const RETENTION = { rawPayloadMonths: 24, alertLogMonths: 12, aiSentDays: 90, importFileDays: 30 } as const;

/** The payload fields the engine reads (ingest, merchants, settlement, the raw cross-check). */
export function slimPayload(payload: unknown): Record<string, unknown> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { _slim: true };
  for (const k of ['status', 'date', 'processedDate', 'chargedAmount', 'chargedCurrency', 'originalAmount', 'originalCurrency', 'type']) if (p[k] !== undefined) out[k] = p[k];
  const raw = p.rawTransaction as Record<string, unknown> | undefined;
  if (raw && typeof raw === 'object') {
    const keep: Record<string, unknown> = {};
    if (raw.planName !== undefined) keep.planName = raw.planName;
    if (raw.supplierId !== undefined) keep.supplierId = raw.supplierId;
    const md = raw.merchantData as Record<string, unknown> | undefined;
    if (md && typeof md === 'object' && (md.merchantNumber !== undefined || md.merchant !== undefined)) keep.merchantData = { merchantNumber: md.merchantNumber, merchant: md.merchant };
    out.rawTransaction = keep;
  }
  return out;
}

const minusMonths = (now: Date, n: number): string => {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString();
};

export interface RetentionResult {
  rawSlimmed: number;
  alertsDeleted: number;
  aiSentCleared: number;
  importFilesDeleted: number;
}

export function pruneData(db: Db, now: Date = new Date(), dir: string = importsDir()): RetentionResult {
  const c = db.$client;
  const res: RetentionResult = { rawSlimmed: 0, alertsDeleted: 0, aiSentCleared: 0, importFilesDeleted: 0 };
  const rawCutoff = minusMonths(now, RETENTION.rawPayloadMonths);
  const old = c.prepare(`select id, payload_json p from raw_transaction where last_seen_at < ? and json_extract(payload_json, '$._slim') is null`).all(rawCutoff) as Array<{ id: number; p: string }>;
  const upd = c.prepare('update raw_transaction set payload_json = ? where id = ?');
  c.transaction(() => {
    for (const r of old) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(r.p);
      } catch {
        /* unreadable: slimmed to nothing */
      }
      upd.run(JSON.stringify(slimPayload(parsed)), r.id);
      res.rawSlimmed++;
    }
    res.alertsDeleted = c.prepare('delete from alert_log where sent_at < ?').run(minusMonths(now, RETENTION.alertLogMonths)).changes;
    res.aiSentCleared = c
      .prepare(`update ai_suggestion set sent_json = '{"pruned":true}' where created_at < ? and sent_json <> '{"pruned":true}'`)
      .run(new Date(now.getTime() - RETENTION.aiSentDays * 86_400_000).toISOString()).changes;
  })();

  // statement files: only those an import of the same bytes finished successfully, and only 30 days after that
  const imported = new Map<string, string>();
  for (const r of c.prepare(`select ended_at e, json_extract(meta_json, '$.fileHash') h from sync_run where trigger = 'import' and status = 'ok' and meta_json is not null`).all() as Array<{ e: string | null; h: string | null }>) {
    if (r.h && r.e && (!imported.has(r.h) || r.e > imported.get(r.h)!)) imported.set(r.h, r.e);
  }
  const fileCutoff = new Date(now.getTime() - RETENTION.importFileDays * 86_400_000).toISOString();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    /* no imports folder */
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
      const at = imported.get(hash);
      if (at && at < fileCutoff) {
        unlinkSync(file);
        res.importFilesDeleted++;
      }
    } catch {
      /* gone or unreadable: left alone */
    }
  }
  return res;
}
