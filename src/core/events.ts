/**
 * Harness-event subscriptions for dsh-telegram.
 *
 * Forwards cordis session/host events into the bridge and the panel/card
 * refresh paths:
 *   - `session/event`: turn/end bar+card sync and incremental todo cards.
 *   - Web-forwarded (`FORWARDED_EVENT_NAMES`) and underlying host
 *     (`HOST_EVENT_NAMES`) events: refresh-only panel/card re-reads.
 *   - `session/disposed`: bounded per-session bookkeeping drops.
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object; the caller owns the disposer list.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Bridge } from "../harness/bridge.js";
import { normalizeTodos, type TodoView } from "../harness/adapters/todos.js";
import { forgetStatusSession } from "../harness/adapters/status.js";

/** Structural slice of the plugin-root state singleton this module reads. */
interface SessionEventsStateSlice {
  /** Chat↔agent bridge (agent→chat reverse lookups). Undefined while unmounted. */
  readonly bridge: Bridge | undefined;
}

export interface SessionEventsDeps {
  state: SessionEventsStateSlice;
  /** Latest durable todo snapshot per chat (todo/write is whole-list). */
  todoSnapshots: Map<number, TodoView[]>;
  /** Live subagent counts per agent id (dropped on session/disposed). */
  statusSubagentCounts: Map<string, number>;
  refreshActiveCards(): void;
  refreshAllPanels(): void;
  scheduleBarSync(chatId: number, delayMs?: number): void;
  notifyTodoChange(chatId: number, previous: readonly TodoView[], next: readonly TodoView[]): void;
}

/** Web `ApiProxy.events.host` also forwards these remote-service events. */
const FORWARDED_EVENT_NAMES = [
  "agent-preset/selected",
  "commands/change",
  "credentials/updated",
  "settings/document-updated",
  "llm/adapters-updated",
  "cordis/request-run",
  "cordis/request-run-resolved",
  "cordis/dynamic-package",
  "cordis/dynamic-retract",
  "cordis/inspect-query",
  "cordis/inspect-query-resolved",
] as const;

/** Underlying cordis events that the web projects into `events.host` frames. */
const HOST_EVENT_NAMES = ["session/created", "session/disposed", "agent/error", "domain/changed"] as const;

/** Subscribe every harness-event forwarding listener. Returns the disposers
 * in registration order; index.ts pushes them into its teardown list so hot
 * unplug reverses exactly what this mounted. */
export function attachSessionEvents(ctx: Context, deps: SessionEventsDeps): (() => void)[] {
  const { state, todoSnapshots, statusSubagentCounts, refreshActiveCards, refreshAllPanels, scheduleBarSync, notifyTodoChange } = deps;
  const refreshEventDisposers: (() => void)[] = [];

  // Incremental todo cards + live bar count (issue #10). The first durable
  // snapshot only primes the baseline. turn/end also refreshes the open
  // Todo card immediately instead of waiting for the next 5s tick (#14).
  refreshEventDisposers.push(
    (ctx.on.bind(ctx) as (name: string, listener: (...args: unknown[]) => void) => () => void)("session/event", (...args: unknown[]) => {
      const session = args[0] as { id: unknown };
      const event = args[1] as { type?: string; data?: { todos?: readonly TodoView[] } };
      const chatId = state.bridge?.chatIdForAgent(String(session.id));
      if (chatId === undefined) return;
      if (event.type === "turn/end") {
        refreshActiveCards();
        scheduleBarSync(chatId, 0);
        return;
      }
      if (event.type !== "todo/write" || !Array.isArray(event.data?.todos)) return;
      const next = normalizeTodos(event.data.todos);
      const hadBaseline = todoSnapshots.has(chatId);
      const previous = todoSnapshots.get(chatId) ?? [];
      todoSnapshots.set(chatId, next);
      if (hadBaseline) notifyTodoChange(chatId, previous, next);
      refreshActiveCards();
      scheduleBarSync(chatId, 0);
    }),
  );

  // Refresh-only subscribers for the events the web forwards over
  // events.mux/events.host: open panels re-read their data source, closed
  // chats get no message. Waterfall events keep flowing (we return void).
  const onRefreshEvent = ctx.on.bind(ctx) as (name: string, listener: (...args: unknown[]) => void) => () => void;
  for (const name of FORWARDED_EVENT_NAMES) {
    refreshEventDisposers.push(
      onRefreshEvent(name, () => {
        refreshAllPanels();
        refreshActiveCards();
      }),
    );
  }
  for (const name of HOST_EVENT_NAMES) {
    refreshEventDisposers.push(
      onRefreshEvent(name, () => {
        refreshAllPanels();
        refreshActiveCards();
      }),
    );
  }
  // Bounded per-session bookkeeping (LOOP_AUDIT #8): drop live counters as
  // soon as the harness reports the session disposed.
  refreshEventDisposers.push(
    onRefreshEvent("session/disposed", (...args: unknown[]) => {
      const session = args[0] as { id?: unknown } | undefined;
      if (session?.id === undefined) return;
      const id = String(session.id);
      forgetStatusSession(id);
      statusSubagentCounts.delete(id);
      const chatId = state.bridge?.chatIdForAgent(id);
      if (chatId !== undefined) todoSnapshots.delete(chatId);
    }),
  );

  return refreshEventDisposers;
}
