/**
 * Debug material has a shelf life (security audit 2026-11-09, M4): raw scraper dumps and failure screenshots
 * under data/ hold bank pages and full statements. Anything older than the retention window is deleted
 * when the worker starts and once a day after that.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { type Db, dumpsDir, pruneData, recordSecurityEvent, RETENTION, screenshotsDir } from '@finc/core';
import { log } from './logger.js';

export const RETENTION_DAYS = 14;

/**
 * The nightly data retention (security research P2-10, core db/retention.ts). Whatever it removed goes to the security
 * log as counts. Never throws: retention must not stop the worker.
 */
export function pruneOldData(db: Db, now = new Date()): void {
  try {
    const r = pruneData(db, now);
    if (r.rawSlimmed + r.alertsDeleted + r.aiSentCleared + r.importFilesDeleted === 0) return;
    log.info({ ...r }, 'retention: old data trimmed');
    recordSecurityEvent(db, { kind: 'data.retention', actor: 'system', detail: { ...r, limits: RETENTION } });
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'retention: data pruning failed');
  }
}

export function pruneDebugFiles(days = RETENTION_DAYS, now = Date.now()): number {
  let removed = 0;
  for (const dir of [dumpsDir(), screenshotsDir()]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const st = statSync(file);
        if (st.isFile() && now - st.mtimeMs > days * 86_400_000) {
          unlinkSync(file);
          removed++;
        }
      } catch {
        /* gone already */
      }
    }
  }
  if (removed) log.info({ removed, days }, 'retention: old dumps and screenshots deleted');
  return removed;
}
