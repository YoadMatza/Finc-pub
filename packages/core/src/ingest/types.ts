/** Connector-agnostic row handed to the ingest engine. Money in signed minor units. */
export interface NormalizedRow {
  /** The source's own account id: scraper accountNumber, RiseUp accountNumberHash, import label. */
  externalAccountId: string;
  /** Purchase / transaction date, YYYY-MM-DD (local Israel date). */
  date: string;
  /** Card billing / bank processing date, YYYY-MM-DD. */
  chargeDate?: string;
  /** Signed agorot. Negative = money out. */
  amount: number;
  originalAmount?: number;
  originalCurrency?: string;
  description: string;
  memo?: string;
  status: 'pending' | 'completed';
  type: 'normal' | 'installments';
  installmentN?: number;
  installmentTotal?: number;
  /** Bank reference / ARN / RiseUp transactionId. */
  identifier?: string;
  /** Verbatim as received. Stored in raw_transaction.payload_json. */
  payload: unknown;
  /** Source-specific extras kept on the transaction as annotations[sourceKind]. */
  annotations?: Record<string, unknown>;
}

export type SourceKind = 'scraper' | 'import' | 'riseup' | 'manual';

/** Higher wins when two sources describe the same transaction (§4a). */
export const SOURCE_PRECEDENCE: Record<SourceKind, number> = { scraper: 3, import: 2, riseup: 1, manual: 0 };

export function sourceKind(source: string): SourceKind {
  const k = source.split(':')[0] as SourceKind;
  if (!(k in SOURCE_PRECEDENCE)) throw new Error(`unknown source "${source}"`);
  return k;
}

export interface IngestStats {
  seen: number;
  new: number;
  updated: number;
  completed: number;
  voided: number;
  annotated: number;
}
