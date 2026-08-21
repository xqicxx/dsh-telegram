/**
 * Todos + Goals cards for dsh-telegram.
 *
 * The live Todos card owns a per-chat 5-second auto-refresh loop
 * (todoCardTimers): the loop only fires while the SAME renderer is still the
 * chat's active card, so Back/Close/any other card stops it on the next tick
 * (issue #14). The Goals card renders the chat agent's current completion
 * goal with edit/pause/clear shortcuts.
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object; the timer map and the stop helper are
 * returned so index.ts teardown/ejectChat and openStatusPanel keep using
 * them.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { getGoal } from "../harness/adapters/goals.js";
import { listTodos } from "../harness/adapters/todos.js";
import { plain, truncate } from "../telegram/html.js";
import { renderTodosCard } from "../telegram/todos-card.js";
import { safeWrap } from "../telegram/safe.js";
import { Ephemeral, type ChatOps } from "../telegram/ephemeral.js";
import { buildBackKeyboard, buildGoalsKeyboard } from "../telegram/keyboard.js";
import type { TelegramTransport } from "../telegram/transport.js";
import type { OpenCard } from "../core/cards.js";

export interface GoalCardsDeps {
  requireTransport(): TelegramTransport;
  requireCtx(): Context;
  currentAgent(chatId?: number): Agent | undefined;
  ephemeral: Ephemeral;
  uiOps(t: TelegramTransport): ChatOps;
  /** Active-card renderer map owned by core/cards.ts (loop liveness check). */
  activeCardRenderers: Map<number, () => Promise<void>>;
  openCard: OpenCard;
  token(payload: Record<string, string>): string;
  log(message: string, error?: unknown): void;
  uiSend(chatId: number, text: string, options?: Parameters<TelegramTransport["sendText"]>[2]): Promise<number | undefined>;
}

/** Build the todos/goals cards and the per-chat Todos refresh loop. Called
 * once by index.ts; every card closes over the shared deps like the previous
 * module-scope closures did over index.ts singletons. */
export function createGoalCards(deps: GoalCardsDeps): {
  /** Per-chat 5-second refresh loops for the live Todos card (issue #14). */
  todoCardTimers: Map<number, ReturnType<typeof setInterval>>;
  stopTodoCardRefresh(chatId: number): void;
  openTodosCard(chatId: number): Promise<void>;
  openGoalsCard(chatId: number): Promise<void>;
} {
  const { requireTransport, requireCtx, currentAgent, ephemeral, uiOps, activeCardRenderers, openCard, token, log, uiSend } = deps;

  /** Per-chat 5-second refresh loops for the live Todos card (issue #14). */
  const TODO_CARD_REFRESH_MS = 5000;
  const todoCardTimers = new Map<number, ReturnType<typeof setInterval>>();

  /** Refresh the open Todos card in place through the UI control lane. */
  async function refreshTodosCard(chatId: number): Promise<void> {
    const t = requireTransport();
    const agent = currentAgent(chatId);
    const todos = agent === undefined ? [] : listTodos(requireCtx(), agent.id);
    await ephemeral.replace(chatId, uiOps(t), renderTodosCard(todos, agent !== undefined), {
      parse_mode: "HTML",
      reply_markup: buildBackKeyboard(),
    });
  }

  /** Stop the per-chat Todos auto-refresh loop (reopen, card switch, teardown). */
  function stopTodoCardRefresh(chatId: number): void {
    const timer = todoCardTimers.get(chatId);
    if (timer === undefined) return;
    clearInterval(timer);
    todoCardTimers.delete(chatId);
  }

  /** Start the 5s auto-refresh. The loop checks that the SAME renderer is still
   * the active card; Back/Close/any other card replaces it and stops the loop
   * on the next tick, so a stale timer can never write over another card. */
  function startTodoCardRefresh(chatId: number, refresh: () => Promise<void>): void {
    stopTodoCardRefresh(chatId);
    const timer = setInterval(() => {
      if (activeCardRenderers.get(chatId) !== refresh) {
        stopTodoCardRefresh(chatId);
        return;
      }
      void safeWrap(`todos-refresh(${chatId})`, () => refresh(), log);
    }, TODO_CARD_REFRESH_MS);
    todoCardTimers.set(chatId, timer);
  }

  async function openTodosCard(chatId: number): Promise<void> {
    const t0 = Date.now();
    log(`openTodosCard start chatId=${chatId}`);
    stopTodoCardRefresh(chatId);
    try {
      const agent = currentAgent(chatId);
      const todos = agent === undefined ? [] : listTodos(requireCtx(), agent.id);
      log(`openTodosCard agent=${agent?.id ?? "none"} todos=${todos.length} took=${Date.now() - t0}ms`);
      const refresh = () => refreshTodosCard(chatId);
      await openCard(chatId, renderTodosCard(todos, agent !== undefined), buildBackKeyboard(), refresh);
      // Start only after the card actually opened; `openCard` has already
      // registered `refresh` as the active renderer for this chat.
      startTodoCardRefresh(chatId, refresh);
    } catch (err) {
      log("openTodosCard FAILED", err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
      await uiSend(chatId, `\u274C Todo list \u8F7D\u5165\u5931\u8D25\uff1A${plain(truncate(err instanceof Error ? err.message : String(err), 120))}`, { parse_mode: "HTML" });
    }
  }

  async function openGoalsCard(chatId: number): Promise<void> {
    const agent = currentAgent(chatId);
    const lines = ["\u{1F3AF} Goal", ""];
    let hasGoal = false;
    let paused = false;
    if (agent) {
      const goal = getGoal(requireCtx(), agent.id);
      if (goal) {
        hasGoal = true;
        paused = goal.phase === "paused";
        lines.push(`phase: ${goal.phase} \u00B7 activation: ${goal.activation} \u00B7 rounds: ${goal.roundsStarted}${goal.maxGoalRounds !== undefined ? `/${goal.maxGoalRounds}` : ""}`);
        lines.push(`objective: ${plain(truncate(goal.objective, 120))}`);
        lines.push(`revision: ${goal.revision} \u00B7 created: ${plain(new Date(goal.createdAt).toLocaleString())}`);
      } else {
        lines.push("(no current goal)");
      }
    } else {
      lines.push("No live agent \u2014 goals are per-agent.");
    }
    const goalPayload = agent ? { action: "goal", agentId: agent.id } : { action: "goal", agentId: "" };
    const callbacks = {
      ...(hasGoal ? {
        edit: token({ ...goalPayload, op: "edit" }),
        toggle: token({ ...goalPayload, op: paused ? "resume" : "pause" }),
        clear: token({ ...goalPayload, op: "clear" }),
      } : {}),
    };
    lines.push("", "Start: /goal &lt;objective&gt; [maxRounds]");
    if (hasGoal) lines.push("Edit: /goaledit &lt;objective&gt; [maxRounds] \u00B7 Clear: /goalclear");
    await openCard(chatId, lines.join("\n"), buildGoalsKeyboard(hasGoal, callbacks, paused));
  }

  return { todoCardTimers, stopTodoCardRefresh, openTodosCard, openGoalsCard };
}
