/**
 * Card lifecycle plumbing for dsh-telegram.
 *
 * One registry per mount: `openCard` replaces the chat's transient card in
 * place through the Ephemeral lane and remembers per-chat refresh renderers
 * so web-side events can re-read open cards; `cardLoad` bounds every card
 * data load with a visible-failure timeout (issue #20/#2); `askConfirm`
 * layers the destructive-action confirmation keyboard on top of `openCard`;
 * `widenCard` pads a card to full bubble width.
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * (transport access, UI seams) arrive through one deps object; the renderer
 * map is created here and returned so index.ts teardown keeps clearing it.
 */
import { buildConfirmKeyboard } from "../telegram/keyboard.js";
import { plain, truncate } from "../telegram/html.js";
import { Ephemeral, type ChatOps } from "../telegram/ephemeral.js";
import type { TelegramTransport } from "../telegram/transport.js";

/** Race one promise against a deadline so a hung callee fails its caller. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Telegram sizes the bubble (and its inline keyboard) to the widest text
 * line. A trailing line of non-breaking spaces forces the card to span the
 * maximum bubble width so keyboard rows never leave a right-hand gap. */
export function widenCard(text: string): string {
  return `${text}\n${"\u00A0".repeat(80)}`;
}

/** Shared card-opener / card-loader signatures consumed by the cards/* domain
 * modules, so every deps interface describes them identically. */
export type OpenCard = (chatId: number, text: string, keyboard: unknown, refresh?: () => Promise<void>) => Promise<void>;
export type CardLoad = <T>(chatId: number, label: string, load: () => Promise<T>) => Promise<T | undefined>;

export interface CardRegistryDeps {
  requireTransport(): TelegramTransport;
  uiOps(t: TelegramTransport): ChatOps;
  ephemeral: Ephemeral;
  token(payload: Record<string, string>): string;
  log(message: string, error?: unknown): void;
  uiSend(chatId: number, text: string, options?: Parameters<TelegramTransport["sendText"]>[2]): Promise<number | undefined>;
}

/** Build the card registry. Called once by index.ts; the returned functions
 * close over the shared deps like the previous module-scope closures did over
 * index.ts singletons. */
export function createCardRegistry(deps: CardRegistryDeps): {
  activeCardRenderers: Map<number, () => Promise<void>>;
  openCard: OpenCard;
  refreshActiveCards(): void;
  askConfirm(chatId: number, text: string, confirmPayload: Record<string, string>, cancelPayload: Record<string, string>): Promise<void>;
  cardLoad: CardLoad;
} {
  const { requireTransport, uiOps, ephemeral, token, log, uiSend } = deps;

  /** Card data-loading deadline (issue #20/#2): a hung service must fail the
   * card with a visible message instead of wedging the chat's UI lane forever. */
  const CARD_LOAD_TIMEOUT_MS = 10_000;

  /** One shared underlying load per chat+label: after a caller's visible
   * deadline fires, the real loader keeps running — a retry used to start a
   * SECOND copy of the same work while the first finished unseen. Callers now
   * join the single in-flight promise (each with their own deadline), and a
   * late settlement after every caller timed out merely clears the entry. */
  const inFlightCardLoads = new Map<string, Promise<unknown>>();

  async function cardLoad<T>(chatId: number, label: string, load: () => Promise<T>): Promise<T | undefined> {
    const key = `${chatId}\u0000${label}`;
    let underlying = inFlightCardLoads.get(key);
    if (underlying === undefined) {
      underlying = Promise.resolve().then(load);
      inFlightCardLoads.set(key, underlying);
      // Forget the entry once it settles; both callbacks subscribe to the
      // rejection, so a loser that finishes after all callers timed out is
      // observed and dropped instead of surfacing as an unhandled rejection.
      const settled = underlying;
      void settled.then(
        () => {
          if (inFlightCardLoads.get(key) === settled) inFlightCardLoads.delete(key);
        },
        () => {
          if (inFlightCardLoads.get(key) === settled) inFlightCardLoads.delete(key);
        },
      );
    }
    try {
      return await withTimeout(underlying as Promise<T>, CARD_LOAD_TIMEOUT_MS, label);
    } catch (err) {
      log(`${label} load failed`, err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
      await uiSend(chatId, `\u274C ${label} \u52A0\u8F7D\u5931\u8D25\uFF1A${plain(truncate(err instanceof Error ? err.message : String(err), 120))}`, { parse_mode: "HTML" });
      return undefined;
    }
  }

  /** Cards that should re-read their data source when web-side settings/plugin
   * events fire (presets, workspaces, sessions). Keyed by chat. */
  const activeCardRenderers = new Map<number, () => Promise<void>>();

  async function openCard(chatId: number, text: string, keyboard: unknown, refresh?: () => Promise<void>): Promise<void> {
    const t = requireTransport();
    if (refresh === undefined) activeCardRenderers.delete(chatId);
    else activeCardRenderers.set(chatId, refresh);
    await ephemeral.replace(chatId, uiOps(t), text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }

  function refreshActiveCards(): void {
    for (const render of activeCardRenderers.values()) {
      void render().catch((err) => log("active card refresh failed", err));
    }
  }

  /** Replace the current card with a destructive-action confirmation. */
  async function askConfirm(chatId: number, text: string, confirmPayload: Record<string, string>, cancelPayload: Record<string, string>): Promise<void> {
    await openCard(chatId, text, buildConfirmKeyboard({
      confirm: token(confirmPayload),
      cancel: token(cancelPayload),
    }));
  }

  return { activeCardRenderers, openCard, refreshActiveCards, askConfirm, cardLoad };
}
