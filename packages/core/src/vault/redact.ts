/**
 * Logging hygiene (security research P2-09). The worker's logger passes every log object through `redact()` (pino
 * `formatters.log`), so a credential-shaped key is censored at any depth, not only at the two levels pino's path list
 * reached. `redact()` is also there for anything else that may carry credentials.
 */
import { cleanErrorText, stripUrlQuery } from '../errors.js';

/**
 * Keys whose value is never logged. Matching ignores case, `-` and `_`: `apiKey`, `api_key`, `API-KEY` and `x-api-key`
 * are all caught. `code` is special (see `secretCode`).
 */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  'password',
  'pass',
  'pwd',
  'passwd',
  'masterPassword',
  'secret',
  'clientSecret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'sessionToken',
  'apiKey',
  'x-api-key',
  'privateKey',
  'pat',
  'pin',
  'otp',
  'otpCode',
  'id',
  'nationalId',
  'userCode',
  'username',
  'card6Digits',
  'card',
  'cardNumber',
  'accountNumber',
  'iban',
  'email',
  'credentials',
  'fields',
  'authorization',
  'proxy-authorization',
  'bearer',
  'cookie',
  'set-cookie',
]);

const norm = (k: string): string => k.replace(/[-_]/g, '').toLowerCase();
const SECRET_NORM: ReadonlySet<string> = new Set([...SECRET_KEYS].map(norm));

/** Keys whose string value is error text: logged through cleanErrorText (longer cut, for the log at home). */
const ERROR_TEXT_KEYS: ReadonlySet<string> = new Set(['err', 'error', 'errormessage', 'errmessage', 'reason'].map(norm));

export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 10;
const LOG_ERROR_MAX = 1000;

/** A key that CONTAINS one of these (after normalising) is secret too: userPassword, clientSecretValue, csrfToken, sessionCookies. */
const SECRET_PARTS = ['password', 'passwd', 'secret', 'token', 'otp', 'cookie', 'apikey'] as const;
/**
 * …except these obviously harmless shapes, which describe a secret without holding it: flags and counters such as
 * hasPassword, isSecret, tokenCount, tokensLength, passwordChangedAt, otpRequired, otpNeeded, tokenExpiresAt,
 * tokenType, secretKind, secretSet. (`pin` is matched only as a whole key, so pinned/pinnedKeys stay.)
 */
const SAFE_PREFIX = /^(has|is)/;
const SAFE_SUFFIX = /(count|length|len|at|ms|required|needed|set|expires|expiry|type|kind|status|name|names)$/;

/** Whether a key's value is always censored (the `…code` keys depend on the value: see secretCode). */
export function isSecretKey(k: string): boolean {
  const n = norm(k);
  if (SECRET_NORM.has(n)) return true;
  if (SAFE_PREFIX.test(n) || SAFE_SUFFIX.test(n)) return false;
  return SECRET_PARTS.some((p) => n.includes(p));
}

/**
 * `code` is both a one-time/pairing code (secret) and a generic error code (useful: ENOENT, SQLITE_BUSY, 403,
 * invalid_type). It is kept only when the value has the shape of an error code: a number below 1000 (HTTP status), an
 * upper-case word (ENOENT, LOCKED), an upper-case identifier with underscores (SQLITE_BUSY, ERR_HTTP2_X), or a
 * lower-case snake_case word without digits. Anything else (a 4–8 digit OTP, a base64url pairing code, a number of 1000 or more) is censored.
 */
export function secretCode(v: unknown): boolean {
  if (v === null || v === undefined || typeof v === 'boolean') return false;
  if (typeof v === 'number') return !(Number.isInteger(v) && v >= 0 && v < 1000);
  if (typeof v !== 'string') return true;
  if (/^\d{1,3}$/.test(v)) return false;
  if (/^[A-Z]{2,24}$/.test(v)) return false;
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v)) return false;
  if (/^[a-z]+(?:_[a-z]+)*$/.test(v) && v.length <= 40) return false;
  return true;
}

/** A deep copy of `value` with secret keys censored at any depth (arrays, Maps and Sets as arrays, Errors kept as errors). */
export function redact<T>(value: T): T {
  return walk(value, 0, new WeakSet()) as T;
}

function walkString(s: string, key: string | null): string {
  if (key !== null && ERROR_TEXT_KEYS.has(norm(key))) return cleanErrorText(s, LOG_ERROR_MAX);
  return s.includes('://') ? stripUrlQuery(s) : s;
}

function walk(v: unknown, depth: number, seen: WeakSet<object>, key: string | null = null): unknown {
  if (typeof v === 'string') return walkString(v, key);
  if (v === null || typeof v !== 'object') return v;
  if (seen.has(v)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Object]';
  if (v instanceof Date || Buffer.isBuffer(v) || ArrayBuffer.isView(v)) return Buffer.isBuffer(v) || ArrayBuffer.isView(v) ? `[${v.constructor.name} ${(v as ArrayBufferView).byteLength} bytes]` : v;
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1, seen));
    if (v instanceof Map) return [...v.entries()].map(([k, x]) => [k, typeof k === 'string' && censor(k, x) ? REDACTED : walk(x, depth + 1, seen, typeof k === 'string' ? k : null)]);
    if (v instanceof Set) return [...v].map((x) => walk(x, depth + 1, seen));
    if (v instanceof Error) return walkError(v, depth, seen);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      const val = (v as Record<string, unknown>)[k];
      out[k] = censor(k, val) ? REDACTED : walk(val, depth + 1, seen, k);
    }
    return out;
  } finally {
    seen.delete(v); // a value seen twice side by side is fine; only a cycle is cut
  }
}

/**
 * `code` and any `…code` key (pairingCode, enrolCode, smsCode, errorCode, statusCode, exitCode) follow secretCode: an
 * error-code-shaped value stays, anything else is censored. Whole-key matches (userCode, otpCode) always censor.
 */
function censor(k: string, val: unknown): boolean {
  const n = norm(k);
  if (SECRET_NORM.has(n)) return true;
  if (n.endsWith('code')) return secretCode(val);
  return isSecretKey(k);
}

/**
 * An Error stays an Error of the same class (so pino's err serializer keeps its type and stack), with the message and
 * stack cleaned and every own enumerable property (an ssh2 `level`, a `config` with a password) walked like an object.
 */
function walkError(e: Error, depth: number, seen: WeakSet<object>): Error {
  const out = Object.create(Object.getPrototypeOf(e) as object) as Error;
  const def = (k: string, value: unknown, enumerable = false) => Object.defineProperty(out, k, { value, enumerable, writable: true, configurable: true });
  def('message', cleanErrorText(e.message, LOG_ERROR_MAX));
  if (e.name !== Object.getPrototypeOf(e)?.name) def('name', e.name);
  if (typeof e.stack === 'string') {
    // the first line repeats the message; the frames are paths and line numbers
    const nl = e.stack.indexOf('\n');
    def('stack', nl < 0 ? cleanErrorText(e.stack, LOG_ERROR_MAX) : `${cleanErrorText(e.stack.slice(0, nl), LOG_ERROR_MAX)}${stripUrlQuery(e.stack.slice(nl))}`);
  }
  const cause = (e as { cause?: unknown }).cause;
  if (cause !== undefined) def('cause', walk(cause, depth + 1, seen, 'err'));
  for (const k of Object.keys(e)) {
    if (k === 'message' || k === 'stack' || k === 'cause') continue;
    const val = (e as unknown as Record<string, unknown>)[k];
    def(k, censor(k, val) ? REDACTED : walk(val, depth + 1, seen, k), true);
  }
  return out;
}

/** "****6150" style masking for account/card numbers in any user-facing output. */
export function maskNumber(s: string | number | undefined | null, keep = 4): string {
  if (s === undefined || s === null) return '';
  const str = String(s).replace(/\s+/g, '');
  if (str.length <= keep) return '*'.repeat(str.length);
  return `****${str.slice(-keep)}`;
}
