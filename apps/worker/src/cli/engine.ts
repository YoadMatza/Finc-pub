import { type EngineReport, openDb, runEngine } from '@finc/core';
import type { Command } from 'commander';

const money = (minor: number): string => (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function printEngineReport(e: EngineReport): void {
  const m = e.merchants;
  const p = e.installments;
  const s = e.settlements;
  const r = e.refunds;
  console.log(`merchants:    assigned ${m.transactionsAssigned} transactions, created ${m.merchantsCreated} merchants, merged ${e.merchantsMerged} cross-source spellings`);
  console.log(`installments: plans created ${p.plansCreated}, updated ${p.plansUpdated}, folded ${p.plansFolded}, slices linked ${p.slicesLinked}, duplicate slices merged ${p.duplicatesMerged}`);
  console.log(`settlements:  bank debits ${s.bankDebitsSeen}, matched exact ${s.matchedExact}, with gap ${s.matchedWithGap}, unmatched ${s.unmatched.length}, links ${s.linksCreated}`);
  for (const g of s.gaps.slice(0, 10)) console.log(`    gap ${g.date}: bank ${money(g.bankAmount)} vs ${g.rows} ${g.mode} card rows ${money(g.cardSum)} → ${money(g.gap)}`);
  for (const u of s.unmatched.slice(0, 10)) console.log(`    unmatched ${u.date} ${money(u.amount)} ${u.description}`);
  console.log(`rules:        ${e.rules.rules} rules${e.rules.seeded ? ` (${e.rules.seeded} defaults seeded)` : ''}, tagged ${e.rules.transactionsTagged}`);
  console.log(`refunds:      credits ${r.creditsSeen}, auto-linked ${r.auto}, suggested ${r.suggest}, unmatched ${r.unmatched.length}`);
  for (const u of r.unmatched.slice(0, 12)) console.log(`    unmatched credit ${u.date} ${money(u.amount)} ${u.description.slice(0, 30)}${u.memo ? ` (${u.memo})` : ''}`);
  console.log(`classify:     ${e.classified} rows given a kind by sign`);
  console.log(`cashflow:     ${e.cashflowShifted} rows moved to the next month (month-end salary rule)`);
  const c = e.categorized;
  console.log(`categories:   ${e.categoriesSeeded ? `${e.categoriesSeeded} seeded, ` : ''}memory seeded ${c.memorySeeded}, assigned rule ${c.assigned.rule} memory ${c.assigned.memory} riseup ${c.assigned.riseup} heuristic ${c.assigned.heuristic}, unchanged ${c.unchanged}, still uncategorized ${c.uncategorized}`);
  const rc = e.recurring;
  console.log(`recurring:    ${rc.groupsExamined} merchant groups, streams created ${rc.created}, updated ${rc.updated}, ended ${rc.ended}, dropped ${rc.dropped}, rows assigned ${rc.rowsAssigned}`);
  console.log(`done in ${e.ms} ms`);
}

export function registerEngineCommands(program: Command): void {
  const eng = program.command('engine').description('Truth engine (Phase 2): merchants, installments, links, counting rules');

  eng
    .command('run')
    .description('Run every engine step over the database (idempotent)')
    .option('--reassign-merchants', 'recompute merchant keys for all transactions', false)
    .action((opts: { reassignMerchants: boolean }) => {
      const db = openDb();
      try {
        printEngineReport(runEngine(db, { reassignMerchants: opts.reassignMerchants }));
      } finally {
        db.$client.close();
      }
    });

  eng
    .command('merchants')
    .description('Top merchants by transaction count')
    .option('-n, --limit <n>', 'how many', '30')
    .action((opts: { limit: string }) => {
      const db = openDb();
      try {
        const rows = db.$client
          .prepare(
            `select m.id, m.key, m.name, count(t.id) n, round(sum(case when t.amount_ils<0 then -t.amount_ils else 0 end)/100.0) spent, m.aliases_json aliases
             from merchant m join "transaction" t on t.merchant_id = m.id group by m.id order by n desc limit ?`,
          )
          .all(Number(opts.limit)) as Array<{ id: number; key: string; name: string; n: number; spent: number; aliases: string }>;
        for (const r of rows) console.log(`#${String(r.id).padStart(4)} ${r.key.padEnd(34)} ${String(r.n).padStart(4)} txns  ₪${String(r.spent).padStart(8)}  aliases ${JSON.parse(r.aliases).length}`);
        const total = db.$client.prepare('select count(*) n from merchant').get() as { n: number };
        console.log(`${total.n} merchants in total`);
      } finally {
        db.$client.close();
      }
    });

  eng
    .command('plans')
    .description('Installment plans')
    .action(() => {
      const db = openDb();
      try {
        const rows = db.$client
          .prepare(
            `select p.id, p.account_id acc, coalesce(m.key,'?') merchant, p.total_n total, p.seen_n seen, p.slice_amount/100.0 slice, p.original_amount/100.0 full_amt, p.first_date first, p.status
             from installment_plan p left join merchant m on m.id = p.merchant_id order by p.first_date`,
          )
          .all() as Array<{ id: number; acc: number; merchant: string; total: number; seen: number; slice: number; full_amt: number; first: string; status: string }>;
        for (const r of rows) console.log(`#${String(r.id).padStart(3)} acc ${r.acc} ${r.merchant.padEnd(28)} ${String(r.seen).padStart(2)}/${String(r.total).padEnd(2)} slice ${String(r.slice).padStart(9)}  full ${String(r.full_amt).padStart(10)}  from ${r.first}  ${r.status}`);
        console.log(`${rows.length} plans, ${rows.filter((r) => r.status === 'active').length} active`);
      } finally {
        db.$client.close();
      }
    });
}
