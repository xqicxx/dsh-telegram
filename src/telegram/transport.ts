/**
 * Telegram Bot API access, following the official docs:
 *
 * - getUpdates long polling with `allowed_updates` narrowed to `message` and
 *   `callback_query` so the bot never pays for update kinds it does not use;
 * - HTML parse mode with all user content escaped upstream;
 * - every outbound call flows through the per-chat serial + global rate-limit
 *   queue, so the dsh agent loop is never blocked by network I/O.
 */
import { Bot, GrammyError, InputFile, type Api } from "grammy";
import { splitText } from "./html.js";
import { buildBarKeyboard } from "./keyboard.js";
import { SendQueue } from "./queue.js";

/** Bound one Bot API call: a hung connection must not wedge the send chain. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`telegram api timeout after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export type UnsupportedMediaKind = "document" | "voice" | "video";

export interface TransportHandlers {
  onText: (chatId: number, text: string, messageId?: number) => void | Promise<void>;
  onPhoto: (chatId: number, fileId: string, caption: string, messageId?: number) => void | Promise<void>;
  /** Media-group batches arrive as several message updates with one
   * `media_group_id`; the router gets one ordered batch per group. */
  onPhotos?: (chatId: number, photos: readonly { fileId: string; caption: string; messageId?: number }[], groupId?: string) => void | Promise<void>;
  onCallback: (chatId: number, data: string) => void | Promise<void>;
  /** Voice is transcribed (when configured), other documents are saved to
   * the session attachments directory. */
  onDocument?: (chatId: number, kind: UnsupportedMediaKind, fileId: string, name: string, mimeType: string, messageId?: number) => void | Promise<void>;
}

export interface TransportOptions {
  token: string;
  queue?: SendQueue;
  maxMessageLength?: number;
  log?: (message: string, error?: unknown) => void;
  /** Injectable backoff timer (tests observe/advance polling delays). */
  sleep?: (ms: number) => Promise<void>;
}

type SendOptions = NonNullable<Parameters<Api["sendMessage"]>[2]>;
type EditOptions = NonNullable<Parameters<Api["editMessageText"]>[3]>;

/** Bot API callback_query has no top-level `chat`; the chat lives on
 * `callback_query.message.chat`. Extracted so a unit test can lock this —
 * reading `callback.chat` silently dropped every inline tap (spinner stuck). */
export function callbackUpdateChatId(callback: {
  chat?: { id?: number };
  message?: { chat?: { id?: number } };
}): number | undefined {
  return callback.message?.chat?.id ?? callback.chat?.id;
}

export class TelegramTransport {
  readonly bot: Bot;
  readonly api: Api;
  private readonly queue: SendQueue;
  private maxMessageLength: number;
  private readonly log: (message: string, error?: unknown) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  /** UI/control lane key: navigation cards, bar swaps and command acks must
   * never queue behind assistant streaming edits (issues #11/#12). */
  private static controlKey(chatId: number): string {
    return `control:${chatId}`;
  }
  private handlers: TransportHandlers | undefined;
  private me: { id: number; username: string } | undefined;
  private polling = false;
  private starting = false;
  /** Bumped on every stop so a start that was awaiting an old generation
   * can detect a stop that arrived while it was waiting. */
  private stopGeneration = 0;
  private pollAbort: AbortController | undefined;
  private pollLoop: Promise<void> | undefined;
  /** Last confirmed update id; preserved across stop/start generations so a
   * hot restart never asks Telegram to redeliver an already-seen batch. */
  private pollOffset = 0;
  /** Consecutive 409 "terminated by other getUpdates" failures. The loop
   * backs off instead of spamming and stops logging every single conflict. */
  private conflict409 = 0;
  /** Consecutive non-409 polling failures (502/timeout/network). Same
   * exponential backoff: the first failure logs, later ones stay quiet until
   * one successful poll resets the meter. */
  private pollingErrors = 0;

  constructor(options: TransportOptions) {
    this.bot = new Bot(options.token);
    this.api = this.bot.api;
    this.queue = options.queue ?? new SendQueue();
    this.maxMessageLength = options.maxMessageLength ?? 4096;
    this.log = options.log ?? ((m, e) => console.error(`[dsh-telegram] ${m}`, e ?? ""));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }

  /** Hot-update rate limits and payload length without restarting polling. */
  applyLimits(options: { maxPerWindow?: number; retry?: { attempts: number; baseDelayMs: number }; maxMessageLength?: number }): void {
    this.queue.configure({
      ...(options.maxPerWindow === undefined ? {} : { maxPerWindow: options.maxPerWindow }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
    });
    if (options.maxMessageLength !== undefined) this.maxMessageLength = options.maxMessageLength;
  }

  /** Route one raw update through the registered handlers. Callbacks are
   * answered first so the Telegram client stops showing the spinner. */
  private async handleUpdate(update: unknown): Promise<void> {
    const entry = update as {
      message?: {
        message_id?: number;
        chat?: { id?: number };
        text?: string;
        photo?: { file_id: string }[];
        caption?: string;
        document?: { file_id?: string; file_name?: string; mime_type?: string };
        voice?: { file_id?: string; mime_type?: string };
        video?: { file_id?: string; file_name?: string; mime_type?: string };
      };
      callback_query?: { chat?: { id?: number }; data?: string; id?: string; message?: { chat?: { id?: number } } };
    };
    if (!this.handlers) return;
    const message = entry.message;
    if (message?.chat?.id !== undefined && typeof message.text === "string") {
      this.log(`inbound text chatId=${message.chat.id} text=${JSON.stringify(message.text.slice(0, 80))}`);
      await this.handlers.onText(message.chat.id, message.text, message.message_id);
      return;
    }
    if (message?.chat?.id !== undefined && Array.isArray(message.photo) && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1]!;
      await this.handlers.onPhoto(message.chat.id, largest.file_id, message.caption ?? "", message.message_id);
      return;
    }
    if (message?.chat?.id !== undefined && this.handlers.onDocument !== undefined) {
      if (message.document !== undefined) {
        await this.handlers.onDocument(message.chat.id, "document", message.document.file_id ?? "", message.document.file_name ?? "document", message.document.mime_type ?? "", message.message_id);
        return;
      }
      if (message.voice !== undefined) {
        await this.handlers.onDocument(message.chat.id, "voice", message.voice.file_id ?? "", "voice message", message.voice.mime_type ?? "", message.message_id);
        return;
      }
      if (message.video !== undefined) {
        await this.handlers.onDocument(message.chat.id, "video", message.video.file_id ?? "", message.video.file_name ?? "video", message.video.mime_type ?? "", message.message_id);
        return;
      }
    }
    const callback = entry.callback_query;
    if (callback !== undefined) {
      // The chat lives on callback_query.message.chat — the callback_query
      // object itself has no top-level `chat` (Bot API shape). Reading
      // `callback.chat` here dropped every inline tap as `undefined`,
      // which made all inline buttons feel dead/stuck.
      const chatId = callbackUpdateChatId(callback);
      // Answer first: the Telegram client keeps a spinner until the callback
      // is acknowledged — without this every button feels dead.
      await withTimeout(this.api.answerCallbackQuery(callback.id ?? ""), 15_000).catch((err) =>
        this.log(`answerCallbackQuery FAILED err=${err instanceof Error ? err.message : String(err)}`, err),
      );
      if (callback.data === undefined || chatId === undefined) {
        this.log(`callback dropped: chat=${chatId} data=${String(callback.data ?? "").slice(0, 64)}`);
        return;
      }
      this.log(`inbound callback chatId=${chatId} data=${callback.data.slice(0, 64)}`);
      await this.handlers.onCallback(chatId, callback.data);
      return;
    }
  }

  /** Route one photo batch (single or media group). Legacy single-photo
   * consumers keep working when no `onPhotos` handler is mounted. */
  private async handlePhotos(chatId: number, photos: readonly { fileId: string; caption: string; messageId?: number }[], groupId?: string): Promise<void> {
    if (!this.handlers) return;
    const batch = photos.slice(0, 10);
    if (this.handlers.onPhotos !== undefined) {
      await this.handlers.onPhotos(chatId, batch, groupId);
      return;
    }
    for (const photo of batch) {
      await this.handlers.onPhoto(chatId, photo.fileId, photo.caption, photo.messageId);
    }
  }

  /** Own getUpdates loop with per-call timeout and automatic reconnect:
   * grammY's bot.start() silently dies on one network error (no way to
   * observe it), which surfaced as the bot going mute. This loop never
   * stops unless stop() is called.
   *
   * start/stop are restart-safe: starting aborts and awaits any previous
   * generation first, so a hot re-apply can never have two in-flight
   * getUpdates requests on the same bot token (the 409 "terminated by other
   * getUpdates request" failure). */
  async start(): Promise<void> {
    if (this.polling || this.starting) return;
    this.starting = true;
    const generation = this.stopGeneration;
    try {
      const previousAbort = this.pollAbort;
      previousAbort?.abort();
      const previousLoop = this.pollLoop;
      if (previousLoop) await previousLoop.catch(() => {});
      if (this.polling || this.stopGeneration !== generation) return;

      const abort = new AbortController();
      this.pollAbort = abort;
      this.polling = true;
      this.pollLoop = (async () => {
        while (this.polling && this.pollAbort === abort) {
          try {
            const updates = await withTimeout(
              // grammY re-exports an AbortSignal shim for older runtimes;
              // Node's native AbortController is compatible at runtime.
              this.api.getUpdates({ offset: this.pollOffset, timeout: 25, allowed_updates: ["message", "callback_query"] }, abort.signal as never),
              40_000,
            );
            // Media groups arrive as N message updates sharing one
            // media_group_id: route them as one ordered batch (issue #9).
            const groups = new Map<string, { chatId: number; groupId: string; photos: { fileId: string; caption: string; messageId?: number }[] }>();
            const batched = new Set<number>();
            updates.forEach((update, index) => {
              const message = (update as { message?: { media_group_id?: string; photo?: { file_id: string }[]; caption?: string; chat?: { id?: number }; message_id?: number } }).message;
              if (message?.chat?.id === undefined || !Array.isArray(message.photo) || message.photo.length === 0 || message.media_group_id === undefined) return;
              const key = `${message.chat.id}:${message.media_group_id}`;
              let group = groups.get(key);
              if (!group) {
                group = { chatId: message.chat.id, groupId: message.media_group_id, photos: [] };
                groups.set(key, group);
              }
              const largest = message.photo[message.photo.length - 1]!;
              group.photos.push({ fileId: largest.file_id, caption: message.caption ?? "", messageId: message.message_id });
              batched.add(index);
            });
            for (const group of groups.values()) {
              void this.handlePhotos(group.chatId, group.photos, group.groupId).catch((err) => this.log("photo batch handler failed", err));
            }
            updates.forEach((update, index) => {
              this.pollOffset = update.update_id + 1;
              if (batched.has(index)) return;
              // Never let a slow handler block the poll loop: an agent turn can
              // take minutes, and a serial await would freeze inbound traffic
              // (the "bot went mute" failure).
              void this.handleUpdate(update).catch((err) => this.log("update handler failed", err));
            });
            this.conflict409 = 0;
            this.pollingErrors = 0;
          } catch (err) {
            if (abort.signal.aborted) return;
            const code = (err as { error_code?: number } | null)?.error_code;
            if (code === 409) {
              this.conflict409 += 1;
              if (this.conflict409 === 1) {
                this.log(
                  "polling conflict: another bot instance is polling this token — this instance stays ready and retries quietly until it stops",
                  err,
                );
              }
              const delay = Math.min(30_000, 2000 * 2 ** Math.min(this.conflict409, 4));
              await this.sleep(delay);
            } else {
              this.conflict409 = 0;
              this.pollingErrors += 1;
              if (this.pollingErrors === 1) {
                this.log("polling error \u2014 backing off and retrying quietly until a poll succeeds", err);
              }
              const delay = Math.min(30_000, 2000 * 2 ** Math.min(Math.max(0, this.pollingErrors - 1), 4));
              await this.sleep(delay);
            }
          }
        }
      })();
      this.log("long polling started");
    } finally {
      this.starting = false;
    }
  }

  /** Stop the current polling generation and wait for its in-flight request
   * to settle so an immediate restart never overlaps getUpdates calls. */
  async stop(): Promise<void> {
    if (!this.polling && this.pollAbort === undefined && !this.starting) return;
    this.stopGeneration += 1;
    this.polling = false;
    const abort = this.pollAbort;
    abort?.abort();
    const loop = this.pollLoop;
    if (loop) await loop.catch(() => {});
    // A concurrent start() may have installed a new generation while this
    // stop was awaiting the old loop; only clear what this call owned.
    if (this.pollAbort === abort) this.pollAbort = undefined;
    if (this.pollLoop === loop) this.pollLoop = undefined;
  }

  /** Download one photo through the Bot API file endpoint. Both the metadata
   * call and the byte download are bounded: a hung connection must not wedge
   * the chat's inbound lane forever. */
  async downloadFile(fileId: string): Promise<Uint8Array | undefined> {
    const file = await withTimeout(this.api.getFile(fileId), 20_000).catch((err) => {
      this.log("getFile failed", err);
      return undefined;
    });
    if (!file?.file_path) return undefined;
    const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch((err) => {
      this.log("photo download failed", err);
      return undefined;
    });
    if (!response?.ok) return undefined;
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Send a document (session-log ZIPs and other host artifacts). */
  sendDocument(chatId: number, buffer: Uint8Array, filename: string, caption?: string): Promise<number | undefined> {
    return this.queue.push(chatId, async () => {
      const msg = await withTimeout(this.api.sendDocument(chatId, new InputFile(buffer, filename), {
        ...(caption === undefined ? {} : { caption, parse_mode: "HTML" as const }),
      }), 60_000);
      return msg.message_id;
    });
  }

  /** Send saved image bytes back to the chat (session.attachment read-back). */
  sendPhoto(chatId: number, buffer: Uint8Array, filename: string, caption?: string): Promise<number | undefined> {
    return this.queue.push(chatId, async () => {
      const msg = await withTimeout(this.api.sendPhoto(chatId, new InputFile(buffer, filename), {
        ...(caption === undefined ? {} : { caption, parse_mode: "HTML" as const }),
      }), 60_000);
      return msg.message_id;
    });
  }

  /** Send an OGG/OPUS voice note (agent outbound attachments, issue #25). */
  sendVoice(chatId: number, buffer: Uint8Array, filename: string, caption?: string): Promise<number | undefined> {
    return this.queue.push(chatId, async () => {
      const msg = await withTimeout(this.api.sendVoice(chatId, new InputFile(buffer, filename), {
        ...(caption === undefined ? {} : { caption, parse_mode: "HTML" as const }),
      }), 60_000);
      return msg.message_id;
    });
  }

  /** Send an audio track (mp3/m4a/... — agent outbound attachments, #25). */
  sendAudio(chatId: number, buffer: Uint8Array, filename: string, caption?: string): Promise<number | undefined> {
    return this.queue.push(chatId, async () => {
      const msg = await withTimeout(this.api.sendAudio(chatId, new InputFile(buffer, filename), {
        ...(caption === undefined ? {} : { caption, parse_mode: "HTML" as const }),
      }), 60_000);
      return msg.message_id;
    });
  }

  /** Remove/replace an inline keyboard in place (approval/question settles). */
  editReplyMarkup(chatId: number, messageId: number, markup: unknown): Promise<boolean> {
    return this.queue.push(chatId, async () => {
      try {
        await withTimeout(this.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: markup as never }), 20_000);
        return true;
      } catch (err) {
        if (err instanceof GrammyError) return false;
        throw err;
      }
    });
  }

/** Pending sends per chat + total — surfaced by the status card. */
  pending(): number {
    return this.queue.pendingCount();
  }

  async botInfo(): Promise<{ id: number; username: string } | undefined> {
    if (!this.me) {
      const info = await withTimeout(this.api.getMe(), 20_000).catch(() => undefined);
      if (info) this.me = { id: info.id, username: info.username };
    }
    return this.me;
  }

  async setCommands(commands: { command: string; description: string }[]): Promise<void> {
    await withTimeout(this.api.setMyCommands(commands), 20_000).catch((err) => this.log("setMyCommands failed", err));
  }

  /** Telegram's native menu button (next to the input field) opens the bot
   * command list in supported clients — a second, official entry point that
   * does not depend on the persistent reply-keyboard bar. */
  async setMenuButtonToCommands(chatId: number): Promise<void> {
    await withTimeout(
      this.api.setChatMenuButton({ chat_id: chatId, menu_button: { type: "commands" } } as never),
      20_000,
    ).catch((err) => this.log("setChatMenuButton failed", err));
  }

  /** Send one split text payload through the requested per-chat lane, with
   * success/failure logged on every attempt so a dropped reply can never be
   * silent again (#11). */
  private sendTextLane(chatId: number, text: string, options: SendOptions, lane: number | string): Promise<number | undefined> {
    const parts = splitText(text, this.maxMessageLength);
    const markup = (options as { reply_markup?: unknown }).reply_markup;
    return this.queue.push(lane, async () => {
      try {
        let first: number | undefined;
        for (let index = 0; index < parts.length; index += 1) {
          // Reply quoting and reply keyboards are per-message Telegram state:
          // only the FIRST part carries them; later parts must be plain text.
          const partOptions = index === 0 ? options : { ...options, reply_markup: undefined, reply_parameters: undefined };
          const msg = await withTimeout(this.api.sendMessage(chatId, parts[index]!, partOptions), 20_000);
          first ??= msg.message_id;
        }
        this.log(`sendText ok chatId=${chatId} parts=${parts.length} reply_markup=${markup === undefined ? "null" : "set"}`);
        return first;
      } catch (err) {
        this.log(`sendText FAILED chatId=${chatId} text.len=${text.length} err=${err instanceof Error ? err.message : String(err)}`, err);
        throw err;
      }
    });
  }

  sendText(chatId: number, text: string, options: SendOptions = {}): Promise<number | undefined> {
    return this.sendTextLane(chatId, text, options, chatId);
  }

  /** UI messages ride their own control lane so cards/acks stay responsive
   * while assistant output streams (issues #11/#12, bar latency report). */
  sendTextControl(chatId: number, text: string, options: SendOptions = {}): Promise<number | undefined> {
    return this.sendTextLane(chatId, text, options, TelegramTransport.controlKey(chatId));
  }

  sendWithBar(chatId: number, text: string, options: SendOptions = {}): Promise<number | undefined> {
    return this.sendText(chatId, text, { ...options, reply_markup: buildBarKeyboard() });
  }

  private editTextLane(chatId: number, messageId: number, text: string, options: EditOptions, lane: number | string): Promise<boolean> {
    return this.queue.push(lane, async () => {
      try {
        await withTimeout(this.api.editMessageText(chatId, messageId, text, options), 20_000);
        this.log(`editText ok chatId=${chatId} messageId=${messageId}`);
        return true;
      } catch (err) {
        // "message is not modified" means the message is alive and already
        // shows the target content — that IS the desired end state, so the
        // edit logically succeeded. Reporting false here made Ephemeral
        // drop a perfectly good message id and re-send the card (#models
        // card taps feeling dead). Classify BEFORE logging: this benign case
        // must not pollute ERROR-level FAILED alerting (#49). Every other
        // GrammyError stays a failure.
        if (err instanceof GrammyError && /message is not modified/i.test(err.message)) {
          this.log(`editText noop chatId=${chatId} messageId=${messageId} (already up to date)`);
          return true;
        }
        this.log(`editText FAILED chatId=${chatId} messageId=${messageId} err=${err instanceof Error ? err.message : String(err)}`, err);
        if (err instanceof GrammyError) return false;
        throw err;
      }
    });
  }

  editText(chatId: number, messageId: number, text: string, options: EditOptions = {}): Promise<boolean> {
    return this.editTextLane(chatId, messageId, text, options, chatId);
  }

  editTextControl(chatId: number, messageId: number, text: string, options: EditOptions = {}): Promise<boolean> {
    return this.editTextLane(chatId, messageId, text, options, TelegramTransport.controlKey(chatId));
  }

  private deleteMessageLane(chatId: number, messageId: number, lane: number | string): Promise<void> {
    return this.queue.push(lane, async () => {
      try {
        await withTimeout(this.api.deleteMessage(chatId, messageId), 20_000);
        this.log(`deleteMessage ok chatId=${chatId} messageId=${messageId}`);
      } catch (err) {
        this.log(`deleteMessage FAILED chatId=${chatId} messageId=${messageId} err=${err instanceof Error ? err.message : String(err)}`, err);
        throw err;
      }
    });
  }

  deleteMessage(chatId: number, messageId: number): Promise<void> {
    return this.deleteMessageLane(chatId, messageId, chatId);
  }

  deleteMessageControl(chatId: number, messageId: number): Promise<void> {
    return this.deleteMessageLane(chatId, messageId, TelegramTransport.controlKey(chatId));
  }

  sendChatAction(chatId: number, action: "typing"): Promise<void> {
    return this.sendChatActionLane(chatId, action, chatId);
  }

  sendChatActionControl(chatId: number, action: "typing"): Promise<void> {
    return this.sendChatActionLane(chatId, action, TelegramTransport.controlKey(chatId));
  }

  private sendChatActionLane(chatId: number, action: "typing", lane: number | string): Promise<void> {
    return this.queue.push(lane, async () => {
      try {
        await withTimeout(this.api.sendChatAction(chatId, action), 20_000);
        this.log(`sendChatAction ok chatId=${chatId} action=${action}`);
      } catch (err) {
        this.log(`sendChatAction FAILED chatId=${chatId} action=${action} err=${err instanceof Error ? err.message : String(err)}`, err);
        throw err;
      }
    });
  }

  /** Last-resort raw Bot API send for critical command acks: if the queued
   * grammY call exhausts retries, one direct HTTPS attempt still runs (#11). */
  async sendTextFallback(chatId: number, text: string, options: SendOptions = {}): Promise<number | undefined> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.bot.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, ...options }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await response.json()) as { ok?: boolean; result?: { message_id?: number } };
      if (payload.ok !== true) {
        this.log(`sendTextFallback FAILED chatId=${chatId} response=${response.status}`, payload);
        return undefined;
      }
      this.log(`sendTextFallback ok chatId=${chatId} messageId=${payload.result?.message_id ?? "unknown"}`);
      return payload.result?.message_id;
    } catch (err) {
      this.log(`sendTextFallback FAILED chatId=${chatId} err=${err instanceof Error ? err.message : String(err)}`, err);
      return undefined;
    }
  }
}
