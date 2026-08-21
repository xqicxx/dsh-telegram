/**
 * Model-tool registration for dsh-telegram.
 *
 * Registers the agent-facing tools on `ctx.tools`:
 *   telegram_send / telegram_reply / telegram_broadcast / telegram_status /
 *   telegram_mark_no_reply, plus the outbound attachment pair
 *   telegram_attach / telegram_send_file (handlers from media/attachments).
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object provided by index.ts at the original
 * registration site inside apply().
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Bridge } from "../harness/bridge.js";
import type { TelegramTransport } from "../telegram/transport.js";

/** Structural slice of the plugin-root state singleton this module reads. */
interface ToolsStateSlice {
  /** Chats that passed the whitelist gate (roster checks for send/broadcast). */
  readonly chats: Set<number>;
  /** Chat↔agent bridge (inbound routing for reply / mark-no-reply). */
  readonly bridge: Bridge | undefined;
}

export interface TelegramToolsDeps {
  state: ToolsStateSlice;
  requireTransport(): TelegramTransport;
  renderStatus(): string;
  sendWorkspaceAttachments(args: { paths?: unknown; chatId?: unknown; caption?: unknown }, exec: ToolRunContext): Promise<string>;
}

function textOutput() {
  return {
    schema: { type: "string" as const },
    render: (_args: Record<string, unknown>, value: string) => [{ type: "text" as const, text: value }],
  };
}

/** Register every built-in model tool. Called once by index.ts inside apply();
 * tool names, descriptions, parameters and result payloads are unchanged. */
export function registerTelegramTools(ctx: Context, deps: TelegramToolsDeps): void {
  const { state, requireTransport, renderStatus, sendWorkspaceAttachments } = deps;

  ctx.tools.register(defineTool({
    name: "telegram_send",
    description: "Send an HTML message to one Telegram chat the bridge knows about.",
    parameters: {
      chatId: { type: "string", required: true, description: "Target chat id." },
      text: { type: "string", required: true, description: "Message body (HTML)." },
      disableNotification: { type: "boolean", description: "Send silently." },
    },
    output: textOutput(),
    async execute(args) {
      const chatId = Number(args.chatId);
      if (!Number.isInteger(chatId) || !state.chats.has(chatId)) {
        return JSON.stringify({ ok: false, error: `chat ${args.chatId} is not in the allowed roster` });
      }
      const t = requireTransport();
      const id = await t.sendText(chatId, args.text, {
        parse_mode: "HTML",
        disable_notification: args.disableNotification === true,
      });
      return JSON.stringify({ ok: true, messageId: id ?? null });
    },
  }));

  // Agent outbound attachments (#25). `telegram_attach` matches pi-telegram's
  // tool name for cross-project agent migration; `telegram_send_file` is the
  // original issue name kept as a drop-in alias.
  const attachToolParameters = {
    paths: {
      type: "array" as const,
      required: true as const,
      items: { type: "string" as const, description: "Workspace-relative file path (1-10 entries)." },
      description: "One or more local files under the workspace root.",
    },
    chatId: { type: "string" as const, description: "Target chat id. Defaults to the executing agent's bound Telegram chat." },
    caption: { type: "string" as const, description: "Optional caption shown above the file (HTML)." },
  };
  ctx.tools.register(defineTool({
    name: "telegram_attach",
    description: "Send 1-10 workspace files to a Telegram chat. Images (.jpg/.jpeg/.png) go as photos, .ogg/.opus as voice notes, other audio as audio, and everything else as a document. Paths outside the workspace root or chats outside the allowed roster are rejected.",
    parameters: attachToolParameters,
    output: textOutput(),
    async execute(args, exec) {
      return sendWorkspaceAttachments(args, exec);
    },
  }));
  ctx.tools.register(defineTool({
    name: "telegram_send_file",
    description: "Alias of telegram_attach: send 1-10 workspace files to a Telegram chat as photo/voice/audio/document by extension.",
    parameters: attachToolParameters,
    output: textOutput(),
    async execute(args, exec) {
      return sendWorkspaceAttachments(args, exec);
    },
  }));

  ctx.tools.register(defineTool({
    name: "telegram_reply",
    description: "Reply to the current inbound Telegram message. Fails when there is no pending inbound message.",
    parameters: {
      text: { type: "string", required: true, description: "Reply body (HTML)." },
      disableNotification: { type: "boolean", description: "Send silently." },
    },
    output: textOutput(),
    async execute(args, exec: ToolRunContext) {
      const bridge = state.bridge;
      // Route by the calling agent, not by the most-recently-touched chat:
      // two sessions in two chats may run telegram_reply concurrently.
      const agentId = exec.agent?.id === undefined ? undefined : String(exec.agent.id);
      const inbound = agentId !== undefined ? bridge?.inboundForAgent(agentId) : undefined;
      if (!bridge || !inbound) throw new Error(agentId === undefined ? "no agent context for telegram_reply" : "no active inbound message");
      await bridge.sendOutbound(inbound.chatId, args.text, {
        replyToInbound: true,
        parseMode: "HTML",
        disableNotification: args.disableNotification === true,
      });
      return JSON.stringify({ ok: true, chatId: inbound.chatId });
    },
  }));

  ctx.tools.register(defineTool({
    name: "telegram_broadcast",
    description: "Send the same HTML message to several Telegram chats concurrently.",
    parameters: {
      targets: {
        type: "array",
        required: true,
        items: {
          type: "object",
          additionalProperties: false,
          properties: { chatId: { type: "string", required: true, description: "Target chat id." } },
        },
      },
      text: { type: "string", required: true, description: "Message body (HTML)." },
    },
    output: textOutput(),
    async execute(args) {
      const t = requireTransport();
      const targets = (args.targets as { chatId?: string }[]).map((x) => x.chatId).filter((x): x is string => typeof x === "string");
      const results = await Promise.all(
        targets.map(async (chatId) => {
          const numeric = Number(chatId);
          if (!Number.isInteger(numeric) || !state.chats.has(numeric)) {
            return { chatId, ok: false, error: "chat is not in the allowed roster" };
          }
          try {
            const id = await t.sendText(numeric, args.text, { parse_mode: "HTML" });
            return { chatId, ok: true, messageId: id ?? null };
          } catch (err) {
            return { chatId, ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );
      return JSON.stringify({ ok: results.length > 0 && results.every((r) => r.ok), results });
    },
  }));

  ctx.tools.register(defineTool({
    name: "telegram_status",
    description: "Report the bridge's current state: bot connectivity, agent status, inbox queue, and known chats.",
    parameters: {},
    output: textOutput(),
    async execute() {
      return renderStatus();
    },
  }));

  ctx.tools.register(defineTool({
    name: "telegram_mark_no_reply",
    description: "Mark the current inbound Telegram message as intentionally not replied.",
    parameters: {
      reason: { type: "string", description: "Optional reason (not sent to the chat)." },
    },
    output: textOutput(),
    async execute(args, exec: ToolRunContext) {
      const bridge = state.bridge;
      const agentId = exec.agent?.id === undefined ? undefined : String(exec.agent.id);
      const inbound = agentId !== undefined ? bridge?.inboundForAgent(agentId) : undefined;
      if (!bridge || !inbound) return JSON.stringify({ ok: false, text: agentId === undefined ? "no agent context for telegram_mark_no_reply" : "no active inbound message for this agent" });
      return JSON.stringify(bridge.markNoReply(args.reason ?? undefined, inbound.chatId));
    },
  }));
}
