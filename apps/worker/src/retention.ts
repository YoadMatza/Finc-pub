/**
 * Debug material has a shelf life (security audit 2026-11-09, M4): raw scraper dumps and failure screenshots
 * under data/ hold bank pages and full statements. Anything older than the retention window is deleted
 * when the worker starts and once a day after that.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { dumpsDir, screenshotsDir } from '@finc/core';
import { log } from './logger.js';

export const RETENTION_DAYS = 14;

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
