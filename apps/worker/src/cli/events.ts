/**
 * `finc events [--limit N] [--kind K] [--before ID]` (security research P1-08): the security log, newest first, as a
 * compact table. Talks to the running worker's GET /api/security-events with data/control.token, like `finc panic`.
 */
import type { Command } from 'commander';
import { localTime, workerAnswers } from './backup.js';
import { workerRequest } from './worker-client.js';

export interface EventRow {
  id: number;
  at: string;
  kind: string;
  actor: string;
  actorName: string | null;
  address: string | null;
  detail: string | null;
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One line per event: id, local time, kind, actor ("name"), address, detail (cut to fit a terminal). */
export function formatEventsTable(events: EventRow[], nextBefore: number | null = null): string[] {
  if (!events.length) return ['no security events'];
  const who = (e: EventRow) => cut(`${e.actor}${e.actorName ? ` "${e.actorName}"` : ''}`, 32);
  const kindW = Math.min(28, Math.max(4, ...events.map((e) => e.kind.length)));
  const whoW = Math.max(5, ...events.map((e) => who(e).length));
  const addrW = Math.min(22, Math.max(7, ...events.map((e) => (e.address ?? '-').length)));
  const idW = Math.max(2, ...events.map((e) => String(e.id).length));
  const lines = [`${'#'.padStart(idW)}  ${'time'.padEnd(16)}  ${'kind'.padEnd(kindW)}  ${'actor'.padEnd(whoW)}  ${'address'.padEnd(addrW)}  detail`];
  for (const e of events) {
    lines.push(`${String(e.id).padStart(idW)}  ${localTime(e.at).padEnd(16)}  ${cut(e.kind, kindW).padEnd(kindW)}  ${who(e).padEnd(whoW)}  ${cut(e.address ?? '-', addrW).padEnd(addrW)}  ${cut(e.detail ?? '', 80)}`);
  }
  if (nextBefore !== null) lines.push(`older: finc events --before ${nextBefore}`);
  return lines;
}

export function registerEventsCommands(program: Command): void {
  program
    .command('events')
    .description('The security log: sign-ins, pairings, removals, vault unlocks, settings changes, lockdowns (newest first)')
    .option('--limit <n>', 'how many (1-200)', '30')
    .option('--kind <kind>', 'only this kind, e.g. auth.pin_failed or device.paired')
    .option('--before <id>', 'only events older than this id (paging)')
    .action(async (opts: { limit: string; kind?: string; before?: string }) => {
      if (!(await workerAnswers())) throw new Error('the worker is not running; start it with: docker compose start worker');
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('--limit is a whole number from 1 to 200');
      const q = new URLSearchParams({ limit: String(limit) });
      if (opts.kind) q.set('kind', opts.kind);
      if (opts.before) q.set('before', opts.before);
      const r = await workerRequest<{ events?: EventRow[]; nextBefore?: number | null; error?: string }>('GET', `/api/security-events?${q}`, undefined, 15_000);
      if (r.status !== 200) throw new Error(r.body.error ?? `the worker refused (${r.status})`);
      for (const line of formatEventsTable(r.body.events ?? [], r.body.nextBefore ?? null)) console.log(line);
    });
}
