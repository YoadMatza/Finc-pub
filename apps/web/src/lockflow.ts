/**
 * The phone's boot and unlock decisions as pure functions (security research P1-11), so they can be tested
 * without React or the native plugin.
 */
import { setServer } from './api';
import type { Key } from './i18n';
import { lockVault, type PairedServer, type UnlockResult, type VaultStatus } from './native';

/**
 * - 'novault': the vault plugin did not answer (an APK older than this bundle);
 * - 'nolock': the phone has no screen lock, so there is nothing to bind the key to: refuse to run;
 * - 'lock': a vault secret, or a legacy pairing to move into the vault on unlock;
 * - 'pair': nothing stored.
 */
export type BootScreen = 'novault' | 'nolock' | 'lock' | 'pair';

export function bootScreen(status: VaultStatus | null, hasLegacy: boolean): BootScreen {
  if (!status) return 'novault';
  if (!status.deviceSecure) return 'nolock';
  if (status.hasSecret || hasLegacy) return 'lock';
  return 'pair';
}

export type UnlockOutcome =
  | { kind: 'ready'; server: PairedServer }
  /** forget whatever is stored and pair again; `message` explains why (null: nothing was stored) */
  | { kind: 'pair'; message: Key | null }
  | { kind: 'nolock' }
  /** stay on the lock screen with a retry button */
  | { kind: 'retry'; message: Key };

export function unlockOutcome(r: UnlockResult): UnlockOutcome {
  if ('server' in r) return { kind: 'ready', server: r.server };
  switch (r.reason) {
    case 'invalidated':
      return { kind: 'pair', message: 'lock_invalidated' };
    case 'none':
      return { kind: 'pair', message: null };
    case 'wrong-host':
      // A pairing to a hub this build does not pin (P1-10): refuse to use it, but KEEP it. Pairing again works only
      // at home, so deleting it could lock the owner out while away; only "Forget this pairing" deletes it.
      return { kind: 'retry', message: 'lock_wrong_host' };
    case 'no-lock':
      return { kind: 'nolock' };
    case 'cancelled':
      return { kind: 'retry', message: 'lock_cancelled' };
    default:
      return { kind: 'retry', message: 'lock_failed' };
  }
}

/**
 * On relock: the hub leaves JS memory, every cached answer (balances, transactions) is dropped, and the native
 * session (the decrypted pairing with the token, P2-01) is dropped too: the next request needs a new unlock.
 */
export function forgetSession(qc: { clear(): void }): void {
  setServer(null);
  qc.clear();
  void lockVault();
}

/** Why a just-paired server could not be kept, as the Pair screen says it. */
export function storeFailureMessage(reason: 'cancelled' | 'no-lock' | 'failed' | 'wrong-host' | undefined): Key {
  if (reason === 'cancelled') return 'pair_store_cancelled';
  if (reason === 'wrong-host') return 'pair_wrong_host_any';
  if (reason === 'no-lock') return 'nolock_help';
  return 'pair_store_failed';
}
