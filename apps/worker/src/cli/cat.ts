import { category, categorize, coverage, merchant, openDb, resolveCategory, rule, setCategory, transactions } from '@finc/core';
import type { Command } from 'commander';
import { eq } from 'drizzle-orm';

const money = (minor: number): string => (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const pad = (s: string | number, n: number): string => String(s).padStart(n);

export function registerCategoryCommands(program: Command): void {
  const cat = program.command('cat').description('Categories: list, assign, rules, coverage');

  cat
    .command('list')
    .description('The category tree with 12-month spend')
    .action(() => {
      const db = openDb();
      try {
        const rows = db.$client
          .prepare(
            `select c.id, c.key, c.name_he, c.name_en, c.group_key, c.section, c.icon,
                    count(t.id) n, round(sum(case when t.amount_ils<0 then -t.amount_ils else 0 end)/100.0) spent
             from category c left join "transaction" t on t.category_id=c.id and t.excluded=0 and t.status='completed' and t.txn_date >= date('now','-12 months')
             group by c.id order by c.sort_order`,
          )
          .all() as Array<{ id: number; key: string; name_he: string; name_en: string; group_key: string; section: string; icon: string | null; n: number; spent: number }>;
        let group = '';
        for (const r of rows) {
          if (r.group_key !== group) {
            group = r.group_key;
            console.log(`\n[${group}] (${r.section})`);
          }
          console.log(`  ${(r.icon ?? ' ').padEnd(2)} ${r.key.padEnd(26)} ${r.name_he.padEnd(22)} ${pad(r.n, 5)} rows  ₪${pad(money(r.spent * 100), 8)}`);
        }
      } finally {
        db.$client.close();
      }
    });

  cat
    .command('report')
    .description('Auto-categorisation coverage over the last 12 months, and the biggest uncategorised merchants')
    .option('--since <YYYY-MM-DD>', 'start date', new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10))
    .action((opts: { since: string }) => {
      const db = openDb();
      try {
        const c = coverage(db, opts.since);
        console.log(`since ${opts.since}: ${c.categorized} of ${c.rows} non-excluded rows categorised = ${(c.share * 100).toFixed(1)}%`);
        console.log(`by source: ${Object.entries(c.bySource).map(([k, v]) => `${k}=${v}`).join('  ')}`);
        if (c.uncategorizedByMerchant.length) {
          console.log('\nbiggest uncategorised merchants (decide with: finc cat set merchant:<id> <category>):');
          for (const m of c.uncategorizedByMerchant) console.log(`  merchant:${pad(m.merchantId ?? '-', 4)}  ${pad(m.rows, 3)} rows  ₪${pad(money(m.spend), 7)}  ${m.name.slice(0, 40)}`);
        }
      } finally {
        db.$client.close();
      }
    });

  cat
    .command('set <target> <category>')
    .description('Assign a category. target = a transaction id, or merchant:<id> for the whole merchant. Adds merchant memory; --rule also creates a rule')
    .option('--all', 'with a transaction id: also apply to the whole merchant', false)
    .option('--rule', 'also create a rule for the merchant', false)
    .option('--note <text>', 'why')
    .action((target: string, categoryText: string, opts: { all: boolean; rule: boolean; note?: string }) => {
      const db = openDb();
      try {
        const c = resolveCategory(db, categoryText);
        const p = target.startsWith('merchant:') ? { merchantId: Number(target.slice(9)) } : { txnId: Number(target) };
        const r = setCategory(db, { ...p, categoryId: c.id, applyToMerchant: opts.all, createRule: opts.rule, ...(opts.note ? { note: opts.note } : {}) });
        console.log(`${c.key}: ${r.transactions} transaction(s)${r.merchantUpdated ? ', merchant memory updated' : ''}${r.ruleId ? `, rule #${r.ruleId}` : ''}`);
      } finally {
        db.$client.close();
      }
    });

  cat
    .command('recompute')
    .description('Re-run automatic categorisation (user and rule decisions are kept)')
    .action(() => {
      const db = openDb();
      try {
        const r = categorize(db, { recomputeAutomatic: true });
        console.log(`assigned rule ${r.assigned.rule} memory ${r.assigned.memory} riseup ${r.assigned.riseup} heuristic ${r.assigned.heuristic}; unchanged ${r.unchanged}; uncategorised ${r.uncategorized}`);
      } finally {
        db.$client.close();
      }
    });

  cat
    .command('rules')
    .description('List rules')
    .action(() => {
      const db = openDb();
      try {
        const rows = db.select().from(rule).all();
        if (!rows.length) return console.log('no rules yet (finc cat set <target> <category> --rule)');
        for (const r of rows) {
          const cond = JSON.parse(r.conditionsJson) as { merchantId?: number; descriptionContains?: string };
          const act = JSON.parse(r.actionsJson) as { categoryId?: number };
          const m = cond.merchantId ? db.select().from(merchant).where(eq(merchant.id, cond.merchantId)).get() : null;
          const c = act.categoryId ? db.select().from(category).where(eq(category.id, act.categoryId)).get() : null;
          console.log(`#${r.id} p${r.priority} ${r.enabled ? '' : '(off) '}${m ? `merchant "${m.name}"` : ''}${cond.descriptionContains ? ` contains "${cond.descriptionContains}"` : ''} → ${c?.key ?? JSON.stringify(act)}${r.note ? `  (${r.note})` : ''}`);
        }
      } finally {
        db.$client.close();
      }
    });

  cat
    .command('show <id>')
    .description('One transaction with its category, source and links')
    .action((id: string) => {
      const db = openDb();
      try {
        const t = db.select().from(transactions).where(eq(transactions.id, Number(id))).get();
        if (!t) throw new Error(`no transaction #${id}`);
        const c = t.categoryId ? db.select().from(category).where(eq(category.id, t.categoryId)).get() : null;
        const m = t.merchantId ? db.select().from(merchant).where(eq(merchant.id, t.merchantId)).get() : null;
        console.log(`#${t.id} ${t.txnDate} ${money(t.amountIls)} ${t.descriptionRaw}`);
        console.log(`  merchant ${m ? `#${m.id} ${m.name}` : '-'}  kind ${t.kind}  excluded ${t.excluded}  status ${t.status}  cashflow ${t.cashflowMonth}`);
        console.log(`  category ${c ? `${c.key} (${t.categorySource}, ${t.categoryConfidence})` : 'none'}  plan ${t.installmentPlanId ?? '-'}  stream ${t.recurringStreamId ?? '-'}`);
        if (t.annotationsJson) console.log(`  annotations ${t.annotationsJson.slice(0, 200)}`);
      } finally {
        db.$client.close();
      }
    });
}
