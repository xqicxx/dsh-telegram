/**
 * The harness<->telegram coupling point:
 * inbound text -> per-chat agent inbox, session events -> that chat.
 *
 * Each Telegram chat owns one dsh agent binding. Inbound text from chat N
 * goes to chat N's agent, and session events are routed back to chat N by
 * looking up the agent id — chats never share turns or steal each other's
 * final replies. The legacy single-chat fields (`currentAgentId`,
 * `activeChat`, `inbound`) are maintained as the "most recently touched"
 * view for plugins and callers that only need one active conversation.
 */
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { resolveInboundMode, type TelegramConfig } from "../config.js";
import { isReasoningEffort, reasoningDirective } from "../reasoning.js";
import { noteToolCall } from "./adapters/status.js";
import { markdownToHtml } from "../telegram/markdown.js";
import type { TelegramTransport } from "../telegram/transport.js";

/** Prepend the configured reasoning directive (codex-telegram-bot semantics). */
function withReasoningDirective(config: TelegramConfig, text: string): string {
  const effort = config.reasoning?.effort;
  if (effort === undefined || !isReasoningEffort(effort)) return text;
  const directive = reasoningDirective(effort);
  if (directive === "") return text;
  return `${directive}\n\n${text}`;
}

/** The OpenAI SDK's no-body fallback literal (`"429 status code (no body)"`)
 * carries no information beyond its status; showing it verbatim reads as an
 * opaque crash (issue #37). */
const OPAQUE_STATUS_LITERAL = /^\d{3} status code \(no body\)$/;

/** User-facing rendering of one turn failure (issue #37): classify the tone
 * instead of forwarding the provider literal - a 429 is transient (the user
 * should wait), a 5xx is provider-side breakage, anything else stays verbatim.
 * Returns Telegram HTML. */
export function formatTurnFailure(failure: string): string {
  const raw = failure.trim();
  if (raw === "") return "";
  const detail = OPAQUE_STATUS_LITERAL.test(raw)
    ? ""
    : ` \u00B7 ${markdownToHtml(raw.slice(0, 400))}`;
  const rateLimited =
    /\b429\b/.test(raw) ||
    /\bRATE_LIMIT\b/.test(raw) ||
    /rate[ -]?limit/i.test(raw) ||
    /too many requests/i.test(raw) ||
    /\bquota\b/i.test(raw);
  if (rateLimited) {
    return `\u23F3 Rate limited by the upstream provider - wait a moment and try again.${detail}`;
  }
  const serverError =
    /\b5\d\d\b/.test(raw) ||
    /\bSERVER\b/.test(raw) ||
    /internal server error|service unavailable|bad gateway|gateway timeout|server error/i.test(raw);
  if (serverError) {
    return `\u26A0\uFE0F Upstream provider error - the provider may be temporarily unavailable, try again shortly.${detail}`;
  }
  return `\u274C ${markdownToHtml(raw.slice(0, 900))}`;
}

export interface BridgeOptions {
  ctx: Context;
  transport: TelegramTransport;
  getConfig: () => TelegramConfig;
  onStateChange: () => void;
  /** Turn lifecycle for chat indicators: running=true on turn/start, false on turn/end. */
  onTurnRunning?: (chatId: number, running: boolean) => void;
  /** Called after a final assistant text message landed, so the host can add
   * feedback buttons without the bridge knowing any Telegram keyboard UI. */
  onAssistantDelivered?: (chatId: number, telegramMessageId: number, sessionId: string, assistantMessageId: string) => void;
  log: (message: string, error?: unknown) => void;
}

interface Inbound {
  chatId: number;
  text: string;
  /** Telegram message_id of the user message; final replies quote it. */
  messageId?: number;
  replied: boolean;
  noReply: boolean;
}

interface ChatState {
  agentId: ReturnType<typeof SessionId>;
  inbound?: Inbound;
  reminded: boolean;
}

export class Bridge {
  private readonly ctx: Context;
  private readonly transport: TelegramTransport;
  private readonly getConfig: () => TelegramConfig;
  private readonly onStateChange: () => void;
  private readonly onTurnRunning: ((chatId: number, running: boolean) => void) | undefined;
  private readonly onAssistantDelivered: ((chatId: number, telegramMessageId: number, sessionId: string, assistantMessageId: string) => void) | undefined;
  private readonly log: (message: string, error?: unknown) => void;
  private readonly disposers: (() => void)[] = [];
  private readonly chatStates = new Map<number, ChatState>();
  /** Dropped-event diagnostics: one line per unbound agent, plus every
   * turn/end so a missing final delivery is visible in the log. */
  private readonly droppedEvents = new Map<string, { count: number; lastType?: string }>();

  /** Most recently touched chat/agent — compatibility view, not the routing
   * source of truth. Session events are routed through `chatStates`. */
  private currentAgentId: ReturnType<typeof SessionId> | undefined;
  private activeChat: number | undefined;
  private inbound: Inbound | undefined;
  private assistantConsumer: ((chatId: number, text: string, assistantMessageId?: string) => void) | undefined;
  private reminded = false;

  /** Active chat id for stream plugins (official session/event consumers). */
  activeChatValue(): number | undefined {
    return this.activeChat;
  }

  constructor(options: BridgeOptions) {
    this.ctx = options.ctx;
    this.transport = options.transport;
    this.getConfig = options.getConfig;
    this.onStateChange = options.onStateChange;
    this.onTurnRunning = options.onTurnRunning;
    this.onAssistantDelivered = options.onAssistantDelivered;
    this.log = options.log;
  }

  /** Resolve the agent for a chat. A bound chat always wins; when that bound
   * agent is no longer live we return undefined so its chat can create a new
   * session instead of accidentally borrowing another chat's live agent.
   * Callers with no chat keep the legacy first-live-agent fallback. */
  private resolveAgent(chatId?: number) {
    if (chatId !== undefined) {
      const boundId = this.chatStates.get(chatId)?.agentId;
      if (boundId !== undefined) {
        const bound = this.ctx.agents?.get(boundId);
        return bound;
      }
    }
    if (this.currentAgentId !== undefined) {
      const bound = this.ctx.agents?.get(this.currentAgentId);
      if (bound) return bound;
    }
    return this.ctx.agents?.list()[0];
  }

  private touch(chatId: number, agentId: ReturnType<typeof SessionId>): ChatState {
    const existing = this.chatStates.get(chatId) ?? { agentId, reminded: false };
    existing.agentId = agentId;
    this.chatStates.set(chatId, existing);
    this.currentAgentId = agentId;
    this.activeChat = chatId;
    return existing;
  }

  private notifyStateChange(): void {
    try {
      this.onStateChange();
    } catch (err) {
      // A throwing panel refresh must never escape a cordis event listener.
      this.log(
        "state change handler failed",
        err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
      );
    }
  }

  /** Bind (or clear) the agent owned by one Telegram chat. */
  bindAgent(chatId: number, agentId: string | undefined): void {
    if (agentId === undefined) {
      this.chatStates.delete(chatId);
      if (this.activeChat === chatId) {
        this.currentAgentId = undefined;
        this.activeChat = undefined;
        this.inbound = undefined;
        this.reminded = false;
      }
    } else {
      const id = SessionId(agentId);
      const previous = this.chatStates.get(chatId);
      if (previous !== undefined && String(previous.agentId) !== String(id)) {
        // Rebinding this chat to a new session must not inherit the old
        // session's unanswered inbound (its reply-quote and turn/end state).
        previous.inbound = undefined;
        previous.reminded = false;
        if (this.activeChat === chatId) this.inbound = undefined;
      }
      // One agent belongs to one chat: if another chat already owns it, clear
      // that old binding so event routing can never become ambiguous.
      for (const [existingChat, state] of [...this.chatStates]) {
        if (existingChat !== chatId && String(state.agentId) === String(id)) {
          this.chatStates.delete(existingChat);
          if (this.activeChat === existingChat) {
            this.activeChat = undefined;
            this.inbound = undefined;
            this.reminded = false;
          }
        }
      }
      this.touch(chatId, id);
    }
    this.notifyStateChange();
  }

  /** Legacy single-binding setter; when a chat is active it updates that
   * chat's binding as well. */
  setCurrentAgent(agentId: string | undefined): void {
    if (this.activeChat !== undefined) {
      this.bindAgent(this.activeChat, agentId);
      return;
    }
    this.currentAgentId = agentId === undefined ? undefined : SessionId(agentId);
    this.notifyStateChange();
  }

  currentAgentIdValue(): string | undefined {
    return this.currentAgentId;
  }

  agentIdForChat(chatId: number): string | undefined {
    const agentId = this.chatStates.get(chatId)?.agentId;
    return agentId === undefined ? undefined : String(agentId);
  }

  chatIdForAgent(agentId: string): number | undefined {
    for (const [chatId, state] of this.chatStates) {
      if (String(state.agentId) === agentId) return chatId;
    }
    if (this.activeChat !== undefined && this.currentAgentId !== undefined && String(this.currentAgentId) === agentId) {
      return this.activeChat;
    }
    return undefined;
  }

  private inboundFor(chatId: number): Inbound | undefined {
    return this.chatStates.get(chatId)?.inbound ?? (this.activeChat === chatId ? this.inbound : undefined);
  }

  /** Pending inbound owned by the agent that is about to call `telegram_reply`.
   * Tool calls know their caller agent; routing through that id keeps chat A's
   * reply out of chat B even when B was the most recently touched chat. */
  inboundForAgent(agentId: string): Inbound | undefined {
    const chatId = this.chatIdForAgent(agentId);
    if (chatId !== undefined) return this.inboundFor(chatId);
    return this.inbound;
  }

  private syncLegacy(chatId: number, state: ChatState, inbound?: Inbound): void {
    this.currentAgentId = state.agentId;
    this.activeChat = chatId;
    this.inbound = inbound ?? state.inbound;
    this.reminded = state.reminded;
  }

  /** Route one inbound user text into that chat's agent inbox. */
  deliver(chatId: number, text: string, messageId?: number): { ok: boolean; text: string } {
    const agent = this.resolveAgent(chatId);
    if (!agent) return { ok: false, text: "No live agent in this session." };
    const config = this.getConfig();
    const mode = resolveInboundMode(config, chatId, text);
    if (mode === "muted") return { ok: true, text: "Muted \u2014 message ignored." };

    const message = createUserMessage({
      content: [{ type: "text", text: withReasoningDirective(config, text) }],
      source: { kind: "user" },
    });
    // Bind the chat to this agent and install the inbound BEFORE the agent
    // can emit anything: a synchronous turn/start or assistant/message must
    // already know its chat and quote target, never be dropped as "no chat".
    const state = this.touch(chatId, agent.id);
    const inbound = { chatId, text, messageId, replied: false, noReply: false };
    state.inbound = inbound;
    state.reminded = false;
    this.syncLegacy(chatId, state, inbound);
    if (mode === "queue-only") {
      agent.send(message, "next-turn", false);
    } else {
      agent.followup(message);
    }
    return { ok: true, text: mode === "queue-only" ? "Queued." : "Delivered." };
  }

  /** Deliver a media-group batch as ONE inbound turn (issue #9). */
  deliverImages(chatId: number, attachments: readonly { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }[], caption?: string, messageId?: number): { ok: boolean; text: string } {
    if (attachments.length === 1) return this.deliverImage(chatId, attachments[0]!, caption, messageId);
    return this.deliverImageContent(chatId, caption, messageId, attachments.map((attachment) => ({ type: "image", attachment })));
  }

  /** Deliver one promoted image as the inbound turn (session.attachment path). */
  deliverImage(chatId: number, attachment: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }, caption?: string, messageId?: number): { ok: boolean; text: string } {
    return this.deliverImageContent(chatId, caption, messageId, [{ type: "image", attachment }]);
  }

  private deliverImageContent(chatId: number, caption: string | undefined, messageId: number | undefined, imageBlocks: unknown[]): { ok: boolean; text: string } {
    const agent = this.resolveAgent(chatId);
    if (!agent) return { ok: false, text: "No live agent in this session." };
    const config = this.getConfig();
    const mode = resolveInboundMode(config, chatId, caption ?? "");
    if (mode === "muted") return { ok: true, text: "Muted \u2014 message ignored." };
    const content: unknown[] = [];
    if (caption && caption.trim()) content.push({ type: "text", text: withReasoningDirective(config, caption.trim()) });
    content.push(...imageBlocks);
    const message = createUserMessage({ content: content as never, source: { kind: "user" } });
    const target = agent as unknown as { send(message: unknown, target: string, wakeup: boolean): void; followup(message: unknown): void };
    // Same ordering contract as deliver(): the binding and inbound quote must
    // exist before the agent can emit a session event synchronously.
    const state = this.touch(chatId, agent.id);
    const inbound = { chatId, text: caption || `[${imageBlocks.length} image${imageBlocks.length === 1 ? "" : "s"}]`, messageId, replied: false, noReply: false };
    state.inbound = inbound;
    state.reminded = false;
    this.syncLegacy(chatId, state, inbound);
    if (mode === "queue-only") target.send(message, "next-turn", false);
    else target.followup(message);
    return { ok: true, text: mode === "queue-only" ? "Image queued." : "Image delivered." };
  }

  /** Bot-API send options that quote the current inbound message when it
   * belongs to `chatId` (Telegram's native reply affordance). */
  private replyParametersFor(chatId: number): Record<string, unknown> {
    const inbound = this.inboundFor(chatId);
    if (inbound?.messageId !== undefined) {
      return { reply_parameters: { message_id: inbound.messageId } };
    }
    return {};
  }

  /** telegram_reply / telegram_send entry point. */
  async sendOutbound(
    chatId: number,
    text: string,
    options?: { replyToInbound?: boolean; parseMode?: "HTML"; disableNotification?: boolean },
  ): Promise<void> {
    const config = this.getConfig();
    const inbound = options?.replyToInbound ? this.inboundFor(chatId) : undefined;
    const extra: Record<string, unknown> = {
      parse_mode: options?.parseMode ?? config.outbound.parseMode,
      disable_notification: options?.disableNotification ?? config.outbound.disableNotification,
      ...(inbound?.messageId !== undefined
        ? { reply_parameters: { message_id: inbound.messageId } }
        : {}),
    };
    const sent = await this.transport.sendText(chatId, text, extra);
    // Only a confirmed Telegram message satisfies the inbound: a queued send
    // that ultimately fails must leave the turn open for the error/reminder.
    if (inbound && !inbound.replied && sent !== undefined) {
      inbound.replied = true;
    }
  }

  /** Telegram message id of the pending inbound for a chat. */
  inboundMessageIdValue(chatId?: number): number | undefined {
    const target = chatId ?? this.activeChat;
    if (target === undefined) return this.inbound?.messageId;
    return this.inboundFor(target)?.messageId;
  }

  markNoReply(reason?: string, chatId?: number): { ok: boolean; text: string } {
    const target = chatId ?? this.activeChat;
    if (target === undefined) return { ok: false, text: "No active inbound message." };
    const state = this.chatStates.get(target);
    const inbound = this.inboundFor(target);
    if (inbound) {
      inbound.noReply = true;
    }
    if (state) state.inbound = undefined;
    if (this.activeChat === target) {
      this.inbound = undefined;
      this.reminded = false;
    }
    return { ok: true, text: reason ?? "Marked as no-reply." };
  }

  hasPendingInbound(chatId?: number): boolean {
    const target = chatId ?? this.activeChat;
    if (target === undefined) return this.inbound !== undefined && !this.inbound.replied && !this.inbound.noReply;
    const inbound = this.inboundFor(target);
    return inbound !== undefined && !inbound.replied && !inbound.noReply;
  }

  /** Live feed switch (`outbound.liveFeed`): when false, stream-renderer
   * plugins are ignored and the built-in immediate forwarding is restored
   * without unloading or re-registering the plugin. */
  private liveFeedEnabled(): boolean {
    return this.getConfig().outbound.liveFeed !== false;
  }

  /** Stream-renderer plugin seam: when a consumer is registered the core
   * forwards assistant text blocks to it instead of the chat and defers the
   * inbound-answered bookkeeping to the consumer. No consumer = the built-in
   * immediate forwarding, byte-for-byte the pre-plugin behavior. */
  setAssistantConsumer(consumer: ((chatId: number, text: string, assistantMessageId?: string) => void) | undefined): void {
    this.assistantConsumer = consumer;
  }

  /** Whether a live-feed renderer currently owns presentation (goal progress
   * cards must not duplicate openclaw's draft). */
  hasAssistantConsumer(): boolean {
    return this.assistantConsumer !== undefined && this.liveFeedEnabled();
  }

  /** Renderer plugins call this after delivering the final answer for a chat. */
  markInboundReplied(chatId?: number): void {
    const target = chatId ?? this.activeChat;
    if (target === undefined) return;
    const inbound = this.inboundFor(target);
    if (inbound) inbound.replied = true;
  }

  currentInbound(): Inbound | undefined {
    return this.inbound;
  }

  private logDroppedEvent(agentId: string, type: string | undefined): void {
    const entry = this.droppedEvents.get(agentId) ?? { count: 0, lastType: type };
    entry.count += 1;
    entry.lastType = type;
    this.droppedEvents.set(agentId, entry);
    // First occurrence always logs; afterwards only turn/end repeats so a
    // silently lost final answer stays visible without flooding the console.
    if (entry.count === 1 || type === "turn/end") {
      this.log(
        `event dropped: no chat for agent ${agentId} (${type ?? "unknown"}${entry.count > 1 ? `; ${entry.count} total dropped` : ""})`,
      );
    }
  }

  attach(): void {
    this.disposers.push(
      this.ctx.on("session/event", (session, event) => {
        // Route by the agent that produced the event: chat A's transcript can
        // never leak into chat B, even when the chats are active concurrently.
        const sessionId = String(session.id);
        const chatId = this.chatIdForAgent(sessionId);
        if (chatId === undefined) {
          // Only diagnose events that belonged to an agent Telegram itself
          // touched. Web-owned sessions are expected to be unbound and must
          // not flood the console on every browser turn.
          if (this.currentAgentId !== undefined && String(this.currentAgentId) === sessionId) {
            this.logDroppedEvent(sessionId, event.type);
          }
          return;
        }
        const state = this.chatStates.get(chatId);
        const inbound = this.inboundFor(chatId);

        if (event.type === "assistant/message") {
          const data = event.data as { message?: { id?: unknown; content?: readonly { type?: string; text?: string }[] } } | undefined;
          const message = data?.message;
          const content = Array.isArray(message?.content) ? message.content : [];
          const text = content
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("")
            .trim();
          const messageId = message?.id === undefined ? undefined : String(message.id);
          if (text) {
            // `outbound.liveFeed=false` disables stream-renderer plugins
            // dynamically: the core falls back to its legacy immediate
            // forwarding even while a consumer is registered.
            const consumer = this.liveFeedEnabled() ? this.assistantConsumer : undefined;
            if (consumer !== undefined) {
              // A stream-renderer plugin owns presentation and final delivery.
              consumer(chatId, text, messageId);
            } else {
              // A prose reply satisfies the inbound message: the turn/end
              // reminder must not fire when the agent answered normally.
              if (inbound) inbound.replied = true;
              void this.transport
                .sendText(chatId, markdownToHtml(text), {
                  parse_mode: this.getConfig().outbound.parseMode,
                  ...this.replyParametersFor(chatId),
                })
                .then((telegramMessageId) => {
                  if (telegramMessageId !== undefined && messageId !== undefined) {
                    this.onAssistantDelivered?.(chatId, telegramMessageId, String(session.id), messageId);
                  }
                })
                .catch((err) => this.log("assistant reply failed", err));
            }
          }
        }
        if (event.type === "turn/start") {
          this.onTurnRunning?.(chatId, true);
        }
        if (event.type === "turn/end") {
          this.onTurnRunning?.(chatId, false);
          // Surface LLM/infra errors verbatim instead of the generic
          // telegram_reply reminder (that reminder misled users when the
          // turn died before the model ever answered).
          const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } } | undefined)?.reason;
          const failure = reason?.kind === "error" ? reason.error?.message : undefined;
          const unanswered = inbound === undefined || (!inbound.replied && !inbound.noReply);
          if (failure !== undefined && failure.trim() !== "" && unanswered) {
            // Autonomous turns (a /goal turn, for example) have no inbound
            // message, but their LLM/infra failure still has to reach the
            // chat instead of leaving the user staring at silence. The tone
            // is classified (429 vs 5xx vs verbatim) per issue #37.
            if (inbound !== undefined) inbound.replied = true;
            if (state) state.reminded = true;
            void this.transport
              .sendText(chatId, formatTurnFailure(failure), {
                parse_mode: "HTML",
                ...this.replyParametersFor(chatId),
              })
              .catch((err) => this.log("turn error reply failed", err));
          } else if (
            (this.assistantConsumer === undefined || !this.liveFeedEnabled()) &&
            inbound !== undefined &&
            !inbound.replied &&
            !inbound.noReply &&
            state?.reminded !== true
          ) {
            // No renderer plugin is active: the built-in reminder fires as
            // before. With a consumer registered, the plugin owns the final
            // delivery (and this reminder) and marks the inbound answered.
            if (state) state.reminded = true;
            void this.transport
              .sendText(chatId, "\u231B The turn ended without a telegram_reply \u2014 use the telegram_reply tool or reply yourself.", {
                parse_mode: "HTML",
                ...this.replyParametersFor(chatId),
              })
              .catch((err) => this.log("no-reply reminder FAILED", err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)));
          }
          this.notifyStateChange();
        }
        // Live status feed: every event that changes turn/step/tool/usage
        // figures refreshes the open panels and the bar queue counter.
        if (
          event.type === "tool/call" ||
          event.type === "tool/result" ||
          event.type === "step/start" ||
          event.type === "step/end" ||
          event.type === "assistant/message" ||
          event.type === "turn/start"
        ) {
          if (event.type === "tool/call") noteToolCall(String(session.id));
          this.notifyStateChange();
        }
      }),
    );
    this.disposers.push(this.ctx.on("agent/status", () => this.notifyStateChange()));
    // LOOP_AUDIT #8: dropped-event diagnostics are bounded by session life.
    this.disposers.push(
      this.ctx.on("session/disposed", (session: { id?: unknown }) => {
        if (session?.id !== undefined) this.droppedEvents.delete(String(session.id));
      }),
    );
  }

  detach(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.chatStates.clear();
    this.droppedEvents.clear();
    this.inbound = undefined;
    this.currentAgentId = undefined;
    this.activeChat = undefined;
    this.reminded = false;
  }
}
