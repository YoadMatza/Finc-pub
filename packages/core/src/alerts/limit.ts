/**
 * Telegram alerts for the monthly spending limit (research_notes/proposals/now-screen-and-limit.md §3, build step 4):
 * at 80% and at 100% of the limit, once each per month, and "ahead of pace" at most once a week. The dispatcher sends a
 * key once per channel, so the keys carry the month (or the week's Sunday). Current month only. Descriptive wording.
 */
import type { HubLimit } from '../hub/limit.js';

/** "Ahead of pace" fires when spent is more than 20% above the even-spread amount… */
export const PACE_ALERT_SHARE = 0.2;
/** …and the gap is more than 5% of the limit (the "on pace" band), so small early-month amounts stay quiet. */
export const PACE_ALERT_MIN_SHARE_OF_LIMIT = 0.05;

export interface LimitAlert {
  key: string;
  text: string;
}

const LRI = '⁦';
const PDI = '⁩';
const ils = (minor: number, he: boolean) => {
  const n = Math.abs(minor / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return `${LRI}${he ? `${n} ₪` : `₪${n}`}${PDI}`;
};

/** The Sunday (YYYY-MM-DD) of the Sunday–Saturday week containing `today`. */
export function weekSunday(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

/** At most one alert: 100% wins over 80%, and 80% over "ahead of pace". */
export function limitAlerts(limit: HubLimit | null, ctx: { month: string; today: string; lang: 'he' | 'en' }): LimitAlert[] {
  if (!limit || limit.amount <= 0 || ctx.month !== ctx.today.slice(0, 7)) return [];
  const he = ctx.lang === 'he';
  const spent = ils(limit.spent, he);
  const amount = ils(limit.amount, he);
  if (limit.spent >= limit.amount) {
    const over = limit.spent - limit.amount;
    return [
      {
        key: `spend_limit:100:${ctx.month}`,
        text: he
          ? `🛑 ההוצאות היומיומיות הגיעו למסגרת החודשית: ${spent} מתוך ${amount}${over > 0 ? `, ${ils(over, he)} מעליה` : ''}`
          : `🛑 Day-to-day spending reached the monthly limit: ${spent} of ${amount}${over > 0 ? `, ${ils(over, he)} over it` : ''}`,
      },
    ];
  }
  if (limit.spent * 100 >= limit.amount * 80) {
    return [
      {
        key: `spend_limit:80:${ctx.month}`,
        text: he
          ? `⚠️ 80% מהמסגרת החודשית: ${spent} מתוך ${amount}, נשארו ${ils(limit.amount - limit.spent, he)}`
          : `⚠️ 80% of the monthly spending limit: ${spent} of ${amount}, ${ils(limit.amount - limit.spent, he)} left`,
      },
    ];
  }
  const { byToday, delta } = limit.pace;
  if (delta > byToday * PACE_ALERT_SHARE && delta > limit.amount * PACE_ALERT_MIN_SHARE_OF_LIMIT) {
    return [
      {
        key: `spend_limit:pace:${weekSunday(ctx.today)}`,
        text: he
          ? `📊 ההוצאות היומיומיות ${ils(delta, he)} מעל הקצב: ${spent} מתוך ${amount}; בפריסה שווה היו ${ils(byToday, he)} עד היום`
          : `📊 Day-to-day spending is ${ils(delta, he)} ahead of pace: ${spent} of ${amount}; an even spread would be ${ils(byToday, he)} by today`,
      },
    ];
  }
  return [];
}
