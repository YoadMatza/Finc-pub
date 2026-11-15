/**
 * Group-level monthly targets (one number for "lifestyle", say) kept in the settings table as
 * `target.group.<group>` in agorot. The research behind Phase 4b's UI pass favours one broad
 * discretionary target over many narrow category targets, so a group target wins over the sum of
 * its categories' targets when both exist.
 */
import type { Db } from '../db/db.js';
import { getSetting, setSetting } from '../ai/settings.js';

const PREFIX = 'target.group.';

export function groupTargets(db: Db): Map<string, number> {
  const rows = db.$client.prepare(`select key, value from setting where key like ?`).all(`${PREFIX}%`) as Array<{ key: string; value: string }>;
  const out = new Map<string, number>();
  for (const r of rows) {
    const n = Number(r.value);
    if (Number.isFinite(n) && n > 0) out.set(r.key.slice(PREFIX.length), Math.round(n));
  }
  return out;
}

export function getGroupTarget(db: Db, group: string): number | null {
  const v = getSetting(db, PREFIX + group);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export function setGroupTarget(db: Db, group: string, amount: number | null): void {
  if (!/^[a-z_]+$/.test(group)) throw new Error(`group key ${group} is unknown`);
  setSetting(db, PREFIX + group, amount && amount > 0 ? String(Math.round(amount)) : null);
}

/**
 * The target that counts for a group: the explicit group target, else the sum of its tracked
 * categories' targets, else undefined.
 */
export function effectiveGroupTargets(db: Db): Map<string, { target: number; basis: 'group' | 'categories' }> {
  const out = new Map<string, { target: number; basis: 'group' | 'categories' }>();
  const cats = db.$client.prepare(`select group_key g, sum(monthly_target) t from category where monthly_target is not null and track = 1 group by group_key`).all() as Array<{ g: string; t: number }>;
  for (const r of cats) out.set(r.g, { target: r.t, basis: 'categories' });
  for (const [g, t] of groupTargets(db)) out.set(g, { target: t, basis: 'group' });
  return out;
}
