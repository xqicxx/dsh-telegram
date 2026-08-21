/**
 * Extension contract for dsh-telegram: the core is ONLY a Telegram bridge
 * (transport + router + session binding + registry). Every domain feature —
 * cards, callbacks, commands, bar buttons, menu rows, inline flows — is an
 * extension implementing TelegramExtension and registering through
 * registerExtension(). Core stays domain-free.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import type { MenuItem } from "../telegram/keyboard.js";

/** Everything an extension may touch on the host bridge. */
export interface ExtensionHost {
  /** Show/replace one card message (inline keyboard optional). */
  openCard(chatId: number, text: string, keyboard?: unknown): Promise<void>;
  /** Send one plain message to a chat. */
  send(chatId: number, text: string, options?: Record<string, unknown>): Promise<number | undefined>;
  /** Mint a callback token carrying a payload (callback_data ≤ 64 bytes). */
  token(payload: Record<string, string>): string;
  /** The bridge-bound live agent, if any. */
  currentAgent(): Agent | undefined;
  /** The attached dsh context (throws before apply). */
  requireCtx(): Context;
  /** Path of the active project directory. */
  workspaceRoot(): string;
  /** Read one config leaf by dot path (e.g. "reasoning.effort"). */
  getConfigPath(path: string): unknown;
  /** Hot-apply + persist a config patch (returns applied section names). */
  applyConfig(patch: Record<string, unknown>): string[];
  /** Whether the live reasoning/tool draft is enabled (`outbound.liveFeed`). */
  liveFeedEnabled(): boolean;
  /** Refresh open status panels / menu heads after state changes. */
  refreshAllPanels(): void;
  /** Edit one message in place (streaming drafts). */
  editMessage(chatId: number, messageId: number, text: string, options?: Record<string, unknown>): Promise<boolean>;
  /** Delete one message. */
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  /** Current agent stats (turn/step/tool/token figures) for draft finalization. */
  statusStats(): unknown;
  /** The bridge-bound agent id, if any (official session/event stream filter). */
  currentAgentId(): string | undefined;
  /** The chat currently bound to the live agent (streaming target). */
  currentChatId(): number | undefined;
  /** Agent id owned by a specific Telegram chat. */
  agentIdForChat(chatId: number): string | undefined;
  /** Chat that owns an agent id, for event routing across concurrent chats. */
  chatIdForAgent(agentId: string): number | undefined;
  /** Bind/clear the agent owned by a specific Telegram chat. */
  bindAgent(chatId: number, agentId: string | undefined): void;
  /** Clear a chat binding (e.g. after its session is stopped/closed). */
  unbindChat(chatId: number): void;
  /** Stream-renderer plugins claim assistant text blocks: the core forwards
   * each `assistant/message` text block here instead of the chat, and stops
   * marking the inbound as answered. Passing `undefined` restores the
   * built-in immediate forwarding (no plugin = no behavior change). */
  setAssistantConsumer(consumer: ((chatId: number, text: string, assistantMessageId?: string) => void) | undefined): void;
  /** Attach 👍/👎/list buttons to a delivered assistant reply. */
  attachFeedback(chatId: number, telegramMessageId: number, sessionId: string, assistantMessageId: string): void;
  /** Whether a chat (default: most recent) still has an unanswered inbound. */
  pendingInbound(chatId?: number): boolean;
  /** Telegram message_id of the unanswered inbound, for a native reply. */
  inboundMessageId(chatId?: number): number | undefined;
  /** Mark a chat's inbound as answered (suppresses the core turn/end
   * reminder when a renderer plugin owns final delivery). */
  markInboundReplied(chatId?: number): void;
  /** Hard-stop every background live-feed loop (heartbeat/retry timers) for
   * one chat. Assigned by the streaming renderer on mount; the core calls it
   * when the user Aborts so no timer can outlive the turn (#48). */
  stopLiveFeed?(chatId: number): void;
  /** Current goal for a chat, if any (goal-aware streaming titles). */
  goalForChat?(chatId: number): { objective: string } | undefined;
}

/** One card/reasoning domain mounted on the bridge. */
export interface TelegramExtension {
  name: string;
  /** Rows appended to the paginated core menu (menu page is chosen by core). */
  menuItems?: (host: ExtensionHost) => MenuItem[];
  /** Exact callback keys ("m:reasoning") or token actions ("reasoning-select"). */
  callbacks?: Record<string, (chatId: number, payload: Record<string, string>, host: ExtensionHost) => void | Promise<void>>;
  /** Slash commands ("reasoning" → /reasoning). */
  commands?: Record<string, (chatId: number, args: string, host: ExtensionHost) => void | Promise<void>>;
  /** Persistent reply-keyboard bar buttons (canonical label → handler). */
  barButtons?: Record<string, (chatId: number, host: ExtensionHost) => void | Promise<void>>;
  /** Inline text-input flows: return true when the text was consumed. */
  onUserText?: (chatId: number, text: string, host: ExtensionHost) => boolean;
  /** Teardown (called on hot unplug / disable). */
  detach?: () => void;
}

/** Cordis service injection typing: loader-mounted extension plugins declare
 * `export const inject = ["telegram"]` and read the provided bridge host from
 * `ctx.telegram` (the canonical dependency mechanism — `ctx.get()` only sees
 * services whose providing fiber is actively running). */
declare module "@deepseek-ai/cordis" {
  interface Context {
    telegram: ExtensionHost | undefined;
  }
}
