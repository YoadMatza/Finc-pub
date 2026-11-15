/**
 * Lookup memory for "ask my money" (chat v2 step 2): per caller and chat id, the lookups the model already saw in
 * earlier turns of the same conversation ("{tool,args} → result", already through the egress guard), so a follow-up
 * ("both", "and by merchant?") can continue from them. Nothing new leaves the PC because of it.
 *
 * In the worker's memory only, never on disk: 30 minutes from last use, at most 50 chats (least recently used goes
 * first), at most MAX_LOOKUPS lookups and MAX_CHARS characters per chat (newest kept). Everything is dropped when
 * the vault locks (lock, panic, a new unlock): the routes call clear(), which also bumps a generation, so a question
 * that was in flight during the lock stores nothing afterwards. As a backstop an entry stored under one vault object
 * is never served under another one or under a locked vault, and an entry is dropped when the data changed since
 * (a sync, an engine run or an edit changes the data stamp the route passes in).
 */
export const CHAT_MEMORY_TTL_MS = 30 * 60_000;
export const CHAT_MEMORY_MAX_CHATS = 50;
export const CHAT_MEMORY_MAX_LOOKUPS = 8;
export const CHAT_MEMORY_MAX_CHARS = 24_000;

/** The vault as the memory sees it: its identity and whether it is open. */
export type VaultRef = { locked: boolean } | null | undefined;

const openVault = (vault: VaultRef): object | null => (vault && !vault.locked ? vault : null);

interface Entry {
  lookups: string[];
  lastUsed: number;
  vault: object | null;
  stamp: string;
}

/** One question's use of the memory: what it may see, and where its own lookups go when it is done. */
export interface ChatTurn {
  previous: string[];
  /** stores the turn's lookups, unless the memory was cleared (a lock, a panic) while the question ran */
  finish: (lookups: readonly string[]) => void;
}

/** The newest lookups whose total length fits in `maxChars` (oldest dropped first). */
export function newestWithin(lookups: readonly string[], maxChars: number, maxCount = Number.POSITIVE_INFINITY): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (let i = lookups.length - 1; i >= 0 && kept.length < maxCount; i--) {
    const l = lookups[i]!;
    if (chars + l.length > maxChars) break;
    kept.unshift(l);
    chars += l.length;
  }
  return kept;
}

export class ChatMemory {
  private readonly chats = new Map<string, Entry>();
  /** bumped by every clear(): a turn that began before it never stores */
  private generation = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Starts a question: the chat's earlier lookups (at most `maxChars` of them, newest kept), and a finish() bound to
   * the vault, data stamp and generation of this moment.
   */
  begin(key: string, vault: VaultRef, stamp = '', maxChars = CHAT_MEMORY_MAX_CHARS): ChatTurn {
    const gen = this.generation;
    const v = openVault(vault);
    const previous = newestWithin(this.get(key, vault, stamp), maxChars);
    return {
      previous,
      finish: (lookups) => {
        // cleared meanwhile, or the vault this question began under is no longer open
        if (gen !== this.generation || openVault(vault) !== v) return;
        this.add(key, lookups, vault, stamp);
      },
    };
  }

  /** The chat's earlier lookups (and marks it used); [] when unknown, expired, stored under another vault or older data. */
  get(key: string, vault: VaultRef, stamp = ''): string[] {
    const e = this.chats.get(key);
    if (!e) return [];
    if (this.now() - e.lastUsed > CHAT_MEMORY_TTL_MS || e.vault !== openVault(vault) || e.stamp !== stamp) {
      this.chats.delete(key);
      return [];
    }
    e.lastUsed = this.now();
    // most recently used last (Map order = LRU order)
    this.chats.delete(key);
    this.chats.set(key, e);
    return [...e.lookups];
  }

  /**
   * Adds a turn's lookups to the chat (oldest dropped past the caps; an identical lookup moves to the end). A turn
   * without lookups keeps what the chat had, so a third question can still use the first one's data.
   */
  add(key: string, lookups: readonly string[], vault: VaultRef, stamp = ''): void {
    this.prune();
    const prev = this.get(key, vault, stamp);
    const kept = newestWithin([...prev.filter((l) => !lookups.includes(l)), ...lookups], CHAT_MEMORY_MAX_CHARS, CHAT_MEMORY_MAX_LOOKUPS);
    this.chats.delete(key);
    if (!kept.length) return;
    this.chats.set(key, { lookups: kept, lastUsed: this.now(), vault: openVault(vault), stamp });
    while (this.chats.size > CHAT_MEMORY_MAX_CHATS) this.chats.delete(this.chats.keys().next().value!);
  }

  /** "New chat" on the web: the old conversation's lookups go. */
  forget(key: string): void {
    this.chats.delete(key);
  }

  /** The vault locked (or a panic ran): everything goes, and questions still running store nothing. */
  clear(): void {
    this.generation++;
    this.chats.clear();
  }

  get size(): number {
    return this.chats.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [id, e] of this.chats) if (t - e.lastUsed > CHAT_MEMORY_TTL_MS) this.chats.delete(id);
  }
}
