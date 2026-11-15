/**
 * The security log (security research P1-08): an append-only record of security-relevant events, so that after a
 * suspected break-in "did anyone get in, from where, what did they change?" has an answer.
 *
 * - Append-only: triggers in migration 0013 refuse UPDATE and DELETE on security_event.
 * - Never secrets: callers pass kinds, actors, names and small structured details; tokens, PINs, passwords, codes,
 *   amounts and merchant names never go in. As a last line of defence, anything shaped like a device token or a
 *   Telegram bot token is masked here, and the detail is cut to DETAIL_MAX characters.
 * - Never throws: a failing write is logged to stderr and dropped; the action that caused it carries on.
 * - Aggregation: a noisy kind (failures from the internet) is written at most once per kind+address per minute, and
 *   every event whose actor is a paired device or a passkey session at most once per kind+actor+address per minute (a stolen
 *   token must not be able to grow the table without limit).
 *   The first one in a window is written at once; repeats inside the window are only counted. The next occurrence
 *   after the window carries that count in its detail (`repeats`); if none comes, the count is written as its own row
 *   (detail `{"repeats": n, "summary": true}`) within about two minutes (flushSecurityEvents, run by a timer).
 * - Retention: none for now; rows are tiny.
 */
import type { Db } from '../db/db.js';

export const SECURITY_DETAIL_MAX = 500;
/** an aggregation window */
export const SECURITY_AGGREGATE_MS = 60_000;
/** more distinct kind+address keys than this inside a window fold into one key per kind (address '*') */
const MAX_KEYS = 500;

export interface SecurityEventInput {
  kind: string;
  /** 'pc' | 'device:<id>' | 'passkey:<id>' | 'telegram' | 'cli' | 'control' | 'public' | 'system' */
  actor: string;
  actorName?: string | null | undefined;
  address?: string | null | undefined;
  /** short text, or an object written as JSON */
  detail?: string | Record<string, unknown> | null | undefined;
  /** high-volume failure: at most one row per kind+address per minute (see above) */
  aggregate?: boolean | undefined;
  /** the time of the event (tests); default now */
  at?: Date | number | undefined;
}

export interface SecurityEventRow {
  id: number;
  at: string;
  kind: string;
  actor: string;
  actorName: string | null;
  address: string | null;
  detail: string | null;
}

interface Window {
  kind: string;
  actor: string;
  actorName: string | null;
  address: string | null;
  start: number;
  /** occurrences inside the window after the first (not written yet) */
  repeats: number;
}

interface Aggregator {
  windows: Map<string, Window>;
  timer: NodeJS.Timeout | null;
}

const aggregators = new WeakMap<Db, Aggregator>();

/** Device tokens (finc_dev_…), Telegram bot tokens (123456:ABC…) and bearer values never reach the table. */
function mask(s: string): string {
  return s
    .replace(/finc_dev_[A-Za-z0-9_-]+/g, 'finc_dev_[masked]')
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[masked bot token]')
    .replace(/(bearer\s+)[^\s"',;]+/gi, '$1[masked]');
}

function clip(s: string | null | undefined, max: number): string | null {
  if (s === null || s === undefined) return null;
  const t = mask(String(s)).replace(/[\r\n\t]+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function detailText(d: SecurityEventInput['detail'], extra?: Record<string, unknown>): string | null {
  if (d === null || d === undefined) return extra ? clip(JSON.stringify(extra), SECURITY_DETAIL_MAX) : null;
  if (typeof d === 'string') return clip(extra ? `${d} ${JSON.stringify(extra)}` : d, SECURITY_DETAIL_MAX);
  let json: string;
  try {
    json = JSON.stringify(extra ? { ...d, ...extra } : d);
  } catch {
    json = '"(detail could not be written)"';
  }
  return clip(json, SECURITY_DETAIL_MAX);
}

const toMs = (at: Date | number | undefined): number => (at === undefined ? Date.now() : typeof at === 'number' ? at : at.getTime());

function insert(db: Db, row: Omit<SecurityEventRow, 'id'>): void {
  db.$client.prepare('insert into security_event (at, kind, actor, actor_name, address, detail) values (?, ?, ?, ?, ?, ?)').run(row.at, row.kind, row.actor, row.actorName, row.address, row.detail);
}

function warn(e: unknown): void {
  try {
    process.stderr.write(`${JSON.stringify({ level: 'warn', msg: 'security log: an event could not be written', err: (e instanceof Error ? e.message : String(e)).slice(0, 200) })}\n`);
  } catch {
    // nothing left to tell
  }
}

function aggregatorOf(db: Db): Aggregator {
  let a = aggregators.get(db);
  if (!a) {
    a = { windows: new Map(), timer: null };
    aggregators.set(db, a);
  }
  return a;
}

function ensureTimer(db: Db, a: Aggregator): void {
  if (a.timer) return;
  a.timer = setInterval(() => {
    flushSecurityEvents(db);
    if (!a.windows.size && a.timer) {
      clearInterval(a.timer);
      a.timer = null;
    }
  }, SECURITY_AGGREGATE_MS);
  a.timer.unref?.();
}

function summaryRow(w: Window, at: number): Omit<SecurityEventRow, 'id'> {
  return { at: new Date(at).toISOString(), kind: w.kind, actor: w.actor, actorName: w.actorName, address: w.address, detail: detailText({ repeats: w.repeats, summary: true, since: new Date(w.start).toISOString() }) };
}

/**
 * Append one event. Never throws. With `aggregate`, at most one row per kind+address per minute (see the file header).
 */
export function recordSecurityEvent(db: Db, e: SecurityEventInput): void {
  try {
    const now = toMs(e.at);
    const kind = clip(e.kind, 40) ?? 'unknown';
    const actor = clip(e.actor, 60) ?? 'system';
    const actorName = clip(e.actorName, 80);
    let address = clip(e.address, 64);
    let extra: Record<string, unknown> | undefined;
    const byActor = /^(device|passkey):/.test(actor);
    if (e.aggregate || byActor) {
      const a = aggregatorOf(db);
      // a device or passkey per kind and address: a stolen token used from a new place is written at once, a flood is not
      let key = byActor ? `${kind}|actor:${actor}|${address ?? ''}` : `${kind}|${address ?? ''}`;
      if (!a.windows.has(key) && a.windows.size >= MAX_KEYS) {
        // too many distinct addresses: fold into one key for the kind (an address-hopping flood stays one row a minute)
        flushSecurityEvents(db, now);
        if (a.windows.size >= MAX_KEYS) {
          address = '*';
          key = `${kind}|*`;
        }
      }
      const w = a.windows.get(key);
      if (w && now - w.start < SECURITY_AGGREGATE_MS) {
        w.repeats++;
        return;
      }
      if (w && w.repeats > 0) extra = { repeats: w.repeats, since: new Date(w.start).toISOString() };
      a.windows.set(key, { kind, actor, actorName, address, start: now, repeats: 0 });
      ensureTimer(db, a);
    }
    insert(db, { at: new Date(now).toISOString(), kind, actor, actorName, address, detail: detailText(e.detail, extra) });
  } catch (err) {
    warn(err);
  }
}

/**
 * Write the counts of aggregation windows that ended (two minutes old: no occurrence took the count over) with repeats nobody has reported yet, and forget
 * them. `all` flushes every window with repeats regardless of age (shutdown). Never throws.
 */
export function flushSecurityEvents(db: Db, now: number = Date.now(), all = false): void {
  const a = aggregators.get(db);
  if (!a) return;
  for (const [key, w] of a.windows) {
    // two windows: a flood that goes on hands its count to the next occurrence instead (one row a minute)
    if (!all && now - w.start < 2 * SECURITY_AGGREGATE_MS) continue;
    a.windows.delete(key);
    if (w.repeats > 0) {
      try {
        insert(db, summaryRow(w, now));
      } catch (err) {
        warn(err);
      }
    }
  }
  if (all && a.timer) {
    clearInterval(a.timer);
    a.timer = null;
  }
}

/** Newest first. `limit` 1..200 (default 50); `beforeId` pages back; `kind` filters. */
export function listSecurityEvents(db: Db, opts: { limit?: number; beforeId?: number; kind?: string } = {}): { events: SecurityEventRow[]; nextBefore: number | null } {
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.beforeId !== undefined) {
    where.push('id < ?');
    args.push(opts.beforeId);
  }
  if (opts.kind) {
    where.push('kind = ?');
    args.push(opts.kind);
  }
  const rows = db.$client
    .prepare(`select id, at, kind, actor, actor_name actorName, address, detail from security_event ${where.length ? `where ${where.join(' and ')}` : ''} order by id desc limit ?`)
    .all(...args, limit + 1) as SecurityEventRow[];
  const more = rows.length > limit;
  const events = more ? rows.slice(0, limit) : rows;
  return { events, nextBefore: more ? events[events.length - 1]!.id : null };
}
