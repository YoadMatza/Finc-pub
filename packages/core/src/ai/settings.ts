import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { dbPath } from '../config/paths.js';
import { assertDbAvailable } from '../db/owner.js';
import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { setting } from '../db/schema.js';
import { AI_DEFAULTS } from './provider.js';

export function getSetting(db: Db, key: string): string | null {
  return db.select().from(setting).where(eq(setting.key, key)).get()?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string | null): void {
  if (value === null) {
    db.delete(setting).where(eq(setting.key, key)).run();
    return;
  }
  db.insert(setting).values({ key, value, updatedAt: nowIso() }).onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: nowIso() } }).run();
}

export interface AiSettings {
  provider: 'anthropic' | 'openai' | 'local' | null;
  model: string | null;
  baseUrl: string | null;
  /** the chat's own model (chat v2 step 4), one of CHAT_MODELS for the provider; null = the chat uses `model` */
  chatModel: string | null;
}

/**
 * The chat's model choice (chat v2 step 4), separate from categorisation: two tiers per cloud provider and nothing
 * else, so a setting can never point the chat at an arbitrary model id. The local provider has no choice (ai.model).
 */
export const CHAT_MODELS = {
  openai: { fast: 'gpt-5-mini', better: 'gpt-5' },
  anthropic: { fast: 'claude-haiku-5-5', better: 'claude-sonnet-5-5' },
} as const;
export type ChatTier = keyof (typeof CHAT_MODELS)['openai'];

/** Is `model` one of the chat models offered for `provider`? */
export function chatModelAllowed(provider: AiSettings['provider'], model: string): boolean {
  return (provider === 'openai' || provider === 'anthropic') && (Object.values(CHAT_MODELS[provider]) as string[]).includes(model);
}

const aiSettingsOf = (get: (k: string) => string | null): AiSettings => {
  const p = get('ai.provider');
  const provider = p === 'anthropic' || p === 'openai' || p === 'local' ? p : null;
  const chat = get('ai.chatModel');
  // a stored chat model that does not belong to the provider (set by hand, or a stale row) is ignored
  return { provider, model: get('ai.model'), baseUrl: get('ai.baseUrl'), chatModel: chat && chatModelAllowed(provider, chat) ? chat : null };
};

export function getAiSettings(db: Db): AiSettings {
  return aiSettingsOf((k) => getSetting(db, k));
}

/** The model the chat actually uses: ai.chatModel when set (cloud providers only), else ai.model, else the default. */
export function chatModelOf(ai: AiSettings): string | null {
  if (!ai.provider) return null;
  // a cloud chat with no choice made runs the provider's fast model, never ai.model: that is the categorisation
  // model, and after a provider switch it may still name the other provider's model
  if (ai.provider !== 'local') return ai.chatModel ?? CHAT_MODELS[ai.provider].fast;
  return ai.model ?? AI_DEFAULTS[ai.provider].model;
}

/**
 * The AI settings through a read-only connection (`finc chat-eval`): no migration, no owner claim, no write. Another
 * host's worker owning the file is still refused (assertDbAvailable). Undefined when it cannot be opened read-only
 * (the caller may then fall back to openDb).
 */
export function readAiSettingsReadOnly(file: string = dbPath()): AiSettings | undefined {
  assertDbAvailable(file);
  let conn: Database.Database | undefined;
  try {
    conn = new Database(file, { readonly: true, fileMustExist: true });
    const rows = conn.prepare(`select key, value from setting where key in ('ai.provider', 'ai.model', 'ai.baseUrl', 'ai.chatModel')`).all() as Array<{ key: string; value: string }>;
    return aiSettingsOf((k) => rows.find((r) => r.key === k)?.value ?? null);
  } catch {
    return undefined;
  } finally {
    conn?.close();
  }
}
