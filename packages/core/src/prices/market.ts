/**
 * US regular trading session (NYSE/Nasdaq): 09:30–16:00 America/New_York, Monday to Friday. Daylight saving comes from
 * Intl, so the session is right in both EST and EDT and across the switch. Holidays are not known here: on a holiday
 * the quotes simply stop moving, and the live view goes by each quote's own regularMarketTime.
 */
export const US_TZ = 'America/New_York';
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday, of the local calendar date */
  weekday: number;
}

/** The wall-clock time in `tz` at instant `t` (ms). */
export function wallTime(t: number, tz: string = US_TZ): WallTime {
  const parts: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(t))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  const year = parts.year!;
  const month = parts.month!;
  const day = parts.day!;
  return { year, month, day, hour: parts.hour! % 24, minute: parts.minute!, second: parts.second!, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** YYYY-MM-DD of instant `t` in `tz` (an unknown zone falls back to New York). */
export function localDate(t: number, tz: string = US_TZ): string {
  let w: WallTime;
  try {
    w = wallTime(t, tz);
  } catch {
    w = wallTime(t, US_TZ);
  }
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/** The instant (ms) at which `tz`'s wall clock shows the given date and time. */
function wallToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (t: number): number => {
    const w = wallTime(t, tz);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(t / 1000) * 1000;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t); // a second pass settles a guess that crossed a DST switch
  return t;
}

const isWeekday = (wd: number): boolean => wd >= 1 && wd <= 5;

/** Is the US regular session open at instant `t`? */
export function usSessionOpen(t: number): boolean {
  const w = wallTime(t);
  const m = w.hour * 60 + w.minute;
  return isWeekday(w.weekday) && m >= OPEN_MIN && m < CLOSE_MIN;
}

/** Calendar date `k` days from NY's date at `t`, as {y, m, d, weekday}. */
function nyDay(t: number, k: number): { y: number; m: number; d: number; weekday: number } {
  const w = wallTime(t);
  const base = new Date(Date.UTC(w.year, w.month - 1, w.day) + k * DAY_MS);
  return { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate(), weekday: base.getUTCDay() };
}

/** The most recent weekday 16:00 New York at or before `t` (ms). */
export function lastUsClose(t: number): number {
  for (let k = 0; k <= 7; k++) {
    const day = nyDay(t, -k);
    if (!isWeekday(day.weekday)) continue;
    const close = wallToUtc(day.y, day.m, day.d, 16, 0, US_TZ);
    if (close <= t) return close;
  }
  /* c8 ignore next */
  return t - 7 * DAY_MS;
}

/** The next weekday 09:30 New York strictly after `t` (ms). */
export function nextUsOpen(t: number): number {
  for (let k = 0; k <= 7; k++) {
    const day = nyDay(t, k);
    if (!isWeekday(day.weekday)) continue;
    const open = wallToUtc(day.y, day.m, day.d, 9, 30, US_TZ);
    if (open > t) return open;
  }
  /* c8 ignore next */
  return t + 7 * DAY_MS;
}
