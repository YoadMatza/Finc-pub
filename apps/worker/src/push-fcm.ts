/**
 * Push alerts through Firebase Cloud Messaging (research_notes/proposals/push-alerts.md): a data-only, high-priority
 * message whose only field is a random id. No alert text, amount, merchant or kind ever goes to Google; the app wakes,
 * fetches its queued alerts from finc over its pinned connection and shows them.
 *
 * Credentials: the vault entry `push_fcm` (projectId, clientEmail, privateKey from a Firebase service-account key,
 * stored by `finc push setup`). An OAuth access token is minted from it (JWT bearer, RS256) and cached until it expires.
 */
import { createSign, randomBytes } from 'node:crypto';
import type { Vault } from '@finc/core';
import { log as defaultLog } from './logger.js';

export const PUSH_VAULT_ENTRY = 'push_fcm';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 10_000;

export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** The three fields from the vault, or null when push is not set up (or the vault is locked). */
export function fcmCredentials(vault: Vault | null): FcmCredentials | null {
  if (!vault || vault.locked) return null;
  const f = vault.get(PUSH_VAULT_ENTRY)?.fields;
  if (!f?.projectId || !f.clientEmail || !f.privateKey) return null;
  return { projectId: f.projectId, clientEmail: f.clientEmail, privateKey: f.privateKey };
}

/** A service-account key file's fields, checked: what `finc push setup` stores. */
export function parseServiceAccount(json: unknown): FcmCredentials | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  if (j.type !== 'service_account') return null;
  const projectId = j.project_id;
  const clientEmail = j.client_email;
  const privateKey = j.private_key;
  if (typeof projectId !== 'string' || !/^[a-z0-9-]{4,40}$/.test(projectId)) return null;
  if (typeof clientEmail !== 'string' || !/^[^\s@]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(clientEmail)) return null;
  if (typeof privateKey !== 'string' || !privateKey.includes('BEGIN PRIVATE KEY')) return null;
  return { projectId, clientEmail, privateKey };
}

export interface PushSender {
  /** Wakes these devices; ok when at least one was reached. `invalid` lists tokens Firebase no longer knows. */
  ping(tokens: string[]): Promise<{ ok: boolean; error?: string; invalid: string[] }>;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export class FcmSender implements PushSender {
  private access: { token: string; until: number } | null = null;

  constructor(
    private readonly deps: {
      creds: () => FcmCredentials | null;
      fetch?: typeof fetch;
      now?: () => number;
      log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
    },
  ) {}

  private get fetchFn() {
    return this.deps.fetch ?? fetch;
  }
  private get log() {
    return this.deps.log ?? defaultLog;
  }

  private async accessToken(c: FcmCredentials): Promise<string> {
    const now = (this.deps.now ?? Date.now)();
    if (this.access && this.access.until > now + 60_000) return this.access.token;
    const iat = Math.floor(now / 1000);
    const head = b64({ alg: 'RS256', typ: 'JWT' });
    const body = b64({ iss: c.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 });
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(c.privateKey).toString('base64url');
    const res = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
    if (!res.ok || typeof j.access_token !== 'string') throw new Error(`google token: ${res.status}`);
    this.access = { token: j.access_token, until: now + (typeof j.expires_in === 'number' ? j.expires_in : 3600) * 1000 };
    return j.access_token;
  }

  async ping(tokens: string[]): Promise<{ ok: boolean; error?: string; invalid: string[] }> {
    const c = this.deps.creds();
    if (!c) return { ok: false, error: 'push is not set up (or the vault is locked)', invalid: [] };
    let access: string;
    try {
      access = await this.accessToken(c);
    } catch (e) {
      this.log.warn({ err: e instanceof Error ? e.message : 'error' }, 'push: no access token');
      return { ok: false, error: 'google token refused', invalid: [] };
    }
    let reached = 0;
    const invalid: string[] = [];
    let lastError: string | undefined;
    for (const token of tokens) {
      // the whole message: a token to deliver to, a random id, high priority, a short life. Nothing about the alert.
      const message = { message: { token, data: { w: randomBytes(9).toString('base64url') }, android: { priority: 'high', ttl: '900s', collapse_key: 'finc' } } };
      try {
        const res = await this.fetchFn(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(c.projectId)}/messages:send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.ok) reached++;
        else {
          const body = (await res.json().catch(() => ({}))) as { error?: { status?: string; details?: Array<{ errorCode?: string }> } };
          const code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status ?? String(res.status);
          if (code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT' || res.status === 404) invalid.push(token);
          lastError = `fcm ${code}`;
        }
      } catch (e) {
        lastError = e instanceof Error ? e.name : 'error';
      }
    }
    this.log.info({ devices: tokens.length, reached, invalid: invalid.length }, 'push: woke the app');
    return reached ? { ok: true, invalid } : { ok: false, error: lastError ?? 'no device reached', invalid };
  }
}
