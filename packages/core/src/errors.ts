/**
 * Error text hygiene (security research P2-09).
 *
 * Two rules:
 *  1. Raw error text never leaves the machine. Telegram (and anything else outside) gets an error KIND from a fixed
 *     list plus a fixed phrase for it, in Hebrew or English: `syncErrorKind()` for a sync's error_type,
 *     `classifyError()` for any thrown error, `errorPhrase()` for the words.
 *  2. Error text that is stored (sync_run.error, connection.last_error, the backup/offsite status settings, security
 *     event details) or logged goes through `cleanErrorText()` first: still useful for debugging at home, but without
 *     URL query strings, account/card numbers, e-mail addresses (and user@host targets) or bot tokens.
 */

const MAX_CLEAN = 300;
/** stripUrlQuery handles at most this much of a string (a log line is never this long in practice); the rest is cut. */
const MAX_STRIP = 64 * 1024;

/**
 * Strip the query string and fragment of every URL in `s` (scheme, host and path stay), and any user:password@.
 * Linear: the scheme is bounded, so a long run like "a.a.a…" is not rescanned from every position (review M1).
 */
export function stripUrlQuery(s: string): string {
  if (!s.includes('://')) return s;
  const t = s.length > MAX_STRIP ? `${s.slice(0, MAX_STRIP)}…[cut]` : s;
  return t.replace(/\b([a-z][a-z0-9+.-]{0,20}:\/\/)(?:[^\s/?#@"'<>]*@)?([^\s?#"'<>]*)(?:[?#][^\s"'<>]*)?/gi, '$1$2');
}

const maskTail = (m: string): string => `****${m.replace(/\D/g, '').slice(-2)}`;

/** A long base64/base64url/hex run with letters and digits is a token; an UPPER_CASE_IDENTIFIER is not. */
function maskToken(m: string): string {
  if (!/\d/.test(m) || !/[A-Za-z]/.test(m) || /^[A-Z0-9_]+$/.test(m)) return m;
  return '[token]';
}

/** "12-345-67890": 2–3 digit first group, dash-joined, 8+ digits in all. A dd-mm-yyyy date is kept. */
function maskDashedAccount(m: string): string {
  if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(m)) return m;
  return m.replace(/\D/g, '').length >= 8 ? maskTail(m) : m;
}

/**
 * Clean error text before it is stored or logged. Removed or masked: URL query strings and fragments (with or without
 * a scheme; scheme + host + path stay), `;jsessionid=` style path parameters, Telegram bot tokens (with or without
 * "bot"), `Bearer x`, JWTs, long base64/hex tokens, e-mail addresses (and ssh-style user@host), card numbers (4-4-4-4,
 * Amex 4-6-5), dash-joined bank account numbers and any digit run of 6 or more (last 2 digits kept). Dates, IPs,
 * versions and ports stay. Whitespace collapses and the result is cut to `max` (300) characters.
 *
 * The input is cut to 4 × max (at a word boundary) before any pattern runs, and every pattern is linear, so a huge or
 * hostile string costs next to nothing (review M1).
 */
export function cleanErrorText(input: unknown, max = MAX_CLEAN): string {
  let s = input instanceof Error ? input.message : typeof input === 'string' ? input : input === null || input === undefined ? '' : String(input);
  if (s.length > max * 4) {
    const cut = s.slice(0, max * 4);
    const ws = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'), cut.lastIndexOf('\t'));
    s = ws > max ? cut.slice(0, ws) : cut; // a token cut in half at the end does not survive as a half
  }
  s = s.replace(/\b(?:bot)?\d{6,}:[A-Za-z0-9_-]{30,}/g, (m) => (m.startsWith('bot') ? 'bot[REDACTED]' : '[REDACTED]'));
  s = s.replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot[REDACTED]');
  s = stripUrlQuery(s);
  // a URL without a scheme that carries a query: host.tld/path?… (the host and path stay)
  s = s.replace(/(?<![\w.@:/-])((?:[A-Za-z0-9-]{1,63}\.){1,10}[A-Za-z]{2,24}(?::\d{1,5})?(?:\/[^\s?#"'<>]*)?)[?#][^\s"'<>]*/g, '$1');
  s = s.replace(/;\s*(jsessionid|phpsessid|sessionid|sid)=[^\s?#;/"'<>]*/gi, ';$1=[REDACTED]');
  s = s.replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[JWT]');
  // the local part starts where a run of local-part characters starts (lookbehind), so no position is rescanned
  s = s.replace(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g, '[email]');
  s = s.replace(/(?<![A-Za-z0-9_+-])[A-Za-z0-9_+-]{24,}={0,2}(?![A-Za-z0-9_+=-])/g, maskToken);
  // card numbers written in groups: "4580 1234 5678 6150", "4580-1234-5678-6150", Amex "3714 496353 98431"
  s = s.replace(/\b(?:\d{4}[ -]){3}\d{1,7}\b/g, maskTail);
  s = s.replace(/\b\d{4}[ -]\d{6}[ -]\d{5}\b/g, maskTail);
  // bank accounts like 12-345-67890 (a 2–3 digit first group, so ISO dates 2026-11-10 never match)
  s = s.replace(/(?<![\d-])\d{2,3}(?:-\d{2,9}){1,3}(?![\d-])/g, maskDashedAccount);
  s = s.replace(/\d{6,}/g, (m) => `${'*'.repeat(m.length - 2)}${m.slice(-2)}`);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The kinds an error is reported as outside the machine. Anything not recognised is 'other'. */
export const ERROR_KINDS = [
  'invalid_password',
  'change_password',
  'account_blocked',
  'otp',
  'timeout',
  'blocked',
  'config',
  'crash',
  'ingest',
  'network',
  'disk_full',
  'permission',
  'not_found',
  'auth',
  'host_key',
  'locked',
  'other',
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export function isErrorKind(s: unknown): s is ErrorKind {
  return typeof s === 'string' && (ERROR_KINDS as readonly string[]).includes(s);
}

/** A sync's error_type (israeli-bank-scrapers' ErrorTypes plus finc's own CONFIG / CRASH / INGEST / AUTOMATION_BLOCKED). */
const SYNC_TYPES: Record<string, ErrorKind> = {
  INVALID_PASSWORD: 'invalid_password',
  CHANGE_PASSWORD: 'change_password',
  ACCOUNT_BLOCKED: 'account_blocked',
  TWO_FACTOR_RETRIEVER_MISSING: 'otp',
  TIMEOUT: 'timeout',
  AUTOMATION_BLOCKED: 'blocked',
  CONFIG: 'config',
  CRASH: 'crash',
  INGEST: 'ingest',
  LOCKED: 'locked',
};

export function syncErrorKind(errorType: string | null | undefined): ErrorKind {
  return (errorType && SYNC_TYPES[errorType.trim().toUpperCase()]) || 'other';
}

/** An error_type as stored: an identifier only (the scraper's own value could be anything). */
export function cleanErrorType(errorType: string | null | undefined): string {
  return (errorType ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'UNKNOWN';
}

const CODE_KINDS: Record<string, ErrorKind> = {
  ENOSPC: 'disk_full',
  EDQUOT: 'disk_full',
  EACCES: 'permission',
  EPERM: 'permission',
  EROFS: 'permission',
  ENOENT: 'not_found',
  ENOTDIR: 'not_found',
  ETIMEDOUT: 'timeout',
  ESOCKETTIMEDOUT: 'timeout',
  ECONNREFUSED: 'network',
  ECONNRESET: 'network',
  ECONNABORTED: 'network',
  EHOSTUNREACH: 'network',
  ENETUNREACH: 'network',
  ENOTFOUND: 'network',
  EAI_AGAIN: 'network',
  EPIPE: 'network',
};

/** The kind of any thrown error, from its name, code (errno style) and, last, a few message patterns. */
export function classifyError(e: unknown): ErrorKind {
  const o = (e && typeof e === 'object' ? e : {}) as { name?: unknown; code?: unknown; level?: unknown; message?: unknown };
  const name = typeof o.name === 'string' ? o.name : '';
  const code = typeof o.code === 'string' ? o.code : '';
  if (name === 'HostKeyChangedError') return 'host_key';
  if (name === 'VaultError' && code === 'LOCKED') return 'locked';
  if (code && CODE_KINDS[code]) return CODE_KINDS[code];
  if (o.level === 'client-authentication') return 'auth'; // ssh2
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : typeof o.message === 'string' ? o.message : '';
  if (/no space left|disk full|ENOSPC/i.test(msg)) return 'disk_full';
  if (/host key/i.test(msg)) return 'host_key';
  if (/authentication|auth fail|unauthori[sz]ed|login (?:failed|refused)/i.test(msg)) return 'auth';
  if (/permission denied|access denied|EACCES|EPERM|read-only file system/i.test(msg)) return 'permission';
  if (/timed? ?out|timeout|ETIMEDOUT/i.test(msg)) return 'timeout';
  if (/ENOENT|no such file|not found/i.test(msg)) return 'not_found';
  if (/network|socket|ECONN|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|getaddrinfo|unreachable|handshake/i.test(msg)) return 'network';
  if (/vault is locked/i.test(msg)) return 'locked';
  return 'other';
}

const PHRASES: Record<ErrorKind, { he: string; en: string }> = {
  invalid_password: { he: 'שם המשתמש או הסיסמה שגויים', en: 'wrong username or password' },
  change_password: { he: 'האתר מבקש להחליף סיסמה', en: 'the site asks for a new password' },
  account_blocked: { he: 'החשבון חסום באתר', en: 'the account is blocked on the site' },
  otp: { he: 'נדרש קוד חד־פעמי', en: 'a one-time code was needed' },
  timeout: { he: 'לא התקבלה תשובה בזמן', en: 'no answer in time' },
  blocked: { he: 'האתר חסם את הכניסה האוטומטית', en: 'the site blocked the automated login' },
  config: { he: 'פרטי הכניסה השמורים חסרים', en: 'the saved login details are incomplete' },
  crash: { he: 'הסנכרון קרס', en: 'the sync crashed' },
  ingest: { he: 'הנתונים לא נשמרו', en: 'the data could not be stored' },
  network: { he: 'שגיאת רשת', en: 'network error' },
  disk_full: { he: 'הדיסק מלא', en: 'the disk is full' },
  permission: { he: 'אין הרשאה', en: 'permission denied' },
  not_found: { he: 'קובץ או תיקייה חסרים', en: 'a file or folder is missing' },
  auth: { he: 'ההתחברות נדחתה', en: 'the login was refused' },
  host_key: { he: 'מפתח השרת השתנה', en: "the server's host key changed" },
  locked: { he: 'הכספת נעולה', en: 'the vault is locked' },
  other: { he: 'שגיאה לא צפויה; הפרטים בלוג בבית', en: 'unexpected error; details in the log at home' },
};

/** The fixed phrase for a kind, in the hub's language. Unknown kinds read as 'other'. */
export function errorPhrase(kind: string | null | undefined, lang: 'he' | 'en' = 'en'): string {
  return PHRASES[isErrorKind(kind) ? kind : 'other'][lang];
}

/** "the disk is full (disk_full)": what an outgoing message says about an error. Never the error's own text. */
export function errorSummary(e: unknown, lang: 'he' | 'en' = 'en'): string {
  const kind = classifyError(e);
  return `${errorPhrase(kind, lang)} (${kind})`;
}
