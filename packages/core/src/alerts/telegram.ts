/**
 * Telegram Bot API, the first notification channel (§7d). The bot token lives in the vault under
 * `telegram` (field `token`); the chat id is discovered from the first message the owner sends the bot and
 * kept as a plain setting. Only merchant names, amounts and dates ever appear in a message.
 */
import { cleanErrorText } from '../errors.js';

const API = 'https://api.telegram.org';

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TgUpdate {
  update_id: number;
  message?: { message_id: number; date: number; text?: string; chat: { id: number; type: string; first_name?: string; username?: string } };
}

async function call<T>(token: string, method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<TgResponse<T>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    return (await res.json()) as TgResponse<T>;
  } catch (e) {
    // cleaned: the request URL carries the bot token, and this text is stored (alert_log.error) and logged
    return { ok: false, description: cleanErrorText(e) };
  } finally {
    clearTimeout(timer);
  }
}

export function looksLikeTelegramToken(token: string): boolean {
  return /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token);
}

export interface TelegramSendOptions {
  /**
   * 'HTML' (the default) for the alert texts finc writes itself; null sends plain text, for anything that carries a
   * name someone else chose (security alerts, P1-05): nothing in it can break the message or inject a link.
   */
  parseMode?: 'HTML' | null;
}

/** `code` is Telegram's error_code when it answered (400 "chat not found", 403 "bot can't initiate conversation"). */
export async function telegramSend(token: string, chatId: string, text: string, opts: TelegramSendOptions = {}): Promise<{ ok: boolean; error?: string; code?: number }> {
  const parseMode = opts.parseMode === undefined ? 'HTML' : opts.parseMode;
  const r = await call<unknown>(token, 'sendMessage', { chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}), disable_web_page_preview: true });
  return r.ok ? { ok: true } : { ok: false, error: r.description ?? 'telegram error', ...(r.error_code !== undefined ? { code: r.error_code } : {}) };
}

/** The bot's own identity, to show in Settings and to validate the token. `id` is the bot's numeric id. */
export async function telegramMe(token: string): Promise<{ ok: boolean; id?: number; username?: string; error?: string }> {
  const r = await call<{ id?: number; username?: string }>(token, 'getMe', {});
  return r.ok ? { ok: true, ...(typeof r.result?.id === 'number' ? { id: r.result.id } : {}), ...(r.result?.username ? { username: r.result.username } : {}) } : { ok: false, error: r.description ?? 'telegram error' };
}

/**
 * The private chat that sent `/start <code>` (or just the code) at or after `sinceUnix` (security research P0-02).
 * Binding by a one-time code made at home means whoever messaged the bot last can no longer become the
 * alert channel; the newest matching message wins if the owner pressed Start more than once.
 */
export async function telegramFindChatByCode(token: string, code: string, sinceUnix: number): Promise<{ chatId: string; from: string } | null> {
  const r = await call<TgUpdate[]>(token, 'getUpdates', { limit: 100, timeout: 0 });
  if (!r.ok || !r.result) return null;
  const hit = r.result
    .filter((u) => {
      const m = u.message;
      if (!m || m.chat.type !== 'private' || m.date < sinceUnix) return false;
      const text = (m.text ?? '').trim();
      return text === `/start ${code}` || text === code;
    })
    .sort((a, b) => b.update_id - a.update_id)[0]?.message;
  if (!hit) return null;
  return { chatId: String(hit.chat.id), from: hit.chat.username ? `@${hit.chat.username}` : (hit.chat.first_name ?? 'you') };
}

/**
 * The chat that most recently wrote to the bot. Kept for diagnostics only: the hub binds the alert chat
 * with telegramFindChatByCode, never with this (P0-02).
 */
export async function telegramDiscoverChatId(token: string): Promise<{ chatId: string; from: string } | null> {
  const r = await call<TgUpdate[]>(token, 'getUpdates', { limit: 20, timeout: 0 });
  if (!r.ok || !r.result) return null;
  const msgs = r.result.filter((u) => u.message?.chat.type === 'private').sort((a, b) => b.update_id - a.update_id);
  const m = msgs[0]?.message;
  if (!m) return null;
  return { chatId: String(m.chat.id), from: m.chat.username ? `@${m.chat.username}` : (m.chat.first_name ?? 'you') };
}

/**
 * Wait for a reply from the configured chat (a one-time bank code). Long-polls getUpdates with an
 * offset so older messages are never re-read. Returns the first message matching `pattern`.
 */
export async function telegramWaitForReply(token: string, chatId: string, opts: { timeoutMs: number; pattern?: RegExp }): Promise<string | null> {
  const deadline = Date.now() + opts.timeoutMs;
  // skip everything already queued
  const seed = await call<TgUpdate[]>(token, 'getUpdates', { limit: 100, timeout: 0 });
  let offset = seed.ok && seed.result?.length ? Math.max(...seed.result.map((u) => u.update_id)) + 1 : 0;
  while (Date.now() < deadline) {
    const r = await call<TgUpdate[]>(token, 'getUpdates', { offset, timeout: 20, limit: 20 }, 30_000);
    if (!r.ok || !r.result) {
      await new Promise((res) => setTimeout(res, 3000));
      continue;
    }
    for (const u of r.result) {
      offset = u.update_id + 1;
      const text = u.message?.text?.trim();
      if (!text || String(u.message?.chat.id) !== chatId) continue;
      if (!opts.pattern || opts.pattern.test(text)) return text;
    }
  }
  return null;
}
