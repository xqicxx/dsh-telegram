/**
 * Todo domain over the durable `todo/write` session event. The schema is
 * minimal (content + status), so priority is derived from common text tags
 * (`[P0]`/`high`/🔴…) for display only — never invented into the model list.
 */
import type { Context } from "@deepseek-ai/cordis";

export interface TodoView {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TodoDiff {
  added: TodoView[];
  started: TodoView[];
  completed: TodoView[];
  remaining: number;
}

interface EventLike {
  type?: string;
  data?: { todos?: readonly TodoView[] };
}

/** Normalize the durable whole-list payload into stable TodoView objects. */
export function normalizeTodos(todos: readonly TodoView[]): TodoView[] {
  return todos.map((todo) => ({
    content: typeof todo.content === "string" ? todo.content : String(todo.content ?? ""),
    status: todo.status === "completed" || todo.status === "in_progress" ? todo.status : "pending",
  }));
}

/**
 * Incremental cache for `listTodos` (issue #14): session event lists are
 * append-only and can reach thousands of entries, so the common case must not
 * re-scan the whole array for every bar sync / 5-second card refresh. The
 * first call scans once and records the scanned end index; later calls only
 * inspect newly appended events.
 *
 * Keyed by the EVENTS ARRAY object itself, not the agent: a compaction/reset
 * can swap in a fresh array with the SAME length, which a length-only check
 * would silently accept as "nothing appended" and serve stale todos. With
 * identity keying any replaced array misses the cache and forces one full
 * re-scan; scannedEnd still short-circuits pure appends on the same array.
 */
const todoListCache = new WeakMap<object, { scannedEnd: number; todos: TodoView[] }>();

/** Latest whole-list snapshot for one live agent (last write wins). */
export function listTodos(ctx: Context, agentId: string): TodoView[] {
  const agent = ctx.agents?.get(agentId as never) as unknown as
    | { session?: { events?: readonly EventLike[] } }
    | undefined;
  const events = agent?.session?.events;
  if (!events) return [];
  const end = events.length - 1;
  const cached = todoListCache.get(events);
  if (cached !== undefined && cached.scannedEnd === end) return cached.todos;

  if (cached !== undefined && cached.scannedEnd < end) {
    // Only the newly appended tail can contain a newer todo/write event.
    for (let index = end; index > cached.scannedEnd; index -= 1) {
      const event = events[index];
      if (event?.type === "todo/write" && Array.isArray(event.data?.todos)) {
        const todos = normalizeTodos(event.data.todos);
        todoListCache.set(events, { scannedEnd: end, todos });
        return todos;
      }
    }
    return cached.todos;
  }

  // First scan on this array, or the events array was REPLACED at any length
  // (compaction/reset): walk the whole array once and cache the result,
  // including the empty result.
  for (let index = end; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "todo/write" && Array.isArray(event.data?.todos)) {
      const todos = normalizeTodos(event.data.todos);
      todoListCache.set(events, { scannedEnd: end, todos });
      return todos;
    }
  }
  todoListCache.set(events, { scannedEnd: end, todos: [] });
  return [];
}

/** Incomplete tasks only — the bar counter measures remaining work. */
export function pendingTodoCount(todos: readonly TodoView[]): number {
  return todos.filter((todo) => todo.status !== "completed").length;
}

/** Compact diff for the notification card (stable order, statuses only). */
export function diffTodos(previous: readonly TodoView[], next: readonly TodoView[]): TodoDiff {
  const previousByContent = new Map(previous.map((todo) => [todo.content, todo] as const));
  const added = next.filter((todo) => !previousByContent.has(todo.content));
  const started = next.filter((todo) => todo.status === "in_progress" && previousByContent.get(todo.content)?.status === "pending");
  const completed = next.filter((todo) => todo.status === "completed" && previousByContent.get(todo.content)?.status !== "completed");
  return {
    added,
    started,
    completed,
    remaining: pendingTodoCount(next),
  };
}

const PRIORITY_HIGH = /(?:^|[^A-Za-z0-9])(?:🔴|P0|high|urgent|紧急|高)(?:[^A-Za-z0-9]|$)/i;
const PRIORITY_MEDIUM = /(?:^|[^A-Za-z0-9])(?:🟡|P1|medium|中)(?:[^A-Za-z0-9]|$)/i;

/** Display priority tag; absent from the durable schema, so this only colors
 * the Telegram card and never mutates the todo list. */
export function todoPriority(content: string): "high" | "medium" | "low" {
  if (PRIORITY_HIGH.test(content)) return "high";
  if (PRIORITY_MEDIUM.test(content)) return "medium";
  return "low";
}

export function todoIcon(todo: TodoView): string {
  if (todo.status === "completed") return "\u2705";
  if (todo.status === "in_progress") return "\u23F3";
  return todoPriority(todo.content) === "high" ? "\u{1F534}" : todoPriority(todo.content) === "medium" ? "\u{1F7E1}" : "\u{1F7E2}";
}

/** One-line card renderer shared by /todo and the todo card. */
export function renderTodos(todos: readonly TodoView[]): string {
  if (todos.length === 0) return "(no todos yet)";
  return todos
    .map((todo) => {
      const tag = todo.status === "completed" ? "[completed]" : todo.status === "in_progress" ? "[in_progress]" : "[pending]";
      const priority = todo.status === "completed" ? "" : ` \u00B7 ${todoPriority(todo.content)}`;
      return `${todoIcon(todo)} ${todo.content} \u00B7 ${tag}${priority}`;
    })
    .join("\n");
}
