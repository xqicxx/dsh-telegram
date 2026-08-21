/**
 * Goal progress feed for long-running autonomous /goal turns.
 *
 * One control-lane card per chat is created on turn/start (only when no
 * streaming renderer owns presentation), updated on every step/tool event,
 * and collapsed at turn/end into the openclaw-style receipt — including the
 * cache hit-rate line. The feed is pure bookkeeping + render; all Telegram
 * effects go through the injected ops.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { StatusStats } from "../harness/adapters/status.js";
import type { TodoView } from "../harness/adapters/todos.js";
import { safeWrap } from "./safe.js";
import { renderTurnReceipt } from "./turn-receipt.js";

export interface ProgressGoal {
  objective: string;
}

export interface ProgressOps {
  send(chatId: number, text: string, options: Record<string, unknown>): Promise<number | undefined>;
  edit(chatId: number, messageId: number, text: string, options: Record<string, unknown>): Promise<boolean>;
}

export interface ProgressDeps {
  ops: ProgressOps;
  log: (message: string, error?: unknown) => void;
  chatIdForAgent(agentId: string): number | undefined;
  goalFor(chatId: number): ProgressGoal | undefined;
  todosFor(chatId: number): readonly TodoView[];
  statusStats(chatId: number): StatusStats | undefined;
  /** openclaw (or another renderer) owns presentation while mounted. */
  liveRendererActive(): boolean;
  pendingInbound(chatId: number): boolean;
  /** Long-task notification switches (`notify.on*`, default true). */
  notifyOnComplete?(): boolean;
  notifyOnLongTask?(): boolean;
}

export interface ProgressSnapshot {
  objective: string;
  turn: number;
  step: number;
  tools: number;
  currentTool?: string;
  elapsedMs: number;
  todosDone: number;
  todosTotal: number;
}

interface Running {
  objective: string;
  turn: number;
  step: number;
  tools: number;
  currentTool?: string;
  startedAt: number;
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  messageId?: number;
  sending?: Promise<number | undefined>;
  timer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setTimeout>;
  finalized: boolean;
}

interface EventLike {
  type?: string;
  data?: {
    turn?: number;
    step?: number;
    name?: string;
    callId?: string;
    usage?: TokenUsageLike;
    chunk?: { type?: string; usage?: TokenUsageLike };
  };
}

interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

const EDIT_THROTTLE_MS = 250;
/** Long tools can be silent for a while: heartbeat every 30s so the elapsed
 * timer keeps moving and the user sees the task is alive (issue #18). Shared
 * with the openclaw extension's draft heartbeat. */
export const LIVENESS_HEARTBEAT_MS = 30_000;

function bar(done: number, total: number): string {
  const width = 10;
  const filled = total === 0 ? 0 : Math.max(0, Math.min(width, Math.round((done / total) * width)));
  return `${"\u2593".repeat(filled)}${"\u2591".repeat(width - filled)} ${Math.round(total === 0 ? 0 : (done / total) * 100)}%`;
}

export class GoalProgressFeed {
  private readonly running = new Map<number, Running>();
  private dispose: (() => void) | undefined;

  constructor(private readonly deps: ProgressDeps) {}

  attach(ctx: Context): void {
    const on = ctx.on.bind(ctx) as (name: string, listener: (...args: unknown[]) => void) => () => void;
    this.dispose = on("session/event", (...args: unknown[]) => {
      const session = args[0] as { id: unknown };
      const event = args[1] as EventLike;
      const chatId = this.deps.chatIdForAgent(String(session.id));
      if (chatId === undefined) return;
      this.record(chatId, event);
    });
  }

  detach(): void {
    this.dispose?.();
    this.dispose = undefined;
    for (const draft of this.running.values()) {
      if (draft.timer !== undefined) clearTimeout(draft.timer);
      if (draft.heartbeatTimer !== undefined) clearTimeout(draft.heartbeatTimer);
    }
    this.running.clear();
  }

  snapshot(chatId: number): ProgressSnapshot | undefined {
    const running = this.running.get(chatId);
    if (!running) return undefined;
    const todos = this.deps.todosFor(chatId);
    return {
      objective: running.objective,
      turn: running.turn,
      step: running.step,
      tools: running.tools,
      currentTool: running.currentTool,
      elapsedMs: Date.now() - running.startedAt,
      todosDone: todos.filter((todo) => todo.status === "completed").length,
      todosTotal: todos.length,
    };
  }

  private record(chatId: number, event: EventLike): void {
    const type = event.type;
    if (type === "turn/start") {
      const goal = this.deps.goalFor(chatId);
      if (goal === undefined || this.deps.liveRendererActive() || this.deps.pendingInbound(chatId)) return;
      const previous = this.running.get(chatId);
      if (previous?.timer !== undefined) clearTimeout(previous.timer);
      const draft: Running = {
        objective: goal.objective,
        turn: event.data?.turn ?? 0,
        step: 0,
        tools: 0,
        startedAt: Date.now(),
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        finalized: false,
      };
      this.running.set(chatId, draft);
      this.sendCard(chatId, draft);
      if (this.deps.notifyOnLongTask?.() !== false) this.armHeartbeat(chatId, draft);
      return;
    }
    const draft = this.running.get(chatId);
    if (!draft || draft.finalized) return;

    if (type === "step/start") {
      draft.step = event.data?.step ?? draft.step;
      this.schedule(chatId, draft);
      return;
    }
    if (type === "tool/call") {
      draft.tools += 1;
      draft.currentTool = typeof event.data?.name === "string" ? event.data.name : undefined;
      this.schedule(chatId, draft);
      return;
    }
    if (type === "todo/write") {
      this.schedule(chatId, draft);
      return;
    }
    if (type === "assistant/chunk") {
      const usage = event.data?.chunk?.type === "usage" ? event.data.chunk.usage : event.data?.usage;
      if (usage !== undefined) {
        draft.uncachedInputTokens += usage.inputTokens ?? 0;
        draft.outputTokens += usage.outputTokens ?? 0;
        draft.cacheReadTokens += usage.cacheReadTokens ?? 0;
        draft.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
      }
      return;
    }
    if (type === "turn/end") {
      draft.finalized = true;
      if (draft.timer !== undefined) {
        clearTimeout(draft.timer);
        draft.timer = undefined;
      }
      if (draft.heartbeatTimer !== undefined) {
        clearTimeout(draft.heartbeatTimer);
        draft.heartbeatTimer = undefined;
      }
      this.finalize(chatId, draft);
      this.running.delete(chatId);
    }
  }

  private renderRunning(chatId: number, draft: Running): string {
    const todos = this.deps.todosFor(chatId);
    const total = todos.length;
    const done = todos.filter((todo) => todo.status === "completed").length;
    const seconds = Math.max(1, Math.round((Date.now() - draft.startedAt) / 1000));
    const lines = [`\u{1F4CA} ${draft.objective.slice(0, 60)}`, ""];
    if (total > 0) lines.push(`${bar(done, total)} \u00B7 todo ${done}/${total}`);
    lines.push(`step ${draft.step} \u00B7 tools ${draft.tools} \u00B7 \u23F1\uFE0F ${seconds}s`);
    if (draft.currentTool !== undefined) lines.push(`\u{1F6E0}\uFE0F ${draft.currentTool}`);
    return lines.join("\n");
  }

  private schedule(chatId: number, draft: Running): void {
    if (draft.timer !== undefined) return;
    draft.timer = setTimeout(() => {
      draft.timer = undefined;
      this.editCard(chatId, draft, this.renderRunning(chatId, draft));
    }, EDIT_THROTTLE_MS);
  }

  /** Periodic liveness edit: even with no new session events the card's
   * elapsed timer advances, so a long silent tool never looks frozen. */
  private armHeartbeat(chatId: number, draft: Running): void {
    if (draft.heartbeatTimer !== undefined) return;
    draft.heartbeatTimer = setTimeout(() => {
      draft.heartbeatTimer = undefined;
      if (this.running.get(chatId) !== draft || draft.finalized) return;
      this.editCard(chatId, draft, this.renderRunning(chatId, draft));
      this.armHeartbeat(chatId, draft);
    }, LIVENESS_HEARTBEAT_MS);
    // Liveness only: never keep an otherwise-idle process alive.
    draft.heartbeatTimer.unref?.();
  }

  private sendCard(chatId: number, draft: Running): void {
    const pending = this.deps.ops.send(chatId, this.renderRunning(chatId, draft), { parse_mode: "HTML" });
    draft.sending = pending;
    void safeWrap(`goal-progress-send(${chatId})`, () => pending.then((id) => {
      if (id !== undefined) draft.messageId = id;
      return id !== undefined;
    }), this.deps.log).then((sent) => {
      if (sent !== true) {
        draft.sending = undefined;
        this.running.delete(chatId);
      }
    });
  }

  private editCard(chatId: number, draft: Running, text: string): void {
    if (draft.messageId === undefined) return;
    void safeWrap(`goal-progress-edit(${chatId})`, () => this.deps.ops.edit(chatId, draft.messageId!, text, { parse_mode: "HTML" }), this.deps.log);
  }

  private finalize(chatId: number, draft: Running): void {
    const receipt = renderTurnReceipt({
      durationMs: Date.now() - draft.startedAt,
      toolCalls: draft.tools,
      reasoningSteps: 0,
      tokens: draft,
      sessionStats: this.deps.statusStats(chatId),
      goalObjective: draft.objective,
    });
    const settle = (messageId: number | undefined): void => {
      if (messageId === undefined) return;
      void safeWrap(`goal-progress-finalize(${chatId})`, () => this.deps.ops.edit(chatId, messageId, receipt, { parse_mode: "HTML" }), this.deps.log);
    };
    if (draft.messageId !== undefined) settle(draft.messageId);
    else if (draft.sending !== undefined) void safeWrap(`goal-progress-finalize-pending(${chatId})`, () => draft.sending!.then(settle), this.deps.log);
    // Completion push (issue #18): a silent in-place edit is easy to miss,
    // so goal turns also deliver one fresh receipt message with notifications.
    if (this.deps.notifyOnComplete?.() !== false) {
      void safeWrap(`goal-progress-completion(${chatId})`, () => this.deps.ops.send(chatId, receipt, {
        parse_mode: "HTML",
        disable_notification: false,
      }), this.deps.log);
    }
  }
}
