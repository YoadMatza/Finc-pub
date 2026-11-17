/**
 * One-time codes from the phone app (push-alerts.md P4): a bank sync that needs a code opens a request here; the app
 * (or the hub) answers it with POST /api/otp/:id. Telegram keeps working in parallel: whichever answers first wins.
 * In memory: a request lives as long as the waiting sync (minutes).
 */
import { randomBytes } from 'node:crypto';

export interface OtpRequest {
  id: string;
  institutionId: string;
  expiresAt: number;
}

export class OtpBroker {
  private open = new Map<string, OtpRequest & { resolve: (code: string) => void }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Opens a request; `code` resolves with the app's answer, or never (the caller races it with Telegram and a timeout). */
  request(institutionId: string, timeoutMs: number): { id: string; code: Promise<string>; cancel: () => void } {
    this.prune();
    const id = randomBytes(16).toString('base64url');
    let cancel = () => undefined as void;
    const code = new Promise<string>((resolve) => {
      this.open.set(id, { id, institutionId, expiresAt: this.now() + timeoutMs, resolve });
      cancel = () => void this.open.delete(id);
    });
    return { id, code, cancel };
  }

  pending(): OtpRequest[] {
    this.prune();
    return [...this.open.values()].map(({ id, institutionId, expiresAt }) => ({ id, institutionId, expiresAt }));
  }

  /** true when the request was open and the code is well-formed; the request closes either way on a good code. */
  answer(id: string, code: string): boolean {
    this.prune();
    const r = this.open.get(id);
    if (!r || !/^\d{4,8}$/.test(code)) return false;
    this.open.delete(id);
    r.resolve(code);
    return true;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, v] of this.open) if (v.expiresAt <= t) this.open.delete(k);
  }
}

/** The worker's one broker, shared by the scheduler's OTP provider and the API. */
export const otpBroker = new OtpBroker();
