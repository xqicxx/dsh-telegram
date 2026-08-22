/**
 * One live status card per chat, updated in place via editMessageText so
 * frequent refreshes never spam the conversation. Identical content is
 * skipped entirely; a deleted message falls back to a fresh send.
 */
import { ChatOps } from "./ephemeral.js";
import { serializePerKey } from "./serialize-per-key.js";

export interface PanelOps extends ChatOps {
  editText(chatId: number, messageId: number, text: string, options?: Record<string, unknown>): Promise<boolean>;
}

interface Panel {
  messageId?: number;
  text?: string;
}

export class StatusPanel {
  private readonly panels = new Map<number, Panel>();
  private readonly locks = new Map<number, Promise<unknown>>();

  private serialize<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
    return serializePerKey(this.locks, chatId, fn);
  }

  /** Create the card on demand (Status button / command) or update it in
   * place when one already exists (live event feed). */
  refresh(chatId: number, ops: PanelOps, text: string, createIfMissing = false): Promise<void> {
    return this.serialize(chatId, async () => {
      const panel = this.panels.get(chatId);
      if (panel === undefined && !createIfMissing) return;
      if (panel?.text === text) return;
      if (panel?.messageId !== undefined) {
        const edited = await ops.editText(chatId, panel.messageId, text).catch(() => false);
        if (edited) {
          panel.text = text;
          return;
        }
        // The edit failed (the card message was deleted by hand, the chat was
        // cleared, ...): the stored id is dead and must not be retried — drop
        // the entry so live refreshes stop hammering it until the user asks
        // for the panel again (audit RE-8; mirrors Ephemeral.replace's
        // edit-failure self-healing).
        this.panels.delete(chatId);
      }
      if (!createIfMissing) return;
      const id = await ops.sendText(chatId, text).catch(() => undefined);
      if (id === undefined) return;
      this.panels.set(chatId, { messageId: id, text });
    });
  }

  /** Drop all in-memory panels on plugin teardown (hot unplug / HMR). */
  reset(): void {
    this.panels.clear();
    this.locks.clear();
  }
}
