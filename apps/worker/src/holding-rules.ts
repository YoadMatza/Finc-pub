/**
 * Evaluating the owner's holding rules (research_notes/proposals/stock-decision-aids.md, Part A, step 1) and storing
 * their state per rule and held symbol. No new data source: the facts come from the holdings snapshots, the live-price
 * cache and the insights panel (insights-panel.ts), which reuses the Yahoo and SEC services' caches, limits and
 * deadlines.
 *
 * When:
 *  - a panel is built for a holding (GET /api/holdings/:id/insights): at once, for the rules that apply to its symbol
 *    (rulesForPanel);
 *  - daily at 23:30 Israel time (after the US close) and after each successful bank sync: every held security, one
 *    after another with a pause between them; a holding whose rules need only holdings data builds no panel (nothing
 *    is fetched), and a holding without rules is skipped;
 *  - right after a rule is created or changed (evaluateSymbols, awaited by the API within the panel's deadline), for
 *    the symbols it covers, so the holdings list's counts follow the edit.
 * One run at a time: a run asked for while one is going runs once more after it. States of symbols no longer held, of
 * disabled rules and of rules scoped elsewhere are pruned at the start of each run.
 *
 * The log carries counts only: no symbol, value or threshold.
 */
import {
  type Db,
  type FactKey,
  type HeldPosition,
  type HoldingInsights,
  type HoldingRuleStatus,
  type PriceCache,
  RULES_TZ,
  assembleFacts,
  emptyPriceCache,
  evaluateAndStore,
  heldPositions,
  normSymbol,
  pruneRuleStates,
  ruleTemplate,
  rulesForSymbol,
} from '@finc/core';
import { Cron } from 'croner';
import { type PanelDeps, buildPanel } from './insights-panel.js';
import { log as defaultLog } from './logger.js';

/** facts that come from the holdings alone (no panel needed) */
const POSITION_FACTS: ReadonlySet<FactKey> = new Set(['costPrice', 'price', 'valueIls', 'portfolioIls', 'dayChangePct']);
export const RULES_DAILY_CRON = '30 23 * * *';
export const RULES_GAP_MS = 1500;

/**
 * The rules of one symbol evaluated against a panel just built (and the holdings as they are now), stored, and returned
 * for the panel's `rules` field. A symbol not held any more evaluates without position facts (those rules unknown).
 */
export function rulesForPanel(db: Db, symbol: string, insights: HoldingInsights | null, cache: PriceCache, now: number): HoldingRuleStatus[] {
  const s = normSymbol(symbol);
  if (!rulesForSymbol(db, s).length) return [];
  const held = heldPositions(db, cache, now);
  return evaluateAndStore(db, s, assembleFacts({ position: held.positions.get(s) ?? null, portfolio: held, insights, now }), now);
}

export interface HoldingRulesDeps {
  db: Db;
  /** the Yahoo and SEC services, read at each run (they may be absent: the panel then answers 'off') */
  panel: () => PanelDeps;
  prices?: () => PriceCache;
  now?: () => number;
  /** pause between two holdings in a run (default 1.5 s) */
  gapMs?: number;
  log?: { info(o: object, m: string): void; warn(o: object, m: string): void };
}

export interface RulesRunResult {
  symbols: number;
  evaluated: number;
  panels: number;
  failed: number;
  pruned: number;
}

export class HoldingRulesService {
  private cron: Cron | null = null;
  private running: Promise<RulesRunResult> | null = null;
  private again = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly log: NonNullable<HoldingRulesDeps['log']>;

  constructor(private readonly deps: HoldingRulesDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? defaultLog;
  }

  /** The daily run at 23:30 Israel time. */
  start(): void {
    this.stopped = false;
    this.cron ??= new Cron(RULES_DAILY_CRON, { timezone: RULES_TZ, name: 'holding-rules' }, () => void this.runAll('daily'));
  }

  stop(): void {
    this.stopped = true;
    this.cron?.stop();
    this.cron = null;
  }

  /**
   * After a rule changed: evaluate the held symbols it covers now (`symbols` null = every held security), one after
   * another without a pause, through the panel's caches and deadlines. Runs alongside a daily run (the services join
   * fetches in flight); never prunes. Returns how many symbols were evaluated. Never throws.
   */
  async evaluateSymbols(symbols: readonly string[] | null): Promise<number> {
    const held = heldPositions(this.deps.db, this.cache(), this.now());
    const want = symbols === null ? [...held.positions.keys()].sort() : [...new Set(symbols.map(normSymbol))].filter((s) => held.positions.has(s));
    let n = 0;
    for (const symbol of want) {
      if (this.stopped) break;
      if (await this.evaluateOne(symbol, held.positions.get(symbol)!)) n++;
    }
    return n;
  }

  private cache(): PriceCache {
    return this.deps.prices?.() ?? emptyPriceCache();
  }

  /** One symbol: its panel when a rule needs one, then the store. false when it has no rules or failed. */
  private async evaluateOne(symbol: string, p: HeldPosition, beforePanel?: () => Promise<void>): Promise<boolean> {
    const { db } = this.deps;
    const rules = rulesForSymbol(db, symbol);
    if (!rules.length) return false;
    try {
      const needsPanel = rules.some((r) => (ruleTemplate(r.template)?.facts ?? []).some((f) => !POSITION_FACTS.has(f)));
      let insights: HoldingInsights | null = null;
      if (needsPanel) {
        await beforePanel?.();
        insights = await buildPanel(this.deps.panel(), panelRow(p), this.now);
        this.panelsBuilt++;
      }
      // the holdings as they are now (a run takes a while; live prices move)
      const now = this.now();
      const fresh = heldPositions(db, this.cache(), now);
      evaluateAndStore(db, symbol, assembleFacts({ position: fresh.positions.get(symbol) ?? null, portfolio: fresh, insights, now }), now);
      return true;
    } catch (e) {
      this.failedCount++;
      this.log.warn({ err: e instanceof Error ? e.message.slice(0, 200) : 'error' }, 'holding rules: one holding could not be evaluated');
      return false;
    }
  }

  private panelsBuilt = 0;
  private failedCount = 0;

  /** Evaluate every held security; one run at a time (a request during a run makes one more run after it). Never throws. */
  runAll(reason: 'daily' | 'sync' | 'manual' = 'manual'): Promise<RulesRunResult> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = (async (): Promise<RulesRunResult> => {
      let r = await this.runOnce(reason);
      while (this.again && !this.stopped) {
        this.again = false;
        r = await this.runOnce(reason);
      }
      return r;
    })().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async runOnce(reason: string): Promise<RulesRunResult> {
    const out: RulesRunResult = { symbols: 0, evaluated: 0, panels: 0, failed: 0, pruned: 0 };
    try {
      const held = heldPositions(this.deps.db, this.cache(), this.now());
      out.symbols = held.positions.size;
      out.pruned = pruneRuleStates(this.deps.db, [...held.positions.keys()]);
      const panels0 = this.panelsBuilt;
      const failed0 = this.failedCount;
      let first = true;
      const gap = async (): Promise<void> => {
        if (!first) await this.pause();
        first = false;
      };
      for (const symbol of [...held.positions.keys()].sort()) {
        if (this.stopped) break;
        if (await this.evaluateOne(symbol, held.positions.get(symbol)!, gap)) out.evaluated++;
      }
      out.panels = this.panelsBuilt - panels0;
      out.failed = this.failedCount - failed0;
      this.log.info({ reason, ...out }, 'holding rules: evaluated');
    } catch (e) {
      this.log.warn({ reason, err: e instanceof Error ? e.message.slice(0, 200) : 'error' }, 'holding rules: run failed');
    }
    return out;
  }

  private pause(): Promise<void> {
    const ms = this.deps.gapMs ?? RULES_GAP_MS;
    if (ms <= 0) return Promise.resolve();
    return new Promise((res) => setTimeout(res, ms).unref?.());
  }
}

const panelRow = (p: HeldPosition) => ({ id: p.rowId, symbol: p.symbol, name: p.name, currency: p.currency, price: p.bankPrice, takenAt: p.takenAt });
