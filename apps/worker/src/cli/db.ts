import { type DedupeDetail, type DedupeReview, mergeCrossSourceDuplicates, openDb } from '@finc/core';
import type { Command } from 'commander';

export function registerDbCommands(program: Command): void {
  const dbc = program.command('db').description('Database integrity tools');

  dbc
    .command('stats')
    .description('Row counts per account and source, duplicate checks')
    .action(() => {
      const db = openDb();
      try {
        const c = db.$client;
        const rows = c
          .prepare(
            `select t.account_id, a.display_name, t.source, count(*) n, min(t.txn_date) oldest, max(t.txn_date) newest
             from "transaction" t join account a on a.id = t.account_id group by t.account_id, t.source order by t.account_id, t.source`,
          )
          .all() as Array<{ account_id: number; display_name: string | null; source: string; n: number; oldest: string; newest: string }>;
        for (const r of rows) console.log(`#${r.account_id} ${(r.display_name ?? '').padEnd(30)} ${r.source.padEnd(18)} ${String(r.n).padStart(5)}  ${r.oldest} → ${r.newest}`);
        const dupFp = (c.prepare(`select count(*) n from (select fingerprint from "transaction" group by fingerprint having count(*) > 1)`).get() as { n: number }).n;
        const dupId = (
          c.prepare(`select count(*) n from (select account_id, source, identifier from "transaction" where identifier is not null group by account_id, source, identifier having count(*) > 1)`).get() as { n: number }
        ).n;
        const twins = (
          c
            .prepare(
              `select count(*) n from "transaction" t where t.source not like 'scraper:%' and exists (
                 select 1 from "transaction" s where s.account_id = t.account_id and s.txn_date = t.txn_date and s.amount_ils = t.amount_ils
                 and s.source like 'scraper:%' and coalesce(s.installment_n, -1) = coalesce(t.installment_n, -1))`,
            )
            .get() as { n: number }
        ).n;
        const total = (c.prepare(`select count(*) n from "transaction"`).get() as { n: number }).n;
        console.log(`transactions: ${total}   duplicate fingerprints: ${dupFp}   repeated identifiers within a source: ${dupId}   lower-source rows with a same-day-same-amount scraped twin: ${twins}`);
      } finally {
        db.$client.close();
      }
    });

  dbc
    .command('dedupe')
    .description('Merge duplicates: RiseUp/import rows into their scraped twin, mirrored settled spellings, and settled bank rows into a stuck pending row (completed, raw still pending)')
    .option('--dry-run', 'report only', false)
    .action((opts: { dryRun: boolean }) => {
      const db = openDb();
      try {
        if (opts.dryRun) {
          db.$client.exec('BEGIN');
          try {
            const r = mergeCrossSourceDuplicates(db);
            console.log(`would merge ${r.merged} of ${r.examined} rows (dry run): ${summarize(r.details)}`);
            for (const d of r.details.slice(0, 10)) console.log(line(d));
            if (r.details.length > 10) console.log(`  … ${r.details.length - 10} more`);
            printReview(r.needsReview);
          } finally {
            db.$client.exec('ROLLBACK');
          }
          return;
        }
        const r = mergeCrossSourceDuplicates(db);
        console.log(`merged ${r.merged} of ${r.examined} rows: ${summarize(r.details)}`);
        for (const d of r.details.slice(0, 10)) console.log(line(d));
        if (r.details.length > 10) console.log(`  … ${r.details.length - 10} more`);
        printReview(r.needsReview);
      } finally {
        db.$client.close();
      }
    });
}

const KIND_LABEL: Record<DedupeDetail['kind'], string> = {
  'cross-source': 'lower-source row into its scraped twin',
  mirror: 'mirrored settled copy into the earlier row',
  'settled-pending': 'settled copy into a stuck pending row',
};

function summarize(details: DedupeDetail[]): string {
  if (details.length === 0) return 'nothing to merge';
  const n = new Map<DedupeDetail['kind'], number>();
  for (const d of details) n.set(d.kind, (n.get(d.kind) ?? 0) + 1);
  return [...n].map(([k, c]) => `${c} ${KIND_LABEL[k]}`).join(', ');
}

const line = (d: DedupeDetail): string => `  #${d.from} → #${d.into}  ${d.date}  ${(d.amount / 100).toFixed(2)}  (${d.kind})`;

function printReview(review: DedupeReview[]): void {
  if (review.length === 0) return;
  console.log(`${review.length} stuck pending row(s) need a manual look (not merged: the settled copy carries user data):`);
  for (const r of review) console.log(`  #${r.settledId} → #${r.txnId}  ${r.date}  ${(r.amount / 100).toFixed(2)}  ${r.reason}`);
}
