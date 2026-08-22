/**
 * Live Todo card renderer (issue #14). The card is opened while the agent is
 * still running and refreshes every few seconds, so the header also encodes
 * the completion state instead of only counts.
 *
 * Typography (design language, ./ui.ts): one header line — icon, bold title,
 * progress bar + done/total meta; completed items are struck through so the
 * remaining work pops without reading status tags.
 */
import { pendingTodoCount, renderTodos, type TodoView } from "../harness/adapters/todos.js";
import { DOT, bold, headerLine, progressBar } from "./ui.js";

/** Todo card renderer shared by the initial open and the periodic refresh. */
export function renderTodosCard(todos: readonly TodoView[], hasLiveAgent: boolean): string {
  const pending = pendingTodoCount(todos);
  const completed = todos.length - pending;
  const complete = pending === 0 && todos.length > 0;
  // The icon itself carries the state: ✅ catches the eye in chat history
  // once everything is done, 📌 otherwise.
  const icon = complete ? "\u2705" : "\u{1F4CC}";
  const titleMeta = !hasLiveAgent ? "No live agent" : complete ? `complete${DOT}${bold(`${completed}/${todos.length} done`)}` : `${pending} pending${DOT}${todos.length} total`;
  const lines = [
    headerLine(icon, "Todos", titleMeta),
    "",
    ...(todos.length === 0 ? ["(no todos yet)"] : renderTodos(todos).split("\n")),
    ...(todos.length > 1 ? ["", progressBar(completed, todos.length)] : []),
    "",
    hasLiveAgent
      ? "Auto-refreshes every 5s while this card stays open."
      : "No live agent \u2014 todos are session-scoped.",
  ];
  return lines.join("\n");
}
