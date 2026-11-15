/** RiseUp external API transaction → NormalizedRow. Field names per riseup-oss/mcp docs. */
import { isoDatePart, toMinor } from './normalize.js';
import type { NormalizedRow } from './types.js';

export interface RiseupTransaction {
  transactionId: string;
  transactionDate: string;
  billingDate?: string;
  cashflowDate: string;
  businessName: string;
  isIncome: boolean;
  amount: number;
  accountNickname?: string | null;
  accountNumberHash?: string | null;
  isInstallment?: boolean;
  installmentNumber?: number;
  totalNumberOfInstallments?: number;
  totalNumberOfPayments?: number;
  isPostponed?: boolean;
  sourceType?: string;
  source?: string;
  commitmentId?: string | null;
  actualType?: string;
  categoryLabel?: string;
  categoryType?: string;
  expenseType?: string | null;
  isExcluded?: boolean;
  sequenceName?: string;
  transactionCustomerComment?: string;
  paymentAppComment?: string;
  paymentAppAddressee?: string;
}

export const RISEUP_SOURCE = 'riseup';

/** RiseUp's per-account key. Falls back to provider+nickname when the hash is missing. */
export function riseupExternalAccountId(t: RiseupTransaction): string {
  return t.accountNumberHash ?? `${t.source ?? 'unknown'}:${t.accountNickname ?? 'unknown'}`;
}

export function fromRiseupTransaction(t: RiseupTransaction): NormalizedRow {
  const abs = toMinor(t.amount) ?? 0;
  const row: NormalizedRow = {
    externalAccountId: riseupExternalAccountId(t),
    date: isoDatePart(t.transactionDate),
    amount: t.isIncome ? Math.abs(abs) : -Math.abs(abs),
    description: t.businessName ?? '',
    status: 'completed', // RiseUp only exposes approved transactions
    type: t.isInstallment ? 'installments' : 'normal',
    identifier: t.transactionId,
    payload: t,
    annotations: {
      transactionId: t.transactionId,
      cashflowDate: t.cashflowDate,
      categoryLabel: t.categoryLabel,
      categoryType: t.categoryType,
      expenseType: t.expenseType,
      actualType: t.actualType,
      isExcluded: t.isExcluded ?? false,
      isPostponed: t.isPostponed ?? false,
      commitmentId: t.commitmentId ?? null,
      sequenceName: t.sequenceName,
      comment: t.transactionCustomerComment,
      paymentAppComment: t.paymentAppComment,
      paymentAppAddressee: t.paymentAppAddressee,
      source: t.source,
      sourceType: t.sourceType,
      accountNickname: t.accountNickname ?? null,
    },
  };
  if (t.billingDate) row.chargeDate = isoDatePart(t.billingDate);
  if (t.isInstallment) {
    if (t.installmentNumber !== undefined) row.installmentN = t.installmentNumber;
    const total = t.totalNumberOfInstallments ?? t.totalNumberOfPayments;
    if (total !== undefined) row.installmentTotal = total;
  }
  return row;
}
