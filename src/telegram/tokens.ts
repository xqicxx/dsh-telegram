/**
 * Callback payload registry: keeps long ids/arguments out of Telegram's
 * 64-byte callback_data limit. Tokens are single-use — a tap executes exactly
 * once even when Telegram redelivers a callback or a stale message is tapped
 * again — optionally bound to their minting chat (RF-1), and every ledger
 * stays bounded for long-running bots.
 */

export class TokenRegistry {
  private readonly tokens = new Map<number, Record<string, string>>();
  private readonly used = new Set<number>();
  /** Minting chat per pending token (RF-1): a tap from any other chat is
   * rejected instead of executing, so a whitelisted stranger cannot replay an
   * enumerated `t:<id>` into someone else's private chat. Only present when
   * the mint site knew its chat; absent entries stay world-usable so every
   * existing caller keeps working unchanged. Entries exist only while their
   * token is pending (dropped on take/evict), so the map stays bounded. */
  private readonly owners = new Map<number, number>();
  private counter = Date.now();

  constructor(private readonly maxEntries = 1000) {}

  mint(payload: Record<string, string>, chatId?: number): string {
    this.counter += 1;
    if (this.tokens.size >= this.maxEntries) {
      const oldest = this.tokens.keys().next().value;
      if (oldest !== undefined) {
        this.tokens.delete(oldest);
        this.owners.delete(oldest);
      }
    }
    this.tokens.set(this.counter, payload);
    if (chatId === undefined) this.owners.delete(this.counter);
    else this.owners.set(this.counter, chatId);
    return `t:${this.counter}`;
  }

  /** Remove and return the payload for a callback; `undefined` when unknown,
   * already consumed, or — for a token minted with a chat binding — tapped
   * from any other chat (RF-1). A token without a recorded owner stays
   * usable from anywhere, which keeps pre-binding cards working; passing no
   * chatId at all also only ever matches unowned tokens. */
  take(data: string, chatId?: number): Record<string, string> | undefined {
    const id = Number(data.slice(2));
    if (!Number.isFinite(id)) return undefined;
    const payload = this.tokens.get(id);
    if (payload === undefined) return undefined;
    const owner = this.owners.get(id);
    if (owner !== undefined && chatId !== owner) return undefined;
    this.tokens.delete(id);
    this.used.add(id);
    this.owners.delete(id);
    if (this.used.size > this.maxEntries * 4) {
      let remove = this.used.size - this.maxEntries * 2;
      for (const old of this.used) {
        this.used.delete(old);
        remove -= 1;
        if (remove === 0) break;
      }
    }
    return payload;
  }

  /** Put a taken token back when its callback threw before doing anything.
   * Only restores an id this registry marked used; tokens are never reused
   * so a successful run can never be un-consumed. `chatId` (the chat that
   * legitimately took the token — take() only succeeds for the minting chat)
   * re-records ownership so a restored token keeps its chat binding. */
  restore(data: string, payload: Record<string, string>, chatId?: number): boolean {
    const id = Number(data.slice(2));
    if (!Number.isFinite(id) || !this.used.has(id) || this.tokens.has(id)) return false;
    this.used.delete(id);
    if (this.tokens.size < this.maxEntries) {
      this.tokens.set(id, payload);
      if (chatId === undefined) this.owners.delete(id);
      else this.owners.set(id, chatId);
    }
    return true;
  }

  /** Distinguish "already ran" from "card predates this bot process". */
  wasUsed(data: string): boolean {
    return this.used.has(Number(data.slice(2)));
  }

  pending(): number {
    return this.tokens.size;
  }

  reset(): void {
    this.tokens.clear();
    this.used.clear();
    this.owners.clear();
  }
}
