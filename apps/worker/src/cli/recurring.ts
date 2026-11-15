import { category, expectedSlots, merchant, openDb, recurringStream, setStreamState, transactions } from '@finc/core';
import type { Command } from 'commander';
import { eq, sql } from 'drizzle-orm';

const money = (minor: number): string => (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s: string | number, n: number): string => String(s).padStart(n);

export function registerRecurringCommands(program: Command): void {
  const rec = program.command('recurring').description('Recurring streams: fixed expenses, subscriptions, fixed income');

  rec
    .command('list')
    .description('Streams by state')
    .option('-s, --state <state>', 'confirmed|candidate|ended|rejected|all', 'confirmed')
    .action((opts: { state: string }) => {
      const db = openDb();
      try {
        const rows = db
          .select()
          .from(recurringStream)
          .where(opts.state === 'all' ? sql`1=1` : eq(recurringStream.state, opts.state))
          .orderBy(recurringStream.direction, sql`abs(${recurringStream.expectedAmount}) desc`)
          .all();
        for (const s of rows) {
          const m = db.select().from(merchant).where(eq(merchant.id, s.merchantId)).get();
          const c = s.categoryId ? db.select().from(category).where(eq(category.id, s.categoryId)).get() : null;
          const amt = s.originalCurrency ? `${money(s.expectedAmount)} (${s.originalCurrency} ${money(s.expectedOriginalAmount ?? 0)})` : money(s.expectedAmount);
          console.log(`#${pad(s.id, 3)} ${s.state.padEnd(9)} ${s.direction.padEnd(7)} ${s.frequency.padEnd(9)} ${pad(amt, 24)} ±${pad(money(s.amountTolerance), 8)} ${s.amountModel.padEnd(8)} x${pad(s.occurrences, 2)} day ${pad(s.expectedDay ?? '-', 2)} next ${s.nextExpectedDate ?? '-'}  ${(m?.name ?? '?').slice(0, 28).padEnd(28)} ${c?.key ?? ''}`);
        }
        console.log(`${rows.length} stream(s)`);
      } finally {
        db.$client.close();
      }
    });

  rec
    .command('month [month]')
    .description('Expected occurrences in a month: matched, upcoming, missing')
    .action((month?: string) => {
      const db = openDb();
      try {
        const m = month ?? new Date().toISOString().slice(0, 7);
        const slots = expectedSlots(db, m);
        for (const s of slots.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate))) {
          const mer = db.select().from(merchant).where(eq(merchant.id, s.merchantId)).get();
          console.log(`${s.expectedDate} ${pad(money(s.amount), 12)} ${s.status.padEnd(9)} ${(mer?.name ?? '?').slice(0, 30)}${s.matchedTxnId ? `  (txn #${s.matchedTxnId})` : ''}`);
        }
        const missing = slots.filter((s) => s.status === 'missing');
        const upcoming = slots.filter((s) => s.status === 'upcoming');
        console.log(`\n${slots.length} slots: ${slots.filter((s) => s.status === 'matched').length} matched, ${upcoming.length} upcoming (${money(upcoming.reduce((a, s) => a + s.amount, 0))}), ${missing.length} missing (${money(missing.reduce((a, s) => a + s.amount, 0))})`);
      } finally {
        db.$client.close();
      }
    });

  for (const verdict of ['confirm', 'reject', 'end', 'pause'] as const) {
    rec
      .command(`${verdict} <id>`)
      .description(`${verdict} a stream (your decision sticks across engine runs)`)
      .option('--label <text>', 'a name for the stream, e.g. "rent"')
      .action((id: string, opts: { label?: string }) => {
        const db = openDb();
        try {
          const state = verdict === 'confirm' ? 'confirmed' : verdict === 'reject' ? 'rejected' : verdict === 'end' ? 'ended' : 'paused';
          setStreamState(db, Number(id), state, opts.label);
          console.log(`stream #${id} → ${state}`);
        } finally {
          db.$client.close();
        }
      });
  }

  rec
    .command('compare')
    .description('Our confirmed streams vs the merchants RiseUp marks as fixed (actualType=fixed)')
    .action(() => {
      const db = openDb();
      try {
        const ours = new Set(db.select({ m: recurringStream.merchantId }).from(recurringStream).where(eq(recurringStream.state, 'confirmed')).all().map((r) => r.m));
        const riseupFixed = db
          .select({ m: transactions.merchantId, n: sql<number>`count(*)` })
          .from(transactions)
          .where(sql`json_extract(${transactions.annotationsJson}, '$.riseup.actualType') = 'fixed' and ${transactions.txnDate} >= date('now', '-12 months') and ${transactions.excluded} = 0 and ${transactions.merchantId} is not null`)
          .groupBy(transactions.merchantId)
          .having(sql`count(*) >= 2`)
          .all();
        const theirs = new Set(riseupFixed.map((r) => r.m!));
        const both = [...ours].filter((m) => theirs.has(m));
        const onlyOurs = [...ours].filter((m) => !theirs.has(m));
        const onlyTheirs = [...theirs].filter((m) => !ours.has(m));
        const name = (id: number) => db.select().from(merchant).where(eq(merchant.id, id)).get()?.name ?? `#${id}`;
        console.log(`confirmed streams: ${ours.size}; RiseUp fixed merchants (≥2 rows, 12m): ${theirs.size}; agree: ${both.length}`);
        console.log(`only ours (${onlyOurs.length}): ${onlyOurs.map(name).join(', ')}`);
        console.log(`only RiseUp (${onlyTheirs.length}): ${onlyTheirs.map(name).join(', ')}`);
      } finally {
        db.$client.close();
      }
    });
}
