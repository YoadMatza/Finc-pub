/**
 * RiseUp history backfill: walk cashflow months backwards until RiseUp says the month is
 * before its earliest record, ingest every transaction (annotated with RiseUp's category,
 * exclusion flag, comments), and snapshot balances.
 */
import { and, eq } from 'drizzle-orm';
import { ensureAccount } from '../db/accounts.js';
import type { Db } from '../db/db.js';
import { finishRunError, finishRunOk, recordBalance, startRun } from '../db/runs.js';
import { account, accountAlias } from '../db/schema.js';
import { ingestBatch } from '../ingest/ingest.js';
import { endOfLocalDayIso, toMinor } from '../ingest/normalize.js';
import { RISEUP_SOURCE, type RiseupTransaction, fromRiseupTransaction, riseupExternalAccountId } from '../ingest/riseup-convert.js';
import type { IngestStats } from '../ingest/types.js';
import { type RiseupClient, currentMonth, prevMonth } from './client.js';

/** RiseUp provider names → our institution ids. Extend as real values show up. */
export const RISEUP_PROVIDER_TO_INSTITUTION: Record<string, string> = {
  max: 'max',
  leumicard: 'max',
  isracard: 'isracard',
  beinleumi: 'beinleumi',
  benleumi: 'beinleumi', // RiseUp's actual spelling (seen 2026-11-08)
  fibi: 'beinleumi',
  beinleumibank: 'beinleumi',
  habeinleumi: 'beinleumi',
};

export interface RiseupImportOptions {
  /** Newest month to import (YYYY-MM). Default: current month. */
  to?: string;
  /** Oldest month to import (YYYY-MM). Default: walk back until RiseUp has no earlier record. */
  from?: string;
  /** Hard cap on months walked (safety against runaway loops). */
  maxMonths?: number;
  /** Also fetch current balances and 90 days of history (needs balances:read). */
  balances?: boolean;
  onMonth?: (month: string, count: number, stats: IngestStats) => void;
}

export interface RiseupImportResult {
  runId: number;
  months: string[];
  stoppedBecause: 'from-reached' | 'before-earliest' | 'max-months' | 'error';
  stats: IngestStats;
  accounts: Array<{ externalId: string; accountId: number; institutionId: string; created: boolean; txns: number }>;
  balances: number;
  apiCalls: number;
  error?: string;
}

const zero = (): IngestStats => ({ seen: 0, new: 0, updated: 0, completed: 0, voided: 0, annotated: 0 });
const add = (a: IngestStats, b: IngestStats): void => {
  for (const k of Object.keys(b) as Array<keyof IngestStats>) a[k] += b[k];
};

export function inferInstitution(t: Pick<RiseupTransaction, 'source' | 'sourceType'>): { institutionId: string; kind: 'bank' | 'card' | 'aggregator'; type: 'checking' | 'credit_card' } {
  const key = (t.source ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const mapped = RISEUP_PROVIDER_TO_INSTITUTION[key];
  const isCard = (t.sourceType ?? '').toLowerCase().includes('credit');
  if (mapped) return { institutionId: mapped, kind: isCard ? 'card' : 'bank', type: isCard ? 'credit_card' : 'checking' };
  return { institutionId: `riseup-${key || 'unknown'}`, kind: 'aggregator', type: isCard ? 'credit_card' : 'checking' };
}

/** Map a RiseUp account onto ours: existing alias → adopt the single same-institution account → create. */
export function resolveRiseupAccount(db: Db, sample: RiseupTransaction): { accountId: number; institutionId: string; created: boolean } {
  const externalId = riseupExternalAccountId(sample);
  const inf = inferInstitution(sample);
  const existing = db
    .select()
    .from(accountAlias)
    .where(and(eq(accountAlias.source, RISEUP_SOURCE), eq(accountAlias.externalId, externalId)))
    .get();
  if (existing) return { accountId: existing.accountId, institutionId: inf.institutionId, created: false };

  if (inf.kind !== 'aggregator') {
    const candidates = db
      .select()
      .from(account)
      .where(and(eq(account.institutionId, inf.institutionId), eq(account.type, inf.type)))
      .all();
    if (candidates.length === 1) {
      db.insert(accountAlias).values({ accountId: candidates[0]!.id, source: RISEUP_SOURCE, externalId }).run();
      return { accountId: candidates[0]!.id, institutionId: inf.institutionId, created: false };
    }
  }
  const r = ensureAccount(db, {
    institutionId: inf.institutionId,
    institutionKind: inf.kind,
    institutionDisplayName: inf.kind === 'aggregator' ? `RiseUp: ${sample.source ?? 'unknown'}` : inf.institutionId,
    source: RISEUP_SOURCE,
    externalId,
    type: inf.type,
    ...(sample.accountNickname ? { displayName: sample.accountNickname } : {}),
  });
  return { accountId: r.accountId, institutionId: inf.institutionId, created: r.created };
}

export async function importRiseup(db: Db, client: RiseupClient, o: RiseupImportOptions = {}): Promise<RiseupImportResult> {
  const runId = startRun(db, { institutionId: 'riseup', source: RISEUP_SOURCE, trigger: 'import' });
  const res: RiseupImportResult = { runId, months: [], stoppedBecause: 'max-months', stats: zero(), accounts: [], balances: 0, apiCalls: 0 };
  const perAccount = new Map<string, { accountId: number; institutionId: string; created: boolean; txns: number }>();
  const maxMonths = o.maxMonths ?? 120;
  let month = o.to ?? currentMonth();

  try {
    for (let i = 0; i < maxMonths; i++) {
      const txns = await client.transactions(month);
      if (txns.length === 0) {
        // Empty month: either a quiet month or before RiseUp's earliest record. The budget endpoint tells.
        const b = await client.budget(month);
        if (b === null) {
          res.stoppedBecause = 'before-earliest';
          break;
        }
      }
      res.months.push(month);
      const monthStats = zero();
      const groups = new Map<string, RiseupTransaction[]>();
      for (const t of txns) {
        const k = riseupExternalAccountId(t);
        const g = groups.get(k) ?? [];
        g.push(t);
        groups.set(k, g);
      }
      for (const [externalId, rows] of groups) {
        let acc = perAccount.get(externalId);
        if (!acc) {
          const r = resolveRiseupAccount(db, rows[0]!);
          acc = { ...r, txns: 0 };
          perAccount.set(externalId, acc);
        }
        const s = ingestBatch(db, { source: RISEUP_SOURCE, runId, accountId: acc.accountId, rows: rows.map(fromRiseupTransaction), batchIsComplete: false });
        acc.txns += rows.length;
        add(monthStats, s);
      }
      add(res.stats, monthStats);
      o.onMonth?.(month, txns.length, monthStats);
      if (o.from && month <= o.from) {
        res.stoppedBecause = 'from-reached';
        break;
      }
      month = prevMonth(month);
    }

    if (o.balances) {
      // RiseUp's balance endpoints describe bank accounts only (they carry the overdraft limit; cards have no balance
      // there), so the account they resolve to is the checking account (security research P3-03, checked 2026-11-16).
      const current = await client.currentBalances();
      for (const b of current) {
        const acc = resolveRiseupAccount(db, { source: b.source, sourceType: 'checkingAccount', accountNumberHash: b.accountNumberHash, accountNickname: b.accountNickname } as RiseupTransaction);
        const minor = toMinor(b.balance);
        if (minor !== undefined) {
          recordBalance(db, { accountId: acc.accountId, runId, balanceMinor: minor, source: RISEUP_SOURCE, takenAt: b.lastUpdated });
          res.balances++;
        }
      }
      const history = await client.balanceHistory(90);
      for (const h of history) {
        const acc = resolveRiseupAccount(db, { source: h.source, sourceType: 'checkingAccount', accountNumberHash: h.accountNumberHash, accountNickname: h.accountNickname } as RiseupTransaction);
        for (const p of h.balances) {
          const minor = toMinor(p.balance);
          if (minor === undefined) continue;
          recordBalance(db, { accountId: acc.accountId, runId, balanceMinor: minor, source: `${RISEUP_SOURCE}:history`, takenAt: endOfLocalDayIso(p.date) });
          res.balances++;
        }
      }
    }
  } catch (e) {
    res.stoppedBecause = 'error';
    res.error = e instanceof Error ? e.message : String(e);
  }

  res.accounts = [...perAccount.entries()].map(([externalId, a]) => ({ externalId, ...a }));
  res.apiCalls = client.calls;
  if (res.error) finishRunError(db, runId, 'RISEUP', res.error);
  else finishRunOk(db, runId, res.stats, { months: res.months.length, oldest: res.months[res.months.length - 1], stoppedBecause: res.stoppedBecause, accounts: res.accounts.length, apiCalls: res.apiCalls });
  return res;
}
