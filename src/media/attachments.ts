/**
 * Media/attachment handlers for dsh-telegram.
 *
 * Outbound: agent-requested workspace file delivery (issue #25), routed to
 * sendPhoto/sendVoice/sendAudio/sendDocument by file extension.
 * Inbound: photo / media-group / document / voice dispatch into the bridge.
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * (state, transport/ctx accessors, UI seams) arrive through one deps object
 * so this module owns no mutable wiring of its own.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { TelegramConfig } from "../config.js";
import type { Bridge } from "../harness/bridge.js";
import { saveImageAttachment, type SessionLifecycle } from "../harness/adapters/sessions.js";
import { saveDocumentAttachment, transcribeVoice } from "../harness/adapters/media.js";
import { plain } from "../telegram/html.js";
import type { TelegramTransport } from "../telegram/transport.js";

/** Structural slice of the plugin-root state singleton this module reads.
 * index.ts passes its live `state` object; hot-applied config and rebinding
 * are observed through the same reference without rewiring. */
interface AttachmentStateSlice {
  /** Chats that passed the whitelist gate (roster checks + delivery targets). */
  readonly chats: Set<number>;
  /** Active project root; outbound paths must stay inside it. */
  workspaceRoot: string;
  /** Live config (model default, media.transcribe). */
  config: TelegramConfig;
  /** Chat↔agent bridge (delivery + reverse lookups). Undefined while unmounted. */
  readonly bridge: Bridge | undefined;
}

export interface AttachmentHandlersDeps {
  state: AttachmentStateSlice;
  requireTransport(): TelegramTransport;
  requireCtx(): Context;
  uiSend(chatId: number, text: string, options?: Parameters<TelegramTransport["sendText"]>[2]): Promise<number | undefined>;
  currentAgent(chatId?: number): Agent | undefined;
  createSessionForChat(
    chatId: number,
    model?: { provider?: string; model?: string },
    agentPreset?: string,
    onlyIfUnbound?: boolean,
  ): Promise<ReturnType<SessionLifecycle["create"]>>;
  bindCreatedSession(chatId: number, agentId: string | undefined): boolean;
  scheduleBarSync(chatId: number, delayMs?: number): void;
}

/** Agent outbound attachments (issue #25): 1-10 workspace files, 50MB each,
 * routed to sendPhoto/sendVoice/sendAudio/sendDocument by file extension. */
const ATTACH_MAX_COUNT = 10;
const ATTACH_MAX_BYTES = 50 * 1024 * 1024;
const ATTACH_PHOTO_EXTENSIONS = new Set(["jpg", "jpeg", "png"]);
const ATTACH_VOICE_EXTENSIONS = new Set(["ogg", "opus"]);
const ATTACH_AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "wav", "flac"]);

function attachExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

function attachWithinWorkspace(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Build the outbound + inbound attachment handlers. Called once by index.ts;
 * every handler closes over the shared deps like the previous module-scope
 * closures did over index.ts singletons. */
export function makeAttachmentHandlers(deps: AttachmentHandlersDeps): {
  sendWorkspaceAttachments: (args: { paths?: unknown; chatId?: unknown; caption?: unknown }, exec: ToolRunContext) => Promise<string>;
  ensureChatAgent: (chatId: number) => Promise<Agent | undefined>;
  dispatchPhoto: (chatId: number, fileId: string, caption: string, messageId?: number) => Promise<void>;
  dispatchPhotos: (chatId: number, photos: readonly { fileId: string; caption: string; messageId?: number }[]) => Promise<void>;
  dispatchDocument: (chatId: number, kind: "document" | "voice" | "video", fileId: string, name: string, mimeType: string, messageId?: number) => Promise<void>;
} {
  const { state, requireTransport, requireCtx, uiSend, currentAgent, createSessionForChat, bindCreatedSession, scheduleBarSync } = deps;

  async function sendWorkspaceAttachments(
    args: { paths?: unknown; chatId?: unknown; caption?: unknown },
    exec: ToolRunContext,
  ): Promise<string> {
    const paths = Array.isArray(args.paths) ? args.paths.filter((entry): entry is string => typeof entry === "string") : [];
    if (!Array.isArray(args.paths)) return JSON.stringify({ ok: false, error: "paths must be an array of 1-10 workspace-relative file paths" });
    if (paths.length < 1 || paths.length > ATTACH_MAX_COUNT) {
      return JSON.stringify({ ok: false, error: `paths must contain 1-10 entries, got ${paths.length}` });
    }
    const agentId = exec.agent?.id === undefined ? undefined : String(exec.agent.id);
    const fallbackAgentId = agentId ?? state.bridge?.currentAgentIdValue();
    const resolvedChat = args.chatId !== undefined ? Number(args.chatId) : (fallbackAgentId !== undefined ? state.bridge?.chatIdForAgent(fallbackAgentId) : undefined);
    if (resolvedChat === undefined || !Number.isInteger(resolvedChat) || !state.chats.has(resolvedChat)) {
      return JSON.stringify({
        ok: false,
        error:
          args.chatId !== undefined
            ? `chat ${args.chatId} is not in the allowed roster`
            : "no bound Telegram chat context \u2014 pass chatId explicitly",
      });
    }
    const t = requireTransport();
    const root = resolve(state.workspaceRoot);
    const results: { path: string; ok: boolean; method?: string; messageId?: number | null; bytes?: number; error?: string }[] = [];
    for (const rel of paths) {
      const abs = resolve(root, rel);
      try {
        if (!attachWithinWorkspace(root, abs)) {
          results.push({ path: rel, ok: false, error: "path is outside the workspace root" });
          continue;
        }
        const info = await stat(abs);
        if (!info.isFile()) {
          results.push({ path: rel, ok: false, error: "not a file" });
          continue;
        }
        if (info.size > ATTACH_MAX_BYTES) {
          results.push({ path: rel, ok: false, error: `exceeds the ${ATTACH_MAX_BYTES / (1024 * 1024)}MB Telegram limit` });
          continue;
        }
        const buffer = await readFile(abs);
        const filename = basename(abs);
        const ext = attachExtension(filename);
        const caption = typeof args.caption === "string" && args.caption !== "" ? args.caption : undefined;
        let method: string;
        let messageId: number | undefined;
        if (ATTACH_PHOTO_EXTENSIONS.has(ext)) {
          method = "sendPhoto";
          messageId = await t.sendPhoto(resolvedChat, buffer, filename, caption);
        } else if (ATTACH_VOICE_EXTENSIONS.has(ext)) {
          method = "sendVoice";
          messageId = await t.sendVoice(resolvedChat, buffer, filename, caption);
        } else if (ATTACH_AUDIO_EXTENSIONS.has(ext)) {
          method = "sendAudio";
          messageId = await t.sendAudio(resolvedChat, buffer, filename, caption);
        } else {
          method = "sendDocument";
          messageId = await t.sendDocument(resolvedChat, buffer, filename, caption);
        }
        results.push({ path: rel, ok: messageId !== undefined, method, messageId: messageId ?? null, bytes: buffer.length });
      } catch (err) {
        results.push({ path: rel, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return JSON.stringify({ ok: results.length > 0 && results.every((entry) => entry.ok), results });
  }

  /** Ensure this chat has a live agent for media delivery; first media starts
   * its own session, same as first text. */
  async function ensureChatAgent(chatId: number): Promise<Agent | undefined> {
    let agent = currentAgent(chatId);
    if (agent) return agent;
    const created = await createSessionForChat(chatId, state.config.model, undefined, true);
    if (!created.result.ok || created.agentId === undefined) {
      await uiSend(chatId, `\u274C ${plain(created.result.text)}`, { parse_mode: "HTML" });
      return undefined;
    }
    bindCreatedSession(chatId, created.agentId);
    agent = currentAgent(chatId);
    if (!agent) await uiSend(chatId, "\u274C No live agent in this session.", { parse_mode: "HTML" });
    return agent;
  }

  async function dispatchPhoto(chatId: number, fileId: string, caption: string, messageId?: number): Promise<void> {
    return dispatchPhotos(chatId, [{ fileId, caption, messageId }]);
  }

  /** Media-group batch: N images become ONE user turn (issue #9). */
  async function dispatchPhotos(chatId: number, photos: readonly { fileId: string; caption: string; messageId?: number }[]): Promise<void> {
    const t = requireTransport();
    const agent = await ensureChatAgent(chatId);
    if (!agent) return;
    const downloads = await Promise.all(photos.slice(0, 10).map(async (photo) => ({ ...photo, data: await t.downloadFile(photo.fileId) })));
    if (downloads.some((photo) => !photo.data)) {
      await uiSend(chatId, "\u274C One or more photo downloads failed \u2014 nothing was delivered.", { parse_mode: "HTML" });
      return;
    }
    const attachments: NonNullable<Awaited<ReturnType<typeof saveImageAttachment>>["attachment"]>[] = [];
    for (const photo of downloads) {
      const saved = await saveImageAttachment(requireCtx(), photo.data!, "image/jpeg", `telegram-${photo.fileId}.jpg`);
      if (!saved.ok || !saved.attachment) {
        await uiSend(chatId, `\u274C ${plain(saved.text)}`, { parse_mode: "HTML" });
        return;
      }
      attachments.push(saved.attachment);
    }
    const caption = photos.map((photo) => photo.caption).find((entry) => entry.trim() !== "") ?? "";
    const firstId = photos[0]?.messageId;
    const res = state.bridge?.deliverImages(chatId, attachments, caption, firstId);
    if (res && !res.ok) await uiSend(chatId, `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
    else {
      await uiSend(chatId, `\u{1F4F7} ${plain(res?.text ?? "Images delivered.")} \u00B7 ${attachments.length} images \u00B7 /attachment ${plain(attachments.map((entry) => entry.attachmentId).join(" "))}`, { parse_mode: "HTML" });
      scheduleBarSync(chatId, 0);
    }
  }

  async function dispatchDocument(chatId: number, kind: "document" | "voice" | "video", fileId: string, name: string, mimeType: string, messageId?: number): Promise<void> {
    const t = requireTransport();
    const agent = await ensureChatAgent(chatId);
    if (!agent) return;
    const data = await t.downloadFile(fileId);
    if (!data) {
      await uiSend(chatId, `\u274C ${plain(kind)} download failed.`, { parse_mode: "HTML" });
      return;
    }
    if (kind === "voice") {
      const transcribed = await transcribeVoice(data, "voice.ogg", state.config.media?.transcribe);
      if (!transcribed.ok || transcribed.transcript === undefined) {
        await uiSend(chatId, `\u274C ${plain(transcribed.text)}`, { parse_mode: "HTML" });
        return;
      }
      await uiSend(chatId, `\u{1F399}\uFE0F \u8F6C\u5199: ${plain(transcribed.transcript)}`, { parse_mode: "HTML" });
      const delivered = state.bridge!.deliver(chatId, transcribed.transcript, messageId);
      if (!delivered.ok) await uiSend(chatId, `\u274C ${plain(delivered.text)}`, { parse_mode: "HTML" });
      else scheduleBarSync(chatId, 0);
      return;
    }
    const saved = await saveDocumentAttachment(agent.id, data, name || `${kind}.bin`);
    if (!saved.ok || saved.path === undefined) {
      await uiSend(chatId, `\u274C ${plain(saved.text)}`, { parse_mode: "HTML" });
      return;
    }
    await uiSend(chatId, plain(saved.text), { parse_mode: "HTML" });
    const prompt = `\u{1F4CE} Telegram ${kind} saved to ${saved.path} (${data.byteLength} bytes, ${mimeType || "unknown type"}) \u2014 read and process it.`;
    const delivered = state.bridge!.deliver(chatId, prompt, messageId);
    if (!delivered.ok) await uiSend(chatId, `\u274C ${plain(delivered.text)}`, { parse_mode: "HTML" });
    else scheduleBarSync(chatId, 0);
  }

  return { sendWorkspaceAttachments, ensureChatAgent, dispatchPhoto, dispatchPhotos, dispatchDocument };
}
