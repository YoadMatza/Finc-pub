/**
 * The owner's holding rules and their last evaluation per held symbol (tables holding_rule, holding_rule_state).
 * Rules are validated per template (templates.ts); at most MAX_HOLDING_RULES. A change to a rule's template, numbers
 * or scope, or disabling it, forgets its stored states (they described the old condition).
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { holdingRule, holdingRuleState } from '../db/schema.js';
import { type RuleFacts, type RuleSource, type RuleStateName, evaluateRule } from './evaluate.js';
import { normSymbol } from './facts.js';
import { TEMPLATE_IDS, type TemplateId, isTemplateId, validateParams } from './templates.js';

export const MAX_HOLDING_RULES = 100;

export class HoldingRuleError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'too_many',
    message: string,
  ) {
    super(message);
    this.name = 'HoldingRuleError';
  }
}

export interface HoldingRuleView {
  id: number;
  template: TemplateId;
  params: Record<string, number>;
  scopeSymbol: string | null;
  notify: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HoldingRuleStatus {
  ruleId: number;
  template: TemplateId;
  params: Record<string, number>;
  scopeSymbol: string | null;
  /** the raw condition now (no hysteresis) */
  state: RuleStateName;
  /** 1 decimal, the template's own terms; null when unknown */
  value: number | null;
  source: RuleSource | null;
  /** the cost templates: the bank snapshot date of the cost price */
  costAsOf: string | null;
  /** when it turned 'applies' (kept through unknown evaluations; cleared by a known 'clear') */
  since: string | null;
  /** the last known state and when, kept through unknown evaluations (null before the first known one) */
  lastKnownState: 'applies' | 'clear' | null;
  lastKnownAt: string | null;
}

type Row = typeof holdingRule.$inferSelect;

function parseParams(s: string): Record<string, number> {
  try {
    const o = JSON.parse(s) as unknown;
    if (o && typeof o === 'object' && !Array.isArray(o)) return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) as Record<string, number>;
  } catch {
    /* a broken row evaluates as unknown */
  }
  return {};
}

const view = (r: Row): HoldingRuleView => ({
  id: r.id,
  template: r.template as TemplateId,
  params: parseParams(r.params),
  scopeSymbol: r.scopeSymbol,
  notify: r.notify,
  enabled: r.enabled,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** Every rule, oldest first (rows with a template this version does not know are left out). */
export function listHoldingRules(db: Db): HoldingRuleView[] {
  return db
    .select()
    .from(holdingRule)
    .orderBy(holdingRule.id)
    .all()
    .filter((r) => isTemplateId(r.template))
    .map(view);
}

export function getHoldingRule(db: Db, id: number): HoldingRuleView | null {
  const r = db.select().from(holdingRule).where(eq(holdingRule.id, id)).get();
  return r && isTemplateId(r.template) ? view(r) : null;
}

/** Security symbols in the latest snapshot of each account, upper-case, sorted, distinct. */
export function heldSymbols(db: Db): string[] {
  const rows = db.$client
    .prepare(
      `select distinct h.symbol from holding_snapshot h
         where h.kind = 'security' and h.taken_at = (select max(taken_at) from holding_snapshot x where x.account_id = h.account_id)`,
    )
    .all() as Array<{ symbol: string }>;
  return [...new Set(rows.map((r) => normSymbol(r.symbol)).filter(Boolean))].sort();
}

export interface HoldingRuleInput {
  template: string;
  params: unknown;
  scopeSymbol?: string | null | undefined;
  notify?: boolean | undefined;
  enabled?: boolean | undefined;
}

function checked(template: string, params: unknown): Record<string, number> {
  const v = validateParams(template, params);
  if (!v.ok) throw new HoldingRuleError('invalid', v.error);
  return v.params;
}

export function createHoldingRule(db: Db, input: HoldingRuleInput, now: number = Date.now()): HoldingRuleView {
  const params = checked(input.template, input.params);
  const at = new Date(now).toISOString();
  return db.transaction((tx) => {
    const n = (db.$client.prepare('select count(*) n from holding_rule').get() as { n: number }).n;
    if (n >= MAX_HOLDING_RULES) throw new HoldingRuleError('too_many', `at most ${MAX_HOLDING_RULES} rules`);
    const r = tx
      .insert(holdingRule)
      .values({ template: input.template, params: JSON.stringify(params), scopeSymbol: input.scopeSymbol ? normSymbol(input.scopeSymbol) : null, notify: input.notify ?? false, enabled: input.enabled ?? true, createdAt: at, updatedAt: at })
      .returning()
      .get();
    return view(r);
  });
}

/**
 * A partial update. A new template needs its params in the same call; params alone are checked against the rule's
 * template. A change of template, params or scope, or disabling, forgets the rule's stored states.
 */
export function updateHoldingRule(db: Db, id: number, patch: Partial<HoldingRuleInput>, now: number = Date.now()): HoldingRuleView {
  const cur = getHoldingRule(db, id);
  if (!cur) throw new HoldingRuleError('not_found', 'no such rule');
  const template = patch.template ?? cur.template;
  if (patch.template !== undefined && patch.template !== cur.template && patch.params === undefined) throw new HoldingRuleError('invalid', 'a new template needs its params');
  const params = patch.params !== undefined ? checked(template, patch.params) : cur.params;
  const scopeSymbol = patch.scopeSymbol === undefined ? cur.scopeSymbol : patch.scopeSymbol ? normSymbol(patch.scopeSymbol) : null;
  const enabled = patch.enabled ?? cur.enabled;
  const notify = patch.notify ?? cur.notify;
  const changed = template !== cur.template || JSON.stringify(params) !== JSON.stringify(cur.params) || scopeSymbol !== cur.scopeSymbol || (!enabled && cur.enabled);
  return db.transaction((tx) => {
    const r = tx
      .update(holdingRule)
      .set({ template, params: JSON.stringify(params), scopeSymbol, enabled, notify, updatedAt: new Date(now).toISOString() })
      .where(eq(holdingRule.id, id))
      .returning()
      .get();
    if (changed) tx.delete(holdingRuleState).where(eq(holdingRuleState.ruleId, id)).run();
    return view(r);
  });
}

/** true when it existed; its states go with it */
export function deleteHoldingRule(db: Db, id: number): boolean {
  return db.transaction((tx) => {
    tx.delete(holdingRuleState).where(eq(holdingRuleState.ruleId, id)).run();
    return tx.delete(holdingRule).where(eq(holdingRule.id, id)).run().changes > 0;
  });
}

/** The enabled rules that apply to `symbol`: scope null (every holding) or that symbol. */
export function rulesForSymbol(db: Db, symbol: string): HoldingRuleView[] {
  const s = normSymbol(symbol);
  return listHoldingRules(db).filter((r) => r.enabled && (r.scopeSymbol === null || r.scopeSymbol === s));
}

/**
 * Evaluate every rule that applies to `symbol` against `facts` (raw, no hysteresis) and store the result. An unknown
 * evaluation does not wipe the history: `since`, the last known state, its time and value stay. `since` is set when a
 * known evaluation applies and none is set, and cleared only by a known 'clear'.
 */
export function evaluateAndStore(db: Db, symbol: string, facts: RuleFacts, now: number = Date.now()): HoldingRuleStatus[] {
  const s = normSymbol(symbol);
  const at = new Date(now).toISOString();
  const rules = rulesForSymbol(db, s);
  if (!rules.length) return [];
  return db.transaction((tx) => {
    const out: HoldingRuleStatus[] = [];
    for (const rule of rules) {
      const prev = tx
        .select()
        .from(holdingRuleState)
        .where(and(eq(holdingRuleState.ruleId, rule.id), eq(holdingRuleState.symbol, s)))
        .get();
      const r = evaluateRule(rule, facts);
      const known = r.state !== 'unknown';
      const since = r.state === 'applies' ? (prev?.since ?? at) : r.state === 'clear' ? null : (prev?.since ?? null);
      const lastKnownState = known ? (r.state as 'applies' | 'clear') : ((prev?.lastKnownState ?? null) as 'applies' | 'clear' | null);
      const lastKnownAt = known ? at : (prev?.lastKnownAt ?? null);
      const lastValue = known ? r.value : (prev?.lastValue ?? null);
      const row = { state: r.state, since, lastValue, lastKnownState, lastKnownAt, lastEvaluatedAt: at };
      tx.insert(holdingRuleState)
        .values({ ruleId: rule.id, symbol: s, ...row, lastNotifiedAt: null })
        .onConflictDoUpdate({ target: [holdingRuleState.ruleId, holdingRuleState.symbol], set: row })
        .run();
      out.push({ ruleId: rule.id, template: rule.template, params: rule.params, scopeSymbol: rule.scopeSymbol, state: r.state, value: r.value, source: r.source, costAsOf: r.costAsOf, since, lastKnownState, lastKnownAt });
    }
    return out;
  });
}

/**
 * Forget states that no longer mean anything: symbols not held any more, rules now scoped to another symbol, and
 * disabled rules. Returns how many were removed.
 */
export function pruneRuleStates(db: Db, held: readonly string[] = heldSymbols(db)): number {
  const keep = new Set(held.map(normSymbol));
  const rules = new Map(listHoldingRules(db).map((r) => [r.id, r]));
  const rows = db.select({ ruleId: holdingRuleState.ruleId, symbol: holdingRuleState.symbol }).from(holdingRuleState).all();
  const drop = rows.filter((x) => {
    const r = rules.get(x.ruleId);
    return !r || !r.enabled || !keep.has(x.symbol) || (r.scopeSymbol !== null && r.scopeSymbol !== x.symbol);
  });
  if (!drop.length) return 0;
  db.transaction((tx) => {
    for (const x of drop) tx.delete(holdingRuleState).where(and(eq(holdingRuleState.ruleId, x.ruleId), eq(holdingRuleState.symbol, x.symbol))).run();
  });
  return drop.length;
}

/** symbol → how many enabled rules of a known template (scope null or that symbol) apply now, from the stored raw states */
export function rulesApplyingBySymbol(db: Db): Map<string, number> {
  const rows = db.$client
    .prepare(
      `select s.symbol, count(*) n from holding_rule_state s join holding_rule r on r.id = s.rule_id
         where s.state = 'applies' and r.enabled = 1 and (r.scope_symbol is null or r.scope_symbol = s.symbol)
           and r.template in (select value from json_each(?)) group by s.symbol`,
    )
    .all(JSON.stringify(TEMPLATE_IDS)) as Array<{ symbol: string; n: number }>;
  return new Map(rows.map((r) => [r.symbol, r.n]));
}
