/**
 * Inbound routing, per chat:
 *   slash command  -> onCommand   (whitelist-checked)
 *   bar button     -> onBarButton (whitelist-checked)
 *   inline callback-> onCallback  (whitelist-checked)
 *   other text     -> onUserText  (whitelist-checked, feeds the agent inbox)
 */
import { normalizeBarLabel } from "./keyboard.js";
import { serializePerKey } from "./serialize-per-key.js";
import type { TelegramTransport } from "./transport.js";

export interface RouterDeps {
  transport: TelegramTransport;
  isAllowed: (chatId: number) => boolean;
  onCommand: (chatId: number, command: string, args: string, messageId?: number) => void | Promise<void>;
  onBarButton: (chatId: number, label: string, messageId?: number) => void | Promise<void>;
  onCallback: (chatId: number, data: string) => void | Promise<void>;
  onUserText: (chatId: number, text: string, messageId?: number) => void | Promise<void>;
  onPhoto: (chatId: number, fileId: string, caption: string, messageId?: number) => void | Promise<void>;
  onPhotos: (chatId: number, photos: readonly { fileId: string; caption: string; messageId?: number }[], groupId?: string) => void | Promise<void>;
  onDocument: (chatId: number, kind: "document" | "voice" | "video", fileId: string, name: string, mimeType: string, messageId?: number) => void | Promise<void>;
  onUnauthorized: (chatId: number, reason?: string) => void | Promise<void>;
}

/** `/cmd` — plus the group-chat `/cmd@BotName` form, whose bot-name suffix is
 * accepted and excluded from the captured command (audit RE-12: `/status@MyBot`
 * used to miss the regex entirely and fall into the agent inbox). */
const COMMAND_RE = /^\/([a-zA-Z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/;

/** Two FIFO lanes per chat:
 * - `user`: real inbound content (text/photos/documents). These MUST stay in
 *   arrival order — two rapid first messages can never create two sessions.
 * - `ui`: bar buttons and inline callbacks. They run immediately instead of
 *   waiting behind an inbound turn, so "collapse bar" and card navigation
 *   stay responsive while the agent is working.
 * Lanes are per chat; different chats still proceed in parallel. */
const userChains = new Map<number, Promise<unknown>>();
const uiChains = new Map<number, Promise<unknown>>();

function enqueue(chains: Map<number, Promise<unknown>>, chatId: number, task: () => unknown | Promise<unknown>): Promise<void> {
  // Shared per-key serialization (audit R3-2): the task runs once the
  // previous one settles (either way), a rejected task never poisons the
  // lane, and the map entry is swept when it is still the tail.
  return serializePerKey(chains, chatId, task).then(() => {});
}

export function attachRouter(deps: RouterDeps): void {
  deps.transport.setHandlers({
    onText: (chatId, text, messageId) => {
      const match = COMMAND_RE.exec(text.trim());
      const barLabel = normalizeBarLabel(text);
      // Bar buttons are control input, not chat content: route them through
      // the responsive UI lane. Slash commands and ordinary text keep the
      // user lane (pending-input flows must be ordered with the text that
      // follows them).
      if (barLabel !== undefined) {
        return enqueue(uiChains, chatId, async () => {
          if (!deps.isAllowed(chatId)) return deps.onUnauthorized(chatId, undefined);
          return deps.onBarButton(chatId, barLabel, messageId);
        });
      }
      return enqueue(userChains, chatId, async () => {
        if (!deps.isAllowed(chatId)) return deps.onUnauthorized(chatId, match ? `command:${match[1]}` : undefined);
        if (match) return deps.onCommand(chatId, match[1]!, (match[2] ?? "").trim(), messageId);
        return deps.onUserText(chatId, text, messageId);
      });
    },
    onPhoto: (chatId, fileId, caption, messageId) =>
      enqueue(userChains, chatId, async () => {
        if (!deps.isAllowed(chatId)) return deps.onUnauthorized(chatId);
        return deps.onPhoto(chatId, fileId, caption, messageId);
      }),
    onPhotos: (chatId, photos, groupId) =>
      enqueue(userChains, chatId, async () => {
        if (!deps.isAllowed(chatId)) return deps.onUnauthorized(chatId);
        return deps.onPhotos(chatId, photos, groupId);
      }),
    onDocument: (chatId, kind, fileId, name, mimeType, messageId) =>
      enqueue(userChains, chatId, async () => {
        if (!deps.isAllowed(chatId)) return deps.onUnauthorized(chatId);
        return deps.onDocument(chatId, kind, fileId, name, mimeType, messageId);
      }),
    onCallback: (chatId, data) =>
      enqueue(uiChains, chatId, async () => {
        if (!deps.isAllowed(chatId) && data !== "m:allowthis") return;
        return deps.onCallback(chatId, data);
      }),
  });
}
