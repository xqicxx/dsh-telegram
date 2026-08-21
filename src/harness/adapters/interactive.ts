/**
 * Interactive answering (web ApiProxy `respond` for approval/question frames).
 * Mirrors the api-proxy semantics exactly:
 *   - approvals: `approval/request` waterfall listener claims the pending
 *     approval/asked event (callId-matched) and settles it with the button
 *     answer;
 *   - questions: `ctx.userQuestions.registerProvider` owns the ask() promise
 *     and settles it with the submitted answers.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { QuestionOwnership } from "../../config.js";

export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled";
/** What the user tapped. Scoped grants settle the approval as allowed-once
 * while remembering the wider permission for later requests. */
export type ApprovalAnswer = ApprovalOutcome | "allowed-goal" | "allowed-session" | "allowed-always";

export interface BroadcastDelivery {
  chatId: number;
  messageId: number;
}

export interface InteractiveDelivery {
  /** Send one Telegram message. When `chatId` is provided only that chat
   * receives it; otherwise the delivery defaults to every whitelisted chat. */
  broadcast(text: string, keyboard: unknown, chatId?: number): Promise<BroadcastDelivery[]>;
  edit(chatId: number, messageId: number, text: string, keyboard: unknown): Promise<boolean>;
  /** Resolve the chat that owns a dsh session (per-chat routing). Absent =
   * legacy broadcast-to-all behavior. */
  chatForSession?(sessionId: string): number | undefined;
}

interface ApprovalRequestLike {
  agent: { id: string; session: { events: readonly { seq: number; type: string; data?: Record<string, unknown> }[] } };
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}

interface PendingApproval {
  id: number;
  approvalId: string;
  sessionId: string;
  toolName: string;
  reason?: string;
  /** Current goal id, when the chat has one — enables goal-scoped grants. */
  goalId?: string;
  resolve: (outcome: ApprovalOutcome, display?: string) => void;
  messageIds: Map<number, number>;
  cardText: string;
}

interface QuestionOptionLike {
  /** Selected value echoed back in the answer. Required in the dsh contract;
   * legacy test shapes also carry an `id`. */
  label: string;
  description?: string;
  id?: string;
}

interface QuestionItemLike {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: QuestionOptionLike[];
  multiSelect?: boolean;
  intent?: { kind?: string; approve?: string };
}

interface QuestionRequestLike {
  agent?: { id: string };
  questions: QuestionItemLike[];
  signal?: AbortSignal;
}

interface PendingQuestion {
  id: number;
  sessionId: string;
  questions: QuestionItemLike[];
  resolve: (answer: { answers: { id: string; selected: string[]; custom?: string }[] }) => void;
  reject: (err: Error) => void;
  messageIds: Map<number, number>;
  selections: Map<string, string[]>;
  custom: Map<string, string>;
  answerer?: number;
}

interface QuestionsServiceLike {
  registerProvider(provider: { ask(request: QuestionRequestLike): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }> }): () => void;
  /** The single active UI provider; web UI sets this when it owns the seam. */
  provider?: unknown;
}

interface LoaderEntryLike {
  disabled?: boolean;
  options?: { name?: string; group?: unknown };
}

interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>;
}

/** The web API proxy owns the single userQuestions provider when mounted. */
function webUiOwnsQuestions(ctx: Context): boolean {
  const loader = ctx.get("loader") as LoaderLike | undefined;
  if (!loader) return false;
  for (const entry of loader.entries()) {
    if (entry.disabled === true) continue;
    if (entry.options?.name === "@deepseek-ai/dsh-host-apiproxy") return true;
  }
  return false;
}

/** Stable option identity inside one question: label is the protocol value;
 * a numeric token keeps callback_data tiny even for long labels. */
function optionKey(option: QuestionOptionLike, index: number): string {
  return String(index);
}

function optionValue(option: QuestionOptionLike): string {
  return option.label;
}

function findOption(question: QuestionItemLike, token: string): QuestionOptionLike | undefined {
  const options = question.options ?? [];
  const index = Number(token);
  if (Number.isInteger(index) && index >= 0 && index < options.length) return options[index];
  return options.find((option) => option.id === token || option.label === token);
}

/** Same validation the user-questions service applies before `provider.ask`. */
function assertValidRequest(ctx: Context, request: QuestionRequestLike): void {
  if (request.signal?.aborted === true) {
    throw new Error("ask_user_question was aborted before the user answered");
  }
  if (request.questions.length === 0) {
    throw new Error("ask_user_question requires at least one question");
  }
  const agent = request.agent;
  if (agent === undefined) return;
  const agents = ctx.get("agents") as { get(id: unknown): unknown; roots?(): unknown[] } | undefined;
  if (agents === undefined || agents.get(agent.id) !== agent) {
    throw new Error("human interaction requires the exact live calling agent when an agent is supplied");
  }
  if (typeof agents.roots === "function" && !agents.roots().includes(agent)) {
    throw new Error(
      "human interaction is unavailable while the calling agent is owned by another live agent; " +
      "include the unresolved question or decision in the child agent's final result",
    );
  }
  for (const question of request.questions) {
    const intent = question.intent;
    if (intent === undefined) continue;
    const approve = intent.approve;
    if (approve !== undefined && !(question.options ?? []).some((option) => option.label === approve)) {
      throw new Error(`question ${question.id} declares an intent whose approve label names none of its options`);
    }
    if (question.detail === undefined) {
      throw new Error(`question ${question.id} declares an intent without the detail it reviews`);
    }
  }
}

interface ApprovalServiceLike {
  on?: unknown;
}

interface CordisEventsLike {
  on<K extends string>(name: K, listener: (...args: unknown[]) => unknown): () => void;
}

export interface Interactive {
  answerApproval(id: number, answer: ApprovalAnswer): boolean;
  /** Hot-update the persisted forever-allow set (e.g. /config changed it). */
  setAllowedTools(tools: readonly string[]): void;
  toggleQuestionOption(chatId: number, id: number, questionId: string, optionId: string): Promise<boolean>;
  setQuestionCustom(chatId: number, id: number, questionId: string, text: string): Promise<boolean>;
  submitQuestions(chatId: number, id: number): Promise<boolean>;
  cancelQuestions(chatId: number, id: number): Promise<boolean>;
  detach(): void;
}

const approvals = new Map<number, PendingApproval>();
const questions = new Map<number, PendingQuestion>();
/** Goal ids the user granted: later approvals under the same goal auto-allow. */
const grantedGoals = new Set<string>();
/** sessionId -> tool names the user granted for the rest of that session. */
const grantedSessions = new Map<string, Set<string>>();
/** Tool names the user granted forever (persisted by the host via options). */
const grantedTools = new Set<string>();
let counter = 0;

/** Tools whose irreversible actions deserve a warning on the forever button.
 * Unknown tools default to normal: showing the option is more useful than
 * hiding it behind a risk table the plugin cannot keep complete. */
const HIGH_RISK_TOOLS = new Set(["bash", "shell", "exec", "sudo", "write", "edit", "delete", "remove", "rm", "kill", "stop", "abort", "publish", "uninstall"]);

/** Whether the "Allow forever" button should carry a warning emoji. */
export function isRiskyTool(toolName: string): boolean {
  const name = toolName.trim().toLowerCase();
  if (HIGH_RISK_TOOLS.has(name)) return true;
  return /\b(bash|shell|exec|delete|remove|rm|kill|abort|uninstall)\b/.test(name);
}

function mint(): number {
  counter += 1;
  return counter;
}

async function reRenderQuestion(ctx: Context, pending: PendingQuestion, chatId: number, delivery: InteractiveDelivery): Promise<void> {
  const messageId = pending.messageIds.get(chatId);
  if (messageId === undefined) return;
  const text = renderQuestions(pending, chatId);
  await delivery.edit(chatId, messageId, text, questionKeyboard(pending.id, chatId)).catch(() => {});
  void ctx;
}

/** Prefer the chat bound to the requesting session; fall back to the legacy
 * broadcast-to-all only when the host offers no per-chat resolver. */
function broadcastForSession(delivery: InteractiveDelivery, sessionId: string, text: string, keyboard: unknown): Promise<BroadcastDelivery[]> {
  return delivery.broadcast(text, keyboard, delivery.chatForSession?.(sessionId));
}

/** Settle/status text edits each card that actually received it in place
 * (Telegram users expect the answered card to lose its buttons, not spawn a
 * second status message next to a stale clickable card). When no card ever
 * landed, fall back to a bare status message so the outcome is not lost. */
async function settleCards(delivery: InteractiveDelivery, messageIds: ReadonlyMap<number, number>, fallbackChat: number | undefined, text: string): Promise<void> {
  if (messageIds.size === 0) {
    if (fallbackChat !== undefined) await delivery.broadcast(text, undefined, fallbackChat).catch(() => {});
    return;
  }
  await Promise.all(
    [...messageIds].map(([chatId, messageId]) =>
      delivery.edit(chatId, messageId, text, undefined).catch(() => {}),
    ),
  );
}

export function questionIdAt(id: number, index: number): string | undefined {
  const pending = questions.get(id);
  return pending?.questions[index]?.id;
}

export function renderQuestions(pending: PendingQuestion, chatId: number): string {
  const lines = [`\u2753 ${pending.sessionId ? `Session ${pending.sessionId}` : "Session"} asks (id ${pending.id}):`, ""];
  pending.questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.header ? `[${question.header}] ` : ""}${question.question}`);
    if (question.detail) lines.push(`   ${question.detail}`);
    const selected = pending.selections.get(question.id) ?? [];
    const custom = pending.custom.get(question.id);
    if (question.options?.length) {
      for (const option of question.options) {
        lines.push(`   ${selected.includes(optionValue(option)) ? "\u2705" : "\u25CB"} ${option.label}`);
      }
      if (question.multiSelect) lines.push("   (multi-select: tap to toggle)");
    } else {
      lines.push(selected.length ? `   \u2705 ${selected[0]}` : "   \u25CB (reply with /answer <id> <question-number> <text>)");
    }
    if (custom) lines.push(`   \u270F custom: ${custom}`);
    void chatId;
  });
  return lines.join("\n").slice(0, 3800);
}

export function questionKeyboard(pendingId: number, chatId: number): unknown {
  const pending = questions.get(pendingId);
  if (!pending) return undefined;
  const rows: { text: string; callback_data: string }[][] = [];
  pending.questions.forEach((question, index) => {
    (question.options ?? []).slice(0, 24).forEach((option, optionIndex) => {
      const selected = pending.selections.get(question.id) ?? [];
      const marked = selected.includes(optionValue(option)) ? "\u2705 " : "";
      rows.push([{ text: `${index + 1}:${marked}${option.label}`.slice(0, 40), callback_data: `qu:${pendingId}:${index}:${optionKey(option, optionIndex)}`.slice(0, 64) }]);
    });
  });
  rows.push([
    { text: "\u2714\uFE0F Submit", callback_data: `qu:${pendingId}:s` },
    { text: "\u2716 Cancel", callback_data: `qu:${pendingId}:c` },
  ]);
  return { inline_keyboard: rows };
}

function approvalKeyboard(id: number, goalId: string | undefined, toolName: string): unknown {
  const rows: { text: string; callback_data: string }[][] = [];
  const scoped: { text: string; callback_data: string }[] = [];
  if (goalId !== undefined) {
    scoped.push({ text: "\u{1F7E2} Allow for this goal", callback_data: `ap:${id}:g` });
  }
  scoped.push({ text: "\u{1F7E3} Allow for this session", callback_data: `ap:${id}:s` });
  rows.push(scoped);
  rows.push([
    { text: "\u2705 Allow once", callback_data: `ap:${id}:y` },
    { text: "\u274C Reject", callback_data: `ap:${id}:n` },
  ]);
  rows.push([
    {
      text: isRiskyTool(toolName) ? "\u{1F7E4} Allow forever \u26A0\uFE0F risky" : "\u{1F7E4} Allow forever (by tool)",
      callback_data: `ap:${id}:a`,
    },
  ]);
  return { inline_keyboard: rows };
}

export interface InteractiveOptions {
  /** Explicit channel ownership for `ask_user_question`. Defaults to Telegram. */
  userQuestions?: QuestionOwnership;
  /** Diagnostic sink; defaults to console.error. */
  log?: (message: string, error?: unknown) => void;
  /** Resolve the current goal id for one agent/session. Absent = no
   * goal-scoped approval button. */
  goalIdForSession?: (sessionId: string) => string | undefined;
  /** Tool names already allowed forever (loaded from persisted config). */
  allowedTools?: readonly string[];
  /** Persist a new forever-allow for one tool. Return false when the write
   * failed; the grant stays live in memory for this plugin mount. */
  persistToolAllow?: (toolName: string) => boolean;
}

interface ToolExecutionLike {
  name?: string;
  arguments?: { questions?: unknown };
  agent?: { id: string };
  signal?: AbortSignal;
}

/** Project a `tools/execute` execution for `ask_user_question` onto the same
 * request shape the user-questions service forwards to providers. */
function toQuestionRequest(exec: ToolExecutionLike): QuestionRequestLike | undefined {
  if (exec.name !== "ask_user_question") return undefined;
  const raw = exec.arguments?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const questions: QuestionItemLike[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const item = entry as {
      id?: unknown;
      question?: unknown;
      detail?: unknown;
      header?: unknown;
      options?: unknown;
      multi_select?: unknown;
    };
    if (typeof item.id !== "string" || typeof item.question !== "string") return undefined;
    let options: QuestionOptionLike[] | undefined;
    if (item.options !== undefined) {
      if (!Array.isArray(item.options)) return undefined;
      options = [];
      for (const option of item.options) {
        const value = option as { label?: unknown; description?: unknown };
        // Leave malformed arguments for the tool body's schema validation.
        if (typeof value.label !== "string") return undefined;
        options.push({
          label: value.label,
          ...(typeof value.description === "string" ? { description: value.description } : {}),
        });
      }
    }
    questions.push({
      id: item.id,
      question: item.question,
      ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
      ...(typeof item.header === "string" ? { header: item.header } : {}),
      ...(options === undefined ? {} : { options }),
      ...(item.multi_select === true ? { multiSelect: true } : {}),
    });
  }
  return {
    ...(exec.agent === undefined ? {} : { agent: exec.agent }),
    questions,
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  };
}

/** Create the pending Telegram question card and wait for the user's answer. */
function askViaTelegram(delivery: InteractiveDelivery, request: QuestionRequestLike): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }> {
  const sessionId = request.agent?.id;
  if (sessionId === undefined) return Promise.reject(new Error("telegram user interaction requires an agent-owned session"));
  return new Promise((resolve, reject) => {
    const id = mint();
    const pending: PendingQuestion = {
      id,
      sessionId,
      questions: request.questions,
      resolve,
      reject,
      messageIds: new Map(),
      selections: new Map(),
      custom: new Map(),
    };
    const onAbort = () => {
      if (!questions.delete(id)) return;
      reject(new Error("ask_user_question was aborted before the user answered"));
    };
    pending.questions.forEach((question) => pending.selections.set(question.id, []));
    questions.set(id, pending);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    void broadcastForSession(delivery, sessionId, renderQuestions(pending, 0), questionKeyboard(id, 0)).then(
      (delivered) => {
        for (const entry of delivered) pending.messageIds.set(entry.chatId, entry.messageId);
        pending.answerer = delivered[0]?.chatId;
        // Zero deliveries would leave the tool execution waiting forever for
        // a card nobody received (LOOP_AUDIT #4). Settle with a clear error.
        if (delivered.length === 0 && questions.delete(id)) {
          reject(new Error("no allowed Telegram chat is available to answer this question"));
        }
      },
      // A rejected broadcast delivered nothing either: take the same path as
      // zero deliveries so the tool execution cannot wait on a card that was
      // never sent.
      () => {
        if (questions.delete(id)) {
          reject(new Error("no allowed Telegram chat is available to answer this question"));
        }
      },
    );
  });
}

export function attachInteractive(ctx: Context, delivery: InteractiveDelivery, options: InteractiveOptions = {}): Interactive {
  const disposers: (() => void)[] = [];
  const ownership = options.userQuestions ?? "telegram";
  const log = options.log ?? ((message: string, error?: unknown) => console.error(`[dsh-telegram] ${message}`, error ?? ""));
  const goalIdForSession = options.goalIdForSession;
  for (const toolName of options.allowedTools ?? []) {
    if (toolName.trim() !== "") grantedTools.add(toolName.trim());
  }

  if (ctx.get("approval") !== undefined) {
    const events = ctx as unknown as CordisEventsLike;
    disposers.push(
      events.on("approval/request", (request, next) => {
        const req = request as ApprovalRequestLike;
        if (req.signal?.aborted === true) return Promise.resolve("cancelled");
        const goalId = goalIdForSession?.(String(req.agent.id));
        // A previous "Allow for this goal" covers the rest of the goal:
        // settle without showing another card.
        if (goalId !== undefined && grantedGoals.has(goalId)) return Promise.resolve("allowed-once");
        // Session and forever (by-tool) grants cover the same tool without
        // another card. Session grants die with the plugin mount, matching
        // the web's per-session permission model.
        const toolName = req.toolName.trim();
        if (grantedTools.has(toolName) || grantedSessions.get(String(req.agent.id))?.has(toolName)) {
          return Promise.resolve("allowed-once");
        }
        const claimed = new Set([...approvals.values()].map((entry) => entry.approvalId));
        const decided = new Set<string>();
        let approvalId: string | undefined;
        for (let i = req.agent.session.events.length - 1; i >= 0; i -= 1) {
          const event = req.agent.session.events[i];
          if (event.type === "approval/decided") decided.add(String((event.data as { id?: unknown })?.id));
          else if (event.type === "approval/asked") {
            const data = event.data as { id?: unknown; callId?: unknown };
            if (decided.has(String(data.id)) || claimed.has(String(data.id))) continue;
            if ((req.callId ?? null) !== (data.callId ?? null)) continue;
            approvalId = String(data.id);
            break;
          }
        }
        if (approvalId === undefined) return (next as () => Promise<unknown>)();
        const id = mint();
        return new Promise<ApprovalOutcome>((resolve) => {
          const settle = (outcome: ApprovalOutcome, display: string = outcome) => {
            if (!approvals.delete(id)) return;
            req.signal?.removeEventListener("abort", onAbort);
            // Edit the requested card in place and drop its inline buttons.
            // No remove_keyboard reply: that would wipe the persistent command
            // bar for the whole chat.
            void settleCards(
              delivery,
              pending.messageIds,
              delivery.chatForSession?.(pending.sessionId),
              `${pending.cardText}\n\n\u{1F6E1} Approval ${display} \u00B7 ${req.toolName}${req.reason ? ` \u00B7 ${req.reason}` : ""}`,
            );
            resolve(outcome);
          };
          const onAbort = () => settle("cancelled");
          const cardText = `\u{1F6E1} Approval requested \u00B7 ${req.toolName}${req.reason ? `\nReason: ${req.reason}` : ""}\nSession: ${req.agent.id}`;
          const pending: PendingApproval = { id, approvalId, sessionId: req.agent.id, toolName: req.toolName, ...(req.reason === undefined ? {} : { reason: req.reason }), ...(goalId === undefined ? {} : { goalId }), resolve: settle, messageIds: new Map(), cardText };
          approvals.set(id, pending);
          req.signal?.addEventListener("abort", onAbort, { once: true });
          void broadcastForSession(delivery, req.agent.id, cardText, approvalKeyboard(id, goalId, req.toolName)).then(
            (delivered) => {
              for (const entry of delivered) pending.messageIds.set(entry.chatId, entry.messageId);
              // Zero deliveries would block the agent forever on a card no
              // chat can answer (LOOP_AUDIT #4): cancel instead.
              if (delivered.length === 0) settle("cancelled");
            },
            // A rejected broadcast delivered nothing either: settle the same
            // way as zero deliveries instead of blocking the agent forever.
            () => settle("cancelled"),
          );
        });
      }),
    );
  }

  const questionsService = ctx.get("userQuestions") as QuestionsServiceLike | undefined;
  let disposeProvider: (() => void) | undefined;
  const webMounted = webUiOwnsQuestions(ctx);
  const serviceOwned = questionsService?.provider !== undefined;

  if (ownership === "telegram") {
    // When another UI already owns the single userQuestions provider (or the
    // web API proxy is mounted and may claim it later), Telegram claims
    // ask_user_question at the public `tools/execute` seam instead. The
    // one-provider invariant stays untouched: Telegram never registers a
    // second provider. When the seam is free, the ordinary provider path
    // keeps the service's own validation in front of every ask.
    if (questionsService !== undefined && (serviceOwned || webMounted)) {
      const events = ctx as unknown as CordisEventsLike;
      if (typeof events.on === "function") {
        disposers.push(
          events.on("tools/execute", (exec, next) => {
            const request = toQuestionRequest(exec as ToolExecutionLike);
            if (request === undefined) return (next as () => Promise<unknown>)();
            assertValidRequest(ctx, request);
            return askViaTelegram(delivery, request).then((answer) => ({ value: answer }));
          }),
        );
      }
      if (serviceOwned) {
        log("interactive.userQuestions=telegram: another UI owns ctx.userQuestions; Telegram answers ask_user_question at the tools/execute seam");
      } else {
        log("interactive.userQuestions=telegram: web API proxy is mounted; Telegram answers ask_user_question at the tools/execute seam and leaves the single provider seam to the web UI");
      }
    } else if (questionsService !== undefined) {
      try {
        disposeProvider = questionsService.registerProvider({ ask: (request) => askViaTelegram(delivery, request) });
      } catch (err) {
        log("telegram userQuestions provider registration failed; another provider owns the seam", err);
      }
    } else {
      log("interactive.userQuestions=telegram: userQuestions service is unavailable; ask_user_question will fail if it is ever dispatched");
    }
  } else if (ownership === "auto") {
    // Legacy inference: only register when no other provider and no enabled
    // web API proxy loader entry. The service itself enforces the
    // single-provider invariant on the attempted registration.
    if (questionsService !== undefined && questionsService.provider === undefined && !webMounted) {
      try {
        disposeProvider = questionsService.registerProvider({ ask: (request) => askViaTelegram(delivery, request) });
      } catch (err) {
        log("telegram userQuestions provider registration failed; another provider owns the seam", err);
      }
    } else if (questionsService !== undefined && (serviceOwned || webMounted)) {
      log(`interactive.userQuestions=auto: ${serviceOwned ? "another provider" : "web API proxy"} owns ask_user_question; Telegram will not answer questions`);
    }
  }

  return {
    answerApproval(id, answer) {
      const pending = approvals.get(id);
      if (!pending) return false;
      const toolName = pending.toolName.trim();
      if (answer === "allowed-goal") {
        if (pending.goalId === undefined) return false;
        grantedGoals.add(pending.goalId);
        pending.resolve("allowed-once", "allowed-goal (this goal)");
        return true;
      }
      if (answer === "allowed-session") {
        const allowed = grantedSessions.get(pending.sessionId) ?? new Set<string>();
        allowed.add(toolName);
        grantedSessions.set(pending.sessionId, allowed);
        pending.resolve("allowed-once", "allowed-session (this session)");
        return true;
      }
      if (answer === "allowed-always") {
        grantedTools.add(toolName);
        let persisted = true;
        try {
          persisted = options.persistToolAllow?.(toolName) ?? true;
        } catch (err) {
          log("persisting an approval forever-allow failed; grant stays in memory for this plugin mount", err);
          persisted = false;
        }
        if (!persisted) log(`persisting approval forever-allow for ${toolName} failed; grant stays in memory for this plugin mount`);
        pending.resolve("allowed-once", "allowed-always (by tool)");
        return true;
      }
      pending.resolve(answer);
      return true;
    },
    setAllowedTools(tools) {
      grantedTools.clear();
      for (const toolName of tools) {
        if (toolName.trim() !== "") grantedTools.add(toolName.trim());
      }
    },
    async toggleQuestionOption(chatId, id, questionId, optionToken) {
      const pending = questions.get(id);
      if (!pending) return false;
      const question = pending.questions.find((candidate) => candidate.id === questionId);
      if (!question) return false;
      const option = findOption(question, optionToken);
      if (!option) return false;
      const value = optionValue(option);
      const selected = pending.selections.get(questionId) ?? [];
      if (selected.includes(value)) {
        pending.selections.set(questionId, selected.filter((entry) => entry !== value));
      } else if (question.multiSelect) {
        pending.selections.set(questionId, [...selected, value]);
      } else {
        pending.selections.set(questionId, [value]);
      }
      await reRenderQuestion(ctx, pending, chatId, delivery);
      return true;
    },
    async setQuestionCustom(chatId, id, questionId, text) {
      const pending = questions.get(id);
      if (!pending) return false;
      pending.custom.set(questionId, text);
      await reRenderQuestion(ctx, pending, chatId, delivery);
      return true;
    },
    async submitQuestions(chatId, id) {
      const pending = questions.get(id);
      if (!pending) return false;
      const answers: { id: string; selected: string[]; custom?: string }[] = [];
      for (const question of pending.questions) {
        const selected = pending.selections.get(question.id) ?? [];
        const custom = pending.custom.get(question.id);
        if (selected.length === 0 && custom === undefined && question.options?.length) {
          void delivery.edit(chatId, pending.messageIds.get(chatId) ?? 0, `${renderQuestions(pending, chatId)}\n\n\u26A0\uFE0F Answer every question first.`, questionKeyboard(id, chatId)).catch(() => {});
          return true;
        }
        answers.push({ id: question.id, selected, ...(custom === undefined ? {} : { custom }) });
      }
      questions.delete(id);
      pending.resolve({ answers });
      void settleCards(delivery, pending.messageIds, delivery.chatForSession?.(pending.sessionId), `\u2705 Questions answered (id ${id}).`);
      return true;
    },
    async cancelQuestions(chatId, id) {
      const pending = questions.get(id);
      if (!pending) return false;
      questions.delete(id);
      pending.reject(new Error("the user cancelled ask_user_question"));
      void settleCards(delivery, pending.messageIds, delivery.chatForSession?.(pending.sessionId), `\u2716 Questions cancelled (id ${id}).`);
      void chatId;
      return true;
    },
    detach() {
      for (const dispose of disposers.splice(0)) dispose();
      disposeProvider?.();
      disposeProvider = undefined;
      for (const pending of approvals.values()) pending.resolve("cancelled");
      for (const pending of questions.values()) pending.reject(new Error("telegram interactive provider was disposed"));
      approvals.clear();
      questions.clear();
      grantedGoals.clear();
      grantedSessions.clear();
      grantedTools.clear();
    },
  };
}
