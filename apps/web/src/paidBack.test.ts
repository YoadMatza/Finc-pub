import { describe, expect, it } from 'vitest';
import { he, en } from './i18n';
import { explainItemIsPaidBack, isGenericPayerError, paidBackButtons, paidBackLine, paidBackState, undoConfirmKey } from './paidBack';

describe('paidBackState', () => {
  it('a paid-back row gets the badge, even if the hub still says ask', () => {
    expect(paidBackState({ id: 5, paidBack: true })).toBe('paid_back');
    expect(paidBackState({ id: 5, paidBack: true, askPaidBack: true })).toBe('paid_back');
  });
  it('an asked row gets the question', () => expect(paidBackState({ id: 5, paidBack: false, askPaidBack: true })).toBe('ask'));
  it('nothing when neither, or on an older hub that sends neither field', () => {
    expect(paidBackState({ id: 5, paidBack: false, askPaidBack: false })).toBe('none');
    expect(paidBackState({ id: 5 })).toBe('none');
  });
  it('an expected item (id null) is never asked about', () => {
    expect(paidBackState({ id: null, askPaidBack: true })).toBe('none');
    expect(paidBackState({ id: null, paidBack: true })).toBe('none');
  });
});

describe('paidBackLine', () => {
  it('shown with the total and the count when positive', () => {
    expect(paidBackLine({ total: 45_000, items: [{ id: 1, name: 'Dana', amount: 45_000, date: '2026-11-03', byRule: true }] })).toEqual({ total: 45_000, count: 1 });
  });
  it('hidden when zero, or on an older hub', () => {
    expect(paidBackLine({ total: 0, items: [] })).toBeNull();
    expect(paidBackLine(undefined)).toBeNull();
    expect(paidBackLine(null)).toBeNull();
  });
});

describe('answers and undo confirmation', () => {
  it('a payer that can be remembered: Always / Just this one / No (remembered)', () => {
    expect(paidBackButtons(true).map((a) => a.answer)).toEqual(['always', 'once', 'no']);
    expect(paidBackButtons(true).map((a) => a.key)).toEqual(['paid_back_always', 'paid_back_once', 'paid_back_no']);
  });
  it('an older hub (no canRemember) reads as remembered', () => expect(paidBackButtons(undefined).map((a) => a.answer)).toEqual(['always', 'once', 'no']));
  it('shared bank text: no Always, and No covers this payment only', () => {
    expect(paidBackButtons(false).map((a) => a.answer)).toEqual(['once', 'no_once']);
    expect(paidBackButtons(false).map((a) => a.key)).toEqual(['paid_back_once', 'paid_back_no']);
  });
  it('byRule says the payer stops being treated as paying back; not byRule only this payment; unknown says it may', () => {
    expect(undoConfirmKey(true)).toBe('paid_back_undo_confirm_rule');
    expect(undoConfirmKey(false)).toBe('paid_back_undo_confirm');
    expect(undoConfirmKey(undefined)).toBe('paid_back_undo_confirm_any');
  });
  it('every key the helpers return exists in both languages, with the placeholders the UI fills', () => {
    const keys = ['paid_back_generic_payer' as const, ...paidBackButtons(true).map((a) => a.key), undoConfirmKey(true), undoConfirmKey(false), undoConfirmKey(undefined)];
    for (const k of keys) {
      expect(he[k]).toBeTruthy();
      expect(en[k]).toBeTruthy();
    }
    for (const k of [undoConfirmKey(true), undoConfirmKey(false), undoConfirmKey(undefined)]) {
      for (const d of [he, en]) {
        expect(d[k]).toContain('{name}');
        expect(d[k]).toContain('{x}');
      }
    }
    expect(en.paid_back_line).toBe('Paid back to you: {x} — counted against day-to-day spending');
    expect(en.paid_back_ask).toBe('Is {name} paying you back?');
  });
});

describe('explainItemIsPaidBack', () => {
  it('a positive day-to-day row is paid back, a negative one is spending', () => {
    expect(explainItemIsPaidBack('variable_spent', 45_000)).toBe(true);
    expect(explainItemIsPaidBack('variable_spent', -12_000)).toBe(false);
  });
  it('income rows are never relabelled; a paid_back term always is', () => {
    expect(explainItemIsPaidBack('income_extra_received', 45_000)).toBe(false);
    expect(explainItemIsPaidBack('paid_back', 45_000)).toBe(true);
  });
});

describe('isGenericPayerError', () => {
  const err = (status: number, data: Record<string, unknown>, message = 'x') => Object.assign(new Error(message), { status, data });
  it('a 400 with the generic_payer code, as code, as error, or as the message', () => {
    expect(isGenericPayerError(err(400, { code: 'generic_payer' }))).toBe(true);
    expect(isGenericPayerError(err(400, { error: 'generic_payer' }))).toBe(true);
    expect(isGenericPayerError(err(400, {}, 'generic_payer'))).toBe(true);
  });
  it('other errors are not', () => {
    expect(isGenericPayerError(err(400, { error: 'invalid answer' }))).toBe(false);
    expect(isGenericPayerError(err(500, { code: 'generic_payer' }))).toBe(false);
    expect(isGenericPayerError(new Error('generic_payer'))).toBe(false);
    expect(isGenericPayerError(null)).toBe(false);
  });
});
