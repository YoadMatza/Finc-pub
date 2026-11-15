/** One entry point for the whole truth engine, used by the CLI and by the worker after every sync. */
import { setSetting } from '../ai/settings.js';
import type { Db } from '../db/db.js';
import { assignCashflowMonths } from './cashflow.js';
import { seedCategories } from './categories.js';
import { type CategorizeResult, categorize } from './categorize.js';
import { type RecurringBuildResult, buildRecurringStreams } from './recurring.js';
import { type InstallmentBuildResult, buildInstallmentPlans } from './installments.js';
import { type AssignMerchantsResult, assignMerchants, mergeCrossSourceMerchants } from './merchant.js';
import { type RefundResult, linkRefunds } from './refunds.js';
import { type RulesResult, applyCounterpartyRules, classifyRemaining, seedDefaultRules } from './rules.js';
import { type SettlementResult, linkCardSettlements } from './settlement.js';

/** ISO time the last completed engine run started: every transaction created before it has been processed. */
export const ENGINE_PROCESSED_SETTING = 'engine.processedUntil';

export interface EngineReport {
  merchants: AssignMerchantsResult;
  /** merchants that turned out to be one business spelled differently by two sources */
  merchantsMerged: number;
  installments: InstallmentBuildResult;
  settlements: SettlementResult;
  rules: RulesResult & { seeded: number };
  refunds: RefundResult;
  classified: number;
  /** rows whose cashflow month changed in this run (month-end salary rule) */
  cashflowShifted: number;
  categoriesSeeded: number;
  categorized: CategorizeResult;
  recurring: RecurringBuildResult;
  ms: number;
}

export function runEngine(db: Db, opts: { reassignMerchants?: boolean } = {}): EngineReport {
  const t0 = Date.now();
  // Everything created before this moment has been through the engine once this run ends: money alerts look only
  // at such rows, so a dispatch in the middle of a sync never judges a row before it has its kind, plan or stream.
  const startedAt = new Date(t0).toISOString();
  const merchants = assignMerchants(db, { reassignAll: opts.reassignMerchants ?? false });
  const merchantsMerged = mergeCrossSourceMerchants(db).merged;
  const installments = buildInstallmentPlans(db);
  const settlements = linkCardSettlements(db);
  const seeded = seedDefaultRules(db);
  const rules = { ...applyCounterpartyRules(db), seeded };
  const refunds = linkRefunds(db);
  const classified = classifyRemaining(db);
  const cashflowShifted = assignCashflowMonths(db);
  const categoriesSeeded = seedCategories(db);
  const categorized = categorize(db);
  const recurring = buildRecurringStreams(db);
  setSetting(db, ENGINE_PROCESSED_SETTING, startedAt);
  return { merchants, merchantsMerged, installments, settlements, rules, refunds, classified, cashflowShifted, categoriesSeeded, categorized, recurring, ms: Date.now() - t0 };
}
