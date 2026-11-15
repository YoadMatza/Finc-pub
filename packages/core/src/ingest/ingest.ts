/**
 * Ingest engine: raw upsert, dedupe, pending→completed→voided tracking, cross-source
 * annotation. Pipeline steps 2 and part of 3 in architecture §5.
 */
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { eventTxn, link, rawTransaction, transactions, txnFingerprint } from '../db/schema.js';
import { assignOccurrences, fingerprint, monthOf, normalizeDescription, sourceHash } from './normalize.js';
import { type IngestStats, type NormalizedRow, SOURCE_PRECEDENCE, sourceKind } from './types.js';

export interface IngestOptions {
  /** e.g. 'scraper:max', 'riseup', 'import:max-2026-10.xlsx' */
  source: string;
  runId: number | null;
  accountId: number;
  rows: NormalizedRow[];
  /**
   * True when `rows` is the source's complete current view of the account for the period
   * (scrapers). Enables void detection: pending rows not in this batch may be voided.
   */
  batchIsComplete?: boolean;
  /** A pending row unseen for this many days without a completed twin → voided. */
  voidAfterDays?: number;
  now?: Date;
}

type TxnRow = typeof transactions.$inferSelect;

export function ingestBatch(db: Db, opts: IngestOptions): IngestStats {
  const now = (opts.now ?? new Date()).toISOString();
  const kind = sourceKind(opts.source);
  const stats: IngestStats = { seen: opts.rows.length, new: 0, updated: 0, completed: 0, voided: 0, annotated: 0 };

  const prepared = assignOccurrences(
    opts.rows.map((r) => ({ ...r, descriptionNorm: normalizeDescription(r.description) })),
  );

  const run = db.transaction((tx) => {
    const seenTxnIds = new Set<number>();
    /** Transactions already claimed as a cross-source twin in this batch (two identical rows → two twins). */
    const claimed = new Set<number>();

    const keyed = prepared.map((r) => ({
      r,
      fp: fingerprint({
        accountId: opts.accountId,
        date: r.date,
        amount: r.amount,
        descriptionNorm: r.descriptionNorm,
        ...(r.installmentN !== undefined ? { installmentN: r.installmentN } : {}),
        occurrence: r.occurrence,
      }),
    }));
    // Security research P0-01: every transaction this batch reaches by its own fingerprint is a row the
    // source still shows, so it can never also be another incoming row's twin, whatever the row order.
    // Together with the rows created and claimed below, one batch never maps two rows onto one transaction.
    for (const { fp } of keyed) {
      const direct = findByFingerprint(tx, fp);
      if (direct) seenTxnIds.add(direct.id);
    }
    const taken = { has: (id: number) => seenTxnIds.has(id) || claimed.has(id) };

    for (const { r, fp } of keyed) {
      const hash = sourceHash({
        source: opts.source,
        externalAccountId: r.externalAccountId,
        date: r.date,
        amount: r.amount,
        descriptionNorm: r.descriptionNorm,
        ...(r.identifier !== undefined ? { identifier: r.identifier } : {}),
        ...(r.installmentN !== undefined ? { installmentN: r.installmentN } : {}),
        ...(r.installmentTotal !== undefined ? { installmentTotal: r.installmentTotal } : {}),
        occurrence: r.occurrence,
      });

      const existingRaw = tx.select().from(rawTransaction).where(eq(rawTransaction.sourceHash, hash)).get();
      let rawId: number;
      if (existingRaw) {
        tx.update(rawTransaction)
          .set({ lastSeenAt: now, lastSeenRunId: opts.runId })
          .where(eq(rawTransaction.id, existingRaw.id))
          .run();
        rawId = existingRaw.id;
      } else {
        const ins = tx
          .insert(rawTransaction)
          .values({
            accountId: opts.accountId,
            source: opts.source,
            sourceHash: hash,
            payloadJson: JSON.stringify(r.payload ?? null),
            firstSeenAt: now,
            lastSeenAt: now,
            firstSeenRunId: opts.runId,
            lastSeenRunId: opts.runId,
          })
          .run();
        rawId = Number(ins.lastInsertRowid);
      }

      let existing = findByFingerprint(tx, fp);
      if (!existing) {
        // Same account, day, amount (and installment #) from another source, spelled differently (§4a).
        const twin = findCrossSourceTwin(tx, {
          accountId: opts.accountId,
          date: r.date,
          amount: r.amount,
          ...(r.installmentN !== undefined ? { installmentN: r.installmentN } : {}),
          incomingKind: kind,
          incomingStatus: r.status,
          descriptionNorm: r.descriptionNorm,
          exclude: taken,
        });
        if (twin) {
          existing = twin;
          claimed.add(twin.id);
          tx.insert(txnFingerprint).values({ fingerprint: fp, transactionId: twin.id }).onConflictDoNothing().run();
        }
      }
      if (!existing) {
        const ins = tx
          .insert(transactions)
          .values({
            rawId,
            accountId: opts.accountId,
            source: opts.source,
            fingerprint: fp,
            txnDate: r.date,
            chargeDate: r.chargeDate ?? null,
            cashflowMonth: monthOf(r.date),
            amountIls: r.amount,
            originalAmount: r.originalAmount ?? null,
            originalCurrency: r.originalCurrency ?? 'ILS',
            descriptionRaw: r.description,
            descriptionNorm: r.descriptionNorm,
            memo: r.memo ?? null,
            identifier: r.identifier ?? null,
            status: r.status,
            txnType: r.type,
            installmentN: r.installmentN ?? null,
            installmentTotal: r.installmentTotal ?? null,
            annotationsJson: r.annotations ? JSON.stringify({ [kind]: r.annotations }) : null,
            completedAt: r.status === 'completed' ? now : null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        const newId = Number(ins.lastInsertRowid);
        tx.insert(txnFingerprint).values({ fingerprint: fp, transactionId: newId }).onConflictDoNothing().run();
        seenTxnIds.add(newId);
        stats.new++;
        continue;
      }

      seenTxnIds.add(existing.id);
      const patch = reconcile(existing, r, { rawId, source: opts.source, kind, now });
      if (patch.completed) stats.completed++;
      if (patch.annotated) stats.annotated++;
      if (patch.changed && !patch.completed && !patch.annotated) stats.updated++;
      if (patch.changed) {
        tx.update(transactions).set(patch.set).where(eq(transactions.id, existing.id)).run();
      }
    }

    if (opts.batchIsComplete) {
      const cutoff = new Date(new Date(now).getTime() - (opts.voidAfterDays ?? 7) * 86_400_000).toISOString();
      const stale = tx
        .select({ id: transactions.id, rawId: transactions.rawId })
        .from(transactions)
        .innerJoin(rawTransaction, eq(rawTransaction.id, transactions.rawId))
        .where(
          and(
            eq(transactions.accountId, opts.accountId),
            eq(transactions.status, 'pending'),
            eq(rawTransaction.source, opts.source),
            opts.runId === null ? sql`1=1` : ne(rawTransaction.lastSeenRunId, opts.runId),
            sql`${rawTransaction.lastSeenAt} < ${cutoff}`,
          ),
        )
        .all();
      for (const s of stale) {
        if (seenTxnIds.has(s.id)) continue;
        tx.update(transactions).set({ status: 'voided', voidedAt: now, updatedAt: now }).where(eq(transactions.id, s.id)).run();
        stats.voided++;
      }
    }
  });
  void run;
  return stats;
}

export type Tx = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>;

/**
 * Fold transaction `from` into `into`: its source becomes an annotation on `into`, every fingerprint
 * that resolved to `from` now resolves to `into`, and `from` is deleted. Raw rows stay untouched.
 */
export function mergeTransactionInto(tx: Tx, from: TxnRow, into: TxnRow): void {
  const kind = sourceKind(from.source);
  const ann = parseAnn(into.annotationsJson);
  const own = parseAnn(from.annotationsJson);
  ann[kind] = { ...(typeof own[kind] === 'object' && own[kind] ? (own[kind] as object) : {}), descriptionRaw: from.descriptionRaw, identifier: from.identifier, memo: from.memo, txnDate: from.txnDate };
  const set: Partial<TxnRow> = { annotationsJson: JSON.stringify(ann), updatedAt: new Date().toISOString() };
  // What the folded row knew and the survivor does not: a category (RiseUp's, or the user's), and,
  // when the two are the same source, the settlement facts of whichever of them settled. `into` keeps
  // its own source, so no ownership changes hands here and its status is never taken from a
  // lower-precedence `from` (callers fold lower into higher, or same kind into same kind).
  if (into.categoryId === null && from.categoryId !== null) Object.assign(set, { categoryId: from.categoryId, categorySource: from.categorySource, categoryConfidence: from.categoryConfidence });
  if (kind === sourceKind(into.source) && from.status === 'completed') {
    Object.assign(set, { status: 'completed', completedAt: into.completedAt ?? from.completedAt, voidedAt: null, rawId: from.rawId, identifier: from.identifier ?? into.identifier, chargeDate: from.chargeDate ?? into.chargeDate });
  }
  tx.update(transactions).set(set).where(eq(transactions.id, into.id)).run();
  tx.update(txnFingerprint).set({ transactionId: into.id }).where(eq(txnFingerprint.transactionId, from.id)).run();
  tx.insert(txnFingerprint).values({ fingerprint: from.fingerprint, transactionId: into.id }).onConflictDoNothing().run();
  tx.delete(transactions).where(eq(transactions.id, from.id)).run();
}

function findByFingerprint(tx: Tx, fp: string): TxnRow | undefined {
  const direct = tx.select().from(transactions).where(eq(transactions.fingerprint, fp)).get();
  if (direct) return direct;
  const link = tx.select().from(txnFingerprint).where(eq(txnFingerprint.fingerprint, fp)).get();
  if (!link) return undefined;
  return tx.select().from(transactions).where(eq(transactions.id, link.transactionId)).get();
}

export interface TwinQuery {
  accountId: number;
  date: string;
  amount: number;
  installmentN?: number;
  /** Source kind of the incoming row; candidates must come from a different kind. */
  incomingKind: ReturnType<typeof sourceKind>;
  /** Status of the incoming row: only a completed row can be the settled copy of a pending one. */
  incomingStatus?: NormalizedRow['status'];
  descriptionNorm: string;
  /** Transaction ids not to consider (already claimed in this batch, or the row itself). */
  exclude?: { has(id: number): boolean };
}

/**
 * Second-level cross-source match: same account, day, amount and installment #, from another source
 * kind, not yet linked to a row of the incoming kind. One candidate → it. Several → the most similar
 * description, if it is clearly the best. Never merges two rows of the same source.
 */
export function findCrossSourceTwin(tx: Tx, q: TwinQuery): TxnRow | undefined {
  const sameDay = tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, q.accountId),
        eq(transactions.txnDate, q.date),
        eq(transactions.amountIls, q.amount),
        q.installmentN === undefined ? isNull(transactions.installmentN) : eq(transactions.installmentN, q.installmentN),
      ),
    )
    .all()
    .filter((r) => !q.exclude?.has(r.id));
  const score = (rows: TxnRow[]) => rows.map((r) => ({ r, s: descriptionSimilarity(q.descriptionNorm, r.descriptionNorm) })).sort((a, b) => b.s - a.s || a.r.id - b.r.id);

  const rows = sameDay.filter((r) => sourceKind(r.source) !== q.incomingKind).filter((r) => !(q.incomingKind in parseAnn(r.annotationsJson)));
  if (rows.length > 0) {
    const best = score(rows)[0]!;
    // A reasonably similar name, one candidate or several (identical scores pair in id order). Was 0.15
    // for a lone candidate until security research P2-04; on the real data every cross-source merge
    // scored ≥ 0.5 (checked 2026-11-10), so a weaker match is two different charges.
    return best.s >= 0.3 ? best.r : undefined;
  }

  // Same source, and still the same transaction: a pending row whose name changes when it settles,
  // or Max's mirrored spelling ("ESCAPE ROOM" pending, "MOOR EPACSE" settled). Here a similar name
  // is required whatever the count: two different ₪20 coffees on one day must stay two rows. Only a
  // completed row settles a pending one (a pending row never absorbs another pending row).
  const settles = q.incomingStatus === undefined || q.incomingStatus === 'completed';
  const own = sameDay.filter((r) => sourceKind(r.source) === q.incomingKind).filter((r) => (r.status === 'pending' && settles) || isMirror(r.descriptionNorm, q.descriptionNorm));
  if (own.length === 0) return undefined;
  const best = score(own)[0]!;
  return best.s >= 0.3 ? best.r : undefined;
}

const compact = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, '');

/** True when one name is the other written backwards (letters only): Max stores some merchants that way. */
export function isMirror(a: string, b: string): boolean {
  const ca = compact(a);
  const cb = compact(b);
  return ca.length > 3 && ca !== cb && ca === [...cb].reverse().join('');
}

/**
 * 0..1 similarity between two normalized descriptions. 1 when one is a prefix of the other after
 * removing spaces and punctuation (truncated card names, reordered cheque words share nothing by
 * prefix but score high below); otherwise Dice over character bigrams of the compacted strings,
 * which survives "o06-12345" vs "o 06 12345" and Hebrew word reordering.
 */
export function descriptionSimilarity(a: string, b: string): number {
  const ca = compact(a);
  const cb = compact(b);
  if (!ca || !cb) return 0;
  if (ca.startsWith(cb) || cb.startsWith(ca)) return 1;
  if (isMirror(a, b)) return 1;
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(ca);
  const gb = grams(cb);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  const total = ca.length - 1 + (cb.length - 1);
  return total <= 0 ? (ca === cb ? 1 : 0) : (2 * inter) / total;
}

export interface DedupeDetail {
  from: number;
  into: number;
  date: string;
  amount: number;
  /** cross-source: lower source into scraped twin; mirror: mirrored settled spelling; settled-pending: settled copy into a stuck pending row. */
  kind: 'cross-source' | 'mirror' | 'settled-pending';
}

/**
 * Repair pass: merge lower-precedence rows (riseup, import) into a higher-precedence twin that was
 * stored separately before second-level matching existed, and a same-source row whose name is the
 * mirror image of an earlier row's (Max's settled spelling) into that earlier row. Also a same-source
 * settled row into an earlier row stuck as 'completed' while its own raw row is still the bank's
 * pending one (a bank pending row that took over a RiseUp row before 2026-11-11 kept RiseUp's
 * 'completed', so the settled copy was inserted beside it). Raw rows are untouched.
 */
/** A stuck pair the repair would merge but leaves alone: the settled copy carries data that could be lost. */
export interface DedupeReview {
  /** The stuck (earlier) row. */
  txnId: number;
  /** Its settled copy. */
  settledId: number;
  date: string;
  amount: number;
  reason: string;
}

export function mergeCrossSourceDuplicates(db: Db): { examined: number; merged: number; details: DedupeDetail[]; needsReview: DedupeReview[] } {
  const details: DedupeDetail[] = [];
  const needsReview: DedupeReview[] = [];
  let examined = 0;
  db.transaction((tx) => {
    const all = tx
      .select()
      .from(transactions)
      .all()
      .sort((a, b) => a.id - b.id);
    const claimed = new Set<number>();
    for (const t of all) {
      if (claimed.has(t.id)) continue;
      examined++;
      const kind = sourceKind(t.source);
      // Same source, stuck pending: a row that is 'completed' (inherited from RiseUp) although the
      // bank row that took it over was pending, plus that charge's settled copy stored separately.
      const settled = findSettledCopyOfStuckPending(tx, t, claimed);
      if (settled) {
        claimed.add(t.id);
        claimed.add(settled.id);
        const conflict = userDataConflict(tx, settled, t);
        if (conflict) {
          needsReview.push({ txnId: t.id, settledId: settled.id, date: t.txnDate, amount: t.amountIls, reason: conflict });
          continue;
        }
        // What the user attached to the copy and the survivor lacks moves with it (category: mergeTransactionInto).
        if (settled.note && !t.note) tx.update(transactions).set({ note: settled.note }).where(eq(transactions.id, t.id)).run();
        if (settled.excluded && !t.excluded) tx.update(transactions).set({ excluded: true }).where(eq(transactions.id, t.id)).run();
        mergeTransactionInto(tx, settled, t);
        details.push({ from: settled.id, into: t.id, date: t.txnDate, amount: t.amountIls, kind: 'settled-pending' });
        continue;
      }
      const twin = findCrossSourceTwin(tx, {
        accountId: t.accountId,
        date: t.txnDate,
        amount: t.amountIls,
        ...(t.installmentN !== null ? { installmentN: t.installmentN } : {}),
        incomingKind: kind,
        descriptionNorm: t.descriptionNorm,
        exclude: new Set([t.id, ...claimed]),
      });
      if (!twin) continue;
      const twinKind = sourceKind(twin.source);
      if (twinKind === kind) {
        // Same source: only a mirrored name qualifies here (a pending twin is the live sync's job);
        // the later row is the settled copy and folds into the earlier, readable one.
        if (!isMirror(t.descriptionNorm, twin.descriptionNorm) || twin.id < t.id) continue;
        claimed.add(t.id);
        claimed.add(twin.id);
        mergeTransactionInto(tx, twin, t);
        details.push({ from: twin.id, into: t.id, date: t.txnDate, amount: t.amountIls, kind: 'mirror' });
        continue;
      }
      if (SOURCE_PRECEDENCE[twinKind] <= SOURCE_PRECEDENCE[kind]) continue;
      claimed.add(twin.id);
      mergeTransactionInto(tx, t, twin);
      details.push({ from: t.id, into: twin.id, date: t.txnDate, amount: t.amountIls, kind: 'cross-source' });
    }
  });
  return { examined, merged: details.length, details, needsReview };
}

/**
 * For a row stuck by the pre-fix takeover bug: the later row of the same source, account, day, amount
 * and installment #, completed, with a similar name (≥ 0.3), i.e. the bank's settled copy. All must
 * hold, because a raw payload is written once and never updated (a row that settled under the same
 * source hash still has a raw saying 'pending', and must not absorb a second similar charge):
 *  - the row is 'completed' and its own raw row (same source) says pending;
 *  - it carries a lower-source annotation (riseup / import): the bug only arose from a takeover;
 *  - its raw stopped being seen when the copy appeared (last seen run ≤ the copy's first seen run)
 *    while the copy's raw is still seen after that (by run id; by timestamp when run ids are null).
 */
function findSettledCopyOfStuckPending(tx: Tx, t: TxnRow, claimed: Set<number>): TxnRow | undefined {
  if (t.status !== 'completed') return undefined;
  const ann = parseAnn(t.annotationsJson);
  if (!('riseup' in ann) && !('import' in ann)) return undefined;
  const raw = tx.select().from(rawTransaction).where(eq(rawTransaction.id, t.rawId)).get();
  if (!raw || raw.source !== t.source) return undefined;
  let rawStatus: unknown;
  try {
    rawStatus = (JSON.parse(raw.payloadJson) as { status?: unknown } | null)?.status;
  } catch {
    return undefined;
  }
  if (rawStatus !== 'pending') return undefined;
  const candidates = tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, t.accountId),
        eq(transactions.txnDate, t.txnDate),
        eq(transactions.amountIls, t.amountIls),
        eq(transactions.source, t.source),
        eq(transactions.status, 'completed'),
        t.installmentN === null ? isNull(transactions.installmentN) : eq(transactions.installmentN, t.installmentN),
      ),
    )
    .all()
    .filter((r) => r.id > t.id && !claimed.has(r.id))
    .filter((r) => {
      const copyRaw = tx.select().from(rawTransaction).where(eq(rawTransaction.id, r.rawId)).get();
      if (!copyRaw || copyRaw.source !== t.source) return false;
      if (raw.lastSeenRunId !== null && copyRaw.firstSeenRunId !== null && copyRaw.lastSeenRunId !== null) {
        return raw.lastSeenRunId <= copyRaw.firstSeenRunId && raw.lastSeenRunId < copyRaw.lastSeenRunId;
      }
      return raw.lastSeenAt <= copyRaw.firstSeenAt && raw.lastSeenAt < copyRaw.lastSeenAt;
    })
    .map((r) => ({ r, s: descriptionSimilarity(t.descriptionNorm, r.descriptionNorm) }))
    .filter((x) => x.s >= 0.3)
    .sort((a, b) => b.s - a.s || a.r.id - b.r.id);
  return candidates[0]?.r;
}

/**
 * Why folding `copy` into `survivor` could lose something the user did, or null when it is safe:
 * a different note or user/rule category, an exclusion the survivor lacks is carried (not a conflict),
 * a link the user confirmed or made, or membership in an event.
 */
function userDataConflict(tx: Tx, copy: TxnRow, survivor: TxnRow): string | null {
  if (copy.note && survivor.note && copy.note !== survivor.note) return 'settled copy has a different note';
  const userCat = copy.categorySource === 'user' || copy.categorySource === 'rule';
  if (userCat && copy.categoryId !== null && survivor.categoryId !== null && copy.categoryId !== survivor.categoryId) return `settled copy has a ${copy.categorySource} category the survivor lacks`;
  const links = tx
    .select({ id: link.id, decision: link.decision, source: link.source })
    .from(link)
    .where(or(eq(link.fromTxnId, copy.id), eq(link.toTxnId, copy.id)))
    .all();
  if (links.some((l) => l.decision === 'confirmed' || l.source !== 'auto')) return 'settled copy has a confirmed or user-made link';
  const ev = tx.select({ eventId: eventTxn.eventId }).from(eventTxn).where(eq(eventTxn.txnId, copy.id)).get();
  if (ev) return 'settled copy belongs to an event';
  return null;
}

interface ReconcileCtx {
  rawId: number;
  source: string;
  kind: ReturnType<typeof sourceKind>;
  now: string;
}

/** Decide how an incoming row changes an existing transaction with the same fingerprint. */
function reconcile(
  existing: TxnRow,
  r: NormalizedRow & { descriptionNorm: string },
  ctx: ReconcileCtx,
): { set: Partial<TxnRow>; changed: boolean; completed: boolean; annotated: boolean } {
  const set: Partial<TxnRow> = {};
  let changed = false;
  let completed = false;
  let annotated = false;

  const existingKind = sourceKind(existing.source);
  const incomingWins = SOURCE_PRECEDENCE[ctx.kind] > SOURCE_PRECEDENCE[existingKind];
  const sameSource = existing.source === ctx.source;
  const incomingLoses = SOURCE_PRECEDENCE[ctx.kind] < SOURCE_PRECEDENCE[existingKind];

  // 1. Status: pending → completed (never the other way; voided → completed re-opens it). The row's
  //    status belongs to the source that owns it: a lower-precedence source (RiseUp, an import) only
  //    annotates, it never settles or re-opens a row a bank scraper still shows as pending or voided.
  //    Otherwise a RiseUp re-import would mark a bank-pending row completed, and the bank's settled
  //    copy (often under a longer name) would no longer find it and count the charge twice.
  if (r.status === 'completed' && existing.status !== 'completed' && !incomingLoses) {
    set.status = 'completed';
    set.completedAt = ctx.now;
    set.voidedAt = null;
    set.chargeDate = r.chargeDate ?? existing.chargeDate;
    if (r.identifier) set.identifier = r.identifier;
    set.rawId = ctx.rawId;
    if (!incomingWins && !sameSource) set.source = existing.source;
    completed = true;
    changed = true;
  }
  // A higher-precedence source taking the row over brings its own status: RiseUp's "completed" means
  // approved, not settled, so a bank row that is still pending makes the row pending again. The bank's
  // settled copy then completes it through the same-source pending match, and if it vanishes instead
  // it is voided under the usual pending rules (its raw row is now the scraper's).
  if (incomingWins && !sameSource && r.status === 'pending' && existing.status !== 'pending') {
    set.status = 'pending';
    set.completedAt = null;
    set.voidedAt = null;
    changed = true;
  }

  // 2. Core fields: taken over by a higher-precedence source, or refreshed by the same source.
  if (incomingWins || sameSource) {
    // A mirrored spelling arriving on an existing row is the bank's quirk, not a better name: keep ours.
    const mirrored = isMirror(existing.descriptionNorm, r.descriptionNorm);
    const core: Partial<TxnRow> = {
      source: ctx.source,
      rawId: ctx.rawId,
      descriptionRaw: mirrored ? existing.descriptionRaw : r.description,
      descriptionNorm: mirrored ? existing.descriptionNorm : r.descriptionNorm,
      memo: r.memo ?? existing.memo,
      identifier: r.identifier ?? existing.identifier,
      chargeDate: r.chargeDate ?? existing.chargeDate,
      originalAmount: r.originalAmount ?? existing.originalAmount,
      originalCurrency: r.originalCurrency ?? existing.originalCurrency,
      txnType: r.type,
      installmentTotal: r.installmentTotal ?? existing.installmentTotal,
    };
    for (const [k, v] of Object.entries(core) as Array<[keyof TxnRow, unknown]>) {
      if (existing[k] !== v && !(k in set)) {
        (set as Record<string, unknown>)[k] = v;
        changed = true;
      }
    }
    // Keep the previous owner's data as an annotation when a new owner takes over.
    if (incomingWins && !sameSource) {
      const ann = parseAnn(existing.annotationsJson);
      ann[existingKind] = {
        ...(typeof ann[existingKind] === 'object' && ann[existingKind] ? (ann[existingKind] as object) : {}),
        descriptionRaw: existing.descriptionRaw,
        identifier: existing.identifier,
        memo: existing.memo,
      };
      set.annotationsJson = JSON.stringify(ann);
      changed = true;
    }
  }

  // 3. Annotations from the incoming source (always merged, keyed by source kind). A lower-precedence
  //    source always leaves at least its own spelling, id and date: that is how cross-source merchant
  //    aliases are learned later.
  const lowerSourceFacts = !incomingWins && !sameSource ? { descriptionRaw: r.description, identifier: r.identifier ?? null, txnDate: r.date } : null;
  if (r.annotations || lowerSourceFacts) {
    const ann = parseAnn(set.annotationsJson ?? existing.annotationsJson);
    const before = JSON.stringify(ann[ctx.kind] ?? null);
    ann[ctx.kind] = { ...(typeof ann[ctx.kind] === 'object' && ann[ctx.kind] ? (ann[ctx.kind] as object) : {}), ...(lowerSourceFacts ?? {}), ...(r.annotations ?? {}) };
    if (JSON.stringify(ann[ctx.kind]) !== before) {
      set.annotationsJson = JSON.stringify(ann);
      annotated = !incomingWins && !sameSource;
      changed = true;
    }
  }

  if (changed) set.updatedAt = ctx.now;
  return { set, changed, completed, annotated };
}

function parseAnn(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
