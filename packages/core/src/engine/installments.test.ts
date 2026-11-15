import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAccount } from '../db/accounts.js';
import { type Db, openDb } from '../db/db.js';
import { installmentPlan, transactions } from '../db/schema.js';
import { ingestBatch } from '../ingest/ingest.js';
import type { NormalizedRow } from '../ingest/types.js';
import { buildInstallmentPlans, planKeyFor, projectRemainingSlices, shiftMonths } from './installments.js';
import { assignMerchants } from './merchant.js';

let db: Db;
let max: number;
let isr: number;
const slice = (over: Partial<NormalizedRow>): NormalizedRow => ({ externalAccountId: 'x', date: '2026-01-01', amount: -27500, description: 'קאנטרי קלאב דוגמה', status: 'completed', type: 'installments', installmentTotal: 12, payload: {}, ...over });

beforeEach(() => {
  db = openDb(':memory:');
  max = ensureAccount(db, { institutionId: 'max', institutionKind: 'card', institutionDisplayName: 'Max', source: 'scraper:max', externalId: 'm', type: 'credit_card' }).accountId;
  isr = ensureAccount(db, { institutionId: 'isracard', institutionKind: 'card', institutionDisplayName: 'Isracard', source: 'scraper:isracard', externalId: 'i', type: 'credit_card' }).accountId;
});

describe('shiftMonths / planKeyFor', () => {
  it('shifts across year ends and clamps the day', () => {
    expect(shiftMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftMonths('2026-01-15', -3)).toBe('2025-10-15');
    expect(shiftMonths('2025-11-30', 13)).toBe('2026-12-30');
  });
  it('uses the ARN for Max and an inferred key elsewhere', () => {
    expect(planKeyFor({ source: 'scraper:max', identifier: '5120417_6', merchantId: 1, installmentN: 6, installmentTotal: 12, originalAmount: -329500, amountIls: -27500, txnDate: '2026-01-01' })).toBe('arn:5120417');
    expect(planKeyFor({ source: 'scraper:isracard', identifier: 'v1', merchantId: 7, installmentN: 3, installmentTotal: 6, originalAmount: -135000, amountIls: -22500, txnDate: '2026-08-24' })).toBe('inf:7:6:2026-06');
  });
});

describe('buildInstallmentPlans', () => {
  it('groups Max slices by ARN, tracks progress, projects the remaining slices', () => {
    const rows = [6, 7, 8].map((n) => slice({ date: `2026-0${n - 5}-01`, identifier: `ARN1_${n}`, installmentN: n, originalAmount: -329500 }));
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: max, rows });
    assignMerchants(db);
    const r = buildInstallmentPlans(db);
    expect(r).toMatchObject({ plansCreated: 1, slicesLinked: 3, duplicatesMerged: 0 });
    const plan = db.select().from(installmentPlan).get()!;
    expect(plan).toMatchObject({ planKey: 'arn:ARN1', totalN: 12, seenN: 8, status: 'active', sliceAmount: -27500, originalAmount: -329500, firstDate: '2025-08-01' });
    const rem = projectRemainingSlices(plan);
    expect(rem.map((s) => s.n)).toEqual([9, 10, 11, 12]);
    expect(rem[0]).toMatchObject({ expectedDate: '2026-04-01', amount: -27500 });
    expect(buildInstallmentPlans(db)).toMatchObject({ plansCreated: 0, plansUpdated: 0, slicesLinked: 0 });
    // a later sync brings slice 9 → plan updated, not duplicated
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: max, rows: [...rows, slice({ date: '2026-04-01', identifier: 'ARN1_9', installmentN: 9, originalAmount: -329500 })] });
    assignMerchants(db);
    expect(buildInstallmentPlans(db)).toMatchObject({ plansCreated: 0, plansUpdated: 1, slicesLinked: 1 });
    expect(db.select().from(installmentPlan).get()?.seenN).toBe(9);
  });

  it('keeps two overlapping same-merchant plans apart (Isracard "speed" case) and marks a finished plan done', () => {
    const sp = (date: string, n: number, id: string): NormalizedRow => slice({ externalAccountId: 'i', date, amount: -22500, description: 'SPEED', installmentN: n, installmentTotal: 6, identifier: id, originalAmount: -135000 });
    ingestBatch(db, { source: 'scraper:isracard', runId: null, accountId: isr, rows: [sp('2026-06-24', 1, 'a1'), sp('2026-07-24', 2, 'a2'), sp('2026-08-24', 3, 'a3'), sp('2026-09-24', 4, 'a4'), sp('2026-10-24', 5, 'a5'), sp('2026-11-24', 6, 'a6'), sp('2026-10-29', 1, 'b1'), sp('2026-11-29', 2, 'b2')] });
    assignMerchants(db);
    const r = buildInstallmentPlans(db);
    expect(r.plansCreated).toBe(2);
    const plans = db.select().from(installmentPlan).all().sort((a, b) => a.firstDate.localeCompare(b.firstDate));
    expect(plans[0]).toMatchObject({ firstDate: '2026-06-24', seenN: 6, status: 'done' });
    expect(plans[1]).toMatchObject({ firstDate: '2026-10-29', seenN: 2, status: 'active' });
    expect(projectRemainingSlices(plans[1]!)).toHaveLength(4);
  });

  it('RiseUp-era slices 1-5 (no ARN, rounding differences) fold into the ARN plan that holds slices 6-12', () => {
    const arn = [6, 7].map((n) => slice({ date: `2026-0${n - 5}-01`, identifier: `ARN5_${n}`, installmentN: n, originalAmount: -329500 }));
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: max, rows: arn });
    const ru = [1, 2, 3, 4, 5].map((n) => slice({ date: `2025-${String(n + 7).padStart(2, '0')}-15`, identifier: `ru-${n}`, installmentN: n, amount: n === 1 ? -27000 : -27500, originalAmount: 0 }));
    ingestBatch(db, { source: 'riseup', runId: null, accountId: max, rows: ru });
    assignMerchants(db);
    const r = buildInstallmentPlans(db);
    expect(r.plansFolded).toBe(1);
    const plans = db.select().from(installmentPlan).all();
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ planKey: 'arn:ARN5', seenN: 7, status: 'active', firstDate: '2025-08-01' });
    expect(db.select().from(transactions).all().every((t) => t.installmentPlanId === plans[0]!.id)).toBe(true);
  });

  it('folds a RiseUp slice dated on its charge day into the scraped slice of the same plan', () => {
    ingestBatch(db, { source: 'scraper:max', runId: null, accountId: max, rows: [slice({ date: '2026-01-01', identifier: 'ARN9_6', installmentN: 6, originalAmount: -329500 })] });
    ingestBatch(db, { source: 'riseup', runId: null, accountId: max, rows: [slice({ date: '2026-01-15', identifier: 'ru-6', installmentN: 6, annotations: { categoryLabel: 'ספורט' } })] });
    assignMerchants(db);
    expect(db.select().from(transactions).all()).toHaveLength(2);
    const r = buildInstallmentPlans(db);
    expect(r).toMatchObject({ duplicatesMerged: 1, plansCreated: 1 });
    const t = db.select().from(transactions).all();
    expect(t).toHaveLength(1);
    expect(JSON.parse(t[0]!.annotationsJson!).riseup).toMatchObject({ categoryLabel: 'ספורט', txnDate: '2026-01-15' });
    expect(t[0]?.installmentPlanId).not.toBeNull();
  });
});
