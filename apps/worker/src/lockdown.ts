/**
 * Security research P1-09: the panic switch ("lock everything") and the daily sweep of idle device tokens.
 *
 * Panic takes access away and nothing else, in this order: every active paired device is revoked (reason 'panic'),
 * every passkey is revoked (a synced passkey on a stolen phone cannot sign back in; re-enrolling needs a code made at
 * home), every browser and passkey session ends, the vault is locked, and a security alert says what happened and who asked.
 * Every step runs even when an earlier one throws; the errors come back in the result and in the alert, never
 * swallowed. Callers: POST /api/panic (any signed-in caller), `finc panic`, and `/lockdown` on the alarm bot.
 */
import { type Db, type Vault, classifyError, cleanErrorText, expireIdleDevices, recordSecurityEvent, takeExpiryWarnings } from '@finc/core';
import { type SecurityAlertFn, securityAlert } from './alerts.js';
import { log } from './logger.js';

export interface PanicSteps {
  /** revokes every active device; returns how many */
  revokeDevices: () => number;
  /** revokes every active passkey; returns how many */
  revokePasskeys: () => number;
  /** ends every browser and passkey session (and pending pairing / enrolment codes); returns how many sessions */
  endSessions: () => number;
  /** locks the vault and drops it from the worker; returns true when it is locked afterwards */
  lockVault: () => boolean;
  /** sends the security alert; resolves true when Telegram took it */
  alert: (text: string) => Promise<boolean>;
}

export interface PanicResult {
  ok: boolean;
  devices: number;
  passkeys: number;
  sessions: number;
  vaultLocked: boolean;
  alerted: boolean;
  /** one line per step that failed (no stack, no secrets); absent when all went well */
  errors?: string[];
}

const msg = (e: unknown): string => cleanErrorText(e, 200);
/** What a panic error says (it reaches Telegram in the alert and the /lockdown reply): the kind only, never the text (P2-09). */
const kindOf = (e: unknown): string => `(${classifyError(e)})`;

/** Run the panic. `who` is said in the alert: `device "Phone"`, `the PC`, `a passkey session`, `Telegram`, `the CLI`. */
export async function runPanic(steps: PanicSteps, who: string): Promise<PanicResult> {
  const errors: string[] = [];
  let devices = 0;
  let passkeys = 0;
  let sessions = 0;
  let vaultLocked = false;
  try {
    devices = steps.revokeDevices();
  } catch (e) {
    errors.push(`revoking devices failed ${kindOf(e)}`);
    log.error({ err: msg(e) }, 'panic: revoking devices failed');
  }
  try {
    passkeys = steps.revokePasskeys();
  } catch (e) {
    errors.push(`revoking passkeys failed ${kindOf(e)}`);
    log.error({ err: msg(e) }, 'panic: revoking passkeys failed');
  }
  try {
    sessions = steps.endSessions();
  } catch (e) {
    errors.push(`ending sessions failed ${kindOf(e)}`);
    log.error({ err: msg(e) }, 'panic: ending sessions failed');
  }
  try {
    vaultLocked = steps.lockVault();
  } catch (e) {
    errors.push(`locking the vault failed ${kindOf(e)}`);
    log.error({ err: msg(e) }, 'panic: locking the vault failed');
  }
  const text = `LOCKDOWN by ${who}: ${devices} device(s) revoked, ${passkeys} passkey(s) revoked, ${sessions} session(s) ended, vault ${vaultLocked ? 'locked' : 'NOT locked'}${errors.length ? `; errors: ${errors.join('; ')}` : ''}. Pair again, re-enrol passkeys and unlock from the PC at home.`;
  log.warn({ who, devices, passkeys, sessions, vaultLocked, errors }, 'panic: lockdown');
  let alerted = false;
  try {
    alerted = await steps.alert(text);
  } catch (e) {
    errors.push(`the alert failed ${kindOf(e)}`);
    log.error({ err: msg(e) }, 'panic: the alert failed');
  }
  if (!alerted) log.error('panic: the lockdown alert did not reach Telegram');
  return { ok: errors.length === 0, devices, passkeys, sessions, vaultLocked, alerted, ...(errors.length ? { errors } : {}) };
}

/**
 * The daily sweep (and once at start): warn about each device that expires within 3 days (once per expiry window),
 * then revoke devices idle for `devices.idleDays` or more and say so in ONE security alert. Never throws (a scheduler job); returns how many expired.
 */
export function sweepIdleDevices(db: Db, vault: Vault | null, now: Date = new Date(), alert: SecurityAlertFn = securityAlert): number {
  try {
    // one warning per device about to expire (once per expiry window), before anything expires
    for (const w of takeExpiryWarnings(db, now)) {
      alert(db, vault, `paired device "${w.device.name}" will be removed in ${w.daysLeft} day${w.daysLeft === 1 ? '' : 's'} unless it's used; open the app once to keep it`, {
        kind: 'device.expiry_warning',
        actor: 'system',
        detail: { device: w.device.id, name: w.device.name, daysLeft: w.daysLeft },
        at: now,
      });
    }
  } catch (e) {
    log.error({ err: msg(e) }, 'devices: the expiry warnings failed');
  }
  try {
    const gone = expireIdleDevices(db, now);
    if (!gone.length) return 0;
    // one row per device in the security log (P1-08), one alert for all of them
    for (const g of gone) recordSecurityEvent(db, { kind: 'device.expired', actor: 'system', detail: { device: g.device.id, name: g.device.name, idleDays: g.idleDays, via: 'sweep' }, at: now });
    const one = gone[0]!;
    alert(
      db,
      vault,
      gone.length === 1
        ? `device "${one.device.name}" expired after ${one.idleDays} days unused`
        : `${gone.length} devices expired after going unused: ${gone.map((g) => `"${g.device.name}" (${g.idleDays} days)`).join(', ')}`,
      null,
    );
    log.info({ expired: gone.map((g) => g.device.id) }, 'devices: idle tokens expired');
    return gone.length;
  } catch (e) {
    log.error({ err: msg(e) }, 'devices: the idle sweep failed');
    return 0;
  }
}
