/**
 * The WebAuthn side of passkey sign-in (QUESTIONS 17): enrolment codes, sign-in challenges, the relying party
 * derived from `ui.publicUrl`, and the four @simplewebauthn/server calls behind an injectable seam (tests have
 * no authenticator). The routes live in app.ts; the stored credentials in @finc/core (hub/passkeys).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Db, getSetting, setSetting } from '@finc/core';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';

export interface WebAuthnFns {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

export const realWebAuthn: WebAuthnFns = { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse };

const CODE_TTL_MS = 5 * 60_000;

/** The relying party: the public address's hostname and origin. Null when no public address is set. */
export function passkeyRp(db: Db): { rpId: string; origin: string } | null {
  const configured = getSetting(db, 'ui.publicUrl');
  if (!configured) return null;
  try {
    const u = new URL(configured);
    return u.hostname ? { rpId: u.hostname, origin: u.origin } : null;
  } catch {
    return null;
  }
}

/** finc has one user; its WebAuthn user handle is 16 random bytes, made once and kept in the settings. */
export function passkeyUserId(db: Db): Uint8Array<ArrayBuffer> {
  let id = getSetting(db, 'passkey.userId');
  if (!id) {
    id = randomBytes(16).toString('base64url');
    setSetting(db, 'passkey.userId', id);
  }
  return new Uint8Array(Buffer.from(id, 'base64url'));
}

/** A readable default name for a new passkey, from the browser's user agent. */
export function passkeyNameFromAgent(agent: string | undefined): string {
  const a = agent ?? '';
  if (/iPhone/i.test(a)) return 'iPhone';
  if (/iPad/i.test(a)) return 'iPad';
  if (/Android/i.test(a)) return 'Android phone';
  if (/Macintosh|Mac OS X/i.test(a)) return 'Mac';
  if (/Windows/i.test(a)) return 'Windows PC';
  if (/Linux/i.test(a)) return 'Linux';
  return 'passkey';
}

/**
 * One-time enrolment links: made at home by someone signed in, valid for 5 minutes, at most 5 pending, in memory.
 * The code carries the registration challenge between the options and the verification; it is consumed only by
 * a successful registration, so a failed attempt can be retried within the 5 minutes.
 */
export class EnrolmentCodes {
  private readonly codes = new Map<string, { name: string; expiresAt: number; challenge?: string }>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = CODE_TTL_MS,
  ) {}

  create(name: string): string {
    this.prune();
    while (this.codes.size >= 5) {
      const oldest = [...this.codes.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (!oldest) break;
      this.codes.delete(oldest[0]);
    }
    const code = randomBytes(16).toString('base64url');
    this.codes.set(code, { name, expiresAt: this.now() + this.ttlMs });
    return code;
  }

  /** The live entry for a code, without consuming it. */
  get(code: string | undefined): { name: string; challenge?: string } | null {
    this.prune();
    if (!code) return null;
    return this.codes.get(code) ?? null;
  }

  setChallenge(code: string, challenge: string): void {
    const e = this.codes.get(code);
    if (e) e.challenge = challenge;
  }

  consume(code: string): void {
    this.codes.delete(code);
  }

  /** Every pending code gone (the panic switch, P1-09). */
  clear(): void {
    this.codes.clear();
  }

  get pending(): number {
    this.prune();
    return this.codes.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, v] of this.codes) if (v.expiresAt <= t) this.codes.delete(k);
  }
}

/**
 * Sign-in challenges, stateless (independent review 2026-11-10): a challenge is 16 random bytes, its expiry and an
 * HMAC over both with a per-process secret. Nothing is stored when one is handed out, so the public login-options
 * endpoint cannot be flooded to push the owner's challenge out. Only challenges that verified successfully are
 * remembered (until they expire), which makes them single use; an attacker cannot produce successes to fill that set.
 */
export class LoginChallenges {
  private readonly secret = randomBytes(32);
  private readonly used = new Map<string, number>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = CODE_TTL_MS,
  ) {}

  /** A fresh challenge, as the bytes to hand to generateAuthenticationOptions. */
  create(): Uint8Array<ArrayBuffer> {
    const body = Buffer.alloc(24);
    randomBytes(16).copy(body, 0);
    body.writeBigUInt64BE(BigInt(this.now() + this.ttlMs), 16);
    const out = new Uint8Array(56);
    out.set(body, 0);
    out.set(this.mac(body), 24);
    return out;
  }

  /** True when the base64url challenge from the client data was made here, has not expired and was not used yet. */
  isValid(challenge: string): boolean {
    this.prune();
    if (this.used.has(challenge)) return false;
    let raw: Buffer;
    try {
      raw = Buffer.from(challenge, 'base64url');
    } catch {
      return false;
    }
    if (raw.length !== 56) return false;
    const body = raw.subarray(0, 24);
    const expected = this.mac(body);
    if (!timingSafeEqual(expected, raw.subarray(24))) return false;
    return Number(body.readBigUInt64BE(16)) > this.now();
  }

  /** After a successful sign-in only: the challenge can never be used again. */
  consume(challenge: string): void {
    const raw = Buffer.from(challenge, 'base64url');
    this.used.set(challenge, raw.length === 56 ? Number(raw.readBigUInt64BE(16)) : this.now() + this.ttlMs);
  }

  private mac(body: Buffer): Buffer {
    return createHmac('sha256', this.secret).update(body).digest();
  }

  private prune(): void {
    const t = this.now();
    for (const [k, exp] of this.used) if (exp <= t) this.used.delete(k);
  }
}
