import { compareMonth, currentMonth, hubOverview, link, monthSummary, monthsBetween, openDb, paidBackLine, rawSourceCrossCheck, transactions } from '@finc/core';
import type { Command } from 'commander';
import { and, desc, eq, sql } from 'drizzle-orm';

const money = (minor: number): string => (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s: string | number, n: number): string => String(s).padStart(n);

export function registerMonthCommands(program: Command): void {
  program
    .command('month [month]')
    .description('Monthly summary with the no-double-counting rules (default: current month)')
    .option('--billing', 'count card rows by billing date instead of purchase date', false)
    .option('-c, --categories', 'also break the month down by category', false)
    .option('--json', 'machine-readable', false)
    .action((month: string | undefined, opts: { billing: boolean; categories: boolean; json: boolean }) => {
      const db = openDb();
      try {
        const s = monthSummary(db, month ?? currentMonth(), opts.billing ? 'billing' : 'purchase');
        if (opts.json) return console.log(JSON.stringify(s, null, 2));
        console.log(`${s.month}  (${s.view} view)`);
        const expIn = s.expectedIncomeRemaining;
        const expFixed = s.expectedFixedRemaining;
        const expInst = s.expectedInstallments.reduce((a, e) => a + e.amount, 0);
        console.log(`  income        ${pad(money(s.income.sum), 14)}  (${s.income.count} rows)${expIn ? `   + expected ${money(expIn)}` : ''}`);
        console.log(`  fixed         ${pad(money(s.fixed.sum), 14)}  (${s.fixed.count} rows)${expFixed ? `   + expected ${money(expFixed)}` : ''}`);
        console.log(`  variable      ${pad(money(s.variable.sum), 14)}  (${s.variable.count} rows, refunds netted ${money(s.refundsNetted)})`);
        console.log(`  installments  ${pad(money(s.installments.sum), 14)}  (${s.installments.count} slices)${expInst ? `   + expected ${money(expInst)}` : ''}`);
        console.log(`  savings       ${pad(money(s.savings.sum), 14)}  (${s.savings.count} rows)`);
        console.log(`  net so far    ${pad(money(s.net), 14)}`);
        const h = hubOverview(db, s.month, s.view);
        const f = h.forecast;
        if (f.isCurrentMonth) {
          const sp = h.spread;
          const ex = h.incomeSplit.extra.received + h.incomeSplit.extra.expected;
          console.log(`  room before variable ${pad(money(f.roomBeforeVariable), 14)}   (income ${money(f.income.total)} − committed ${money(f.committed.total)} − savings ${money(f.savings.total)})`);
          console.log(`  left to spend ${pad(money(f.left), 14)}   ${f.state === 'short' ? 'the month is already short' : sp.extraExcluded ? '' : f.weekly.envelope !== null ? `≈ ${money(f.weekly.envelope)} a week` : ''}`);
          console.log(`  without extra ${pad(money(h.withoutExtra.left), 14)}   (${h.withoutExtra.tone}; extra income ${money(ex)})`);
          if (sp.extraExcluded && sp.projectedAll) {
            // the large-extra rule: the envelope and the projection on the regular income, and on all of it
            console.log(`  a large extra is not spread: on the regular income ${f.weekly.envelope !== null ? `≈ ${money(f.weekly.envelope)} a week` : 'nothing left to spread'}; including the extra ${sp.weeklyAll !== null ? `≈ ${money(sp.weeklyAll)} a week` : '-'}`);
            console.log(`  projected end ${pad(money(f.projected.end), 14)}   on the regular income (${money(f.projected.lo)} to ${money(f.projected.hi)})`);
            console.log(`  projected end ${pad(money(sp.projectedAll.end), 14)}   including the extra (${money(sp.projectedAll.lo)} to ${money(sp.projectedAll.hi)}; usual pace: variable ${money(f.variable.predicted)} of which ${money(f.variable.remaining)} still to come)`);
          } else {
            console.log(`  projected end ${pad(money(f.projected.end), 14)}   (${money(f.projected.lo)} to ${money(f.projected.hi)}; usual pace: variable ${money(f.variable.predicted)} of which ${money(f.variable.remaining)} still to come)`);
          }
        }
        const l = h.limit;
        if (l) {
          const pace = l.pace.state === 'on' ? 'on pace' : `${money(Math.abs(l.pace.delta))} ${l.pace.state === 'ahead' ? 'ahead of' : 'under'} pace`;
          const left = l.leftWithin >= 0 ? `${money(l.leftWithin)} left within it` : `${money(-l.leftWithin)} over it`;
          console.log(`  spending limit ${money(l.amount)}: spent ${money(l.spent)} (${l.usedPct}%), ${pace}, ${left}${l.week ? `; this week ${money(l.week.spent)} of ${money(l.week.limit)}` : ''}`);
        }
        // paid back to me: already netted in the variable line above
        const pb = paidBackLine(h.paidBack, (m) => `₪${money(m)}`);
        if (pb) console.log(`  ${pb}`);
        const missing = s.expectedFixed.filter((e) => e.status === 'missing');
        if (missing.length) console.log(`  ⚠ ${missing.length} expected fixed item(s) not yet charged: ${missing.map((e) => `${money(e.amount)} on ${e.expectedDate}`).join(', ')}`);
        console.log(`  excluded: settlements ${money(s.excluded.settlements.sum)} (${s.excluded.settlements.count}), transfers ${money(s.excluded.transfers.sum)} (${s.excluded.transfers.count}), refunds ${money(s.excluded.refunds.sum)} (${s.excluded.refunds.count})`);
        for (const a of s.byAccount) console.log(`  #${a.accountId} ${(a.displayName ?? a.type).padEnd(30)} in ${pad(money(a.income), 12)}  out ${pad(money(a.out), 12)}  (${a.count})`);
        if (opts.categories) {
          console.log('  by category:');
          for (const c of s.byCategory) console.log(`    ${(c.key ?? '(uncategorised)').padEnd(26)} ${(c.nameHe ?? '').padEnd(20)} ${pad(money(c.sum), 12)}  (${c.count})`);
        }
        if (s.expectedInstallments.length) console.log(`  expected installment slices still to come: ${s.expectedInstallments.map((e) => `${money(e.amount)} on ${e.expectedDate} (${e.n}/${e.totalN})`).join(', ')}`);
        console.log(`  integrity: buckets ${money(s.integrity.bucketsSum)} = non-excluded ${money(s.integrity.nonExcludedSum)} + netted ${money(s.refundsNetted)} → ${s.integrity.ok ? 'OK' : 'MISMATCH'}; pending rows ${s.integrity.pendingCount}`);
        for (const u of s.integrity.unmatchedSettlementDebits) console.log(`  ⚠ card-company debit not matched to card rows: ${u.date} ${money(u.amount)} ${u.description}`);
      } finally {
        db.$client.close();
      }
    });

  program
    .command('compare')
    .description('Our monthly in/out vs RiseUp, every difference attributed; plus the raw-source cross-check')
    .option('--from <YYYY-MM>', 'first month', '2025-11')
    .option('--to <YYYY-MM>', 'last month (default: current)')
    .option('--cells', 'show the attribution cells per month', false)
    .action((opts: { from: string; to?: string; cells: boolean }) => {
      const db = openDb();
      try {
        const months = monthsBetween(opts.from, opts.to ?? currentMonth());
        console.log('month     ours in      riseup in    Δin        ours out      riseup out    Δout       riseup rows');
        for (const m of months) {
          const c = compareMonth(db, m);
          console.log(`${m}  ${pad(money(c.ours.in), 11)}  ${pad(money(c.riseup.in), 11)}  ${pad(money(c.diffIn), 9)}  ${pad(money(c.ours.out), 12)}  ${pad(money(c.riseup.out), 12)}  ${pad(money(c.diffOut), 9)}  ${pad(c.riseupRowsSeen, 5)}`);
          if (opts.cells) for (const cell of c.cells) console.log(`            ours=${cell.ours.padEnd(8)} riseup=${cell.riseup.padEnd(8)} ${pad(cell.count, 4)} rows  ${pad(money(cell.sum), 12)}`);
        }
        console.log('\nraw-source cross-check (completed scraped rows per account/month = transactions owned by that source):');
        const checks = rawSourceCrossCheck(db, { from: opts.from, ...(opts.to ? { to: opts.to } : {}) });
        const bad = checks.filter((c) => !c.ok);
        console.log(`  ${checks.length} account-months checked, ${bad.length} mismatches`);
        for (const b of bad) console.log(`  ✗ account #${b.accountId} ${b.month} ${b.source}: raw ${b.rawCount} rows ${money(b.rawSum)} vs table ${b.txnCount} rows ${money(b.txnSum)}`);
      } finally {
        db.$client.close();
      }
    });

  program
    .command('links')
    .description('Links between transactions (settlements, refunds, cancellations)')
    .option('-t, --type <type>', 'card_settlement|refund|cancellation|transfer')
    .option('-z, --zone <zone>', 'auto|suggest')
    .option('-n, --limit <n>', 'how many', '40')
    .action((opts: { type?: string; zone?: string; limit: string }) => {
      const db = openDb();
      try {
        const conds = [];
        if (opts.type) conds.push(eq(link.type, opts.type));
        if (opts.zone) conds.push(eq(link.zone, opts.zone));
        const rows = db
          .select()
          .from(link)
          .where(conds.length ? and(...conds) : sql`1=1`)
          .orderBy(desc(link.createdAt), desc(link.id))
          .limit(Number(opts.limit))
          .all();
        for (const l of rows) {
          const from = db.select().from(transactions).where(eq(transactions.id, l.fromTxnId)).get();
          const to = db.select().from(transactions).where(eq(transactions.id, l.toTxnId)).get();
          console.log(`#${pad(l.id, 5)} ${l.type.padEnd(15)} ${l.zone.padEnd(7)} ${l.confidence.toFixed(2)} ${l.decision ?? '-'}  ${from?.txnDate} ${pad(money(l.amount), 10)} ${(from?.descriptionRaw ?? '').slice(0, 24).padEnd(24)} → ${to?.txnDate} ${pad(money(to?.amountIls ?? 0), 10)} ${(to?.descriptionRaw ?? '').slice(0, 24)}`);
        }
      } finally {
        db.$client.close();
      }
    });

  const review = program.command('review').description('Suggestions waiting for a decision');
  review
    .command('inbox', { isDefault: true })
    .description('How much is waiting in each queue')
    .action(() => {
      const db = openDb();
      try {
        const c = db.$client;
        const links = (c.prepare(`select count(*) n from link where zone='suggest' and decision is null and type in ('refund','cancellation')`).get() as { n: number }).n;
        const gapCycles = (c.prepare(`select count(distinct from_txn_id) n from link where zone='suggest' and decision is null and type='card_settlement'`).get() as { n: number }).n;
        const uncat = c.prepare(`select count(distinct merchant_id) m, count(*) n from "transaction" where excluded=0 and status='completed' and category_id is null and txn_date >= date('now','-12 months')`).get() as { m: number; n: number };
        const cand = (c.prepare(`select count(*) n from recurring_stream where state='candidate'`).get() as { n: number }).n;
        const excl = (c.prepare(`select count(*) n from "transaction" where excluded=0 and json_extract(annotations_json,'$.riseup.isExcluded')=1`).get() as { n: number }).n;
        const missing = (c.prepare(`select count(*) n from recurring_stream where state='confirmed' and next_expected_date < date('now','-7 days')`).get() as { n: number }).n;
        console.log(`suggested refund/cancellation links  ${String(links).padStart(4)}   finc review list`);
        console.log(`card cycles matched with a gap       ${String(gapCycles).padStart(4)}   finc links -t card_settlement -z suggest`);
        console.log(`uncategorised (12 months)            ${String(uncat.n).padStart(4)} rows / ${uncat.m} merchants   finc cat report`);
        console.log(`recurring candidates                 ${String(cand).padStart(4)}   finc recurring list -s candidate`);
        console.log(`fixed items overdue                  ${String(missing).padStart(4)}   finc recurring month`);
        console.log(`rows RiseUp excluded that we count   ${String(excl).padStart(4)}   finc review exclusions`);
      } finally {
        db.$client.close();
      }
    });
  review
    .command('list')
    .description('Suggested links with their explanation')
    .action(() => {
      const db = openDb();
      try {
        const rows = db
          .select()
          .from(link)
          .where(and(eq(link.zone, 'suggest'), sql`${link.decision} is null`, sql`${link.type} in ('refund','cancellation','transfer')`))
          .orderBy(desc(link.confidence))
          .all();
        if (!rows.length) return console.log('nothing to review');
        for (const l of rows) {
          const from = db.select().from(transactions).where(eq(transactions.id, l.fromTxnId)).get();
          const to = db.select().from(transactions).where(eq(transactions.id, l.toTxnId)).get();
          console.log(`#${l.id} ${l.type} ${l.confidence.toFixed(2)}: ${from?.txnDate} ${money(l.amount)} "${(from?.descriptionRaw ?? '').slice(0, 30)}" ↔ ${to?.txnDate} ${money(to?.amountIls ?? 0)} "${(to?.descriptionRaw ?? '').slice(0, 30)}"`);
          for (const s of JSON.parse(l.explanationJson) as Array<{ signal: string; score: number; note: string }>) console.log(`      ${s.signal.padEnd(9)} ${s.score.toFixed(2)}  ${s.note}`);
        }
        console.log(`\n${rows.length} suggestion(s). Decide with: finc review confirm <id> | finc review reject <id>`);
      } finally {
        db.$client.close();
      }
    });
  review
    .command('exclusions')
    .description('Rows RiseUp excluded from its cashflow that we still count (candidates for `finc tx exclude`)')
    .action(() => {
      const db = openDb();
      try {
        const rows = db
          .select()
          .from(transactions)
          .where(and(eq(transactions.excluded, false), sql`json_extract(${transactions.annotationsJson}, '$.riseup.isExcluded') = 1`))
          .orderBy(desc(transactions.txnDate))
          .all();
        if (!rows.length) return console.log('none');
        for (const t of rows) console.log(`#${pad(t.id, 5)} ${t.txnDate} ${pad(money(t.amountIls), 12)} ${t.descriptionRaw.slice(0, 40)}  (RiseUp comment: ${(JSON.parse(t.annotationsJson!).riseup.comment ?? '-') as string})`);
        console.log(`\n${rows.length} row(s). Exclude one with: finc tx exclude <id>`);
      } finally {
        db.$client.close();
      }
    });

  const tx = program.command('tx').description('Per-transaction decisions');
  tx.command('exclude <id>')
    .description('Exclude a transaction from the cashflow (one-off that is not spending or income, e.g. a property transfer)')
    .option('--note <text>', 'why')
    .action((id: string, opts: { note?: string }) => {
      const db = openDb();
      try {
        const r = db.update(transactions).set({ excluded: true, kind: 'ignore', ...(opts.note ? { note: opts.note } : {}) }).where(eq(transactions.id, Number(id))).run();
        console.log(r.changes ? `#${id} excluded` : `no transaction #${id}`);
      } finally {
        db.$client.close();
      }
    });
  tx.command('include <id>')
    .description('Undo an exclusion')
    .action((id: string) => {
      const db = openDb();
      try {
        const t = db.select().from(transactions).where(eq(transactions.id, Number(id))).get();
        if (!t) throw new Error(`no transaction #${id}`);
        db.update(transactions).set({ excluded: false, kind: t.amountIls < 0 ? 'expense' : 'income' }).where(eq(transactions.id, t.id)).run();
        console.log(`#${id} included again`);
      } finally {
        db.$client.close();
      }
    });

  for (const verdict of ['confirm', 'reject'] as const) {
    review
      .command(`${verdict} <id>`)
      .description(`${verdict} a link; a confirmed refund is netted, a rejected one is ignored`)
      .action((id: string) => {
        const db = openDb();
        try {
          const l = db.select().from(link).where(eq(link.id, Number(id))).get();
          if (!l) throw new Error(`no link #${id}`);
          const decision = verdict === 'confirm' ? 'confirmed' : 'rejected';
          db.update(link).set({ decision, zone: verdict === 'confirm' ? 'auto' : l.zone, source: 'user' }).where(eq(link.id, l.id)).run();
          if (l.type === 'refund' || l.type === 'cancellation') {
            db.update(transactions).set({ kind: verdict === 'confirm' ? 'refund' : 'income', excluded: verdict === 'confirm' }).where(eq(transactions.id, l.fromTxnId)).run();
          }
          console.log(`link #${l.id} ${decision}`);
        } finally {
          db.$client.close();
        }
      });
  }
}
