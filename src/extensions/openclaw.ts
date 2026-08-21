/**
 * dsh-openclaw: openclaw-style streaming progress draft, as a decoupled
 * plugin. Subscribes to the core bridge's official `session/event` feed and
 * owns one draft message per turn — the core knows nothing about streaming
 * rendering. Hot-pluggable via the loader (telegram-openclaw entry).
 *
 * Format mirrors openclaw's Telegram progress draft (research notes 03/06/
 * 08/19/26):
 * - header line while working: `⚙ Working…`
 * - thinking bursts flow in place as one `🧠 <i>…</i>` line; a tool line
 *   commits (freezes) the current burst and the next burst starts a new line
 * - tool lines: `<b>{emoji|✓|✗} name</b> <code>detail</code>
 *   <i>running|failed</i>`, keyed merge by callId; the icon swaps to
 *   ✓/✗ once the result lands
 * - on turn end the draft collapses into the compact receipt
 *   `🧠 N thoughts · 🛠️ N tool calls · ⏱️ Ns` (openclaw
 *   progress-receipt-tracker) — the final answer itself is delivered as a
 *   separate clean message by the bridge.
 */
import type { Context } from "@deepseek-ai/cordis";
import { escapeHtml } from "../telegram/html.js";
import { markdownTablePreBlock, markdownToHtml } from "../telegram/markdown.js";
import { type StatusStats } from "../harness/adapters/status.js";
import { safeWrap } from "../telegram/safe.js";
import { renderTurnReceipt } from "../telegram/turn-receipt.js";
// Shared heartbeat constant (telegram/goal-progress is the lower layer).
import { LIVENESS_HEARTBEAT_MS } from "../telegram/goal-progress.js";
import type { ExtensionHost } from "./types.js";

const MAX_LINES = 8;
/** openclaw progress.maxLineChars default for the flowing thinking line. */
const REASONING_MAX_CHARS = 120;
const REASONING_KEEP_CHARS = 600;
const TOOL_DETAIL_CHARS = 90;
/**
 * Streaming edits are throttled per chat for a flowing feel without edit
 * storms. The 429 protection from issue #15 now lives in the diff check +
 * exponential backoff on the SAME message, not in a long throttle: 1000ms
 * made reasoning visibly lag behind the model stream (issue #24).
 */
const EDIT_THROTTLE_MS = 200;
/** After a failed edit, retry the SAME message with exponential backoff
 * instead of clearing `messageId` and spawning another "…" placeholder. */
const EDIT_RETRY_BASE_MS = 1500;
const EDIT_RETRY_MAX_MS = 30_000;
/** Only abandon a message after this many consecutive edit failures. */
const MAX_EDIT_FAILURES = 5;
/** Heartbeat budget per draft (#48): 60 beats x 30s = a 30-minute hard
 * deadline for ONE draft, so a lost turn/end can never edit forever. */
const MAX_HEARTBEATS = 60;
const NO_REPLY_REMINDER = "\u231B The turn ended without a telegram_reply \u2014 use the telegram_reply tool or reply yourself.";
/** openclaw progress-draft-status-text: strip <think>-style tags. */
const THINKING_TAG_RE =
  /<\s*(\/?)\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/gi;
const THINKING_HEADER_RE =
  /^\s*(?:>\s*)?(?:Reasoning:\s*(?:\r?\n|\r)\s*|Thinking\.{0,3}\s*(?:\r?\n|\r)\s*(?:\r?\n|\r)\s*)/i;
/** openclaw tool-display-config subset + dsh telegram tool names. */
const TOOL_EMOJI: Record<string, string> = {
  bash: "\u{1F6E0}\uFE0F",
  exec: "\u{1F6E0}\uFE0F",
  shell: "\u{1F6E0}\uFE0F",
  terminal: "\u{1F6E0}\uFE0F",
  web_search: "\u{1F50E}",
  "web-search": "\u{1F50E}",
  grep_search: "\u{1F50E}",
  "grep-search": "\u{1F50E}",
  search: "\u{1F50E}",
  read: "\u{1F4C4}",
  write: "\u270F\uFE0F",
  apply_patch: "\u270F\uFE0F",
  "apply-patch": "\u270F\uFE0F",
  edit: "\u270F\uFE0F",
  todo: "\u{1F4CB}",
  list: "\u{1F4CB}",
  ls: "\u{1F4CB}",
  glob: "\u{1F4CB}",
  copy: "\u{1F4CB}",
  memory: "\u{1F9E0}",
  recall: "\u{1F9E0}",
  think: "\u{1F9E0}",
  reason: "\u{1F9E0}",
  send_message: "\u{1F4E8}",
  "send-message": "\u{1F4E8}",
  notify: "\u{1F514}",
  http: "\u{1F310}",
  fetch: "\u{1F310}",
  curl: "\u{1F310}",
  browser: "\u{1F310}",
  request: "\u{1F310}",
  docker: "\u{1F433}",
  docker_exec: "\u{1F433}",
  container: "\u{1F433}",
  git: "\u{1F33F}",
  npm: "\u{1F4E6}",
  pnpm: "\u{1F4E6}",
  yarn: "\u{1F4E6}",
  move: "\u{1F4E6}",
  python: "\u{1F40D}",
  node: "\u{1F7E2}",
  tsx: "\u{1F7E2}",
  go: "\u{1F438}",
  rust: "\u{1F980}",
  cargo: "\u{1F980}",
  approve: "\u2705",
  deny: "\u26D4",
  plan: "\u{1F5FA}\uFE0F",
  wait: "\u23F3",
  image: "\u{1F5BC}\uFE0F",
  video: "\u{1F3AC}",
  audio: "\u{1F3B5}",
  tts: "\u{1F50A}",
  voice: "\u{1F399}\uFE0F",
  transcribe: "\u{1F4DD}",
  translate: "\u{1F30D}",
  code: "\u{1F4BB}",
  open: "\u{1F517}",
  close: "\u{1F512}",
  delete: "\u{1F5D1}\uFE0F",
  remove: "\u{1F5D1}\uFE0F",
  rename: "\u{1F3F7}\uFE0F",
  mkdir: "\u{1F4C1}",
  make_dir: "\u{1F4C1}",
  upload: "\u2B06\uFE0F",
  download: "\u2B07\uFE0F",
  export: "\u{1F4E4}",
  import: "\u{1F4E5}",
  telegram_reply: "\u{1F4E8}",
  telegram_send: "\u{1F4E8}",
  telegram_broadcast: "\u{1F4E2}",
  telegram_status: "\u{1F4CA}",
  telegram_ask: "\u2753",
  session_model: "\u{1F9E9}",
  session_snapshot: "\u{1F4F7}",
  workspace: "\u{1F4C2}",
  goal: "\u{1F3AF}",
  subagent: "\u{1F916}",
  skill: "\u{1F9EA}",
};

interface DraftLine {
  key?: string;
  kind: "reasoning" | "tool";
  html: string;
  name?: string;
  detail?: string;
  done?: boolean;
}

interface Draft {
  messageId?: number;
  lines: DraftLine[];
  reasoningRaw: string;
  reasoningLineIndex?: number;
  reasoningSteps: number;
  toolCalls: number;
  step: number;
  startedAt: number;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** Last HTML confirmed on Telegram (or at least accepted as the current
   * message content). Identical re-renders are skipped (#15). */
  lastHtml?: string;
  /** Backoff timer that re-attempts the last failed edit on the SAME message. */
  retryTimer?: ReturnType<typeof setTimeout>;
  /** Periodic liveness edit while a tool stays silent (issue #18). */
  heartbeatTimer?: ReturnType<typeof setTimeout>;
  /** Consecutive edit failures on the current message. */
  editFails: number;
  /** Edits attempted / succeeded for this turn (receipt hit-rate line). */
  editAttempts: number;
  editSucceeded: number;
  /** Set by the core's Abort seam: every timer path must go dormant. */
  stopped?: boolean;
  /** Heartbeats fired for this draft — bounded so a lost turn/end can never
   * edit one message forever (#48). */
  heartbeats: number;
  sending?: Promise<number | undefined>;
  /** One fallback notice per turn when streaming delivery fails (#12). */
  fallbackSent?: boolean;
  /** After a placeholder send failed we stop trying for this turn — the
   * fallback notice already told the user; retrying here only re-spams. */
  placeholderFailed?: boolean;
  /** Per-turn token meter folds (same vocabulary as the web status strip). */
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function toolEmoji(name: string): string {
  const key = name.toLowerCase();
  return TOOL_EMOJI[key] ?? "\u{1F9E9}";
}

/** Tool detail: bash shows the command, telegram_* shows the message body,
 * plain JSON blobs collapse to nothing. */
function toolDetail(name: string, raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  let detail = typeof raw === "string" ? raw.trim() : JSON.stringify(raw);
  if (name === "telegram_reply" || name === "telegram_send" || name === "telegram_broadcast") {
    try {
      const parsed: unknown = JSON.parse(detail);
      if (parsed !== null && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string") {
        detail = ((parsed as { text: string }).text).trim();
      }
    } catch {
      // Not JSON — keep the raw payload.
    }
  }
  if (detail === "{}" || detail === "null" || detail === "") return "";
  const chars = Array.from(detail);
  if (chars.length <= TOOL_DETAIL_CHARS) return detail;
  return `${chars.slice(0, TOOL_DETAIL_CHARS).join("")}\u2026`;
}

function toolLineHtml(name: string, detailRaw: unknown, done: boolean | undefined): string {
  const detail = toolDetail(name, detailRaw);
  const icon = done === true ? "\u2713" : done === false ? "\u2717" : toolEmoji(name);
  const parts: string[] = [`<b>${icon} ${escapeHtml(name)}</b>`];
  if (detail !== "") parts.push(`<code>${escapeHtml(detail)}</code>`);
  if (done === undefined) parts.push("<i>running</i>");
  else if (done === false) parts.push("<i>failed</i>");
  return parts.join(" ");
}

/** openclaw stripThinkingMarkdown: thinking lines stay plain italic text
 * without markdown noise. */
function stripThinkingMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/^>\s+/gm, "");
}

/** openclaw normalizeReasoningProgressLine: strip think tags/headers, fold
 * whitespace into a single line, drop markdown. */
function normalizeReasoning(text: string): string {
  const stripped = (text ?? "").replace(THINKING_TAG_RE, "");
  return stripThinkingMarkdown(stripped)
    .replace(THINKING_HEADER_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** openclaw mergeReasoningProgressText: snapshot replaces the buffer, plain
 * delta appends. */
function mergeReasoning(current: string, incoming: string): string {
  if (current === "") return incoming;
  const normalizedCurrent = normalizeReasoning(current);
  const normalizedIncoming = normalizeReasoning(incoming);
  if (normalizedIncoming === "" || normalizedIncoming === normalizedCurrent) return current;
  const isSnapshot =
    THINKING_HEADER_RE.test(incoming.trimStart()) ||
    (normalizedCurrent !== "" && normalizedIncoming.startsWith(normalizedCurrent));
  return isSnapshot ? incoming : `${current}${incoming}`;
}

function reasoningLineHtml(raw: string): string {
  // A reasoning snapshot that is a GFM table renders as an aligned
  // monospace block instead of leaking raw pipes (issue #26).
  const stripped = (raw ?? "").replace(THINKING_TAG_RE, "");
  const table = markdownTablePreBlock(stripped);
  if (table !== undefined) return `\u{1F9E0} ${table}`;
  const normalized = stripThinkingMarkdown(stripped)
    .replace(THINKING_HEADER_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized === "") return "";
  const chars = Array.from(normalized);
  let body = normalized;
  if (chars.length > REASONING_MAX_CHARS) {
    const head = chars.slice(0, Math.max(1, REASONING_MAX_CHARS - 2)).join("").trimEnd();
    const boundary = head.search(/\s+\S*$/u);
    body =
      boundary > Math.floor(REASONING_MAX_CHARS * 0.6)
        ? `${head.slice(0, boundary).trimEnd()}\u2026`
        : `${head}\u2026`;
  }
  return `\u{1F9E0} <i>${escapeHtml(body)}</i>`;
}

function commitReasoning(draft: Draft): void {
  if (draft.reasoningRaw.trim() === "") {
    draft.reasoningRaw = "";
    return;
  }
  if (draft.reasoningLineIndex === undefined) {
    draft.lines.push({ kind: "reasoning", html: reasoningLineHtml(draft.reasoningRaw) });
    draft.reasoningLineIndex = draft.lines.length - 1;
  }
  draft.reasoningSteps += 1;
  draft.reasoningRaw = "";
  draft.reasoningLineIndex = undefined;
}

function trimLines(draft: Draft): void {
  if (draft.lines.length <= MAX_LINES * 2) return;
  const cut = draft.lines.length - MAX_LINES * 2;
  draft.lines.splice(0, cut);
  if (draft.reasoningLineIndex !== undefined) {
    draft.reasoningLineIndex -= cut;
    if (draft.reasoningLineIndex < 0) draft.reasoningLineIndex = undefined;
  }
}

function render(draft: Draft, title: string): string {
  const lines: string[] = [title];
  for (const line of draft.lines.slice(-MAX_LINES)) lines.push(line.html);
  return lines.join("\n");
}

function buildSummary(draft: Draft, sessionStats?: StatusStats, goalObjective?: string): string {
  if (draft.editAttempts > 0) {
    const rate = Math.round((draft.editSucceeded / draft.editAttempts) * 100);
    console.error("[dsh-telegram] openclaw-edit stats", `attempted=${draft.editAttempts} succeeded=${draft.editSucceeded} hit=${rate}%`);
  }
  return renderTurnReceipt({
    durationMs: Date.now() - draft.startedAt,
    reasoningSteps: draft.reasoningSteps,
    toolCalls: draft.toolCalls,
    tokens: draft,
    sessionStats,
    ...(goalObjective === undefined ? {} : { goalObjective }),
  });
}

interface SessionEventLike {
  type?: string;
  data?: {
    turn?: number;
    step?: number;
    usage?: TokenUsageLike;
    chunk?: {
      type?: string;
      blockType?: string;
      index?: number;
      text?: string;
      usage?: TokenUsageLike;
      block?: { type?: string; text?: string };
    };
    name?: string;
    input?: unknown;
    arguments?: unknown;
    callId?: string;
    isError?: boolean;
    message?: {
      source?: { kind?: string; callId?: string };
      content?: readonly { type?: string; isError?: boolean }[];
    };
  };
}

interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Cordis dependency: the main dsh-telegram plugin's provided bridge host.
 * The loader waits for this service and hands it over as `ctx.telegram`. */
export const inject = ["telegram"];

export function apply(ctx: Context, _config?: unknown): void {
  const host = ctx.telegram;
  if (host === undefined) return;
  console.error("[dsh-telegram] openclaw streaming feed mounted");
  const chats = new Map<number, Draft>();
  // Latest assistant text block per turn: when this plugin renders the live
  // feed, the core forwards prose here instead of spamming the chat. The
  // plugin owns final delivery at turn/end; the core reminder is suppressed
  // by the consumer registration and replaced here when nothing answered.
  const answers = new Map<number, { text: string; assistantMessageId?: string }>();
  host.setAssistantConsumer((chatId, text, assistantMessageId) => {
    answers.set(chatId, { text, assistantMessageId });
  });
  // Core Abort seam (#48): the user must never need to watch a draft being
  // rewritten forever. Clear every timer and latch the draft dormant; the
  // real turn/end (if it still arrives) finalizes the placeholder as usual.
  host.stopLiveFeed = (chatId) => {
    const draft = chats.get(chatId);
    if (draft === undefined) return;
    clearTimers(draft);
    draft.stopped = true;
  };
  ctx.effect(() => () => {
    host.stopLiveFeed = undefined;
    host.setAssistantConsumer(undefined);
    chats.clear();
    answers.clear();
  });

  /** Goal-aware draft title (issue #7): goal turns show the objective and
   * step count; ordinary turns keep the openclaw working header. The elapsed
   * timer only appears on the 30s liveness heartbeat so normal throttled
   * edits stay diff-stable (issue #15 + issue #18). */
  const titleFor = (chatId: number, draft: Draft, liveness = false): string => {
    const goal = host.goalForChat?.(chatId);
    if (goal === undefined) {
      return liveness
        ? `\u2699\uFE0F Working \u00B7 \u23F1\uFE0F ${Math.max(1, Math.round((Date.now() - draft.startedAt) / 1000))}s`
        : "\u2699\uFE0F Working\u2026";
    }
    const base = `\u{1F4CA} ${goal.objective.slice(0, 48)} \u00B7 step ${draft.step}`;
    return liveness
      ? `${base} \u00B7 \u23F1\uFE0F ${Math.max(1, Math.round((Date.now() - draft.startedAt) / 1000))}s`
      : base;
  };

  const clearTimers = (draft: Draft): void => {
    if (draft.timer !== undefined) {
      clearTimeout(draft.timer);
      draft.timer = undefined;
    }
    if (draft.retryTimer !== undefined) {
      clearTimeout(draft.retryTimer);
      draft.retryTimer = undefined;
    }
    if (draft.heartbeatTimer !== undefined) {
      clearTimeout(draft.heartbeatTimer);
      draft.heartbeatTimer = undefined;
    }
  };

  const flush = (chatId: number, draft: Draft, title: string, force = false): void => {
    // A turn boundary or hot teardown may have replaced this draft while a
    // timer was still armed; stale drafts must never edit anything.
    if (chats.get(chatId) !== draft) return;
    // Aborted turns are terminal: no retry, heartbeat, or throttle timer may
    // touch the message again (#48).
    if (draft.stopped === true) return;
    if (draft.messageId === undefined) return;
    if (!draft.dirty && !force) return;
    draft.dirty = false;
    const text = render(draft, title);
    // Diff check (#15): Telegram rejects "message is not modified" edits.
    // The forced retry path re-attempts after a failed edit, so it bypasses
    // the diff — `lastHtml` is only updated once an edit is confirmed.
    if (!force && text === draft.lastHtml) return;
    const messageId = draft.messageId;
    draft.editAttempts += 1;
    void safeWrap("openclaw-edit", () => host.editMessage(chatId, messageId, text, { parse_mode: "HTML" })).then((edited) => {
      // A turn boundary or hot teardown may have replaced this draft while
      // the edit was in flight; never mutate or retry a stale draft.
      if (chats.get(chatId) !== draft) return;
      if (edited === true) {
        draft.lastHtml = text;
        draft.editFails = 0;
        draft.editSucceeded += 1;
        if (draft.retryTimer !== undefined) {
          clearTimeout(draft.retryTimer);
          draft.retryTimer = undefined;
        }
        return;
      }
      console.error("[dsh-telegram] openclaw-edit FAILED", `chatId=${chatId} messageId=${messageId} editFails=${draft.editFails + 1}`);
      draft.editFails += 1;
      if (draft.editFails > MAX_EDIT_FAILURES) {
        // Abandoning the escape hatch is what spawned placeholder storm v2:
        // clearing messageId and calling ensureMessage() here re-sent a fresh
        // "Working…" every 5 failures. Keep the SAME messageId reference and
        // tell the user once that live progress is stalled; new content may
        // still try the retained message, but never spawns another one (#23).
        console.error("[dsh-telegram] openclaw-edit abandoned", `chatId=${chatId} messageId=${messageId}`);
        draft.editFails = 0;
        if (draft.fallbackSent !== true) {
          draft.fallbackSent = true;
          void safeWrap("openclaw-stalled-fallback", () =>
            host.send(chatId, "\u26A0\uFE0F Agent is running, but live progress cannot be delivered right now \u2014 use /history to see details.", { parse_mode: "HTML" }),
          );
        }
        return;
      }
      // 429/network errors were already retried by the transport queue; if it
      // still failed, keep the SAME messageId and retry with backoff instead
      // of clearing it and sending a new "…" placeholder on the next chunk.
      if (draft.retryTimer === undefined) {
        const delay = Math.min(EDIT_RETRY_MAX_MS, EDIT_RETRY_BASE_MS * 2 ** (draft.editFails - 1));
        draft.retryTimer = setTimeout(() => {
          draft.retryTimer = undefined;
          if (draft.messageId !== undefined) flush(chatId, draft, titleFor(chatId, draft), true);
        }, delay);
      }
    });
  };

  const armHeartbeat = (chatId: number, draft: Draft): void => {
    if (draft.heartbeatTimer !== undefined) return;
    if (draft.stopped === true) return;
    // Hard deadline: a lost turn/end (crashed stream, dropped event) used to
    // re-arm this heartbeat forever, editing the same message every 30s and
    // freezing the chat (#48). The budget bounds one draft to
    // MAX_HEARTBEATS beats; a live turn re-arms a fresh budget on its next
    // event anyway.
    if (draft.heartbeats >= MAX_HEARTBEATS) return;
    draft.heartbeatTimer = setTimeout(() => {
      draft.heartbeatTimer = undefined;
      if (chats.get(chatId) !== draft || draft.stopped === true) return;
      // Edit immediately with the elapsed title: throttling to a 1s frame
      // would strip the liveness suffix again, and 1 edit/30s is far below
      // the per-chat rate limit.
      draft.heartbeats += 1;
      flush(chatId, draft, titleFor(chatId, draft, true), true);
      armHeartbeat(chatId, draft);
    }, LIVENESS_HEARTBEAT_MS);
    // The heartbeat is a liveness convenience, not a lifecycle owner: it must
    // never keep a test process (or an idle Node process) alive by itself.
    draft.heartbeatTimer.unref?.();
  };

  const schedule = (chatId: number, draft: Draft): void => {
    draft.dirty = true;
    // Fresh content supersedes the retry of an older frame: one throttle
    // timer fires the latest state instead of racing the backoff timer.
    if (draft.retryTimer !== undefined) {
      clearTimeout(draft.retryTimer);
      draft.retryTimer = undefined;
    }
    if (draft.timer !== undefined) return;
    draft.timer = setTimeout(() => {
      draft.timer = undefined;
      flush(chatId, draft, titleFor(chatId, draft));
    }, EDIT_THROTTLE_MS);
  };

  const ensureMessage = (chatId: number, draft: Draft): void => {
    if (draft.messageId !== undefined || draft.sending !== undefined || draft.placeholderFailed === true) return;
    // Issue #15: the placeholder is the full card title, never a lone "…".
    const text = titleFor(chatId, draft);
    const pending = host.send(chatId, text, { parse_mode: "HTML" });
    draft.sending = pending;
    void safeWrap("openclaw-placeholder", () =>
      pending.then((id) => {
        if (chats.get(chatId) === draft && id !== undefined) {
          draft.messageId = id;
          draft.lastHtml = text;
        }
        return id !== undefined;
      }),
    ).then((sent) => {
      if (sent !== true && chats.get(chatId) === draft) {
        if (draft.fallbackSent !== true) {
          draft.fallbackSent = true;
          void safeWrap("openclaw-progress-fallback", () =>
            host.send(chatId, "\u26A0\uFE0F Agent is running, but live progress cannot be delivered right now \u2014 check /status or /history.", { parse_mode: "HTML" }),
          );
        }
        // Do not retry the placeholder for the rest of this turn: the next
        // chunk would otherwise spawn message after message (#15).
        draft.placeholderFailed = true;
      }
    }).finally(() => {
      draft.sending = undefined;
    });
  };

  // Official harness event stream — the same session/event feed the web UI
  // streams from. Filtered to the bridge-bound agent; the draft targets the
  // bound chat.
  (ctx.on as (name: string, listener: (session: { id: unknown }, event: SessionEventLike) => void) => void)("session/event", (session, event) => {
    // Per-chat routing: resolve the owner chat from the session id instead of
    // trusting the most-recently-touched chat, so two chats can stream at once.
    const chatId = host.chatIdForAgent(String(session.id));
    if (chatId === undefined) return;
    // `outbound.liveFeed=false` disables this renderer dynamically; the core
    // falls back to immediate forwarding while this listener stays mounted,
    // so a later `/config set outbound.liveFeed true` needs no restart.
    if (!host.liveFeedEnabled()) return;
    const type = event.type;
    if (type === "turn/start") {
      // Drop only this chat's stale draft; another chat's live draft stays.
      // A previous draft's throttled edit must not fire into the new turn.
      const previous = chats.get(chatId);
      if (previous !== undefined) {
        clearTimers(previous);
        previous.dirty = false;
      }
      // A restarted turn reuses the previous placeholder's message id and its
      // failed-send latch instead of spawning another "Working…" (#23).
      const previousMessageId = previous?.messageId;
      const previousPlaceholderFailed = previous?.placeholderFailed;
      chats.delete(chatId);
      answers.delete(chatId);
      chats.set(chatId, {
        lines: [],
        reasoningRaw: "",
        reasoningSteps: 0,
        toolCalls: 0,
        step: 0,
        startedAt: Date.now(),
        dirty: false,
        editFails: 0,
        editAttempts: 0,
        editSucceeded: 0,
        heartbeats: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        ...(previousMessageId === undefined ? {} : { messageId: previousMessageId }),
        ...(previousPlaceholderFailed === true ? { placeholderFailed: true } : {}),
      });
      // Visible feedback starts with the turn itself, not with the first
      // tool/reasoning event (#12): the placeholder later collapses into the
      // openclaw receipt or is deleted for an empty turn.
      const fresh = chats.get(chatId)!;
      ensureMessage(chatId, fresh);
      if ((host.getConfigPath?.("notify.onLongTask") ?? true) !== false) armHeartbeat(chatId, fresh);
      return;
    }
    // Final delivery must never depend on the live draft: a turn whose
    // turn/start was dropped (or whose draft was never created) still has to
    // deliver its buffered final answer / reminder. Keep this branch above
    // the draft-existence guard.
    if (type === "turn/end") {
      const draft = chats.get(chatId);
      const goal = host.goalForChat?.(chatId);
      const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } } | undefined)?.reason;
      // Errored turns surface through the core bridge's classified failure
      // message (issue #37); here they only suppress success receipts.
      const failed = reason?.kind === "error" && typeof reason.error?.message === "string" && reason.error.message.trim() !== "";
      const answer = answers.get(chatId);
      let goalReceipt: string | undefined;
      // Issue #33: a turn that ends successfully with zero visible output
      // (no reasoning, no tools, no prose) must not delete its placeholder
      // into silence - the placeholder becomes the outcome notice instead.
      let emptyNotice: string | undefined;
      let noticeOnPlaceholder = false;
      if (draft !== undefined) {
        clearTimers(draft);
        commitReasoning(draft);
        const sessionStats = host.statusStats() as StatusStats | undefined;
        const hasContent = draft.reasoningSteps > 0 || draft.toolCalls > 0;
        const summary = hasContent ? buildSummary(draft, sessionStats, goal?.objective) : undefined;
        if (goal !== undefined && !failed) {
          goalReceipt = summary ?? `\u2705 ${goal.objective.slice(0, 60)} \u00B7 \u23F1\uFE0F ${Math.max(1, Math.round((Date.now() - draft.startedAt) / 1000))}s`;
        }
        if (!failed && answer === undefined && summary === undefined && goalReceipt === undefined) {
          // The notice rides on the placeholder (falling back to a fresh
          // send when the edit fails) instead of vanishing with deleteMessage.
          emptyNotice = `\u{1F937} Empty response \u00B7 \u23F1\uFE0F ${Math.max(1, Math.round((Date.now() - draft.startedAt) / 1000))}s`;
          noticeOnPlaceholder = true;
        }
        const finalize = (messageId: number | undefined): void => {
          if (messageId === undefined) return;
          if (summary !== undefined) {
            void safeWrap("openclaw-finalize", () => host.editMessage(chatId, messageId, summary, { parse_mode: "HTML" }));
          } else if (noticeOnPlaceholder) {
            void safeWrap("openclaw-empty-response", () =>
              host
                .editMessage(chatId, messageId, emptyNotice!, { parse_mode: "HTML" })
                .then((edited) => (edited === true ? undefined : host.send(chatId, emptyNotice!, { parse_mode: "HTML" }))),
            );
          } else {
            void safeWrap("openclaw-cleanup", () => host.deleteMessage(chatId, messageId));
          }
        };
        if (draft.messageId !== undefined) {
          finalize(draft.messageId);
        } else if (draft.sending !== undefined) {
          // The placeholder is still in flight: finalize it when it lands
          // instead of leaving a stray "…" message behind.
          void safeWrap("openclaw-finalize-pending", () => draft.sending!.then(finalize));
        }
        chats.delete(chatId);
      } else if (!failed && answer === undefined) {
        // No live draft existed (turn/start dropped): zero output by
        // definition, and the notice must still reach the chat (#33).
        emptyNotice = "\u{1F937} Empty response";
      }

      // Final delivery is this plugin's job while it is mounted: the newest
      // prose block is the turn's answer; without one the openclaw-mode
      // reminder replaces the core's (suppressed) reminder. A tool reply
      // (telegram_reply) already answered the inbound — skip both.
      answers.delete(chatId);
      if (noticeOnPlaceholder) {
        // The placeholder edit IS this turn's outcome: it satisfies the
        // inbound, so the tool-shaped reminder must not stack on top of it.
        if (host.pendingInbound(chatId)) host.markInboundReplied(chatId);
      } else if (host.pendingInbound(chatId)) {
        const text =
          answer !== undefined
            ? markdownToHtml(answer.text)
            : // A zero-output turn is the model returning nothing, not the
              // agent forgetting telegram_reply: deliver the notice instead
              // of the tool-shaped reminder (issue #33).
              emptyNotice ?? NO_REPLY_REMINDER;
        const inboundMessageId = host.inboundMessageId(chatId);
        const agentId = host.agentIdForChat(chatId);
        const assistantMessageId = answer?.assistantMessageId;
        void host
          .send(chatId, text, {
            parse_mode: "HTML",
            ...(inboundMessageId === undefined ? {} : { reply_parameters: { message_id: inboundMessageId } }),
          })
          .then((telegramMessageId) => {
            if (telegramMessageId !== undefined && agentId !== undefined && assistantMessageId !== undefined) {
              host.attachFeedback(chatId, telegramMessageId, agentId, assistantMessageId);
            }
            host.markInboundReplied(chatId);
          })
          .catch((err) => {
            console.error("[dsh-telegram] openclaw-final-answer FAILED", err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
          });
      } else if (goal !== undefined && goalReceipt !== undefined && (host.getConfigPath?.("notify.onComplete") ?? true) !== false) {
        // Goal turns have no inbound answer, so an in-place draft edit is the
        // only signal. Push a fresh receipt message too (issue #18).
        void safeWrap("openclaw-goal-completion", () =>
          host.send(chatId, goalReceipt!, { parse_mode: "HTML", disable_notification: false }),
        );
      } else if (emptyNotice !== undefined) {
        // No placeholder carried the notice (turn/start dropped or the
        // placeholder send failed): still refuse to end in silence (#33).
        void safeWrap("openclaw-empty-response", () => host.send(chatId, emptyNotice, { parse_mode: "HTML" }));
      }
      return;
    }
    const draft = chats.get(chatId);
    if (!draft) return;

    if (type === "step/start") {
      draft.step = event.data?.step ?? draft.step;
      schedule(chatId, draft);
      return;
    }

    // Thinking bursts: text/reasoning deltas flow into one 🧠 line, replaced
    // in place on every edit — the openclaw "block that flows" behavior.
    // Complete text blocks are authoritative snapshots: they replace the
    // partial stream of the same block instead of duplicating it.
    if (type === "assistant/chunk") {
      const chunk = event.data?.chunk;
      const usage = chunk?.type === "usage" ? chunk.usage : event.data?.usage;
      if (usage !== undefined) {
        draft.uncachedInputTokens += usage.inputTokens ?? 0;
        draft.outputTokens += usage.outputTokens ?? 0;
        draft.cacheReadTokens += usage.cacheReadTokens ?? 0;
        draft.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
      }
      const deltaText =
        chunk !== undefined && (chunk.type === "text-delta" || chunk.type === "reasoning-delta") && typeof chunk.text === "string" && chunk.text !== ""
          ? chunk.text
          : undefined;
      const blockText =
        chunk !== undefined && chunk.type === "block-end" && chunk.block?.type === "text" && typeof chunk.block.text === "string"
          ? chunk.block.text
          : undefined;
      if (deltaText !== undefined || blockText !== undefined) {
        draft.reasoningRaw = blockText !== undefined ? blockText : mergeReasoning(draft.reasoningRaw, deltaText as string);
        const chars = Array.from(draft.reasoningRaw);
        if (chars.length > REASONING_KEEP_CHARS) {
          draft.reasoningRaw = chars.slice(0, REASONING_KEEP_CHARS).join("");
        }
        const html = reasoningLineHtml(draft.reasoningRaw);
        if (html !== "") {
          if (draft.reasoningLineIndex === undefined) {
            draft.lines.push({ kind: "reasoning", html });
            draft.reasoningLineIndex = draft.lines.length - 1;
            trimLines(draft);
          } else {
            const line = draft.lines[draft.reasoningLineIndex];
            if (line !== undefined) line.html = html;
          }
          ensureMessage(chatId, draft);
          schedule(chatId, draft);
        }
      }
      return;
    }
    if (type === "tool/call") {
      const data = event.data ?? {};
      const name = typeof data.name === "string" && data.name !== "" ? data.name : "tool";
      const detailRaw = data.arguments !== undefined ? data.arguments : data.input;
      const key = typeof data.callId === "string" ? data.callId : `call:${draft.toolCalls}`;
      // A tool line lands between reasoning bursts: commit the current
      // thinking line so the next thought starts its own line.
      commitReasoning(draft);
      const existing = draft.lines.find((line) => line.kind === "tool" && line.key === key);
      const html = toolLineHtml(name, detailRaw, undefined);
      if (existing !== undefined) {
        existing.html = html;
        existing.name = name;
        existing.detail = typeof detailRaw === "string" ? detailRaw : JSON.stringify(detailRaw ?? "");
        existing.done = undefined;
      } else {
        draft.lines.push({
          kind: "tool",
          key,
          html,
          name,
          detail: typeof detailRaw === "string" ? detailRaw : JSON.stringify(detailRaw ?? ""),
        });
        draft.toolCalls += 1;
      }
      trimLines(draft);
      ensureMessage(chatId, draft);
      schedule(chatId, draft);
      return;
    }
    if (type === "tool/result") {
      const data = event.data ?? {};
      const source = data.message?.source;
      const key = typeof source?.callId === "string" ? source.callId : typeof data.callId === "string" ? data.callId : undefined;
      const resultBlock = data.message?.content?.find((block) => block.type === "tool-result");
      const isError = resultBlock !== undefined ? resultBlock.isError === true : data.isError === true;
      const line = key === undefined ? draft.lines.filter((candidate) => candidate.kind === "tool").at(-1) : draft.lines.find((candidate) => candidate.kind === "tool" && candidate.key === key);
      if (line !== undefined && line.done === undefined) {
        line.done = !isError;
        line.html = toolLineHtml(line.name ?? "tool", line.detail ?? "", line.done);
      }
      schedule(chatId, draft);
      return;
    }
  });
}
