/**
 * Stored passkeys (QUESTIONS 17): the login from outside the home network. This module only keeps the
 * credentials; the WebAuthn ceremony (challenges, signature checks) lives in the worker API with
 * @simplewebauthn/server. Revocation is a timestamp so the row stays as a record.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/db.js';
import { passkey } from '../db/schema.js';

export interface PasskeyView {
  id: number;
  name: string;
  rpId: string;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** What the WebAuthn verifier needs about a stored credential. */
export interface StoredPasskey extends PasskeyView {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
}

type Row = typeof passkey.$inferSelect;

const view = (r: Row): PasskeyView => ({ id: r.id, name: r.name, rpId: r.rpId, deviceType: r.deviceType, backedUp: r.backedUp, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, revokedAt: r.revokedAt });

const stored = (r: Row): StoredPasskey => {
  let transports: string[] = [];
  try {
    const t = JSON.parse(r.transportsJson ?? '[]') as unknown;
    if (Array.isArray(t)) transports = t.filter((x): x is string => typeof x === 'string');
  } catch {
    /* none */
  }
  return { ...view(r), credentialId: r.credentialId, publicKey: r.publicKey, counter: r.counter, transports };
};

export function addPasskey(
  db: Db,
  input: { credentialId: string; publicKey: string; counter: number; transports?: string[]; rpId: string; name: string; deviceType?: string | null; backedUp?: boolean },
): PasskeyView {
  if (!input.credentialId || !input.publicKey) throw new Error('a passkey needs a credential id and a public key');
  const now = new Date().toISOString();
  const [row] = db
    .insert(passkey)
    .values({
      credentialId: input.credentialId,
      publicKey: input.publicKey,
      counter: input.counter,
      transportsJson: JSON.stringify(input.transports ?? []),
      rpId: input.rpId,
      name: input.name.trim().slice(0, 60) || 'passkey',
      deviceType: input.deviceType ?? null,
      backedUp: input.backedUp ?? false,
      createdAt: now,
    })
    .returning()
    .all();
  return view(row!);
}

/** The active (not revoked) passkey with this credential id for this relying party, if any. */
export function findPasskey(db: Db, credentialId: string, rpId: string): StoredPasskey | null {
  const r = db
    .select()
    .from(passkey)
    .where(and(eq(passkey.credentialId, credentialId), eq(passkey.rpId, rpId), isNull(passkey.revokedAt)))
    .get();
  return r ? stored(r) : null;
}

/** Active passkeys for a relying party, for the sign-in allow list and the "already registered" exclude list. */
export function activePasskeys(db: Db, rpId: string): StoredPasskey[] {
  return db
    .select()
    .from(passkey)
    .where(and(eq(passkey.rpId, rpId), isNull(passkey.revokedAt)))
    .all()
    .map(stored);
}

export function listPasskeys(db: Db, includeRevoked = false): PasskeyView[] {
  const q = db.select().from(passkey);
  const rows = includeRevoked ? q.orderBy(desc(passkey.createdAt)).all() : q.where(isNull(passkey.revokedAt)).orderBy(desc(passkey.createdAt)).all();
  return rows.map(view);
}

/** After a successful sign-in: the new signature counter and the time. */
export function touchPasskey(db: Db, id: number, counter: number): void {
  db.update(passkey).set({ counter, lastUsedAt: new Date().toISOString() }).where(eq(passkey.id, id)).run();
}

export function revokePasskey(db: Db, id: number): boolean {
  const r = db
    .update(passkey)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(passkey.id, id), isNull(passkey.revokedAt)))
    .run();
  return r.changes > 0;
}

/** The panic switch (P1-09): every active passkey revoked at once; re-enrolling needs a new code made at home. */
export function revokeAllPasskeys(db: Db): number {
  return db.update(passkey).set({ revokedAt: new Date().toISOString() }).where(isNull(passkey.revokedAt)).run().changes;
}
