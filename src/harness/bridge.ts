/**
 * The harness<->telegram coupling point:
 * inbound text -> per-chat agent inbox, session events -> that chat.
 *
 * Each Telegram chat owns one dsh agent binding. Inbound text from chat N
 * goes to chat N's agent, and session events are routed back to chat N by
 * looking up the agent id — chats never share turns or steal each other's
 * final replies. `chatStates` plus the `chatByAgent` reverse index are the
 * single source of truth; a `lastTouch` pointer derives the "most recently
 * touched" compatibility view for plugins and callers that only need one
 * active conversation.
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
  /** Reverse index: agent id -> owning chat. Maintained in lockstep with
   * `chatStates` by every mutation point (touch/bindAgent/detach); one agent
   * maps to at most one chat, so `chatIdForAgent` stays O(1) on the hot
   * session/event path. */
  private readonly chatByAgent = new Map<string, number>();
  /** Dropped-event diagnostics: one line per unbound agent, plus every
   * turn/end so a missing final delivery is visible in the log. */
  private readonly droppedEvents = new Map<string, { count: number; lastType?: string }>();

  /** Most recently touched chat/agent — compatibility view, not the routing
   * source of truth. Session events are routed through `chatStates`.
   * `setCurrentAgent` without an active chat keeps just the agent half. */
  private lastTouch: { chatId?: number; agentId: ReturnType<typeof SessionId> } | undefined;
  private assistantConsumer: ((chatId: number, text: string, assistantMessageId?: string) => void) | undefined;

  /** Active chat id for stream plugins (official session/event consumers). */
  activeChatValue(): number | undefined {
    return this.lastTouch?.chatId;
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
    const touched = this.lastTouch?.agentId;
    if (touched !== undefined) {
      const bound = this.ctx.agents?.get(touched);
      if (bound) return bound;
    }
    return this.ctx.agents?.list()[0];
  }

  private touch(chatId: number, agentId: ReturnType<typeof SessionId>): ChatState {
    // One agent belongs to one chat: if another chat already owns this
    // agent, drop that stale binding so the reverse index stays exclusive
    // and event routing can never become ambiguous.
    const owner = this.chatByAgent.get(String(agentId));
    if (owner !== undefined && owner !== chatId) {
      // Audit RE-10: eviction must not silently swallow the old owner chat's
      // unanswered inbound. Marking it noReply keeps every reminder path from
      // firing at that chat for a conversation that just moved elsewhere; the
      // pending state is then dropped together with the evicted entry.
      const evictedInbound = this.chatStates.get(owner)?.inbound;
      if (evictedInbound !== undefined && !evictedInbound.replied && !evictedInbound.noReply) {
        evictedInbound.noReply = true;
      }
      this.chatStates.delete(owner);
    }
    const existing = this.chatStates.get(chatId) ?? { agentId, reminded: false };
    const previousId = String(existing.agentId);
    if (previousId !== String(agentId)) this.chatByAgent.delete(previousId);
    existing.agentId = agentId;
    this.chatStates.set(chatId, existing);
    this.chatByAgent.set(String(agentId), chatId);
    this.lastTouch = { chatId, agentId };
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
      const previous = this.chatStates.get(chatId);
      this.chatStates.delete(chatId);
      if (previous !== undefined && this.chatByAgent.get(String(previous.agentId)) === chatId) {
        this.chatByAgent.delete(String(previous.agentId));
      }
      if (this.lastTouch?.chatId === chatId) this.lastTouch = undefined;
    } else {
      const id = SessionId(agentId);
      const previous = this.chatStates.get(chatId);
      if (previous !== undefined && String(previous.agentId) !== String(id)) {
        // Rebinding this chat to a new session must not inherit the old
        // session's unanswered inbound (its reply-quote and turn/end state).
        previous.inbound = undefined;
        previous.reminded = false;
      }
      // touch() evicts any other chat that still owns this agent, so the
      // one-agent-one-chat rule holds in both `chatStates` and the index.
      this.touch(chatId, id);
    }
    this.notifyStateChange();
  }

  /** Legacy single-binding setter; when a chat is active it updates that
   * chat's binding as well. */
  setCurrentAgent(agentId: string | undefined): void {
    const active = this.activeChatValue();
    if (active !== undefined) {
      this.bindAgent(active, agentId);
      return;
    }
    this.lastTouch = agentId === undefined ? undefined : { agentId: SessionId(agentId) };
    this.notifyStateChange();
  }

  currentAgentIdValue(): string | undefined {
    return this.lastTouch?.agentId;
  }

  agentIdForChat(chatId: number): string | undefined {
    const agentId = this.chatStates.get(chatId)?.agentId;
    return agentId === undefined ? undefined : String(agentId);
  }

  chatIdForAgent(agentId: string): number | undefined {
    return this.chatByAgent.get(agentId);
  }

  private inboundFor(chatId: number): Inbound | undefined {
    return this.chatStates.get(chatId)?.inbound;
  }

  /** Pending inbound owned by the agent that is about to call `telegram_reply`.
   * Tool calls know their caller agent; routing through that id keeps chat A's
   * reply out of chat B even when B was the most recently touched chat. */
  inboundForAgent(agentId: string): Inbound | undefined {
    const chatId = this.chatIdForAgent(agentId);
    return chatId === undefined ? undefined : this.inboundFor(chatId);
  }

  /** Route one inbound user text into that chat's agent inbox. */
  deliver(chatId: number, text: string, messageId?: number): { ok: boolean; text: string } {
    return this.deliverContent(chatId, messageId, { queued: "Queued.", delivered: "Delivered." }, (config) => ({
      probe: text,
      content: [{ type: "text", text: withReasoningDirective(config, text) }],
      inboundText: text,
    }));
  }

  /** Deliver a media-group batch as ONE inbound turn (issue #9). */
  deliverImages(chatId: number, attachments: readonly { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }[], caption?: string, messageId?: number): { ok: boolean; text: string } {
    if (attachments.length === 1) return this.deliverImage(chatId, attachments[0]!, caption, messageId);
    return this.deliverContent(chatId, messageId, { queued: "Image queued.", delivered: "Image delivered." }, (config) => {
      const content: unknown[] = [];
      if (caption && caption.trim()) content.push({ type: "text", text: withReasoningDirective(config, caption.trim()) });
      content.push(...attachments.map((attachment) => ({ type: "image", attachment })));
      return {
        probe: caption ?? "",
        content,
        inboundText: caption || `[${attachments.length} images]`,
      };
    });
  }

  /** Deliver one promoted image as the inbound turn (session.attachment path). */
  deliverImage(chatId: number, attachment: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }, caption?: string, messageId?: number): { ok: boolean; text: string } {
    return this.deliverContent(chatId, messageId, { queued: "Image queued.", delivered: "Image delivered." }, (config) => {
      const content: unknown[] = [];
      if (caption && caption.trim()) content.push({ type: "text", text: withReasoningDirective(config, caption.trim()) });
      content.push({ type: "image", attachment });
      return {
        probe: caption ?? "",
        content,
        inboundText: caption || "[1 image]",
      };
    });
  }

  /** Shared inbound-turn pipeline behind deliver()/deliverImage(): resolve
   * the chat's agent, bind the chat and install the inbound quote BEFORE the
   * agent can emit anything (a synchronous turn/start or assistant/message
   * must already know its chat and quote target), then enqueue the turn. */
  private deliverContent(
    chatId: number,
    messageId: number | undefined,
    labels: { queued: string; delivered: string },
    compose: (config: TelegramConfig) => { probe: string; content: unknown[]; inboundText: string },
  ): { ok: boolean; text: string } {
    const agent = this.resolveAgent(chatId);
    if (!agent) return { ok: false, text: "No live agent in this session." };
    const config = this.getConfig();
    const parts = compose(config);
    const mode = resolveInboundMode(config, chatId, parts.probe);
    if (mode === "muted") return { ok: true, text: "Muted \u2014 message ignored." };
    const message = createUserMessage({ content: parts.content as never, source: { kind: "user" } });
    const target = agent as unknown as { send(message: unknown, target: string, wakeup: boolean): void; followup(message: unknown): void };
    const state = this.touch(chatId, agent.id);
    const inbound = { chatId, text: parts.inboundText, messageId, replied: false, noReply: false };
    state.inbound = inbound;
    state.reminded = false;
    if (mode === "queue-only") target.send(message, "next-turn", false);
    else target.followup(message);
    return { ok: true, text: mode === "queue-only" ? labels.queued : labels.delivered };
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
    const target = chatId ?? this.activeChatValue();
    if (target === undefined) return undefined;
    return this.inboundFor(target)?.messageId;
  }

  markNoReply(reason?: string, chatId?: number): { ok: boolean; text: string } {
    const target = chatId ?? this.activeChatValue();
    if (target === undefined) return { ok: false, text: "No active inbound message." };
    // Dropping the pending inbound is the whole effect: the turn/end reminder
    // keys off `inbound === undefined || replied || noReply`.
    const state = this.chatStates.get(target);
    if (state) state.inbound = undefined;
    return { ok: true, text: reason ?? "Marked as no-reply." };
  }

  hasPendingInbound(chatId?: number): boolean {
    const target = chatId ?? this.activeChatValue();
    if (target === undefined) return false;
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
    const target = chatId ?? this.activeChatValue();
    if (target === undefined) return;
    const inbound = this.inboundFor(target);
    if (inbound) inbound.replied = true;
  }

  currentInbound(): Inbound | undefined {
    const chatId = this.lastTouch?.chatId;
    return chatId === undefined ? undefined : this.chatStates.get(chatId)?.inbound;
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
          const touched = this.lastTouch?.agentId;
          if (touched !== undefined && String(touched) === sessionId) {
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
              // A throwing consumer must never escape a cordis event listener
              // (same containment as notifyStateChange).
              try {
                consumer(chatId, text, messageId);
              } catch (err) {
                this.log(
                  "assistant consumer failed",
                  err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
                );
              }
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
    this.chatByAgent.clear();
    this.droppedEvents.clear();
    this.lastTouch = undefined;
    // A stale consumer must not survive the bridge it was registered on.
    this.assistantConsumer = undefined;
  }
}
