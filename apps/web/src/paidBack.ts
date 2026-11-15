/**
 * Pure helpers for "paid back to me" (now-screen-and-limit.md §1, step 3): which state a payment shows (the
 * three-way question, the paid-back badge, or nothing), the Now-card line, and the undo confirmation. A paid-back
 * payment counts against day-to-day spending instead of being income. Money arrives in agorot; nothing here rounds
 * the data.
 */
import type { PaidBack, PaidBackAnswer } from './types';

export type PaidBackState = 'ask' | 'paid_back' | 'none';

/**
 * A row or a Now-card item: already paid back → the badge (it wins over a stale question); asked → the question;
 * otherwise nothing. An item with no transaction yet (id null, an expected income) never gets either.
 */
export function paidBackState(x: { id?: number | null; paidBack?: boolean; askPaidBack?: boolean }): PaidBackState {
  if (x.id === null) return 'none';
  if (x.paidBack) return 'paid_back';
  if (x.askPaidBack) return 'ask';
  return 'none';
}

/** The Now-card line "Paid back to you: ₪X": shown only when the hub sends a positive total. */
export function paidBackLine(pb: PaidBack | undefined | null): { total: number; count: number } | null {
  if (!pb || !(pb.total > 0)) return null;
  return { total: pb.total, count: pb.items.length };
}

/** The buttons under "Is X paying you back?", in order, with what each sends and its i18n key. */
export type PaidBackButton = { answer: Exclude<PaidBackAnswer, 'undo'>; key: 'paid_back_always' | 'paid_back_once' | 'paid_back_no' };

/**
 * When the payer can be remembered: Always / Just this one / No, it's income ('no', remembered for the payer).
 * When it cannot (`canRemember` false: the bank text is shared by several payers): only Just this one / No, and
 * "No" is remembered for this payment only ('no_once'). An older hub that does not send it: as remembered.
 */
export function paidBackButtons(canRemember: boolean | undefined): PaidBackButton[] {
  if (canRemember === false) {
    return [
      { answer: 'once', key: 'paid_back_once' },
      { answer: 'no_once', key: 'paid_back_no' },
    ];
  }
  return [
    { answer: 'always', key: 'paid_back_always' },
    { answer: 'once', key: 'paid_back_once' },
    { answer: 'no', key: 'paid_back_no' },
  ];
}

/**
 * The hub refuses to remember a payer whose bank text several payers share: a 400 with the code 'generic_payer'
 * (as `code` or as `error` in the body, or as the message). Read without importing the API client.
 */
export function isGenericPayerError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const x = e as { status?: unknown; message?: unknown; data?: Record<string, unknown> };
  if (x.status !== 400) return false;
  return x.data?.code === 'generic_payer' || x.data?.error === 'generic_payer' || x.message === 'generic_payer';
}

/**
 * The confirmation before "undo": known to be remembered for the payer (byRule) → it says that stops too; known
 * not to be → only this payment; unknown (a transaction row does not say) → it says it may stop too.
 */
export function undoConfirmKey(byRule: boolean | undefined): 'paid_back_undo_confirm_rule' | 'paid_back_undo_confirm' | 'paid_back_undo_confirm_any' {
  if (byRule === true) return 'paid_back_undo_confirm_rule';
  if (byRule === false) return 'paid_back_undo_confirm';
  return 'paid_back_undo_confirm_any';
}

/**
 * In "how is this calculated", a positive row under day-to-day spending is money paid back to the owner, not
 * spending: it gets the "paid back" label. Any row of a `paid_back` term does too.
 */
export function explainItemIsPaidBack(termKey: string, amount: number): boolean {
  if (termKey === 'paid_back') return true;
  return termKey === 'variable_spent' && amount > 0;
}
