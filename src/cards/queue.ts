/**
 * Queue card for dsh-telegram.
 *
 * Renders the bound agent's inbox queue (next-turn/step items) plus the live
 * goal-progress line and outbound send backlog for the chat.
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object so this module owns no mutable wiring of
 * its own.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { listQueue } from "../harness/adapters/sessions.js";
import { statusSnapshot } from "../harness/adapters/status.js";
import { plain, truncate } from "../telegram/html.js";
import type { ProgressSnapshot } from "../telegram/goal-progress.js";
import type { TelegramTransport } from "../telegram/transport.js";
import { buildQueueKeyboard } from "../telegram/keyboard.js";
import type { OpenCard } from "../core/cards.js";

/** Structural slice of the plugin-root state singleton this module reads. */
interface QueueCardsStateSlice {
  /** Live transport (outbound send backlog). Undefined while unmounted. */
  readonly transport: TelegramTransport | undefined;
}

export interface QueueCardsDeps {
  state: QueueCardsStateSlice;
  requireCtx(): Context;
  currentAgent(chatId?: number): Agent | undefined;
  boundAgentId(chatId?: number): string | undefined;
  progressFor(chatId: number): ProgressSnapshot | undefined;
  openCard: OpenCard;
}

/** Build the queue card. Called once by index.ts; the card closes over the
 * shared deps like the previous module-scope closure did over index.ts
 * singletons. */
export function createQueueCards(deps: QueueCardsDeps): {
  openQueueCard(chatId: number): Promise<void>;
} {
  const { state, requireCtx, currentAgent, boundAgentId, progressFor, openCard } = deps;

  async function openQueueCard(chatId: number): Promise<void> {
    const ctx = requireCtx();
    const agent = currentAgent(chatId);
    const snapshot = statusSnapshot(ctx, boundAgentId(chatId), false);
    const items = agent ? listQueue(ctx, agent.id) : [];
    const progress = progressFor(chatId);
    const lines = [`\u231B Queue`, "", `Agent inbox: ${snapshot.queue} \u00B7 Outbound sends pending: ${state.transport?.pending() ?? 0}`];
    if (progress !== undefined) {
      const seconds = Math.max(1, Math.round(progress.elapsedMs / 1000));
      const eta = progress.todosDone > 0 && progress.todosTotal > progress.todosDone
        ? ` \u00B7 ETA ~${Math.max(1, Math.round((progress.elapsedMs / progress.todosDone) * (progress.todosTotal - progress.todosDone) / 1000))}s`
        : "";
      lines.push(`\u{1F3AF} ${plain(truncate(progress.objective, 40))} \u00B7 step ${progress.step} \u00B7 tools ${progress.tools}${progress.currentTool ? ` \u00B7 now: ${plain(truncate(progress.currentTool, 24))}` : ""} \u00B7 \u23F1\uFE0F ${seconds}s${eta}`);
    }
    lines.push("");
    items.slice(0, 12).forEach((item, index) => {
      const kind = item.target === "next-turn" ? "turn" : "step";
      const preview = item.text.trim().replace(/\s+/g, " ") || "(no text)";
      lines.push(`#${index + 1} \u00B7 ${kind} \u00B7 ${plain(truncate(preview, 60))}`);
    });
    if (items.length === 0) {
      lines.push("(nothing pending)", "", "\u{1F4A1} \u8FDE\u7EED\u53D1\u4E24\u6761\u6D88\u606F\uFF0C\u7B2C\u4E8C\u6761\u4F1A\u6392\u961F\uFF0C\u6BCF\u6761\u90FD\u6709 \u270F/\u{1F5D1}/\u26A1 \u6309\u94AE\u3002");
    } else {
      lines.push("", "\u270F \u7F16\u8F91 \u00B7 \u{1F5D1} \u5220\u9664 \u00B7 \u26A1 \u7ACB\u5373\u6267\u884C(\u4EC5 next-turn) \u2014 \u6309\u4E0B\u65B9\u6309\u94AE\u64CD\u4F5C");
    }
    await openCard(
      chatId,
      lines.join("\n"),
      buildQueueKeyboard(items.map((item, index) => ({ itemId: item.itemId, kind: item.target, index }))),
    );
  }

  return { openQueueCard };
}
