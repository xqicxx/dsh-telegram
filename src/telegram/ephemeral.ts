/**
 * Transient navigation surfaces (menus, pickers, cards) are tracked per chat
 * so navigation can update the live card IN PLACE via editMessageText —
 * page switches and reopenings render instantly with no delete+resend round
 * trip. Grammy errors are treated as final (the message is already gone),
 * network errors keep the id for a later sweep so no permanent ghost cards.
 */
import { GrammyError } from "grammy";
import { serializePerKey } from "./serialize-per-key.js";

export interface ChatOps {
  sendText(chatId: number, text: string, options?: Record<string, unknown>): Promise<number | undefined>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  editText(chatId: number, messageId: number, text: string, options?: Record<string, unknown>): Promise<boolean>;
}

export class Ephemeral {
  private readonly ids = new Map<number, Set<number>>();
  private readonly last = new Map<number, number>();
  private readonly locks = new Map<number, Promise<unknown>>();

  remember(chatId: number, messageId: number | undefined): void {
    if (messageId === undefined) return;
    let set = this.ids.get(chatId);
    if (!set) this.ids.set(chatId, (set = new Set()));
    set.add(messageId);
    this.last.set(chatId, messageId);
  }

  private serialize<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
    return serializePerKey(this.locks, chatId, fn);
  }

  /** Delete every tracked surface for a chat (best effort). */
  clear(chatId: number, ops: ChatOps): Promise<void> {
    return this.serialize(chatId, async () => {
      const set = this.ids.get(chatId);
      if (!set || set.size === 0) return;
      const keep = new Set<number>();
      await Promise.all(
        [...set].map(async (id) => {
          try {
            await ops.deleteMessage(chatId, id);
          } catch (err) {
            if (!(err instanceof GrammyError)) keep.add(id);
          }
        }),
      );
      const lastId = this.last.get(chatId);
      if (lastId !== undefined && !keep.has(lastId)) {
        this.last.delete(chatId);
      }
      if (keep.size > 0) this.ids.set(chatId, keep);
      else this.ids.delete(chatId);
    });
  }

  /** Open a fresh surface: remove the previous one first. */
  open(chatId: number, ops: ChatOps): Promise<void> {
    return this.clear(chatId, ops);
  }

  /** Send a tracked surface message. */
  reply(chatId: number, ops: ChatOps, text: string, options?: Record<string, unknown>): Promise<number | undefined> {
    return this.serialize(chatId, async () => {
      try {
        const id = await ops.sendText(chatId, text, options);
        this.remember(chatId, id);
        return id;
      } catch {
        return undefined;
      }
    });
  }

  /** Update the current card in place (instant) when possible; otherwise
   * fall back to a fresh send. Navigation never deletes before sending.
   * There is deliberately NO text/markup no-op early return: `last` may
   * point at a message deleted outside this cache, and treating the tap as
   * a no-op left the button feeling completely dead. Every tap goes through
   * editText: alive + identical → Telegram's "message is not modified" is
   * swallowed as success (transport); deleted → edit fails → state clears
   * and the card is re-sent fresh. */
  replace(chatId: number, ops: ChatOps, text: string, options?: Record<string, unknown>): Promise<number | undefined> {
    return this.serialize(chatId, async () => {
      const current = this.last.get(chatId);
      if (current !== undefined) {
        const edited = await ops.editText(chatId, current, text, options).catch(() => false);
        if (edited) {
          return current;
        }
        this.last.delete(chatId);
      }
      const id = await ops.sendText(chatId, text, options);
      this.remember(chatId, id);
      return id;
    });
  }

  /** Remove one tracked message. */
  async drop(chatId: number, messageId: number, ops: ChatOps): Promise<void> {
    await this.serialize(chatId, async () => {
      try {
        await ops.deleteMessage(chatId, messageId);
      } catch {
        /* already gone */
      }
      const set = this.ids.get(chatId);
      if (set) {
        if (this.last.get(chatId) === messageId) {
          this.last.delete(chatId);
        }
        set.delete(messageId);
        if (set.size === 0) this.ids.delete(chatId);
      }
    });
  }

  /** Drop all in-memory tracking on plugin teardown (hot unplug / HMR). */
  reset(): void {
    this.ids.clear();
    this.last.clear();
    this.locks.clear();
  }
}
