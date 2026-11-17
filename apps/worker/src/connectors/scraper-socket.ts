/**
 * The scraper container's job protocol (research_notes/proposals/scraper-container.md, step 2): one job per
 * connection over a Unix socket on a volume only the worker and the scraper share (nothing on a network). Newline-
 * delimited JSON:
 *
 *   worker → scraper   {"t":"job","v":1,"job":ScrapeJob}       then, when asked, {"t":"otp","code":"123456"}
 *   scraper → worker   {"t":"otp_needed"}                       then {"t":"result","out":ScrapeOutput} or {"t":"error","message":"…"}
 *
 * The scraper holds one institution's login fields for the length of one job and forgets them; it never sees the vault
 * or the database. Messages are size-capped; a malformed one ends the connection.
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { log } from '../logger.js';
import type { OtpProvider } from './otp.js';
import type { ScrapeJob, ScrapeOutput, Scraper } from './scrape.js';

export const SCRAPER_SOCKET_DEFAULT = '/run/finc-scraper/scraper.sock';
const PROTOCOL = 1;
/** worker → scraper messages are small (a job, a code) */
const MAX_IN = 64 * 1024;
/** a scraper result can be large (thousands of transactions) */
const MAX_OUT = 64 * 1024 * 1024;
const JOB_TIMEOUT_MS = 20 * 60_000;
const OTP_TIMEOUT_MS = 10 * 60_000;
const INSTITUTIONS = new Set(['beinleumi', 'isracard', 'max']);

/** Reads newline-delimited JSON from a socket, one message at a time, with a size cap. */
function lines(sock: net.Socket, max: number, onMessage: (m: Record<string, unknown>) => void, onBad: (why: string) => void): void {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > max) {
      onBad('message too large');
      sock.destroy();
      return;
    }
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: unknown;
      try {
        m = JSON.parse(line);
      } catch {
        onBad('not JSON');
        sock.destroy();
        return;
      }
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        onBad('not an object');
        sock.destroy();
        return;
      }
      onMessage(m as Record<string, unknown>);
    }
  });
}

const send = (sock: net.Socket, m: unknown): void => {
  if (!sock.destroyed) sock.write(`${JSON.stringify(m)}\n`);
};

/** A job as it arrives: only the known keys and types (fields: short strings only). */
export function checkJob(v: unknown): ScrapeJob | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const j = v as Record<string, unknown>;
  if (typeof j.institutionId !== 'string' || !INSTITUTIONS.has(j.institutionId)) return null;
  if (!j.fields || typeof j.fields !== 'object' || Array.isArray(j.fields)) return null;
  const fields: Record<string, string> = {};
  const entries = Object.entries(j.fields as Record<string, unknown>);
  if (entries.length > 10) return null;
  for (const [k, f] of entries) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(k) || typeof f !== 'string' || f.length > 200) return null;
    fields[k] = f;
  }
  if (typeof j.monthsBack !== 'number' || !Number.isInteger(j.monthsBack) || j.monthsBack < 1 || j.monthsBack > 36) return null;
  if (typeof j.showBrowser !== 'boolean' || typeof j.explore !== 'boolean' || typeof j.debug !== 'boolean') return null;
  if (j.timeoutMs !== undefined && (typeof j.timeoutMs !== 'number' || j.timeoutMs < 1000 || j.timeoutMs > 600_000)) return null;
  return { institutionId: j.institutionId as ScrapeJob['institutionId'], fields, monthsBack: j.monthsBack, showBrowser: j.showBrowser, explore: j.explore, debug: j.debug, ...(typeof j.timeoutMs === 'number' ? { timeoutMs: j.timeoutMs } : {}) };
}

/**
 * The scraper container's server: one job at a time (a second connection while busy is refused). The socket file is
 * owner-only. Returns a close function.
 */
export function serveScraper(scrape: Scraper, socketPath = SCRAPER_SOCKET_DEFAULT): Promise<{ close: () => Promise<void> }> {
  // a Windows named pipe (tests on the PC) has no file to prepare
  const isFile = !socketPath.startsWith('\\');
  if (isFile) {
    mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(socketPath)) rmSync(socketPath, { force: true }); // a socket left by a crash
  }
  let busy = false;
  const open = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    open.add(sock);
    sock.on('close', () => open.delete(sock));
    if (busy) {
      sock.resume(); // drain whatever the caller sent; it gets one answer
      sock.end(`${JSON.stringify({ t: 'error', message: 'the scraper is busy with another job' })}
`);
      return;
    }
    busy = true;
    let job: ScrapeJob | null = null;
    let otpWait: { resolve: (c: string) => void; reject: (e: Error) => void } | null = null;
    const done = () => {
      busy = false;
      if (job) job.fields = {}; // forget the login fields with the job
      job = null;
    };
    sock.on('close', () => {
      otpWait?.reject(new Error('the worker went away'));
      otpWait = null;
    });
    lines(
      sock,
      MAX_IN,
      (m) => {
        if (m.t === 'otp' && otpWait) {
          const code = typeof m.code === 'string' && /^[0-9A-Za-z]{2,12}$/.test(m.code) ? m.code : null;
          const w = otpWait;
          otpWait = null;
          if (code) w.resolve(code);
          else w.reject(new Error('no one-time code'));
          return;
        }
        if (m.t !== 'job' || m.v !== PROTOCOL || job) {
          send(sock, { t: 'error', message: 'unexpected message' });
          sock.end();
          return;
        }
        job = checkJob(m.job);
        if (!job) {
          send(sock, { t: 'error', message: 'bad job' });
          sock.end();
          done();
          return;
        }
        const j = job;
        log.info({ institution: j.institutionId }, 'scraper: job started');
        const otp: OtpProvider = () =>
          new Promise<string>((resolve, reject) => {
            otpWait = { resolve, reject };
            send(sock, { t: 'otp_needed' });
            setTimeout(() => {
              if (otpWait) {
                otpWait = null;
                reject(new Error('no one-time code in time'));
              }
            }, OTP_TIMEOUT_MS).unref();
          });
        scrape(j, otp)
          .then((out) => send(sock, { t: 'result', out }))
          .catch((e: unknown) => send(sock, { t: 'error', message: (e instanceof Error ? e.message : String(e)).slice(0, 500) }))
          .finally(() => {
            log.info({ institution: j.institutionId }, 'scraper: job finished');
            done();
            sock.end();
          });
      },
      (why) => {
        log.warn({ why }, 'scraper: refused a message');
        if (!job) done(); // a running job finishes (and frees the slot) on its own
      },
    );
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      if (isFile) chmodSync(socketPath, 0o600);
      resolve({
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            for (const s of open) s.destroy();
          }),
      });
    });
  });
}

/**
 * The worker's side: a `Scraper` that sends the job to the scraper container and relays one-time codes. A dead or
 * missing scraper is a thrown error, recorded as a CRASH run with a clear message.
 */
export function scraperClient(socketPath = SCRAPER_SOCKET_DEFAULT, timeoutMs = JOB_TIMEOUT_MS): Scraper {
  return (job, otp) =>
    new Promise<ScrapeOutput>((resolve, reject) => {
      let settled = false;
      const finish = (f: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        f();
        sock.destroy();
      };
      const sock = net.createConnection(socketPath);
      const timer = setTimeout(() => finish(() => reject(new Error('the scraper did not finish in time'))), timeoutMs);
      sock.on('error', (e: NodeJS.ErrnoException) =>
        finish(() => reject(new Error(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'the scraper container is not running (docker compose up -d scraper)' : `scraper connection: ${e.code ?? e.message}`))),
      );
      sock.on('close', () => finish(() => reject(new Error('the scraper closed the connection without a result'))));
      sock.on('connect', () => send(sock, { t: 'job', v: PROTOCOL, job }));
      lines(
        sock,
        MAX_OUT,
        (m) => {
          if (m.t === 'otp_needed') {
            otp({ institutionId: job.institutionId })
              .then((code) => send(sock, { t: 'otp', code }))
              .catch(() => send(sock, { t: 'otp', code: null }));
            return;
          }
          if (m.t === 'result' && m.out && typeof m.out === 'object' && (m.out as { scraped?: unknown }).scraped) return finish(() => resolve(m.out as ScrapeOutput));
          if (m.t === 'error') return finish(() => reject(new Error(`scraper: ${typeof m.message === 'string' ? m.message.slice(0, 500) : 'failed'}`)));
          finish(() => reject(new Error('scraper: unexpected answer')));
        },
        (why) => finish(() => reject(new Error(`scraper: ${why}`))),
      );
    });
}
