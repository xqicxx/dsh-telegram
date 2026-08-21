/**
 * dsh-telegram: a native Telegram bridge for DeepSeek Harness.
 *
 * Assembly only — every capability lives in its own module:
 *   telegram/  : transport, queues, keyboards, panels (no dsh imports)
 *   harness/   : adapters + bridge (no grammy imports besides types)
 *
 * v0.2 wiring adds every web-exposed domain (sessions/workspace/goals/
 * feedback/skills/subagents/presets/settings/credentials/llm/host/commands/
 * jobs/downloads/plugins/dynamicCordis/approvals/questions) as a Telegram card.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-session";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { homedir } from "node:os";
import { basename, join, parse, resolve, sep } from "node:path";
import { isChatAllowed, readConfig, resolveToken, writeConfig, overlayConfig, getConfigPath, patchFromPath, type ConfigSection, type TelegramConfig } from "./config.js";
import { Bridge } from "./harness/bridge.js";
import { compactCurrent } from "./harness/adapters/compact.js";
import { modeSummary } from "./harness/adapters/mode.js";
import { listPlugins, togglePlugin, entryIdFor } from "./harness/adapters/plugins.js";
import {
  displayTitleFor,
  groupSessionsByProject,
  listSessionDetails,
  orderProjectGroups,
  type ProjectGroup,
  type SessionDetail,
  searchSessions,
  readHistory,
  readTrajectory,
  renameSession,
  forkSession,
  resumeSession,
  promptSession,
  deleteSession,
  selectSessionModel,
  currentSessionModel,
  listQueue,
  updateQueueItem,
  saveImageAttachment,
  readImageAttachment,
  releaseSavedAttachments,
  SessionLifecycle,
  releaseAllModelSelections,
} from "./harness/adapters/sessions.js";
import { listWorkspaces, createWorkspace, renameWorkspace, deleteWorkspace, insertWorkspaceBefore, insertSessionBefore, archiveSession } from "./harness/adapters/workspace.js";
import { getGoal, createGoal, editGoal, pauseGoal, resumeGoal, clearGoal } from "./harness/adapters/goals.js";
import { listFeedback, putFeedback, deleteFeedback } from "./harness/adapters/feedback.js";
import { listSkills } from "./harness/adapters/skills.js";
import { listSubagents, promptSubagent, interruptSubagent, subagentHistory } from "./harness/adapters/subagents.js";
import { listAgentPresets, selectAgentPreset, setDefaultAgentPreset, readAgentPreset, copyAgentPreset, removeAgentPreset, openAgentPresetDocument, switchAgentPresetMidSession, sessionHasStarted } from "./harness/adapters/presets.js";
import { describeSettings, updateSettings, replaceSettings, mutateSettings, parseJsonWithRevision } from "./harness/adapters/settings.js";
import { describeCredential, describeCredentials, setCredential, unsetCredential, listCredentialRefs } from "./harness/adapters/credentials.js";
import { modelCatalog, providerCatalog, discoverModels } from "./harness/adapters/llm.js";
import { REASONING_DEFAULT, REASONING_EFFORTS, isReasoningEffort, reasoningLabel } from "./reasoning.js";
import { reasoningExtension } from "./extensions/reasoning.js";
import type { TelegramExtension, ExtensionHost } from "./extensions/types.js";
import { describeHost, hostVersionOf, breadcrumbSegments, listDirectory, createDirectory, isDirectory, parentOf, openPath, pickDirectoryHint } from "./harness/adapters/host.js";
import { listCommands, executeCommand } from "./harness/adapters/commands.js";
import { listJobs } from "./harness/adapters/jobs.js";
import { exportSessionLog } from "./harness/adapters/downloads.js";
import { listDynamicCordis, defineDynamicCordis, runDynamicPlugin, stopDynamicPlugin, undefineDynamicPlugin } from "./harness/adapters/dynamicCordis.js";
import { probeCapabilities, missingServices } from "./harness/adapters/capabilities.js";
import { attachInteractive, type Interactive, questionIdAt } from "./harness/adapters/interactive.js";
import { ensureOpencodeGoResponsesRoute, normalizeOpencodeGoModel, opencodeGoModelUsesResponses } from "./harness/adapters/opencodeGo.js";
import { saveDocumentAttachment, transcribeVoice } from "./harness/adapters/media.js";
import { forgetStatusSession, resetStatusStats, statusSnapshot } from "./harness/adapters/status.js";
import { CompactionWatcher, contextUsageOf } from "./harness/adapters/compaction-watch.js";
import { diffTodos, listTodos, normalizeTodos, pendingTodoCount, type TodoView } from "./harness/adapters/todos.js";
import { GoalProgressFeed, type ProgressSnapshot } from "./telegram/goal-progress.js";
import { renderTodosCard } from "./telegram/todos-card.js";
import { Ephemeral } from "./telegram/ephemeral.js";
import { plain, truncate } from "./telegram/html.js";
import {
  buildBackKeyboard,
  buildBarKeyboard,
  buildCollapsedBarKeyboard,
  buildConfirmKeyboard,
  buildHistoryKeyboard,
  buildMenuPage,
  buildPagingKeyboard,
  buildProjectKeyboard,
  queueBarLabel,
  todoBarLabel,
  type MenuItem,
  buildSessionsKeyboard,
  buildSearchKeyboard,
  buildSessionDetailKeyboard,
  buildSessionProjectsKeyboard,
  buildWorkspaceKeyboard,
  buildWorkspaceDetailKeyboard,
  buildQueueKeyboard,
  inputPromptKeyboard,
  buildModelsKeyboard,
  buildProvidersKeyboard,
  buildNewSessionKeyboard,
  buildModelDetailKeyboard,
  buildThinkingKeyboard,
  buildGoalsKeyboard,
  buildSkillsKeyboard,
  buildSubagentsKeyboard,
  buildSubagentDetailKeyboard,
  buildPresetsKeyboard,
  buildPresetDetailKeyboard,
  buildSettingsKeyboard,
  buildCredentialsKeyboard,
  buildHostKeyboard,
  buildDynamicCordisKeyboard,
  buildPluginLifecycleKeyboard,
  type PluginRow,
  buildCapabilitiesKeyboard,
  CALLBACK_RE,
  COLLAPSE_BTN,
  COMPACT_BTN,
  decodeCallbackValue,
  GOAL_BTN,
  MENU_BTN,
  MODELS_BTN,
  MODE_BTN,
  NEW_BTN,
  PLUGINS_BTN,
  PRESETS_BTN,
  RETURN_BTN,
  THINKING_BTN,
  REASONING_BTN,
  QUEUE_BTN,
  SESSIONS_BTN,
  TODO_BTN,
  STATUS_BTN,
  ABORT_BTN,
  STOP_BTN,
} from "./telegram/keyboard.js";
import { SendQueue } from "./telegram/queue.js";
import { safeWrap } from "./telegram/safe.js";
import { TokenRegistry } from "./telegram/tokens.js";
import { attachRouter } from "./telegram/router.js";
import { StatusPanel } from "./telegram/status-panel.js";
import { TelegramTransport } from "./telegram/transport.js";
import { renderTrajectoryLines } from "./telegram/trajectory.js";
import { findWorkspaceRoot } from "./workspace.js";

export const name = "dsh-telegram";
export const version = "0.4.0";
export const inject = ["tools", "commands", "agents"];

interface State {
  context: Context | null;
  /** Active project folder — new sessions are created under it. */
  workspaceRoot: string;
  /** Boot workspace that owns `.pi/telegram.json` (config never moves with the project). */
  configRoot: string;
  config: TelegramConfig;
  transport: TelegramTransport | undefined;
  bridge: Bridge | undefined;
  interactive: Interactive | undefined;
  watching: boolean;
  chats: Set<number>;
  /** Last queue count embedded in a bar per chat (live-count sync). */
  barCounts: Map<number, number>;
  /** Last todo count embedded in a bar per chat. */
  barTodoCounts: Map<number, number>;
  /** Dedicated carrier message carrying the live bar, deletable on refresh. */
  barCarriers: Map<number, number>;
  /** Per-chat debounce timers for bar refreshes. */
  barTimers: Map<number, ReturnType<typeof setTimeout>>;
  /** Last project key shown on the per-chat Sessions card (back navigation). */
  lastSessionsProject: Map<number, string>;
  /** Chats whose bar is collapsed to the single return button. */
  barCollapsed: Map<number, boolean>;
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

/** Latest durable todo snapshot per chat (todo/write is whole-list). */
const todoSnapshots = new Map<number, TodoView[]>();
/** Per-chat 5-second refresh loops for the live Todos card (issue #14). */
const TODO_CARD_REFRESH_MS = 5000;
const todoCardTimers = new Map<number, ReturnType<typeof setInterval>>();
/** Goal progress feed; constructed once the transport exists (control ops). */
let goalProgress: GoalProgressFeed | undefined;
/** Context-pressure compaction watcher (issue #8). */
let compactionWatcher: CompactionWatcher | undefined;

const state: State = {
  context: null,
  workspaceRoot: findWorkspaceRoot(process.cwd()) ?? process.cwd(),
  configRoot: findWorkspaceRoot(process.cwd()) ?? process.cwd(),
  config: readConfig(findWorkspaceRoot(process.cwd()) ?? process.cwd()),
  transport: undefined,
  bridge: undefined,
  interactive: undefined,
  watching: false,
  chats: new Set(),
  barCounts: new Map(),
  barTodoCounts: new Map(),
  barCarriers: new Map(),
  barTimers: new Map(),
  lastSessionsProject: new Map(),
  barCollapsed: new Map(),
};

/** Disposers for the refresh-only cordis event subscriptions above. */
const refreshEventDisposers: (() => void)[] = [];

/** Reverse every live mount effect (hot unplug / HMR / config restart). */
function teardownMount(): void {
  state.interactive?.detach();
  state.interactive = undefined;
  for (const dispose of refreshEventDisposers.splice(0)) dispose();
  state.bridge?.detach();
  state.bridge = undefined;
  const teardownTransport = state.transport;
  if (teardownTransport) void safeWrap("transport-stop", () => teardownTransport.stop(), log);
  state.transport = undefined;
  // Remove dedicated bar-carrier messages so a hot reload never leaves a
  // stale reply keyboard button behind.
  for (const [carrierChat, carrierId] of state.barCarriers) {
    if (teardownTransport) void safeWrap(`bar-carrier-cleanup(${carrierChat})`, () => teardownTransport.deleteMessageControl(carrierChat, carrierId), log);
  }
  state.watching = false;
  state.chats.clear();
  state.context = null;
  pendingRename = undefined;
  pendingWorkspaceCreate = undefined;
  pendingSubagentPrompt = undefined;
  pendingSteer = undefined;
  pendingSearch = undefined;
  pendingPresetCopy = undefined;
  pendingMkdir = undefined;
  pendingPluginAdd = undefined;
  pendingStartAfterAllow.clear();
  for (const timer of typingLoops.values()) clearInterval(timer);
  typingLoops.clear();
  runningTurns.clear();
  for (const timer of todoCardTimers.values()) clearInterval(timer);
  todoCardTimers.clear();
  for (const timer of state.barTimers.values()) clearTimeout(timer);
  state.barTimers.clear();
  state.lastSessionsProject.clear();
  state.barCollapsed.clear();
  state.barCounts.clear();
  state.barTodoCounts.clear();
  state.barCarriers.clear();
  releaseAllModelSelections();
  releaseSavedAttachments();
  tokens.reset();
  statusSubagentCounts.clear();
  statusSubagentSync = undefined;
  todoSnapshots.clear();
  goalProgress?.detach();
  goalProgress = undefined;
  compactionWatcher?.detach();
  compactionWatcher = undefined;
  activeCardRenderers.clear();
  menuPageIndex.clear();
  cardOrigins.clear();
  void safeWrap("session-lifecycle-dispose", () => sessionLifecycle.dispose(), log);
  ephemeral.reset();
  statusPanel.reset();
  resetStatusStats();
}

/** Stop every Telegram-side artifact owned by a chat that just lost its
 * whitelist entry: bridge binding, roster slot, typing loop, bar count and
 * the debounced bar-carrier refresh. The dsh session itself stays live so a
 * re-allowed chat can be bound to it again explicitly. */
function ejectChat(chatId: number): void {
  state.bridge?.bindAgent(chatId, undefined);
  state.chats.delete(chatId);
  stopTyping(chatId);
  runningTurns.delete(chatId);
  const todoTimer = todoCardTimers.get(chatId);
  if (todoTimer !== undefined) clearInterval(todoTimer);
  todoCardTimers.delete(chatId);
  activeCardRenderers.delete(chatId);
  cardOrigins.delete(chatId);
  state.barCounts.delete(chatId);
  state.barTodoCounts.delete(chatId);
  const timer = state.barTimers.get(chatId);
  if (timer !== undefined) clearTimeout(timer);
  state.barTimers.delete(chatId);
}

/** Apply a config patch live, without restarting polling or rebinding the agent. */
function applyConfigLive(changed: readonly ConfigSection[]): void {
  if (changed.includes("outbound")) {
    state.transport?.applyLimits({
      maxPerWindow: state.config.outbound.sendRatePerSecond,
      retry: { attempts: state.config.outbound.maxRetries, baseDelayMs: 500 },
      maxMessageLength: state.config.outbound.maxMessageLength,
    });
  }
  if (changed.includes("watch") && state.config.watch.autoStart && !state.watching) {
    void startWatching().catch((err) => log("auto start failed", err));
  }
  if (changed.includes("security")) {
    const allowed = new Set(state.config.security.allowedChatIds);
    for (const chatId of [...state.chats]) {
      if (!allowed.has(chatId)) ejectChat(chatId);
    }
  }
  if (changed.includes("workspace")) {
    const activePath = state.config.workspace.activePath;
    if (activePath !== undefined && existsSync(activePath)) {
      state.workspaceRoot = activePath;
    }
  }
  if (changed.includes("interactive")) {
    state.interactive?.setAllowedTools(state.config.interactive?.allowByTool ?? []);
    log("interactive config changed \u2014 forever-allow tools applied live; question-provider ownership applies on the next plugin restart");
  }
  refreshAllPanels();
}

const ephemeral = new Ephemeral();
const statusPanel = new StatusPanel();
const sessionLifecycle = new SessionLifecycle();

/** Callback payload registry: keeps long ids out of the 64-byte data limit.
 * Tokens are single-use so a button can never execute twice. */
const tokens = new TokenRegistry();
function token(payload: Record<string, string>): string {
  return tokens.mint(payload);
}

/** Registered domain extensions. Core only dispatches to them; it owns no
 * card/callback/command logic of its own beyond the bridge skeleton. */
const extensions: TelegramExtension[] = [];

function registerExtension(extension: TelegramExtension): void {
  const existing = extensions.findIndex((candidate) => candidate.name === extension.name);
  if (existing !== -1) {
    // Replace the previous registration: hot re-apply / loader double-mount
    // must not accumulate duplicate menu rows or dispatch entries.
    extensions[existing]!.detach?.();
    extensions.splice(existing, 1, extension);
  } else {
    extensions.push(extension);
  }
}

function buildExtensionHost(): ExtensionHost {
  return {
    openCard,
    send: (chatId, text, options) => requireTransport().sendText(chatId, text, options as never),
    token,
    currentAgent,
    requireCtx,
    workspaceRoot: () => state.workspaceRoot,
    getConfigPath: (path) => getConfigPath(state.config, path),
    applyConfig: (patch) => {
      const { config, changed } = overlayConfig(state.config, patch);
      if (changed.length === 0) return changed;
      state.config = config;
      applyConfigLive(changed);
      writeConfig(state.configRoot, state.config);
      return changed;
    },
    liveFeedEnabled: () => state.config.outbound.liveFeed !== false,
    refreshAllPanels,
    editMessage: (chatId, messageId, text, options) => requireTransport().editText(chatId, messageId, text, options as never),
    deleteMessage: (chatId, messageId) => requireTransport().deleteMessage(chatId, messageId),
    statusStats: () => statusSnapshot(requireCtx(), boundAgentId()).stats,
    currentAgentId: () => state.bridge?.currentAgentIdValue(),
    currentChatId: () => state.bridge?.activeChatValue(),
    agentIdForChat: (chatId) => state.bridge?.agentIdForChat(chatId),
    chatIdForAgent: (agentId) => state.bridge?.chatIdForAgent(agentId),
    bindAgent: (chatId, agentId) => state.bridge?.bindAgent(chatId, agentId),
    unbindChat: (chatId) => state.bridge?.bindAgent(chatId, undefined),
    setAssistantConsumer: (consumer) => {
      state.bridge?.setAssistantConsumer(consumer);
    },
    attachFeedback: () => {
      // Message feedback buttons are disabled by user preference; keep the
      // extension seam so streaming plugins can still call it harmlessly.
    },
    pendingInbound: (chatId) => state.bridge?.hasPendingInbound(chatId) ?? false,
    inboundMessageId: (chatId) => state.bridge?.inboundMessageIdValue(chatId),
    goalForChat,
    markInboundReplied: (chatId) => {
      state.bridge?.markInboundReplied(chatId);
    },
  };
}

/** Hot-plug UI refresh: reopen open menu cards and refresh panels so a
 * just-registered/removed extension is visible without a restart. */
function refreshExtensionUi(): void {
  refreshAllPanels();
  for (const [chatId, page] of [...menuPageIndex]) {
    void safeWrap(`menu-refresh(${chatId})`, () => openMenuAt(chatId, page), log);
  }
}

function extensionForCallback(action: string) {
  for (const extension of extensions) {
    const handler = extension.callbacks?.[action];
    if (handler) return { extension, handler };
  }
  return undefined;
}

function extensionForCommand(command: string) {
  for (const extension of extensions) {
    const handler = extension.commands?.[command];
    if (handler) return { extension, handler };
  }
  return undefined;
}

function extensionForBar(label: string) {
  for (const extension of extensions) {
    const handler = extension.barButtons?.[label];
    if (handler) return { extension, handler };
  }
  return undefined;
}

function log(message: string, error?: unknown): void {
  console.error(`[dsh-telegram] ${message}`, error ?? "");
}

function textOutput() {
  return {
    schema: { type: "string" as const },
    render: (_args: Record<string, unknown>, value: string) => [{ type: "text" as const, text: value }],
  };
}

const okCmd = (text: string): CommandResult => ({ kind: "success", text });
const failCmd = (text: string): CommandResult => ({ kind: "error", text });

function requireTransport(): TelegramTransport {
  if (!state.transport) throw new Error("Telegram is not running: set TELEGRAM_BOT_TOKEN and send /telegram start.");
  return state.transport;
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

/** ChatOps adapter on the UI control lane: cards, menus and status panels
 * never wait behind assistant streaming edits, so every bar button reacts
 * immediately even while the agent is running. */
function uiOps(t: TelegramTransport) {
  return {
    sendText: (chatId: number, text: string, options?: Record<string, unknown>) => t.sendTextControl(chatId, text, options as never),
    editText: (chatId: number, messageId: number, text: string, options?: Record<string, unknown>) => t.editTextControl(chatId, messageId, text, options as never),
    deleteMessage: (chatId: number, messageId: number) => t.deleteMessageControl(chatId, messageId),
  };
}

/** Critical UI ack: control lane first, one raw Bot API attempt as fallback.
 * Command results (including /goal) must always reach the user (#11). */
async function uiSend(chatId: number, text: string, options: Parameters<TelegramTransport["sendText"]>[2] = {}): Promise<number | undefined> {
  const t = requireTransport();
  try {
    return await t.sendTextControl(chatId, text, options);
  } catch (err) {
    log(`uiSend control lane FAILED chatId=${chatId} err=${err instanceof Error ? err.message : String(err)}`, err);
    return t.sendTextFallback(chatId, text, options);
  }
}

/** A dispatch handler that throws must still tell the user it failed (#13). */
function notifyDispatchFailure(chatId: number, label: string, err: unknown): void {
  log(`${label} failed`, err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
  void uiSend(chatId, `\u274C ${label} failed \u2014 please retry.`, { parse_mode: "HTML" });
}

/** Per-chat typing refreshers: Telegram's "typing" action expires after ~5s,
 * so long agent turns re-assert it every 4s until turn/end stops it. A hard
 * cap clears a leaked loop when an agent is disposed without turn/end. */
const typingLoops = new Map<number, ReturnType<typeof setInterval>>();
/** Chats whose latest turn/start has not yet seen turn/end (issue #17). */
const runningTurns = new Set<number>();
const TYPING_KEEPALIVE_MAX_MS = 10 * 60_000;
/** Self-rearm budget (#48): a lost turn/end used to re-arm the keepalive
 * forever. Three windows (30 min) per turn/start is generous; a genuinely
 * running turn resets the budget whenever it re-asserts typing. */
const TYPING_REARM_LIMIT = 3;
const typingRearms = new Map<number, number>();

/** Keepalive decision (#48): a live agent's own status is authoritative —
 * the sticky `runningTurns` flag goes stale when a turn/end event is lost,
 * which used to re-arm the typing loop forever. The flag is only trusted
 * when no live agent can answer, and the rearm budget caps everything. */
export function typingKeepaliveActive(agentRunning: boolean | undefined, stickyRunning: boolean, rearmCount: number, rearmLimit = TYPING_REARM_LIMIT): boolean {
  if (rearmCount > rearmLimit) return false;
  return agentRunning === undefined ? stickyRunning : agentRunning;
}

function turnStillRunning(chatId: number): boolean {
  const agent = currentAgent(chatId);
  const agentRunning = agent === undefined ? undefined : agent.status === "running";
  return typingKeepaliveActive(agentRunning, runningTurns.has(chatId), typingRearms.get(chatId) ?? 0);
}

function startTyping(chatId: number): void {
  stopTyping(chatId);
  const transport = state.transport;
  if (!transport) return;
  const fire = () => safeWrap(`typing(${chatId})`, () => transport.sendChatActionControl(chatId, "typing"), log);
  void fire();
  const timer = setInterval(() => {
    void fire();
  }, 4000);
  typingLoops.set(chatId, timer);
  // Self-arming one-shot guard: if turn/end was lost the loop must still die.
  // When the turn is genuinely still running, renew one more keep-alive
  // window instead of silently dropping the typing indicator (#17) — but
  // never beyond the rearm budget (#48).
  typingRearms.set(chatId, (typingRearms.get(chatId) ?? 0) + 1);
  setTimeout(() => {
    if (typingLoops.get(chatId) !== timer) return;
    if (turnStillRunning(chatId)) startTyping(chatId);
    else stopTyping(chatId);
  }, TYPING_KEEPALIVE_MAX_MS);
}

/** The provided `telegram` service instance (assigned on plugin apply) so
 * core paths can reach renderer-assigned seams like stopLiveFeed (#48). */
let telegramService: (ExtensionHost & Record<string, unknown>) | undefined;

/** Terminal cleanup for one chat's background loops (#48): Abort must kill
 * the typing keepalive, the sticky turn flag, its rearm budget, and every
 * live-feed timer — not just hide the UI. */
function abortChatLoops(chatId: number): void {
  stopTyping(chatId);
  runningTurns.delete(chatId);
  typingRearms.delete(chatId);
  telegramService?.stopLiveFeed?.(chatId);
}

function stopTyping(chatId: number): void {
  const timer = typingLoops.get(chatId);
  if (timer !== undefined) {
    clearInterval(timer);
    typingLoops.delete(chatId);
  }
}

import { renderStatsStrip } from "./harness/adapters/status.js";
export { renderStatsStrip };

/** Live subagent counts per agent id. `subagents.listChildren` is async, so
 * the Status card renders the latest snapshot and refreshAllPanels updates it
 * before the next in-place edit. */
const statusSubagentCounts = new Map<string, number>();
let statusSubagentSync: Promise<void> | undefined;
/** One slow subagent listing must never latch `statusSubagentSync` forever:
 * every later panel refresh would otherwise await the same stuck promise. */
const STATUS_SUBAGENTS_TIMEOUT_MS = 5000;

/** Bound one in-process service promise so `refreshStatusSubagents` always
 * settles and clears the shared latch, even when a service hangs. */
/** Card data-loading deadline (issue #20/#2): a hung service must fail the
 * card with a visible message instead of wedging the chat's UI lane forever. */
const CARD_LOAD_TIMEOUT_MS = 10_000;

async function cardLoad<T>(chatId: number, label: string, load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await withTimeout(Promise.resolve().then(load), CARD_LOAD_TIMEOUT_MS, label);
  } catch (err) {
    log(`${label} load failed`, err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
    await uiSend(chatId, `\u274C ${label} \u52A0\u8F7D\u5931\u8D25\uFF1A${plain(truncate(err instanceof Error ? err.message : String(err), 120))}`, { parse_mode: "HTML" });
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function refreshStatusSubagents(): Promise<void> {
  const ctx = requireCtx();
  const agents = ctx.agents?.list() ?? [];
  await Promise.all(
    agents.map(async (agent) => {
      const id = String(agent.id);
      try {
        const entries = await withTimeout(listSubagents(ctx, id), STATUS_SUBAGENTS_TIMEOUT_MS, `subagents.listChildren(${id})`);
        statusSubagentCounts.set(id, entries.length);
      } catch {
        statusSubagentCounts.delete(id);
      }
    }),
  );
}

function renderStatus(chatId?: number): string {
  const ctx = requireCtx();
  const agentId = boundAgentId(chatId);
  const snapshot = statusSnapshot(ctx, agentId, chatId === undefined);
  const profile = modeSummary().profile ?? "?";
  const workspace = state.workspaceRoot;
  const jobs = listJobs(ctx, agentId);
  const runningJobs = jobs.filter((job) => job.status === "running").length;
  const subagents = agentId === undefined ? 0 : (statusSubagentCounts.get(agentId) ?? 0);
  const preset = snapshot.preset ? plain(snapshot.preset) : "default";
  const lines = [
    `\u{1F916} dsh \u00B7 ${plain(profile)} \u00B7 ${snapshot.status}`,
    "",
    `\u{1F4C1} Project: ${plain(truncate(workspace, 32))}`,
    `\u{1F3AD} Router: router-${preset}`,
    `\u{1F9E0} Reasoning: ${plain(reasoningLabel(currentReasoningEffort()))}`,
    `\u{1F9E9} Model: ${snapshot.provider ? `${plain(snapshot.provider)}/` : ""}${snapshot.model ? plain(snapshot.model) : "default"}`,
    `\u{1F916} Agent: ${snapshot.agentId ? plain(truncate(snapshot.agentId, 28)) : "none"} \u00B7 Subagents: ${subagents}`,
    "",
    `\u{1F4CA} Queue: ${snapshot.queue} \u00B7 \u{1F4CB} Todos: ${chatId === undefined ? "n/a" : currentTodoCount(chatId)} \u00B7 Sessions: ${snapshot.sessions}`,
    ...(chatId !== undefined && progressFor(chatId) !== undefined
      ? [`\u{1F3AF} Goal: ${plain(truncate(progressFor(chatId)!.objective, 40))} \u00B7 step ${progressFor(chatId)!.step} \u00B7 tools ${progressFor(chatId)!.tools}`]
      : []),
    `\u{1F4CB} Background jobs running: ${runningJobs}`,
    `\u{1F4E1} Bot: ${state.watching ? "polling" : state.transport ? "standby" : "offline"} \u00B7 Pending: ${state.transport?.pending() ?? 0}`,
  ];
  if (snapshot.stats) {
    const strip = renderStatsStrip(snapshot.stats);
    if (strip !== undefined) lines.push("", strip);
  }
  return lines.join("\n");
}

function requireCtx(): Context {
  if (!state.context) throw new Error("dsh-telegram context is not attached");
  return state.context;
}

/** Open the live Status panel. Unlike `openCard`, the status panel does not
 * own `activeCardRenderers`; before replacing the previous transient card we
 * must stop any Todo auto-refresh loop, otherwise its next 5s tick would
 * resurrect the Todo card on top of the Status panel. */
async function openStatusPanel(chatId: number): Promise<void> {
  stopTodoCardRefresh(chatId);
  activeCardRenderers.delete(chatId);
  const t = requireTransport();
  await ephemeral.open(chatId, uiOps(t));
  await statusPanel.refresh(chatId, uiOps(t), renderStatus(chatId), true);
}

function boundAgentId(chatId?: number): string | undefined {
  if (chatId !== undefined) {
    // Chat-scoped resolution fails closed: an unbound chat never borrows
    // another chat's live agent, even for display-only cards.
    return state.bridge?.agentIdForChat(chatId);
  }
  return state.bridge?.currentAgentIdValue();
}

function currentAgent(chatId?: number): Agent | undefined {
  const ctx = requireCtx();
  if (chatId !== undefined) {
    const id = boundAgentId(chatId);
    if (id === undefined) return undefined;
    return ctx.agents?.get(id as never);
  }
  const id = boundAgentId();
  const agents = ctx.agents?.list() ?? [];
  if (id !== undefined) {
    const bound = ctx.agents?.get(id as never);
    if (bound) return bound;
  }
  return agents[0];
}

/** The live session's project cwd (web skill.list / session.create scope). */
function boundSessionCwd(ctx: Context, agentId: string | undefined): string | undefined {
  if (agentId === undefined) return undefined;
  const agent = ctx.agents?.get(agentId as never);
  const cwd = (agent as unknown as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
}

/** Per-chat serialization for session creation. With router UI lanes, a
 * first inbound message and a fast `✨ New` / model-select tap can run
 * concurrently; this gate guarantees they still produce one session. */
const sessionCreateChains = new Map<number, Promise<unknown>>();

/**
 * Create this chat's next session. The old chat-owned agent (and only that
 * agent) is closed after the new one publishes; `agentPreset` follows web
 * session.create semantics (omitted = the roster's default preset).
 */
async function createSessionForChat(
  chatId: number,
  model?: { provider?: string; model?: string },
  agentPreset?: string,
  onlyIfUnbound = false,
): Promise<ReturnType<SessionLifecycle["create"]>> {
  const previous = sessionCreateChains.get(chatId) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(async () => {
      // A fast UI tap (Models auto-create) may reach the gate after the first
      // inbound message already created and bound this chat's session. Reuse
      // that session instead of replacing it out from under the chat.
      if (onlyIfUnbound) {
        const boundId = state.bridge?.agentIdForChat(chatId);
        if (boundId !== undefined) {
          const live = requireCtx().agents?.get(boundId as never);
          if (live) return { result: { ok: true, text: "Session is already live." }, agentId: boundId };
        }
      }
      const requested = model ?? state.config.model ?? {};
      const selectedModel = requested.provider !== undefined && requested.model !== undefined
        ? normalizeOpencodeGoModel(requested.provider, requested.model)
        : requested;
      if (opencodeGoModelUsesResponses(requested.provider, requested.model)) {
        const ready = await ensureOpencodeGoResponsesRoute(requireCtx(), log);
        if (!ready) {
          return {
            result: {
              ok: false,
              text: "opencode-go-responses route is not registered in the llm registry \u2014 restart dsh once more, then create the session again",
            },
          };
        }
      }
      return sessionLifecycle.create(requireCtx(), state.workspaceRoot, selectedModel, {
        ...(agentPreset === undefined ? {} : { agentPreset }),
        replaceSessionId: state.bridge?.agentIdForChat(chatId),
      });
    });
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  sessionCreateChains.set(chatId, settled);
  void settled.then(() => {
    if (sessionCreateChains.get(chatId) === settled) sessionCreateChains.delete(chatId);
  });
  return run;
}

/** Bind a freshly created agent to its chat and diagnose a missed binding
 * immediately instead of discovering it minutes later via a silent command. */
function bindCreatedSession(chatId: number, agentId: string | undefined): boolean {
  if (agentId === undefined) return false;
  state.bridge?.bindAgent(chatId, agentId);
  const live = currentAgent(chatId);
  log(`session bound chatId=${chatId} agentId=${agentId} live=${live?.id ?? "missing"}`);
  return live !== undefined;
}

/** Cards that should re-read their data source when web-side settings/plugin
 * events fire (presets, workspaces, sessions). Keyed by chat. */
const activeCardRenderers = new Map<number, () => Promise<void>>();

async function openCard(chatId: number, text: string, keyboard: unknown, refresh?: () => Promise<void>): Promise<void> {
  const t = requireTransport();
  if (refresh === undefined) activeCardRenderers.delete(chatId);
  else activeCardRenderers.set(chatId, refresh);
  await ephemeral.replace(chatId, uiOps(t), text, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

function refreshActiveCards(): void {
  for (const render of activeCardRenderers.values()) {
    void render().catch((err) => log("active card refresh failed", err));
  }
}

/** Replace the current card with a destructive-action confirmation. */
async function askConfirm(chatId: number, text: string, confirmPayload: Record<string, string>, cancelPayload: Record<string, string>): Promise<void> {
  await openCard(chatId, text, buildConfirmKeyboard({
    confirm: token(confirmPayload),
    cancel: token(cancelPayload),
  }));
}

const menuPageIndex = new Map<number, number>();
/** Which entry point opened the current card: bar-opened cards close on Back,
 * menu-opened cards return to the last menu page (issue #16). */
const cardOrigins = new Map<number, "menu" | "bar">();

/** Telegram sizes the bubble (and its inline keyboard) to the widest text
 * line. A trailing line of non-breaking spaces forces the card to span the
 * maximum bubble width so keyboard rows never leave a right-hand gap. */
function widenCard(text: string): string {
  return `${text}\n${"\u00A0".repeat(80)}`;
}

/** Paginated core menu. Page 0 = non-bar frequent actions; bar-mirrored
 * functions live on page 1; display-only/rare cards on pages 2-3. */
async function openMenuAt(chatId: number, page: number): Promise<void> {
  cardOrigins.set(chatId, "menu");
  const snapshot = statusSnapshot(requireCtx(), boundAgentId(chatId), false);
  const model = snapshot.provider ? `${snapshot.provider}/${snapshot.model ?? "default"}` : (snapshot.model ?? "default");
  const project = basename(state.workspaceRoot) || "/";
  const mode = state.config.mode?.name || modeSummary().profile || "default";
  const pages: MenuItem[][] = [
    [
      { label: `\u2728 New session \u00B7 ${project}`, cb: "m:new", full: true },
      { label: `\u{1F4C1} Project \u00B7 ${project}`, cb: "m:project", full: true },
      { label: state.barCollapsed.get(chatId) === true ? "\u{1F4A1} \u663E\u793A Bar" : "\u{1F4A1} \u6536\u8D77 Bar", cb: "m:bartoggle", full: true },
      ...extensions.flatMap((extension) => extension.menuItems?.(buildExtensionHost()) ?? []),
      { label: "\u{1F5C2} Workspaces", cb: "m:workspaces" },
      { label: "\u{1F9EC} Skills", cb: "m:skills" },
      { label: "\u{1F916} Subagents", cb: "m:subagents" },
      { label: "\u{1F4CB} Jobs", cb: "m:jobs" },
      { label: "\u269B\uFE0F Dynamic", cb: "m:dynamic" },
      { label: "\u{1F4BB} Host", cb: "m:host" },
      // Goals and Capabilities share one half-width row, as requested.
      { label: `\u{1F4CB} Todos \u00B7 ${currentTodoCount(chatId)}`, cb: "m:todos" },
      { label: "\u{1F3AF} Goals", cb: "m:goals" },
      { label: "\u{1F9EC} Capabilities", cb: "m:capabilities" },
    ],
    [
      { label: `\u231B Queue \u00B7 ${snapshot.queue}`, cb: "m:queue" },
      { label: `\u{1F9E9} Models \u00B7 ${model}`, cb: "m:models" },
      { label: `\u{1F3AD} Mode \u00B7 ${mode}`, cb: "m:mode" },
      { label: "\u{1F9ED} Sessions", cb: "m:sessions" },
      { label: "\u{1F4CA} Status", cb: "m:status" },
      { label: "\u{1F50C} Plugins", cb: "m:plugins" },
      { label: "\u{1F9F9} Compact", cb: "m:compact" },
      { label: "\u23F9 Abort", cb: "m:abort" },
      { label: "\u{1F6E0}\uFE0F Host settings", cb: "m:hostsettings" },
      { label: "\u{1F511} Credentials", cb: "m:credentials" },
      { label: "\u{1F510} Allowed", cb: "m:allowed" },
      { label: "\u2699\uFE0F Settings", cb: "m:settings" },
      { label: "\u2139\uFE0F About", cb: "m:about" },
      { label: "\u{1F3AD} Presets", cb: "m:presets" },
      { label: "\u{1F4E1} Watch", cb: "m:watch" },
    ],
  ];
  const safe = Math.max(0, Math.min(page, pages.length - 1));
  menuPageIndex.set(chatId, safe);
  const header = safe === 0 ? renderStatus(chatId) : `\u2630 Menu \u00B7 page ${safe + 1}/${pages.length}`;
  await openCard(chatId, widenCard(header), buildMenuPage(pages[safe]!, safe, pages.length));
}

// ---------------------------------------------------------------------------
// Domain cards
// ---------------------------------------------------------------------------

async function openModelsCard(chatId: number): Promise<void> {
  const ctx = requireCtx();
  const agent = currentAgent(chatId);
  const current = agent ? currentSessionModel(ctx, agent.id) : {};
  const catalog = await cardLoad(chatId, "model catalog", () => modelCatalog(ctx, current));
  if (catalog === undefined) return;
  const lines = [
    `\u{1F9E9} Models \u00B7 current: ${current.provider ? `${plain(current.provider)}/` : ""}${plain(current.model ?? "default")}${current.reasoningEffort ? ` (${plain(current.reasoningEffort)})` : ""} \u00B7 routable: ${catalog.routable ? "yes" : "no"}`,
    "",
  ];
  for (const group of catalog.groups) {
    lines.push(`\u2022 ${plain(group.name)} (${plain(group.id)})`);
    for (const model of group.models.slice(0, 12)) lines.push(`  \u2212 ${plain(truncate(model.id, 40))}`);
    if (group.models.length > 12) lines.push(`  \u2026 +${group.models.length - 12}`);
  }
  for (const failure of catalog.failures) lines.push(`\u26A0\uFE0F ${plain(failure.provider)}: ${plain(failure.message)}`);
  lines.push("", "Tap a provider to switch the current session's model.");
  log(`models card: groups=${catalog.groups.map((g) => g.id).join(",")} failures=${catalog.failures.length}`);
  await openCard(chatId, lines.join("\n"), buildModelsKeyboard(catalog.groups, "m:providers", current.provider));
}

/** Standalone Providers view (llm.providers): deployment facts per provider
 * \u2014 where it is configured (settingsNs/settingsPath), whether an adapter is
 * mounted (active), and whether settings declared it (declared). */
async function openProvidersCard(chatId: number): Promise<void> {
  const catalog = await cardLoad(chatId, "llm providers", () => providerCatalog(requireCtx()));
  if (catalog === undefined) return;
  const lines = [`\u{1F6F0}\uFE0F Providers (${catalog.providers.length})`, ""];
  for (const provider of catalog.providers.slice(0, 20)) {
    lines.push(`\u2022 ${plain(provider.id)} \u00B7 ${plain(provider.name)}`);
    lines.push(`  settings: ${plain(provider.settingsNs ?? "\u2014")}${provider.settingsPath ? ` (${plain(truncate(provider.settingsPath, 40))})` : ""} \u00B7 active: ${provider.active === undefined ? "\u2014" : provider.active ? "yes" : "no"} \u00B7 declared: ${provider.declared === undefined ? "\u2014" : provider.declared ? "yes" : "no"}`);
  }
  if (catalog.providers.length === 0) lines.push("No providers registered in the llm registry.");
  for (const failure of catalog.failures) lines.push(`\u26A0\uFE0F ${plain(failure.provider)}: ${plain(failure.message)}`);
  await openCard(chatId, lines.join("\n"), buildProvidersKeyboard(
    catalog.providers.slice(0, 20).map((provider) => ({
      label: `\u{1F4E1} ${provider.name}`,
      cb: token({ action: "provider", provider: provider.id }),
    })),
  ));
}

const MODELS_PAGE_SIZE = 12;

async function openProviderModelsCard(chatId: number, providerId: string, page = 0): Promise<void> {
  const ctx = requireCtx();
  const agent = currentAgent(chatId);
  const current = agent ? currentSessionModel(ctx, agent.id) : {};
  const catalog = await cardLoad(chatId, "model catalog", () => modelCatalog(ctx, current));
  if (catalog === undefined) return;
  const group = catalog.groups.find((candidate) => candidate.id === providerId);
  log(`provider card requested=${providerId} groups=${catalog.groups.map((g) => g.id).join(",")} found=${group !== undefined}`);
  if (!group) return openModelsCard(chatId);
  const totalPages = Math.max(1, Math.ceil(group.models.length / MODELS_PAGE_SIZE));
  const safe = Math.max(0, Math.min(page, totalPages - 1));
  const pageModels = group.models.slice(safe * MODELS_PAGE_SIZE, (safe + 1) * MODELS_PAGE_SIZE);
  const lines = [
    `\u{1F4E1} ${plain(group.name)} \u00B7 page ${safe + 1}/${totalPages}`,
    "",
    `current: ${current.provider === providerId ? plain(current.model ?? "default") : "other provider"}`,
    "",
  ];
  const models = pageModels.map((model) => ({
    id: model.id,
    name: model.name,
    cb: token({ action: "model-select", provider: providerId, model: model.id }),
  }));
  for (const model of models) {
    lines.push(`${current.provider === providerId && current.model === model.id ? "\u2705" : "\u25CB"} ${plain(truncate(model.id, 40))}`);
    if (model.name !== model.id) lines.push(`   ${plain(truncate(model.name, 40))}`);
  }
  const selectedModel = current.provider === providerId && current.model !== undefined ? current.model : undefined;
  await openCard(chatId, lines.join("\n"), buildModelDetailKeyboard(
    models,
    selectedModel === undefined
      ? undefined
      : {
          label: reasoningLabel(isReasoningEffort(current.reasoningEffort) ? current.reasoningEffort : currentReasoningEffort()),
          cb: token({ action: "model-thinking", provider: providerId, model: selectedModel }),
        },
    {
      ...(safe > 0 ? { previous: token({ action: "model-page", provider: providerId, page: String(safe - 1) }) } : {}),
      ...(safe + 1 < totalPages ? { next: token({ action: "model-page", provider: providerId, page: String(safe + 1) }) } : {}),
    },
  ));
}

/** Current reasoning effort from the live config (default medium). */
function currentReasoningEffort(): "minimal" | "low" | "medium" | "high" | "max" {
  const effort = state.config.reasoning?.effort;
  return effort !== undefined && isReasoningEffort(effort) ? effort : REASONING_DEFAULT;
}

/** Per-session reasoning picker for the selected model (web selectModel). */
async function openModelThinkingCard(chatId: number, providerId: string, modelId: string): Promise<void> {
  const agent = currentAgent(chatId);
  const current = agent ? currentSessionModel(requireCtx(), agent.id) : {};
  const active = isReasoningEffort(current.reasoningEffort) ? current.reasoningEffort : currentReasoningEffort();
  const options = REASONING_EFFORTS.map((effort) => ({
    id: effort,
    name: reasoningLabel(effort),
    cb: token({ action: "model-effort", provider: providerId, model: modelId, effort }),
  }));
  await openCard(chatId, `\u{1F9E0} Thinking effort \u00B7 ${plain(providerId)}/${plain(modelId)}`, buildThinkingKeyboard(options, active));
}

/** Reasoning-effort picker card: the fixed codex-telegram-bot levels. */
const PLUGINS_PAGE_SIZE = 20;

async function openPluginsCard(chatId: number, page = 0): Promise<void> {
  const ctx = requireCtx();
  const plugins = listPlugins(ctx);
  const totalPages = Math.max(1, Math.ceil(plugins.length / PLUGINS_PAGE_SIZE));
  const safe = Math.max(0, Math.min(page, totalPages - 1));
  const pageItems = plugins.slice(safe * PLUGINS_PAGE_SIZE, (safe + 1) * PLUGINS_PAGE_SIZE);
  const lines = [`\u{1F50C} Plugins (${plugins.length}) \u00B7 page ${safe + 1}/${totalPages}`, ""];
  for (const plugin of pageItems) {
    lines.push(`${plugin.enabled ? "\u2705" : "\u26AA"} ${plain(truncate(plugin.moduleName ?? plugin.entryId, 36))} \u00B7 ${plain(plugin.fiberPhase ?? "\u2014")}`);
  }
  const dynamic = listDynamicCordis(ctx);
  if (dynamic.length > 0) {
    lines.push("", `Dynamic plugin packages: ${dynamic.length}`);
    for (const row of dynamic.slice(0, 10)) lines.push(`\u2022 ${plain(String(row.pluginId))}`);
  }
  lines.push("", "Toggle: /pluginenable &lt;name&gt; \u00B7 /plugindisable &lt;name&gt;");
  await openCard(chatId, lines.join("\n"), buildPagingKeyboard({
    ...(safe > 0 ? { previous: token({ action: "plugins-page", page: String(safe - 1) }) } : {}),
    ...(safe + 1 < totalPages ? { next: token({ action: "plugins-page", page: String(safe + 1) }) } : {}),
    back: "m:back",
  }));
}

const SESSIONS_PAGE_SIZE = 10;
const SESSION_PROJECTS_PAGE_SIZE = 12;
/** Synthetic project key for the legacy flat "all sessions" view. */
const ALL_PROJECTS_KEY = "__all__";

/** Load the Sessions roster once and project it into web-style ordered project groups. */
async function sessionProjectSnapshot(chatId: number): Promise<{ details: SessionDetail[]; groups: ProjectGroup[]; bound?: string }> {
  const ctx = requireCtx();
  const details = await cardLoad(chatId, "sessions roster", () => listSessionDetails(ctx));
  const workspaces = details === undefined ? [] : listWorkspaces(ctx).items;
  if (details === undefined) return { details: [], groups: [], bound: undefined };
  const groups = groupSessionsByProject(details, workspaces);
  const bound = state.bridge?.agentIdForChat(chatId) ?? state.bridge?.currentAgentIdValue();
  return { details, groups: orderProjectGroups(groups, bound), bound };
}

/** Project key the user last viewed on this chat's Sessions card. */
function lastProjectKey(chatId: number): string | undefined {
  return state.lastSessionsProject.get(chatId);
}

async function openSessionsCard(chatId: number, projectKey?: string, page = 0): Promise<void> {
  const { details, groups, bound } = await sessionProjectSnapshot(chatId);
  const requestedKey = projectKey ?? groups[0]?.key ?? ALL_PROJECTS_KEY;
  const group = requestedKey === ALL_PROJECTS_KEY ? undefined : groups.find((candidate) => candidate.key === requestedKey) ?? groups[0];
  const key = group?.key ?? ALL_PROJECTS_KEY;
  const sessions = (group?.sessions ?? details).filter((session) => !session.archived);
  const archivedCount = (group?.sessions ?? details).length - sessions.length;
  const totalPages = Math.max(1, Math.ceil(sessions.length / SESSIONS_PAGE_SIZE));
  const safe = Math.max(0, Math.min(page, totalPages - 1));
  const pageItems = sessions.slice(safe * SESSIONS_PAGE_SIZE, (safe + 1) * SESSIONS_PAGE_SIZE);
  const runningCount = sessions.filter((session) => session.running).length;
  const label = group?.label ?? "\u5168\u90E8\u4F1A\u8BDD";
  state.lastSessionsProject.set(chatId, key);
  const lines = [
    `\u{1F9ED} Sessions \u00B7 ${plain(truncate(label, 26))} \u00B7 \u25B6${runningCount}/${sessions.length}${archivedCount > 0 ? ` \u00B7 \u{1F5C4}${archivedCount}` : ""} \u00B7 page ${safe + 1}/${totalPages}`,
    "",
  ];
  if (sessions.length === 0) lines.push("(\u8BE5\u9879\u76EE\u6682\u65E0\u4F1A\u8BDD)", "");
  for (const session of pageItems) {
    const flags = [session.live ? "live" : "cold", session.running ? "running" : "idle"];
    const title = displayTitleFor(session.title, session.cwd, session.id);
    const hasTitle = session.title !== undefined && session.title.trim() !== "";
    lines.push(
      `${session.id === bound ? "\u25B8" : "\u2022"} ${session.running ? "\u25B6 " : ""}${plain(truncate(title, 32))} \u00B7 ${flags.join("/")}${hasTitle ? ` \u00B7 ${plain(truncate(session.id, 14))}` : ""}`,
    );
    if (session.lastPromptAt !== undefined) lines.push(`   last prompt: ${plain(new Date(session.lastPromptAt).toLocaleString())}`);
  }
  lines.push("", "\u4F1A\u8BDD\u6309\u94AE\u6253\u5F00\u8BE6\u60C5 \u00B7 \u5F52\u6863 / \u5220\u9664 \u76F4\u63A5\u64CD\u4F5C\u3002");
  await openCard(chatId, lines.join("\n"), buildSessionsKeyboard(pageItems.map((session) => ({
    id: session.id,
    title: displayTitleFor(session.title, session.cwd, session.id),
    running: session.running,
    archiveCb: token({ action: "session-archive", sessionId: session.id }),
    deleteCb: token({ action: "session-delete", sessionId: session.id }),
  })), {
    projectCount: groups.length,
    projectsCb: token({ action: "sessions-projects" }),
    paging: {
      ...(safe > 0 ? { previous: token({ action: "sessions-page", projectKey: key, page: String(safe - 1) }) } : {}),
      ...(safe + 1 < totalPages ? { next: token({ action: "sessions-page", projectKey: key, page: String(safe + 1) }) } : {}),
    },
  }), () => openSessionsCard(chatId, key, safe));
}

/** Project switcher page: running projects first, then current, then recency. */
async function openSessionProjectsCard(chatId: number, page = 0): Promise<void> {
  const { groups, bound } = await sessionProjectSnapshot(chatId);
  const totalPages = Math.max(1, Math.ceil(groups.length / SESSION_PROJECTS_PAGE_SIZE));
  const safe = Math.max(0, Math.min(page, totalPages - 1));
  const pageGroups = groups.slice(safe * SESSION_PROJECTS_PAGE_SIZE, (safe + 1) * SESSION_PROJECTS_PAGE_SIZE);
  const lines = [`\u{1F504} \u9879\u76EE (${groups.length}) \u00B7 page ${safe + 1}/${totalPages}`, ""];
  for (const group of pageGroups) {
    const current = bound !== undefined && group.sessions.some((session) => session.id === bound);
    lines.push(
      `${current ? "\u25B8" : "\u2022"} ${plain(truncate(group.label, 30))} \u00B7 \u25B6${group.runningCount} \u00B7 \u5171${group.sessions.length}`,
    );
  }
  lines.push("", "Tap a project to switch its Sessions page.");
  await openCard(chatId, lines.join("\n"), buildSessionProjectsKeyboard(pageGroups.map((group) => ({
    label: group.label,
    running: group.runningCount,
    total: group.sessions.length,
    cb: token({ action: "sessions-project", projectKey: group.key }),
  })), {
    all: token({ action: "sessions-project", projectKey: ALL_PROJECTS_KEY }),
    paging: {
      ...(safe > 0 ? { previous: token({ action: "sessions-projects-page", page: String(safe - 1) }) } : {}),
      ...(safe + 1 < totalPages ? { next: token({ action: "sessions-projects-page", page: String(safe + 1) }) } : {}),
    },
    back: token({ action: "sessions-open" }),
  }), () => openSessionProjectsCard(chatId, safe));
}

async function openSessionDetailCard(chatId: number, sessionId: string): Promise<void> {
  const ctx = requireCtx();
  const details = await cardLoad(chatId, "session details", () => listSessionDetails(ctx));
  if (details === undefined) return;
  const session = details.find((candidate) => candidate.id === sessionId);
  if (!session) {
    await uiSend(chatId, `\u274C Session ${plain(truncate(sessionId, 32))} not found.`, { parse_mode: "HTML" });
    return openSessionsCard(chatId, lastProjectKey(chatId));
  }
  const title = displayTitleFor(session.title, session.cwd, session.id);
  const hasTitle = session.title !== undefined && session.title.trim() !== "";
  const lines = [
    `\u{1F9ED} ${plain(truncate(title, 40))}${hasTitle ? ` \u00B7 ${plain(truncate(session.id, 16))}` : ""}`,
    "",
    `live: ${session.live} \u00B7 running: ${session.running} \u00B7 blank: ${session.blank} \u00B7 archived: ${session.archived}`,
    `events: ${session.eventCount}${session.cwd ? ` \u00B7 cwd: ${plain(truncate(session.cwd, 28))}` : ""}`,
    hasTitle ? `id: ${plain(session.id)}` : "",
    session.lastPromptAt !== undefined ? `last prompt: ${plain(new Date(session.lastPromptAt).toLocaleString())}` : "",
  ].filter((line) => line !== "");
  await openCard(chatId, lines.join("\n"), buildSessionDetailKeyboard(session.id, session.archived, token({ action: "sessions-open" })));
}

async function openHistoryCard(chatId: number, sessionId: string, beforeSeq?: number): Promise<void> {
  // Turn-grouped trajectory view (issue #32), matching the web's 轨迹 ledger:
  // per-turn model/outcome/duration header plus user/thinking/tool/answer steps.
  const result = await cardLoad(chatId, "session history", () => readTrajectory(requireCtx(), sessionId, 6, beforeSeq));
  if (result === undefined) return;
  await openCard(chatId, renderTrajectoryLines(sessionId, result).join("\n"), buildHistoryKeyboard(
    sessionId,
    result.hasMore && result.nextBefore !== undefined
      ? token({ action: "history-older", sessionId, beforeSeq: String(result.nextBefore) })
      : undefined,
  ));
}

const SEARCH_PAGE_SIZE = 10;

async function openSearchCard(chatId: number, query: string, page = 0): Promise<void> {
  const hits = await cardLoad(chatId, "search results", () => searchSessions(requireCtx(), query, 100));
  if (hits === undefined) return;
  const totalPages = Math.max(1, Math.ceil(hits.length / SEARCH_PAGE_SIZE));
  const safe = Math.max(0, Math.min(page, totalPages - 1));
  const pageHits = hits.slice(safe * SEARCH_PAGE_SIZE, (safe + 1) * SEARCH_PAGE_SIZE);
  const lines = [`\u{1F50D} Search "${plain(truncate(query, 40))}" \u2014 ${hits.length} hit(s) \u00B7 page ${safe + 1}/${totalPages}`, ""];
  for (const hit of pageHits) {
    lines.push(`\u2022 ${plain(truncate(hit.sessionId, 24))} [${hit.seq}] ${hit.type}${hit.live ? "" : " (cold)"}`);
    lines.push(`  ${plain(truncate(hit.snippet, 80))}`);
  }
  if (hits.length === 0) lines.push("(no hits)");
  await openCard(chatId, lines.join("\n"), buildSearchKeyboard(pageHits.map((hit) => hit.sessionId), {
    ...(safe > 0 ? { previous: token({ action: "search-page", query, page: String(safe - 1) }) } : {}),
    ...(safe + 1 < totalPages ? { next: token({ action: "search-page", query, page: String(safe + 1) }) } : {}),
  }));
}

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

async function openWorkspacesCard(chatId: number): Promise<void> {
  log(`workspaces card open requested chatId=${chatId}`);
  try {
    const listed = listWorkspaces(requireCtx());
    const items = listed.items;
    const archivedSessionIds = listed.archivedSessionIds;
    log(`workspaces listed items=${items.length} archived=${archivedSessionIds.length}`);
    const lines = [`\u{1F5C2} Workspaces (${items.length})`, ""];
    for (const workspace of items.slice(0, 15)) {
      const title = typeof workspace.title === "string" && workspace.title !== "" ? workspace.title : basename(workspace.path || "workspace");
      lines.push(`\u2022 ${plain(truncate(title, 28))} \u00B7 ${plain(truncate(workspace.path, 24))}`);
      lines.push(`  sessions: ${workspace.sessionIds.length} \u00B7 id: ${plain(truncate(workspace.workspaceId, 20))}`);
    }
    if (items.length === 0) {
      lines.push(`\u2022 Current project: ${plain(truncate(state.workspaceRoot, 48))}`);
      lines.push("No registered workspaces yet \u2014 /workspacecreate &lt;path&gt; [title], or use Project to register this one.");
    }
    if (archivedSessionIds.length > 0) lines.push("", `Archived sessions: ${archivedSessionIds.length}`);
    log(`workspaces card rendering lines=${lines.length}`);
    await openCard(
      chatId,
      lines.join("\n"),
      buildWorkspaceKeyboard(items.map((workspace) => ({ id: workspace.workspaceId, title: typeof workspace.title === "string" ? workspace.title : basename(workspace.path || "workspace") }))),
      () => openWorkspacesCard(chatId),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`workspaces card ERROR chatId=${chatId}: ${message}`);
    await openCard(
      chatId,
      `\u{1F5C2} Workspaces\n\n\u26A0\uFE0F ${plain(truncate(message, 120))}`,
      buildWorkspaceKeyboard([]),
      () => openWorkspacesCard(chatId),
    );
  }
}

async function openWorkspaceDetailCard(chatId: number, workspaceId: string): Promise<void> {
  const { items } = listWorkspaces(requireCtx());
  const workspace = items.find((candidate) => candidate.workspaceId === workspaceId);
  if (!workspace) return openWorkspacesCard(chatId);
  const lines = [
    `\u{1F5C2} ${plain(truncate(workspace.title, 40))}`,
    "",
    `path: ${plain(truncate(workspace.path, 60))}`,
    `id: ${plain(truncate(workspace.workspaceId, 32))}`,
    `sessions (${workspace.sessionIds.length}): ${workspace.sessionIds.slice(0, 6).map((id) => plain(truncate(id, 16))).join(", ")}${workspace.sessionIds.length > 6 ? "\u2026" : ""}`,
    workspace.createdAt !== undefined ? `created: ${plain(new Date(workspace.createdAt).toLocaleString())}` : "",
    workspace.updatedAt !== undefined ? `updated: ${plain(new Date(workspace.updatedAt).toLocaleString())}` : "",
  ].filter((line) => line !== "");
  await openCard(chatId, lines.join("\n"), buildWorkspaceDetailKeyboard(workspaceId, {
    use: token({ action: "workspace-use", workspaceId }),
    sessions: token({ action: "sessions-project", projectKey: workspaceId }),
  }));
}

/** Codex-style project picker: browse folders inline, then use one as the
 * active project for all new sessions. */
const PROJECT_PAGE_SIZE = 24;

async function openProjectCard(chatId: number, target?: string, offset = 0): Promise<void> {
  const path = target ?? state.workspaceRoot;

  const workspacePaths = listWorkspaces(requireCtx()).items.map((workspace) => workspace.path);
  const quick = [...new Set(workspacePaths.filter((candidate) => candidate !== path))].slice(0, 3).map((candidate) => ({
    label: `\u{1F5C2} ${basename(candidate)}`,
    cb: token({ action: "project-open", path: candidate }),
  }));

  const baseActions = {
      up: path === "/" ? undefined : token({ action: "project-up", path }),
      home: path === homedir() ? undefined : token({ action: "project-open", path: homedir() }),
      root: path === "/" ? undefined : token({ action: "project-open", path: "/" }),
      menu: "m:back",
      close: "m:close",
      quick,
  };

  if (!(await isDirectory(path))) {
    const lines = [`\u{1F4C1} ${plain(truncate(path, 60))}`, "", "\u274C Not a directory (or not readable).", "", "Go up a level, or pick a quick root below."];
    await openCard(chatId, lines.join("\n"), buildProjectKeyboard([], baseActions));
    return;
  }

  const listing = await listDirectory(path);
  if (!listing.ok) {
    const lines = [`\u{1F4C1} ${plain(truncate(path, 60))}`, "", `\u274C ${plain(listing.text)}`, "", "The folder itself is valid \u2014 use it as the project, or go up."];
    await openCard(chatId, lines.join("\n"), buildProjectKeyboard([], { ...baseActions, use: token({ action: "project-select", path }) }));
    return;
  }

  const entries = listing.entries ?? [];
  const dirs = entries.filter((entry) => entry.kind === "directory");
  const files = entries.length - dirs.length;
  const active = path === state.workspaceRoot ? " \u00B7 \u2705 current project" : "";
  const lines = [
    `\u{1F4C1} ${plain(truncate(path, 60))}${active}`,
    "",
    `folders: ${dirs.length} \u00B7 files: ${files}`,
    "",
    "Pick a folder to open it, or use this one as the project.",
  ];
  const page = dirs.slice(offset, offset + PROJECT_PAGE_SIZE).map((entry) => ({ label: entry.name, cb: token({ action: "project-open", path: joinPath(path, entry.name) }) }));
  const paging: { text: string; cb: string }[] = [];
  if (offset > 0) paging.push({ text: "\u2B05\uFE0F Prev", cb: token({ action: "project-open", path, offset: String(Math.max(0, offset - PROJECT_PAGE_SIZE)) }) });
  if (offset + PROJECT_PAGE_SIZE < dirs.length) paging.push({ text: "Next \u27A1\uFE0F", cb: token({ action: "project-open", path, offset: String(offset + PROJECT_PAGE_SIZE) }) });
  await openCard(
    chatId,
    lines.join("\n"),
    buildProjectKeyboard(page, {
      ...baseActions,
      paging,
      use: token({ action: "project-select", path }),
    }),
  );
}

function joinPath(parent: string, name: string): string {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

/** Validate, switch, persist, and register the picked project folder. */
async function applyProjectPath(chatId: number, raw: string): Promise<void> {
  const tilde = raw.startsWith("~") ? raw.replace(/^~/, homedir()) : raw;
  const target = tilde === "" ? state.workspaceRoot : resolve(tilde.startsWith("/") ? tilde : joinPath(state.workspaceRoot, tilde));
  const path = target;
  if (!(await isDirectory(path))) {
    await uiSend(chatId, `\u274C Not a directory: ${plain(truncate(path, 60))}`, { parse_mode: "HTML" });
    return openProjectCard(chatId, path);
  }
  state.workspaceRoot = path;
  state.config.workspace.activePath = path;
  writeConfig(state.configRoot, state.config);
  const registry = requireCtx().get("workspaceRegistry");
  if (registry) {
    const anyRegistry = registry as { list(): { path: string }[]; create(path: string, title?: string): Promise<unknown> };
    const existing = anyRegistry.list().find((workspace) => workspace.path === path);
    if (!existing) {
      await anyRegistry.create(path, basename(path) || path).catch((err) => log("project register failed", err));
    }
  }
  await uiSend(chatId, `\u{1F4C1} Project set: ${plain(path)}\n\u2728 New sessions will be created here.`, { parse_mode: "HTML" });
  return openMenuAt(chatId, 0);
}

/** Workspace-create directory picker: instead of typing an abstract path,
 * browse to a folder and tap "Create here". Mirrors the Project browser. */
const WORKSPACE_PICK_PAGE_SIZE = 12;

async function openWorkspaceCreatePicker(chatId: number, path: string, offset = 0): Promise<void> {
  const target = path || state.workspaceRoot;
  if (!(await isDirectory(target))) {
    await uiSend(chatId, `\u274C Not a directory: ${plain(truncate(target, 60))}`, { parse_mode: "HTML" });
    return openWorkspaceCreatePicker(chatId, parentOf(target));
  }
  const listing = await listDirectory(target);
  const dirs = (listing.ok ? listing.entries ?? [] : []).filter((entry) => entry.kind === "directory");
  const safe = Math.max(0, Math.min(offset, Math.max(0, Math.ceil(dirs.length / WORKSPACE_PICK_PAGE_SIZE) - 1)));
  const pageDirs = dirs.slice(safe * WORKSPACE_PICK_PAGE_SIZE, (safe + 1) * WORKSPACE_PICK_PAGE_SIZE);
  const paging: { text: string; cb: string }[] = [];
  if (safe > 0) paging.push({ text: "\u2B05\uFE0F Prev", cb: token({ action: "ws-pick-page", path: target, page: String(safe - 1) }) });
  if ((safe + 1) * WORKSPACE_PICK_PAGE_SIZE < dirs.length) paging.push({ text: "Next \u27A1\uFE0F", cb: token({ action: "ws-pick-page", path: target, page: String(safe + 1) }) });
  const lines = [`\u{1F5C2} Create workspace at:\n${plain(truncate(target, 60))}`, "", `folders: ${dirs.length}`, "", "Browse to a folder, then tap \u2705 Create here."];
  await openCard(chatId, lines.join("\n"), buildProjectKeyboard(
    pageDirs.map((entry) => ({ label: entry.name, cb: token({ action: "ws-pick-open", path: joinPath(target, entry.name) }) })),
    {
      up: target === "/" ? undefined : token({ action: "ws-pick-open", path: parentOf(target) }),
      home: target === homedir() ? undefined : token({ action: "ws-pick-open", path: homedir() }),
      root: target === "/" ? undefined : token({ action: "ws-pick-open", path: "/" }),
      paging,
      use: token({ action: "ws-create-here", path: target }),
      close: "m:workspaces",
    },
  ));
}

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

async function openSkillsCard(chatId: number): Promise<void> {
  const ctx = requireCtx();
  const agent = currentAgent(chatId);
  // Web skill.list is addressed by session + cwd + scope: pass the live
  // session's project root (header cwd, else the workspace root) and ask for
  // the user-invocable scope, then filter client-side for registries that
  // ignore the scope option.
  const cwd = boundSessionCwd(ctx, agent?.id) ?? state.workspaceRoot;
  const skills = await cardLoad(chatId, "skills list", () => listSkills(ctx, { ...(agent?.id === undefined ? {} : { sessionId: agent.id }), cwd, scope: "user" }));
  if (skills === undefined) return;
  const userSkills = skills.filter((skill) => skill.userInvocable);
  const lines = [`\u{1F9D1}\u200D\u{1F3EB} Skills (${userSkills.length} user-invocable)`, ""];
  for (const skill of userSkills.slice(0, 30)) {
    lines.push(`\u2022 ${plain(skill.name)} \u00B7 ${plain(skill.source)}`);
    lines.push(`  ${plain(truncate(skill.description, 80))}`);
    lines.push(`  model:${skill.modelInvocable ? "yes" : "no"} provider: ${plain(skill.provider)}`);
  }
  if (skills.length === 0) lines.push("No skills registered in this profile.");
  else if (userSkills.length === 0) lines.push("No user-invocable skills for this session's project.");
  else if (userSkills.length < skills.length) lines.push("", `Model-only skills hidden: ${skills.length - userSkills.length}`);
  await openCard(chatId, lines.join("\n"), buildSkillsKeyboard());
}

async function openSubagentsCard(chatId: number): Promise<void> {
  const agent = currentAgent(chatId);
  if (!agent) {
    await openCard(chatId, "No live agent \u2014 subagents hang off a parent session.", buildBackKeyboard());
    return;
  }
  const entries = await cardLoad(chatId, "subagents list", () => listSubagents(requireCtx(), agent.id));
  if (entries === undefined) return;
  const lines = [`\u{1F916} Subagents of ${plain(truncate(agent.id, 24))} (${entries.length})`, ""];
  for (const entry of entries.slice(0, 15)) {
    const flags: string[] = [entry.kind, entry.activity];
    if (entry.mode !== undefined) flags.push(entry.mode);
    if (entry.hasChildren === true) flags.push("children");
    flags.push(entry.parentAvailable === false ? "parent:unavailable" : "parent:available");
    lines.push(`\u2022 ${plain(truncate(entry.id, 28))} \u00B7 ${flags.join("/")}${entry.label ? ` \u00B7 ${plain(truncate(entry.label, 20))}` : ""}`);
    if (entry.kind === "diagnostic") lines.push(`  reason: ${plain(entry.reason ?? "unavailable")}`);
  }
  if (entries.length === 0) lines.push("(none)");
  const rows = entries.slice(0, 12).map((entry) => ({ id: entry.id, cb: token({ action: "subagent", parentId: agent.id, childId: entry.id }) }));
  await openCard(chatId, lines.join("\n"), buildSubagentsKeyboard(rows));
}

async function isContinuableSubagent(parentId: string, childId: string): Promise<boolean> {
  try {
    const entries = await withTimeout(listSubagents(requireCtx(), parentId), STATUS_SUBAGENTS_TIMEOUT_MS, "subagents.listChildren");
    return entries.some((entry) => entry.id === childId && entry.kind === "child" && entry.mode === "continuable");
  } catch {
    return false;
  }
}

async function openSubagentDetailCard(chatId: number, parentId: string, childId: string): Promise<void> {
  const entries = await cardLoad(chatId, "subagents list", () => listSubagents(requireCtx(), parentId));
  if (entries === undefined) return;
  const entry = entries.find((candidate) => candidate.id === childId);
  const lines = [
    `\u{1F916} ${plain(truncate(childId, 32))}`,
    "",
    `parent: ${plain(truncate(parentId, 24))}`,
    entry === undefined
      ? "catalog entry: not listed"
      : `kind: ${entry.kind} \u00B7 activity: ${entry.activity}${entry.mode ? ` \u00B7 mode: ${entry.mode}` : ""}${entry.hasChildren === true ? " \u00B7 has children" : ""}${entry.parentAvailable === false ? " \u00B7 parent unavailable" : ""}`,
    entry?.label ? `label: ${plain(truncate(entry.label, 40))}` : "",
    entry?.kind === "diagnostic" ? `reason: ${plain(entry.reason ?? "unavailable")}` : "",
  ].filter((line) => line !== "");
  const continuable = entry?.kind === "child" && entry.mode === "continuable";
  const callbacks = {
    ...(continuable
      ? {
          prompt: token({ action: "subagent-prompt", parentId, childId }),
          interrupt: token({ action: "subagent-interrupt", parentId, childId }),
        }
      : {}),
    history: token({ action: "subagent-history", parentId, childId }),
  };
  if (!continuable) lines.push("", "This subagent is not continuable \u2014 history is read-only.");
  await openCard(chatId, lines.join("\n"), buildSubagentDetailKeyboard(callbacks));
}

/** New-session preset picker (web session.create's agentPreset): use the
 * roster's default preset with one tap, or pick a specific preset. Profiles
 * without presets fall straight through to creation. */
async function openNewSessionCard(chatId: number): Promise<void> {
  const presetsView = await cardLoad(chatId, "agent presets", () => listAgentPresets(requireCtx()));
  if (presetsView === undefined) return;
  const { presets } = presetsView;
  const lines = [
    "\u2728 New session",
    "",
    presets.length > 0
      ? "Compose the session from a preset, or use the roster default:"
      : "This profile composes no agent presets \u2014 the new session uses the profile default.",
    "",
    ...presets.slice(0, 12).map((preset) => `${preset.isDefault ? "\u2B50" : "\u2022"} ${plain(preset.id)}${preset.isDefault ? " (default)" : ""}`),
  ];
  await openCard(chatId, lines.join("\n"), buildNewSessionKeyboard(
    token({ action: "new-default" }),
    presets.slice(0, 12).map((preset) => ({ id: preset.id, isDefault: preset.isDefault, cb: token({ action: "preset-new", presetId: preset.id }) })),
  ));
}

async function openPresetsCard(chatId: number): Promise<void> {
  const presetsView = await cardLoad(chatId, "agent presets", () => listAgentPresets(requireCtx()));
  if (presetsView === undefined) return;
  const { presets, authorable, hasDocument } = presetsView;
  const lines = [`\u{1F3AD} Agent presets (${presets.length}) \u00B7 authorable: ${authorable} \u00B7 document: ${hasDocument ? "yes" : "no"}`, ""];
  for (const preset of presets.slice(0, 20)) {
    lines.push(`${preset.isDefault ? "\u2B50" : "\u2022"} ${plain(preset.id)} \u00B7 ${preset.trust}${preset.broken ? " \u00B7 broken" : ""}`);
    if (preset.description) lines.push(`  ${plain(truncate(preset.description, 60))}`);
  }
  if (presets.length === 0) lines.push("This profile composes no agent presets.");
  const rows = presets.slice(0, 12).map((preset) => ({ id: preset.id, cb: token({ action: "preset", presetId: preset.id }) }));
  await openCard(chatId, lines.join("\n"), buildPresetsKeyboard(rows), () => openPresetsCard(chatId));
}

async function openPresetDetailCard(chatId: number, presetId: string): Promise<void> {
  const agent = currentAgent(chatId);
  const lines = [
    `\u{1F3AD} ${plain(truncate(presetId, 40))}`,
    "",
    "Blank session: applies in place. Started session: forks it, applies the preset to the fork, and closes the original.",
  ];
  const callbacks = {
    select: token({ action: "preset-select", presetId, sessionId: agent?.id ?? "" }),
    read: token({ action: "preset-read", presetId }),
    create: token({ action: "preset-new", presetId }),
    copy: token({ action: "preset-copy", presetId }),
    remove: token({ action: "preset-remove", presetId }),
    open: token({ action: "preset-open", presetId }),
    default: token({ action: "preset-default", presetId }),
  };
  await openCard(chatId, lines.join("\n"), buildPresetDetailKeyboard(callbacks));
}

async function openHostSettingsCard(chatId: number): Promise<void> {
  const { writable, hasDocument, documentPath, namespaces, internalNamespaces } = describeSettings(requireCtx());
  const lines = [`\u2699\uFE0F Host settings \u00B7 writable: ${writable} \u00B7 document: ${hasDocument ? plain(truncate(documentPath ?? "yes", 48)) : "none"}`, ""];
  for (const ns of namespaces.slice(0, 15)) {
    const secrets = ns.secrets.filter((secret) => secret.set).length;
    lines.push(`\u2022 ${plain(truncate(ns.ns, 36))} \u00B7 applies: ${ns.applies} \u00B7 rev ${ns.revision} \u00B7 secrets set: ${secrets}`);
  }
  if (namespaces.length === 0) lines.push("No settings namespaces registered.");
  if (internalNamespaces.length > 0) {
    lines.push("", `Outside the web boundary (not listed): ${internalNamespaces.slice(0, 8).map(plain).join(", ")}${internalNamespaces.length > 8 ? "\u2026" : ""}`);
  }
  lines.push("", "Describe: /settingsdescribe [ns] \u00B7 Update: /settingsupdate &lt;ns&gt; &lt;json patch&gt;");
  await openCard(chatId, lines.join("\n"), buildSettingsKeyboard(namespaces.map((ns) => ns.ns)));
}

async function openSettingsNamespaceCard(chatId: number, ns: string): Promise<void> {
  const { namespaces } = describeSettings(requireCtx());
  const view = namespaces.find((candidate) => candidate.ns === ns);
  if (!view) return openHostSettingsCard(chatId);
  const lines = [
    `\u2699\uFE0F ${plain(truncate(ns, 40))}`,
    "",
    `applies: ${view.applies} \u00B7 revision: ${view.revision}`,
    view.schema !== undefined ? `schema: ${plain(truncate(JSON.stringify(view.schema), 300))}` : "schema: (not declared)",
    `value: ${plain(truncate(JSON.stringify(view.value), 300))}`,
    view.user !== undefined ? `user: ${plain(truncate(JSON.stringify(view.user), 200))}` : "",
    `secrets: ${view.secrets.map((secret) => `${secret.path.join(".")}=${secret.set ? "set" : "unset"}`).join(", ") || "none"}`,
  ].filter((line) => line !== "");
  await openCard(chatId, lines.join("\n"), buildSettingsKeyboard([ns]));
}

async function openCredentialsCard(chatId: number): Promise<void> {
  const refs = await listCredentialRefs(requireCtx());
  const lines = [
    "\u{1F511} Credentials",
    "",
    "Describe: /credential &lt;REF&gt; [REF...] (configured/source/writable, value never shown)",
    "Set: /credentialset &lt;REF&gt; &lt;value&gt; \u00B7 Unset: /credentialunset &lt;REF&gt;",
    "",
    refs.length > 0 ? `Available refs (${refs.length}) \u2014 tap to describe:` : "This host exposes no ref roster (credentials are non-enumerable here).",
    ...refs.slice(0, 12).map((ref) => `\u2022 ${plain(ref)}`),
    refs.length > 12 ? `\u2026 +${refs.length - 12}` : "",
    "",
    "The secret value never rides back \u2014 same as the web form.",
  ].filter((line) => line !== "");
  await openCard(chatId, lines.join("\n"), buildCredentialsKeyboard(refs.slice(0, 12).map((ref) => ({ ref, cb: token({ action: "credential-show", ref }) }))));
}

async function openHostCard(chatId: number): Promise<void> {
  // No hardcoded version: the host version comes from the hostInfo seam or
  // DSH_VERSION; when the profile exposes neither, say so instead of showing
  // a bridge-owned number (the bridge version lives in About).
  const host = describeHost(requireCtx(), state.workspaceRoot);
  const lines = [
    "\u{1F5A5} Host",
    "",
    `version: ${host.version ? plain(host.version) : "unknown (not exposed to plugins)"} \u00B7 cwd: ${plain(truncate(host.cwd, 40))}`,
    `model default: ${host.provider ? `${plain(host.provider)}/` : ""}${host.model ? plain(host.model) : "default"}`,
    `attached sessions: ${host.attachedSessions} \u00B7 canOpenPath: ${host.canOpenPath}`,
    "",
    "Browse: pick a folder below \u00B7 Text: /ls [path] \u00B7 Mkdir: /mkdir &lt;path&gt;",
  ];
  await openCard(chatId, lines.join("\n"), buildHostKeyboard());
}

const HOST_BROWSE_PAGE_SIZE = 20;

/** Telegram-native host.listDirectory: clickable breadcrumb browsing instead
 * of a raw `/ls` dump. Directories are buttons; files are only counted so a
 * large folder never overflows the callback keyboard. */
async function openHostDirectoryCard(chatId: number, path: string, page = 0): Promise<void> {
  const target = resolve(path);
  const res = await listDirectory(target);
  const dirs = (res.entries ?? []).filter((entry) => entry.kind === "directory");
  const files = (res.entries ?? []).length - dirs.length;
  const totalPages = Math.max(1, Math.ceil(dirs.length / HOST_BROWSE_PAGE_SIZE));
  const safe = Math.max(0, Math.min(page, totalPages - 1));
  const pageDirs = dirs.slice(safe * HOST_BROWSE_PAGE_SIZE, (safe + 1) * HOST_BROWSE_PAGE_SIZE);
  const lines = [
    res.ok ? `\u{1F4C2} ${plain(truncate(target, 80))}` : `\u274C ${plain(truncate(target, 80))}`,
    "",
    res.ok
      ? `${dirs.length} dirs \u00B7 ${files} files \u00B7 page ${safe + 1}/${totalPages}`
      : `Cannot list this path: ${plain(res.text)}`,
    "",
  ];
  if (res.ok && pageDirs.length === 0) lines.push("(this directory contains files only)");
  // Breadcrumb: every ancestor up to the current directory is one tap.
  const crumbs = breadcrumbSegments(target);
  if (res.ok && crumbs.length > 1) {
    const shown = crumbs.length > 3 ? [{ label: "\u2026", path: crumbs[crumbs.length - 3]!.path }, ...crumbs.slice(-2)] : crumbs.slice(0, -1);
    lines.splice(2, 0, shown.map((crumb) => plain(crumb.label)).join(" \u203A "));
  }
  await openCard(chatId, lines.join("\n"), buildProjectKeyboard(
    pageDirs.map((entry) => ({ label: entry.name, cb: token({ action: "host-open", path: join(target, entry.name) }) })),
    {
      up: token({ action: "host-open", path: parentOf(target) }),
      home: token({ action: "host-open", path: homedir() }),
      root: token({ action: "host-open", path: parse(target).root }),
      breadcrumb: (res.ok && crumbs.length > 1 ? (crumbs.length > 3 ? [{ label: "\u2026", path: crumbs[crumbs.length - 3]!.path }, ...crumbs.slice(-2)] : crumbs.slice(0, -1)) : []).map(
        (crumb) => ({ label: crumb.label, cb: token({ action: "host-open", path: crumb.path }) }),
      ),
      paging: [
        ...(safe > 0 ? [{ text: "\u2039 Prev", cb: token({ action: "host-page", path: target, page: String(safe - 1) }) }] : []),
        ...(safe + 1 < totalPages ? [{ text: "More \u203A", cb: token({ action: "host-page", path: target, page: String(safe + 1) }) }] : []),
      ],
      newFolder: token({ action: "host-mkdir-prompt", path: target }),
      close: "m:host",
    },
  ));
}

const JOBS_PAGE_SIZE = 20;

async function openJobsCard(chatId: number, page = 0): Promise<void> {
  const agent = currentAgent(chatId);
  const jobs = listJobs(requireCtx(), agent?.id);
  const totalPages = Math.max(1, Math.ceil(jobs.length / JOBS_PAGE_SIZE));
  const safe = Math.max(0, Math.min(page, totalPages - 1));
  const pageItems = jobs.slice(safe * JOBS_PAGE_SIZE, (safe + 1) * JOBS_PAGE_SIZE);
  const lines = [`\u{1F527} Jobs (${jobs.length}) \u00B7 page ${safe + 1}/${totalPages}`, ""];
  for (const job of pageItems) {
    lines.push(`\u2022 ${plain(job.kind)} [${plain(job.id)}] \u00B7 ${job.status}${job.detail ? ` \u00B7 ${plain(truncate(job.detail, 30))}` : ""}`);
    lines.push(`  ${plain(truncate(job.label, 60))} \u00B7 started ${plain(new Date(job.startedAt).toLocaleString())}`);
  }
  if (jobs.length === 0) lines.push("(none)");
  await openCard(chatId, lines.join("\n"), buildPagingKeyboard({
    ...(safe > 0 ? { previous: token({ action: "jobs-page", page: String(safe - 1) }) } : {}),
    ...(safe + 1 < totalPages ? { next: token({ action: "jobs-page", page: String(safe + 1) }) } : {}),
    back: "m:back",
  }));
}

async function openDynamicCordisCard(chatId: number): Promise<void> {
  const rows = listDynamicCordis(requireCtx());
  const lines = [`\u{1F9F0} Dynamic plugins (${rows.length})`, ""];
  const pluginRows: PluginRow[] = [];
  for (const row of rows.slice(0, 15)) {
    const pluginId = String(row.pluginId);
    const running = row.activeRun !== undefined && row.activeRun !== null;
    const current = row.currentPackageId === undefined || row.currentPackageId === null ? undefined : String(row.currentPackageId);
    const versions = Array.isArray(row.packages) ? row.packages.length : 0;
    lines.push(`\u2022 ${plain(pluginId)} \u00B7 ${versions} pkg${current === undefined ? "" : ` \u00B7 @ ${plain(truncate(current, 18))}`}${running ? " \u00B7 \u25B6 running" : ""}`);
    pluginRows.push({
      pluginId,
      running,
      callbacks: {
        run: token({ action: "plugin-run", pluginId }),
        stop: token({ action: "plugin-stop", pluginId }),
        remove: token({ action: "plugin-remove", pluginId }),
      },
    });
  }
  if (rows.length === 0) {
    lines.push("(none)", "", "Install your own plugin from the phone:", "tap \u2795 Add plugin, then reply with a JSON:", '{"name": "my-decoder", "purpose": "...", "host": "<js source>"}', "The host half can call your own model to decode.");
  }
  await openCard(chatId, lines.join("\n"), buildPluginLifecycleKeyboard(pluginRows));
}

async function openCapabilitiesCard(chatId: number): Promise<void> {
  const caps = probeCapabilities(requireCtx());
  const lines = ["\u{1F9E9} Host capabilities", ""];
  for (const [key, available] of Object.entries(caps) as [string, boolean][]) {
    lines.push(`${available ? "\u2705" : "\u274C"} ${plain(key)}`);
  }
  const missing = missingServices(requireCtx());
  if (missing.length > 0) lines.push("", `Missing (cards degrade with hints): ${missing.map(plain).join(", ")}`);
  await openCard(chatId, lines.join("\n"), buildCapabilitiesKeyboard());
}

async function openFeedbackListCard(chatId: number, sessionId: string): Promise<void> {
  const items = await cardLoad(chatId, "feedback list", () => listFeedback(requireCtx(), sessionId));
  if (items === undefined) return;
  const lines = [`\u{1F4CB} Feedback \u00B7 ${plain(truncate(sessionId, 24))} (${items.length})`, ""];
  const rows: { text: string; callback_data: string }[][] = [];
  for (const item of items.slice(0, 20)) {
    lines.push(`\u2022 ${item.rating === "positive" ? "\u{1F44D}" : "\u{1F44E}"} [${item.messageId.slice(0, 8)}]${item.note ? ` ${plain(truncate(item.note, 40))}` : ""}`);
    rows.push([
      {
        text: `\u{1F5D1} Delete [${item.messageId.slice(0, 8)}]`,
        callback_data: token({ action: "feedback-delete", sessionId, messageId: item.messageId, ifVersion: item.version }),
      },
    ]);
  }
  if (items.length === 0) lines.push("(no feedback yet \u2014 tap \u{1F44D}/\u{1F44E} under an assistant reply)");
  rows.push([{ text: "\u2190 Back", callback_data: "m:back" }]);
  await openCard(chatId, lines.join("\n"), { inline_keyboard: rows });
}

async function openModeCard(chatId: number): Promise<void> {
  const mode = modeSummary();
  const displayName = state.config.mode?.name;
  const lines = [
    `\u{1F3AD} Mode${displayName ? ` \u00B7 ${plain(displayName)}` : ""}`,
    "",
    plain(mode.note),
    `Profiles: ${mode.profiles.length > 0 ? mode.profiles.map(plain).join(", ") : "none found"}`,
  ];
  lines.push("", "Switch profile by restarting dsh with `dsh --profile &lt;name&gt;`.");
  await openCard(chatId, lines.join("\n"), buildBackKeyboard());
}

async function openAllowedCard(chatId: number): Promise<void> {
  const allowed = state.config.security.allowedChatIds;
  const lines = [`\u{1F510} Allowed chats (${allowed.length})`, ""];
  for (const id of allowed) lines.push(`\u2022 ${plain(String(id))}`);
  if (allowed.length === 0) lines.push("Nobody is allowed yet \u2014 inbound messages are ignored.");
  await openCard(chatId, lines.join("\n"), {
    inline_keyboard: [
      [{ text: "\u2795 Allow this chat", callback_data: "m:allowthis" }],
      [{ text: "\u2190 Back", callback_data: "m:back" }],
    ],
  });
}

async function openWatchCard(chatId: number): Promise<void> {
  const lines = [`\u{1F4E1} Watch`, "", state.watching ? "Telegram polling is ON." : "Telegram polling is OFF.", `autoStart: ${state.config.watch.autoStart}`];
  await openCard(chatId, lines.join("\n"), {
    inline_keyboard: [
      [{ text: state.watching ? "\u23F8 Pause polling" : "\u25B6 Start polling", callback_data: "m:watchtoggle" }],
      [{ text: "\u2190 Back", callback_data: "m:back" }],
    ],
  });
}

async function openSettingsCard(chatId: number): Promise<void> {
  const c = state.config.outbound;
  const lines = [
    "\u2699\uFE0F Telegram settings",
    "",
    `parseMode: ${c.parseMode}`,
    `disableNotification: ${c.disableNotification}`,
    `maxRetries: ${c.maxRetries} \u00B7 sendRatePerSecond: ${c.sendRatePerSecond}`,
    `maxMessageLength: ${c.maxMessageLength}`,
    "",
    "Edit .pi/telegram.json in the workspace to change these values.",
    "",
    "Host settings live under /hostsettings; credentials under /credentials.",
  ];
  await openCard(chatId, lines.join("\n"), {
    inline_keyboard: [[{ text: "\u2190 Back", callback_data: "m:back" }]],
  });
}

async function openAboutCard(chatId: number): Promise<void> {
  const bot = state.transport ? await state.transport.botInfo().catch(() => undefined) : undefined;
  const lines = [
    "\u2139\uFE0F dsh-telegram",
    "",
    `version: ${version}`,
    `bot: ${bot ? `@${plain(bot.username)} (${bot.id})` : "not connected"}`,
    `token: ${resolveToken() ? "set" : "missing"}`,
    `workspace: ${plain(state.workspaceRoot)}`,
  ];
  await openCard(chatId, lines.join("\n"), {
    inline_keyboard: [[{ text: "\u2190 Back", callback_data: "m:back" }]],
  });
}

// ---------------------------------------------------------------------------
// Callback dispatch
// ---------------------------------------------------------------------------

async function dispatchToken(chatId: number, payload: Record<string, string>): Promise<void> {
  const action = payload["action"];
  const ext = extensionForCallback(action);
  if (ext) {
    const host = buildExtensionHost();
    return ext.handler(chatId, payload, host);
  }
  const agent = currentAgent(chatId);
  switch (action) {
    case "project-open": {
      const offset = Number(payload["offset"] ?? "0");
      return openProjectCard(chatId, payload["path"], Number.isFinite(offset) && offset > 0 ? offset : 0);
    }
    case "project-up":
      return openProjectCard(chatId, parentOf(payload["path"] ?? state.workspaceRoot));
    case "project-select":
      return applyProjectPath(chatId, payload["path"] ?? state.workspaceRoot);
    case "ws-pick-open": {
      const offset = Number(payload["page"] ?? payload["offset"] ?? "0");
      return openWorkspaceCreatePicker(chatId, payload["path"] ?? state.workspaceRoot, Number.isFinite(offset) && offset > 0 ? offset : 0);
    }
    case "ws-pick-page": {
      const page = Number(payload["page"] ?? "0");
      return openWorkspaceCreatePicker(chatId, payload["path"] ?? state.workspaceRoot, Number.isFinite(page) && page > 0 ? page : 0);
    }
    case "ws-create-here": {
      const path = payload["path"] ?? state.workspaceRoot;
      const res = await createWorkspace(requireCtx(), path, basename(path) || undefined);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openWorkspacesCard(chatId);
    }
    case "host-open":
      return openHostDirectoryCard(chatId, payload["path"] ?? state.workspaceRoot);
    case "host-mkdir-prompt": {
      const path = payload["path"] ?? state.workspaceRoot;
      pendingMkdir = { chatId, path };
      await uiSend(chatId, `\u{1F4C1} Reply with the new folder name under ${plain(truncate(path, 48))} (or /cancel):`, {
        parse_mode: "HTML",
        reply_markup: inputPromptKeyboard("New folder name\u2026"),
      });
      return;
    }
    case "host-page": {
      const page = Number(payload["page"] ?? "0");
      return openHostDirectoryCard(chatId, payload["path"] ?? state.workspaceRoot, Number.isFinite(page) && page > 0 ? page : 0);
    }
    case "model-select": {
      const provider = payload["provider"] ?? "";
      const model = payload["model"] ?? "";
      if (!agent) {
        // Web semantics: a session must exist for a model to attach to.
        // Auto-create one with the chosen model (same path as `✨ New`)
        // instead of failing the tap, and persist the choice as the
        // bridge's default so future sessions inherit it.
        const { result: res, agentId } = await createSessionForChat(chatId, { provider, model }, undefined, true);
        bindCreatedSession(chatId, agentId);
        const selected = normalizeOpencodeGoModel(provider, model);
        if (res.ok) {
          state.config.model = { provider: selected.provider, model: selected.model };
          writeConfig(state.configRoot, state.config);
        }
        log(`model-select (no agent) provider=${provider} model=${model} -> ${res.ok ? "ok" : res.text}${selected.provider === provider ? "" : ` (routed via ${selected.provider})`}`);
        await uiSend(chatId, res.ok ? `\u2728 ${plain(res.text)} \u00B7 model ${plain(selected.provider)}/${plain(selected.model)}` : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
        refreshAllPanels();
        scheduleBarSync(chatId, 0);
        return openModelsCard(chatId);
      }
      const res = await selectSessionModel(requireCtx(), agent.id, provider, model);
      log(`model-select agent=${agent.id} provider=${provider} model=${model} -> ${res.ok ? "ok" : res.text}`);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      refreshAllPanels();
      // Return to the PROVIDER card (not the overview): the freshly selected
      // model must show its check mark immediately (#47).
      return openProviderModelsCard(chatId, provider);
    }
    case "model-page": {
      const page = Number(payload["page"] ?? "0");
      return openProviderModelsCard(chatId, payload["provider"] ?? "", Number.isFinite(page) && page > 0 ? page : 0);
    }
    case "model-thinking":
      return openModelThinkingCard(chatId, payload["provider"] ?? "", payload["model"] ?? "");
    case "model-effort": {
      const provider = payload["provider"] ?? "";
      const model = payload["model"] ?? "";
      const effort = payload["effort"] ?? "";
      if (!agent || !isReasoningEffort(effort)) return openProviderModelsCard(chatId, provider);
      const res = await selectSessionModel(requireCtx(), agent.id, provider, model, effort);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      refreshAllPanels();
      return openProviderModelsCard(chatId, provider);
    }
    case "goal": {
      if (!agent) return openGoalsCard(chatId);
      const op = payload["op"] ?? "";
      const goal = getGoal(requireCtx(), agent.id);
      if (!goal) {
        await uiSend(chatId, "\u274C No current goal \u2014 start one with /goal &lt;objective&gt; [maxRounds].", { parse_mode: "HTML" });
        return openGoalsCard(chatId);
      }
      if (op === "edit") {
        await uiSend(chatId, "/goaledit &lt;new objective&gt; [maxRounds]", { parse_mode: "HTML" });
        return;
      }
      if (op === "clear") {
        return askConfirm(
          chatId,
          `\u{1F5D1} Clear the current goal?\n${plain(truncate(goal.objective, 120))}`,
          { action: "goal-clear-confirm", agentId: agent.id },
          { action: "goal-clear-cancel", agentId: agent.id },
        );
      }
      const res = op === "resume"
        ? await resumeGoal(requireCtx(), agent.id, goal.id, goal.revision)
        : await pauseGoal(requireCtx(), agent.id, goal.id, goal.revision);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openGoalsCard(chatId);
    }
    case "goal-clear-confirm": {
      const goal = agent ? getGoal(requireCtx(), agent.id) : undefined;
      if (!agent || !goal) {
        await uiSend(chatId, "\u274C No current goal to clear.", { parse_mode: "HTML" });
        return openGoalsCard(chatId);
      }
      const res = await clearGoal(requireCtx(), agent.id, goal.id, goal.revision);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      refreshAllPanels();
      return openGoalsCard(chatId);
    }
    case "goal-clear-cancel": {
      await uiSend(chatId, "\u2716 Goal clear cancelled.", { parse_mode: "HTML" });
      return openGoalsCard(chatId);
    }
    case "subagent":
      return openSubagentDetailCard(chatId, payload["parentId"] ?? "", payload["childId"] ?? "");
    case "subagent-prompt": {
      const parentId = payload["parentId"] ?? "";
      const childId = payload["childId"] ?? "";
      if (!(await isContinuableSubagent(parentId, childId))) {
        await uiSend(chatId, "\u274C That subagent is not continuable.", { parse_mode: "HTML" });
        return openSubagentDetailCard(chatId, parentId, childId);
      }
      await uiSend(chatId, "Reply with the prompt text:", {
        parse_mode: "HTML",
        reply_markup: inputPromptKeyboard("Prompt for subagent\u2026"),
      });
      pendingSubagentPrompt = { chatId, parentId, childId };
      return;
    }
    case "subagent-interrupt": {
      const parentId = payload["parentId"] ?? "";
      const childId = payload["childId"] ?? "";
      if (!(await isContinuableSubagent(parentId, childId))) {
        await uiSend(chatId, "\u274C That subagent is not continuable.", { parse_mode: "HTML" });
        return openSubagentDetailCard(chatId, parentId, childId);
      }
      return askConfirm(
        chatId,
        `\u23F9 Interrupt subagent ${plain(truncate(childId, 28))}?`,
        { action: "subagent-interrupt-confirm", parentId, childId },
        { action: "subagent-interrupt-cancel", parentId, childId },
      );
    }
    case "subagent-interrupt-confirm": {
      const res = interruptSubagent(requireCtx(), payload["parentId"] ?? "", payload["childId"] ?? "");
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openSubagentsCard(chatId);
    }
    case "subagent-interrupt-cancel": {
      await uiSend(chatId, "\u2716 Interrupt cancelled.", { parse_mode: "HTML" });
      return openSubagentsCard(chatId);
    }
    case "subagent-history": {
      const items = await cardLoad(chatId, "subagent history", () => subagentHistory(requireCtx(), payload["childId"] ?? "", 15));
      if (items === undefined) return;
      const lines = [`\u{1F4DC} ${plain(truncate(payload["childId"] ?? "", 24))}`, ""];
      for (const item of items) lines.push(`[${item.seq}] ${item.role} ${plain(truncate(item.text, 100))}`);
      await openCard(chatId, lines.join("\n"), buildBackKeyboard());
      return;
    }
    case "preset":
      return openPresetDetailCard(chatId, payload["presetId"] ?? "");
    case "providers":
      return openProvidersCard(chatId);
    case "provider":
      return openProviderModelsCard(chatId, payload["provider"] ?? "");
    case "credential-show": {
      const res = await describeCredentials(requireCtx(), [payload["ref"] ?? ""]);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openCredentialsCard(chatId);
    }
    case "preset-new": {
      const presetId = payload["presetId"] ?? "";
      const created = await createSessionForChat(chatId, state.config.model, presetId);
      bindCreatedSession(chatId, created.agentId);
      const suffix = created.agentPreset !== undefined ? ` \u00B7 preset ${plain(created.agentPreset)}` : "";
      await uiSend(chatId, created.result.ok ? `${plain(created.result.text)}${suffix}` : `\u274C ${plain(created.result.text)}`, { parse_mode: "HTML" });
      if (created.result.ok) {
        refreshAllPanels();
        scheduleBarSync(chatId, 0);
      }
      return openPresetsCard(chatId);
    }
    case "preset-select": {
      const sessionId = payload["sessionId"] ?? "";
      if (!sessionId) {
        await uiSend(chatId, "\u274C No live session \u2014 presets select onto a session.", { parse_mode: "HTML" });
        return openPresetsCard(chatId);
      }
      const presetId = payload["presetId"] ?? "";
      if (!sessionHasStarted(requireCtx(), sessionId)) {
        const res = await selectAgentPreset(requireCtx(), sessionId, presetId);
        await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
        return openPresetsCard(chatId);
      }
      // Mid-session switch: fork through the last completed turn, apply the
      // preset on the fork, then close the original session and re-bind the
      // chat to the fork.
      const res = await switchAgentPresetMidSession(requireCtx(), sessionId, presetId);
      if (res.ok && res.childId !== undefined) {
        if (res.handle !== undefined) sessionLifecycle.adopt(res.handle as never);
        state.bridge?.bindAgent(chatId, res.childId);
        const closed = await sessionLifecycle.close(sessionId);
        const text = `${plain(res.text)} \u00B7 ${closed.ok ? plain(closed.text) : `\u26A0\uFE0F ${plain(closed.text)}`}`;
        await uiSend(chatId, text, { parse_mode: "HTML" });
        refreshAllPanels();
        scheduleBarSync(chatId, 0);
      } else {
        await uiSend(chatId, `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      }
      return openPresetsCard(chatId);
    }
    case "preset-default": {
      const res = await setDefaultAgentPreset(requireCtx(), payload["presetId"] ?? "");
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openPresetsCard(chatId);
    }
    case "session-archive": {
      const sessionId = payload["sessionId"] ?? "";
      const res = await archiveSession(requireCtx(), sessionId);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openSessionsCard(chatId, lastProjectKey(chatId));
    }
    case "session-delete": {
      const sessionId = payload["sessionId"] ?? "";
      return askConfirm(
        chatId,
        `\u{1F5D1} Delete session ${plain(truncate(sessionId, 24))}?`,
        { action: "session-delete-confirm", sessionId },
        { action: "session-delete-cancel", sessionId },
      );
    }
    case "session-delete-confirm": {
      const sessionId = payload["sessionId"] ?? "";
      const res = await deleteSession(requireCtx(), sessionId);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openSessionsCard(chatId, lastProjectKey(chatId));
    }
    case "session-delete-cancel": {
      await uiSend(chatId, "\u2716 Delete cancelled.", { parse_mode: "HTML" });
      return openSessionsCard(chatId, lastProjectKey(chatId));
    }
    case "sessions-page": {
      const page = Number(payload["page"] ?? "0");
      const projectKey = payload["projectKey"] ?? lastProjectKey(chatId);
      return openSessionsCard(chatId, projectKey, Number.isFinite(page) && page > 0 ? page : 0);
    }
    case "sessions-projects": {
      return openSessionProjectsCard(chatId);
    }
    case "sessions-projects-page": {
      const page = Number(payload["page"] ?? "0");
      return openSessionProjectsCard(chatId, Number.isFinite(page) && page > 0 ? page : 0);
    }
    case "sessions-project": {
      const projectKey = payload["projectKey"] ?? lastProjectKey(chatId);
      return openSessionsCard(chatId, projectKey);
    }
    case "sessions-open": {
      return openSessionsCard(chatId, lastProjectKey(chatId));
    }
    case "plugins-page": {
      const page = Number(payload["page"] ?? "0");
      return openPluginsCard(chatId, Number.isFinite(page) && page > 0 ? page : 0);
    }
    case "jobs-page": {
      const page = Number(payload["page"] ?? "0");
      return openJobsCard(chatId, Number.isFinite(page) && page > 0 ? page : 0);
    }
    case "search-page": {
      const page = Number(payload["page"] ?? "0");
      const query = payload["query"] ?? "";
      if (query === "") return openSessionsCard(chatId, lastProjectKey(chatId));
      return openSearchCard(chatId, query, Number.isFinite(page) && page > 0 ? page : 0);
    }
    case "history-older": {
      const beforeSeq = Number(payload["beforeSeq"] ?? "");
      return openHistoryCard(chatId, payload["sessionId"] ?? "", Number.isFinite(beforeSeq) ? beforeSeq : undefined);
    }
    case "preset-read": {
      const res = await readAgentPreset(requireCtx(), payload["presetId"] ?? "");
      if (res.ok) {
        await uiSend(chatId, plain((res.content ?? "").slice(0, 3800)) || "(empty composition)", { parse_mode: "HTML" });
      } else {
        await uiSend(chatId, `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      }
      return;
    }
    case "preset-copy": {
      const sourceId = payload["presetId"] ?? "";
      pendingPresetCopy = { chatId, sourceId };
      await uiSend(chatId, `\u{1F4CB} Reply with the new preset id for a copy of ${plain(truncate(sourceId, 32))} (or /cancel):`, {
        parse_mode: "HTML",
        reply_markup: inputPromptKeyboard("New preset id\u2026"),
      });
      return;
    }
    case "preset-remove": {
      const presetId = payload["presetId"] ?? "";
      return askConfirm(
        chatId,
        `\u{1F5D1} Remove agent preset ${plain(truncate(presetId, 32))}?`,
        { action: "preset-remove-confirm", presetId },
        { action: "preset-remove-cancel", presetId },
      );
    }
    case "preset-remove-confirm": {
      const res = await removeAgentPreset(requireCtx(), payload["presetId"] ?? "");
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openPresetsCard(chatId);
    }
    case "preset-remove-cancel": {
      await uiSend(chatId, "\u2716 Remove cancelled.", { parse_mode: "HTML" });
      return openPresetsCard(chatId);
    }
    // Issue #50: dynamic plugin lifecycle from the phone. Run/Stop act on the
    // chat's bound agent (session-scoped ownership, web semantics); Remove
    // confirms first because it deletes every immutable Package version.
    case "plugin-run": {
      const pluginId = payload["pluginId"] ?? "";
      const agent = currentAgent(chatId);
      if (!agent) {
        await uiSend(chatId, "\u274C No live session in this chat \u2014 send a message first, then run plugins.", { parse_mode: "HTML" });
        return;
      }
      const res = await runDynamicPlugin(requireCtx(), agent, pluginId);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      refreshAllPanels();
      return;
    }
    case "plugin-stop": {
      const pluginId = payload["pluginId"] ?? "";
      const agent = currentAgent(chatId);
      if (!agent) {
        await uiSend(chatId, "\u274C No live session in this chat.", { parse_mode: "HTML" });
        return;
      }
      const res = await stopDynamicPlugin(requireCtx(), agent, pluginId);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      refreshAllPanels();
      return;
    }
    case "plugin-remove": {
      const pluginId = payload["pluginId"] ?? "";
      return askConfirm(
        chatId,
        `\u{1F5D1} Remove plugin ${plain(truncate(pluginId, 32))}? All versions and the active run are deleted.`,
        { action: "plugin-remove-confirm", pluginId },
        { action: "plugin-remove-cancel", pluginId },
      );
    }
    case "plugin-remove-confirm": {
      const pluginId = payload["pluginId"] ?? "";
      const agent = currentAgent(chatId);
      if (!agent) {
        await uiSend(chatId, "\u274C No live session in this chat.", { parse_mode: "HTML" });
        return;
      }
      const res = await undefineDynamicPlugin(requireCtx(), agent, pluginId);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      refreshAllPanels();
      return openDynamicCordisCard(chatId);
    }
    case "plugin-remove-cancel": {
      await uiSend(chatId, "\u2716 Remove cancelled.", { parse_mode: "HTML" });
      return openDynamicCordisCard(chatId);
    }
    case "preset-open": {
      const res = openAgentPresetDocument(requireCtx(), payload["presetId"] ?? "");
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return;
    }
    case "workspace-use": {
      const workspace = listWorkspaces(requireCtx()).items.find((candidate) => candidate.workspaceId === payload["workspaceId"]);
      if (!workspace) {
        await uiSend(chatId, "\u274C Workspace not found \u2014 reopen the Workspaces card.", { parse_mode: "HTML" });
        return openWorkspacesCard(chatId);
      }
      return applyProjectPath(chatId, workspace.path);
    }
    case "workspace-delete-confirm": {
      const res = await deleteWorkspace(requireCtx(), payload["id"] ?? "");
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openWorkspacesCard(chatId);
    }
    case "workspace-delete-cancel": {
      await uiSend(chatId, "\u2716 Delete cancelled.", { parse_mode: "HTML" });
      return openWorkspacesCard(chatId);
    }
    case "compact-auto": {
      compactionWatcher?.approve(payload["sessionId"] ?? boundAgentId(chatId) ?? "");
      await uiSend(chatId, "\u2705 Compaction queued \u2014 it runs at the next safe boundary.", { parse_mode: "HTML" });
      return;
    }
    case "compact-manual": {
      compactionWatcher?.snooze(payload["sessionId"] ?? boundAgentId(chatId) ?? "");
      await uiSend(chatId, "Send /compact when the agent is idle (or press Abort first).", { parse_mode: "HTML" });
      return;
    }
    case "compact-skip": {
      compactionWatcher?.snooze(payload["sessionId"] ?? boundAgentId(chatId) ?? "");
      await uiSend(chatId, "\u2716 Compaction skipped \u2014 I will ask again later if pressure stays high.", { parse_mode: "HTML" });
      return;
    }
    case "feedback": {
      const sessionId = payload["sessionId"] ?? "";
      const messageId = payload["messageId"] ?? "";
      const rating = payload["rating"] === "positive" ? "positive" : "negative";
      const res = await putFeedback(requireCtx(), sessionId, messageId, rating);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return;
    }
    case "feedback-list":
      return openFeedbackListCard(chatId, payload["sessionId"] ?? "");
    case "feedback-delete": {
      const sessionId = payload["sessionId"] ?? "";
      const messageId = payload["messageId"] ?? "";
      const ifVersion = payload["ifVersion"] ?? "";
      const res = await deleteFeedback(requireCtx(), sessionId, messageId, ifVersion);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openFeedbackListCard(chatId, sessionId);
    }
    default:
      return;
  }
}

let pendingSubagentPrompt: { chatId: number; parentId: string; childId: string } | undefined;
let pendingSteer: { chatId: number; sessionId: string } | undefined;
let pendingSearch: { chatId: number } | undefined;
let pendingPresetCopy: { chatId: number; sourceId: string } | undefined;
let pendingMkdir: { chatId: number; path: string } | undefined;
/** Issue #50: awaiting the plugin-definition JSON reply. */
let pendingPluginAdd: { chatId: number } | undefined;

async function dispatchCallback(chatId: number, data: string): Promise<void> {
  const ext = extensionForCallback(data);
  if (ext) {
    const host = buildExtensionHost();
    return ext.handler(chatId, {}, host);
  }
  if (data.startsWith("t:")) {
    const payload = tokens.take(data);
    if (payload) {
      log(`token dispatch ${data} action=${payload["action"] ?? "-"}`);
      try {
        return await dispatchToken(chatId, payload);
      } catch (err) {
        // A callback that failed before producing its effect must stay
        // retryable: the user would otherwise be trapped behind
        // "already handled" with no way to try again.
        const restored = tokens.restore(data, payload);
        log(`token dispatch failed and token ${restored ? "restored for retry" : "stayed consumed"} action=${payload["action"] ?? "-"}`, err);
        throw err;
      }
    }
    const used = tokens.wasUsed(data);
    log(`token miss ${data} (${used ? "already handled" : "bot restarted since the card rendered"})`);
    await uiSend(
      chatId,
      used
        ? "\u26A0\uFE0F That button already ran \u2014 the result is in the chat above."
        : "\u26A0\uFE0F That button was from an older card (bot restarted). Reopen the card and tap again.",
      { parse_mode: "HTML" },
    );
    return;
  }
  if (data.startsWith("ap:")) {
    const parts = data.split(":");
    const answer = parts[2];
    const outcome =
      answer === "y" ? "allowed-once" :
      answer === "g" ? "allowed-goal" :
      answer === "s" ? "allowed-session" :
      answer === "a" ? "allowed-always" : "rejected";
    const accepted = state.interactive?.answerApproval(Number(parts[1]), outcome);
    if (!accepted) await uiSend(chatId, "\u274C That approval is already settled.", { parse_mode: "HTML" });
    return;
  }
  if (data.startsWith("qu:")) {
    const parts = data.split(":");
    const id = Number(parts[1]);
    if (parts[2] === "s") {
      await state.interactive?.submitQuestions(chatId, id);
    } else if (parts[2] === "c") {
      await state.interactive?.cancelQuestions(chatId, id);
    } else {
      const questionIndex = Number(parts[2]);
      const optionId = parts.slice(3).join(":");
      const questionId = questionIdAt(id, questionIndex);
      if (questionId !== undefined) await state.interactive?.toggleQuestionOption(chatId, id, questionId, optionId);
    }
    return;
  }
  if (data.startsWith("s:")) {
    const [, id, sub] = data.split(":");
    if (sub === "use") {
      let targetId: string | undefined;
      if (!sessionLifecycle.find(requireCtx(), id)) {
        const res = await resumeSession(requireCtx(), id).catch(() => undefined);
        if (res?.ok && res.agentId !== undefined) {
          if (res.handle !== undefined) sessionLifecycle.adopt(res.handle);
          targetId = res.agentId;
        }
      } else {
        targetId = id;
      }
      if (targetId === undefined) {
        await uiSend(chatId, `\u274C Session ${plain(truncate(id, 32))} is not live.`, { parse_mode: "HTML" });
      } else {
        state.bridge?.bindAgent(chatId, targetId);
        await uiSend(chatId, `\u{1F3AF} Switched to session ${plain(truncate(targetId, 32))}.`, { parse_mode: "HTML" });
      }
      return openSessionsCard(chatId, lastProjectKey(chatId));
    }
    if (sub === "history") return openHistoryCard(chatId, id);
    if (sub === "rename") {
      await uiSend(chatId, `/rename <title> \u2014 reply with just the title to rename ${plain(truncate(id, 24))}:`, {
        parse_mode: "HTML",
        reply_markup: inputPromptKeyboard("New session title\u2026"),
      });
      pendingRename = { chatId, sessionId: id };
      return;
    }
    if (sub === "fork") {
      const res = forkSession(requireCtx(), id);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openSessionsCard(chatId, lastProjectKey(chatId));
    }
    if (sub === "archive") {
      const res = await archiveSession(requireCtx(), id);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      // Return to the DETAIL card so the archive state is immediately visible.
      return openSessionDetailCard(chatId, id);
    }
    if (sub === "model") return openProviderModelsCard(chatId, currentSessionModel(requireCtx(), id).provider ?? "deepseek");
    if (sub === "stop") {
      const res = sessionLifecycle.stop(requireCtx(), id);
      abortChatLoops(chatId);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openSessionDetailCard(chatId, id);
    }
    if (sub === "delete") {
      return askConfirm(
        chatId,
        `\u{1F5D1} Delete session ${plain(truncate(id, 24))}?`,
        { action: "session-delete-confirm", sessionId: id },
        { action: "session-delete-cancel", sessionId: id },
      );
    }
    if (sub === "steer") {
      pendingSteer = { chatId, sessionId: id };
      await uiSend(chatId, `\u{1F3AF} Steer ${plain(truncate(id, 24))} \u2014 send the steer text:`, {
        parse_mode: "HTML",
        reply_markup: inputPromptKeyboard("Steer text\u2026"),
      });
      return;
    }
    if (sub === "log") {
      const exported = await exportSessionLog(requireCtx(), id, false).catch(() => ({ result: { ok: false, text: "session log export failed" }, buffer: undefined }));
      if (exported.result.ok && exported.buffer !== undefined) {
        const fileId = await requireTransport().sendDocument(chatId, exported.buffer, `session-${id.slice(0, 16)}.zip`, `\u{1F4E6} Session log \u00B7 ${plain(truncate(id, 24))}`);
        if (fileId === undefined) await uiSend(chatId, "\u274C Log sent but the document upload was not confirmed.", { parse_mode: "HTML" });
      } else {
        await uiSend(chatId, `\u274C ${plain(exported.result.text)}`, { parse_mode: "HTML" });
      }
      return;
    }
    if (sub === "queue") {
      const agent = sessionLifecycle.find(requireCtx(), id);
      if (!agent) {
        await uiSend(chatId, "\u274C Session is not live \u2014 the queue is agent-owned.", { parse_mode: "HTML" });
        return openSessionsCard(chatId, lastProjectKey(chatId));
      }
      const items = listQueue(requireCtx(), id);
      await openCard(chatId, `\u231B Queue \u00B7 ${plain(truncate(id, 24))} (${items.length})`, buildQueueKeyboard(items.map((item, index) => ({ itemId: item.itemId, kind: item.target, index }))));
      return;
    }
    return openSessionDetailCard(chatId, id);
  }
  if (data.startsWith("w:")) {
    const [, id, sub] = data.split(":");
    // `w:create` predates the `w:<id>:<action>` vocabulary and has no
    // workspace id: dispatch it before the id/sub split misreads "create"
    // as a workspace id and routes it to a nonexistent detail card.
    if (id === "create" && sub === undefined) {
      return openWorkspaceCreatePicker(chatId, state.workspaceRoot);
    }
    if (sub === "rename") {
      await uiSend(chatId, `/workspacerename ${id} &lt;title&gt;`, { parse_mode: "HTML" });
      return;
    }
    if (sub === "delete") {
      return askConfirm(
        chatId,
        `\u{1F5D1} Delete workspace ${plain(truncate(id, 32))}?`,
        { action: "workspace-delete-confirm", id },
        { action: "workspace-delete-cancel", id },
      );
    }
    if (sub === "up" || sub === "down") {
      const { items } = listWorkspaces(requireCtx());
      const index = items.findIndex((workspace) => workspace.workspaceId === id);
      if (index !== -1) {
        const anchor = sub === "up" ? items[index - 1]?.workspaceId : items[index + 2]?.workspaceId;
        const res = await insertWorkspaceBefore(requireCtx(), id, anchor);
        await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      }
      return openWorkspacesCard(chatId);
    }
    if (sub === "pin") {
      await uiSend(chatId, "/workspacepin &lt;workspaceId&gt; &lt;sessionId&gt; [beforeSessionId]", { parse_mode: "HTML" });
      return;
    }
    return openWorkspaceDetailCard(chatId, id);
  }
  if (data.startsWith("q:")) {
    const parts = data.split(":");
    const itemId = parts[1] ?? "";
    const kind = parts[2] ?? "";
    const agent = currentAgent(chatId);
    if (!agent) {
      await uiSend(chatId, "\u274C No live agent owns the queue.", { parse_mode: "HTML" });
      return openQueueCard(chatId);
    }
    if (kind === "e") {
      // Legacy edit button from an older card: the edit flow is gone. Point
      // the user at the delete-and-resend path instead of half-editing text.
      await uiSend(
        chatId,
        "\u270F Inline queue editing was removed \u2014 use \u{1F5D1} Delete, then send your message again.",
        { parse_mode: "HTML" },
      );
      return openQueueCard(chatId);
    }
    if (kind === "r") {
      const queued = listQueue(requireCtx(), agent.id);
      const position = queued.findIndex((entry) => entry.itemId === itemId);
      const label = position >= 0 ? `#${position + 1}` : itemId.slice(0, 8);
      const res = updateQueueItem(requireCtx(), agent.id, itemId, { kind: "remove" });
      await uiSend(chatId, res.ok ? `${plain(res.text)} \u00B7 ${label}` : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      if (res.ok) {
        await uiSend(chatId, `\u{1F5D1} ${label} removed \u2014 send your corrected message again to re-queue it.`, {
          parse_mode: "HTML",
          reply_markup: inputPromptKeyboard("Send the corrected message\u2026"),
        });
      }
      refreshAllPanels();
      scheduleBarSync(chatId, 0);
      return openQueueCard(chatId);
    }
    if (kind === "s") {
      const res = updateQueueItem(requireCtx(), agent.id, itemId, { kind: "steer" });
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      refreshAllPanels();
      scheduleBarSync(chatId, 0);
      return openQueueCard(chatId);
    }
    await uiSend(chatId, "\u274C Unknown queue action \u2014 reopen the Queue card.", { parse_mode: "HTML" });
    return openQueueCard(chatId);
  }
  if (data.startsWith("mo:")) {
    return openProviderModelsCard(chatId, decodeCallbackValue(data.slice(3)));
  }
  if (data.startsWith("set:")) {
    return openSettingsNamespaceCard(chatId, decodeCallbackValue(data.slice(4)));
  }
  if (data.startsWith("h:")) {
    const sub = data.slice(2);
    if (sub === "browse" || sub === "ls") {
      // `ls` remains mapped for stale persisted Host cards from older builds.
      return openHostDirectoryCard(chatId, state.workspaceRoot);
    }
    if (sub === "mkdir") {
      await uiSend(chatId, "/mkdir &lt;path&gt;", { parse_mode: "HTML" });
      return;
    }
    return;
  }
  if (data.startsWith("p:")) {
    const sub = data.slice(2);
    if (sub === "add") {
      pendingPluginAdd = { chatId };
      await uiSend(
        chatId,
        [
          "\u{1F9E9} Reply with the plugin JSON (or /cancel):",
          "",
          '<code>{"name": "my-decoder", "purpose": "decode with my own model", "host": "// js source"}</code>',
          "",
          "Keys: <code>name</code>* \u00B7 <code>purpose</code>* \u00B7 <code>host</code> (JS source) \u00B7 <code>client</code> (JS source). At least one source half is required; a client half activates through the approval card.",
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: inputPromptKeyboard('{"name": …}') },
      );
      return;
    }
    return;
  }
  const match = CALLBACK_RE.exec(data);
  if (!match) return;
  const action = match[1]!;
  const payload = match[2] !== undefined ? decodeCallbackValue(match[2]) : undefined;
  switch (action) {
    case "close":
      stopTodoCardRefresh(chatId);
      cardOrigins.delete(chatId);
      activeCardRenderers.delete(chatId);
      await ephemeral.clear(chatId, uiOps(requireTransport()));
      return;
    case "back":
      stopTodoCardRefresh(chatId);
      // Bar-opened cards close back to the chat; menu-opened cards return to
      // the menu page the user was last on (Back from page 2 must not yank
      // them back to page 1). See issue #16.
      if (cardOrigins.get(chatId) === "bar") {
        cardOrigins.delete(chatId);
        activeCardRenderers.delete(chatId);
        await ephemeral.clear(chatId, uiOps(requireTransport()));
        return;
      }
      return openMenuAt(chatId, menuPageIndex.get(chatId) ?? 0);
    case "more":
      return openMenuAt(chatId, (menuPageIndex.get(chatId) ?? 0) + 1);
    case "prev":
      return openMenuAt(chatId, (menuPageIndex.get(chatId) ?? 0) - 1);
    case "page":
      return;
    case "abort":
    case "stop": {
      const agentId = boundAgentId(chatId);
      if (agentId === undefined) {
        await uiSend(chatId, "\u274C No live agent in this session \u2014 Abort only stops this chat's current turn.", { parse_mode: "HTML" });
        return openMenuAt(chatId, menuPageIndex.get(chatId) ?? 0);
      }
      const res = sessionLifecycle.stop(requireCtx(), agentId);
      // Abort is terminal for background loops too, not just the UI (#48).
      abortChatLoops(chatId);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openMenuAt(chatId, menuPageIndex.get(chatId) ?? 0);
    }
    case "collapsebar":
      return setBarCollapsed(chatId, true);
    case "returnbar":
      return setBarCollapsed(chatId, false);
    case "bartoggle":
      await setBarCollapsed(chatId, state.barCollapsed.get(chatId) !== true);
      return openMenuAt(chatId, menuPageIndex.get(chatId) ?? 0);
    case "project":
      return openProjectCard(chatId);
    case "models":
      return openModelsCard(chatId);
    case "plugins":
      return openPluginsCard(chatId);
    case "sessions":
      return openSessionsCard(chatId, lastProjectKey(chatId));
    case "search": {
      pendingSearch = { chatId };
      await uiSend(chatId, "\u{1F50D} Reply with the search query:", {
        parse_mode: "HTML",
        reply_markup: inputPromptKeyboard("Search query\u2026"),
      });
      return;
    }

    case "use": {
      const id = payload ?? "";
      if (id === "" || !sessionLifecycle.find(requireCtx(), id)) {
        await uiSend(chatId, `\u274C Session ${plain(truncate(id, 32))} is not live.`, { parse_mode: "HTML" });
        return;
      }
      state.bridge?.bindAgent(chatId, id);
      await uiSend(chatId, `\u{1F3AF} Switched to session ${plain(truncate(id, 32))}.`, { parse_mode: "HTML" });
      return openSessionsCard(chatId, lastProjectKey(chatId));
    }
    case "mode":
      return openModeCard(chatId);
    case "queue":
      return openQueueCard(chatId);
    case "allowed":
      return openAllowedCard(chatId);
    case "watch":
      return openWatchCard(chatId);
    case "settings":
      return openSettingsCard(chatId);
    case "about":
      return openAboutCard(chatId);
    case "status":
      return openStatusPanel(chatId);
    case "new":
      return openNewSessionCard(chatId);
    case "new-default": {
      const { result: res, agentId } = await createSessionForChat(chatId);
      const bound = bindCreatedSession(chatId, agentId);
      await sendWithLiveBar(chatId, res.ok
        ? (bound ? `\u2728 ${plain(res.text)}` : "\u274C Session created but the chat binding is not live yet \u2014 send any message to rebind.")
        : `\u274C ${plain(res.text)}`);
      return;
    }
    case "compact": {
      const res = await compactCurrent(requireCtx(), boundAgentId(chatId));
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return;
    }
    case "allowthis": {
      if (!isChatAllowed(state.config, chatId)) {
        state.config.security.allowedChatIds.push(chatId);
        writeConfig(state.configRoot, state.config);
      }
      state.chats.add(chatId);
      // A first touch of `/start` landed on the unauthorized prompt; after
      // granting access land the user in the real welcome instead of making
      // them resend the command.
      if (pendingStartAfterAllow.delete(chatId)) return dispatchCommand(chatId, "start", "");
      return openAllowedCard(chatId);
    }
    case "watchtoggle":
      if (state.watching) await stopWatching();
      else await startWatching();
      await uiSend(
        chatId,
        state.watching
          ? "\u{1F4E1} Polling resumed."
          : "\u23F8 Polling stopped \u2014 tap Watch \u2192 Start to resume, or send /telegram start.",
        { parse_mode: "HTML" },
      );
      return openWatchCard(chatId);
    case "workspaces":
      return openWorkspacesCard(chatId);
    case "goals":
      return openGoalsCard(chatId);
    case "todos":
      return openTodosCard(chatId);
    case "skills":
      return openSkillsCard(chatId);
    case "subagents":
      return openSubagentsCard(chatId);
    case "presets":
      return openPresetsCard(chatId);
    case "hostsettings":
      return openHostSettingsCard(chatId);
    case "credentials":
      return openCredentialsCard(chatId);
    case "host":
      return openHostCard(chatId);
    case "jobs":
      return openJobsCard(chatId);
    case "dynamic":
      return openDynamicCordisCard(chatId);
    case "capabilities":
      return openCapabilitiesCard(chatId);
    case "discover":
      await uiSend(chatId, "/discover &lt;settingsNs&gt; [baseURL]", { parse_mode: "HTML" });
      return;
    case "cred-describe":
      await uiSend(chatId, "/credential &lt;REF&gt; [REF...]", { parse_mode: "HTML" });
      return;
    default:
      return;
  }
}

let pendingRename: { chatId: number; sessionId: string } | undefined;
let pendingWorkspaceCreate: { chatId: number } | undefined;
/** Chats whose first touch was `/start` while unauthorized: once they tap
 * Allow, replay the welcome instead of making them resend the command. */
const pendingStartAfterAllow = new Set<number>();

// ---------------------------------------------------------------------------
// Bar + command dispatch
// ---------------------------------------------------------------------------

/** Complete Telegram command menu. Registered once per chat on /start so the
 * phone's native autocomplete exposes every implemented command. */
const TELEGRAM_COMMANDS = [
  { command: "start", description: "Welcome + persistent button bar" },
  { command: "menu", description: "Core menu card" },
  { command: "new", description: "Fresh session in the workspace" },
  { command: "compact", description: "Compact the current session" },
  { command: "abort", description: "Abort the current turn" },
  { command: "stop", description: "Close this chat's session" },
  { command: "models", description: "Browse providers and models" },
  { command: "status", description: "Live status card" },
  { command: "queue", description: "Inspect or edit the agent inbox" },
  { command: "todo", description: "Show the current session todo list" },
  { command: "sessions", description: "Sessions list" },
  { command: "history", description: "Session trajectory (turn-grouped)" },
  { command: "rename", description: "Rename the current session" },
  { command: "fork", description: "Fork the current session" },
  { command: "use", description: "Switch to a session" },
  { command: "archive", description: "Archive a session" },
  { command: "workspaces", description: "Workspaces list" },
  { command: "workspacecreate", description: "Create a workspace" },
  { command: "project", description: "Pick the active project folder" },
  { command: "goals", description: "Current goal" },
  { command: "bar", description: "Show or hide the button bar" },
  { command: "goal", description: "Start a goal: /goal <objective> [maxRounds]" },
  { command: "goalcreate", description: "Create a goal" },
  { command: "goalclear", description: "Clear the current goal" },
  { command: "skills", description: "Skills list" },
  { command: "subagents", description: "Subagents list" },
  { command: "presets", description: "Agent presets" },
  { command: "plugins", description: "Plugin inventory" },
  { command: "hostsettings", description: "Host settings" },
  { command: "credentials", description: "Credential list" },
  { command: "host", description: "Host details and files" },
  { command: "ls", description: "List a directory" },
  { command: "attachment", description: "Send a saved photo attachment back" },
  { command: "mkdir", description: "Create a directory" },
  { command: "pluginadd", description: "Install your own dynamic plugin (JSON)" },
  { command: "jobs", description: "Jobs list" },
  { command: "capabilities", description: "Profile capability matrix" },
  { command: "menucheck", description: "Self-check every menu data source" },
  { command: "answer", description: "Answer a free-text question by id" },
  { command: "settingsreplace", description: "Replace a settings namespace" },
  { command: "settingsmutate", description: "Mutate settings paths" },
  { command: "pickdir", description: "Pick the active project folder" },
  { command: "openpath", description: "Show a host path for opening" },
  { command: "config", description: "Get/set bridge config live" },
  { command: "help", description: "All commands" },
];


async function dispatchBarButton(chatId: number, label: string): Promise<void> {
  log(`bar button ${label}`);
  cardOrigins.set(chatId, "bar");
  const ext = extensionForBar(label);
  if (ext) {
    const host = buildExtensionHost();
    return ext.handler(chatId, host);
  }
  switch (label) {
    case MENU_BTN:
      return openMenuAt(chatId, 0);
    case NEW_BTN: {
      const { result: res, agentId } = await createSessionForChat(chatId);
      const bound = bindCreatedSession(chatId, agentId);
      await sendWithLiveBar(chatId, res.ok
        ? (bound ? `\u2728 ${plain(res.text)}` : "\u274C Session created but the chat binding is not live yet \u2014 send any message to rebind.")
        : `\u274C ${plain(res.text)}`);
      return;
    }
    case COMPACT_BTN: {
      const res = await compactCurrent(requireCtx(), boundAgentId(chatId));
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return;
    }
    case MODELS_BTN:
      return openModelsCard(chatId);
    case PLUGINS_BTN:
      return openPluginsCard(chatId);
    case MODE_BTN:
      return openModeCard(chatId);
    case SESSIONS_BTN:
      return openSessionsCard(chatId, lastProjectKey(chatId));
    case STATUS_BTN:
      return openStatusPanel(chatId);
    case QUEUE_BTN:
      return openQueueCard(chatId);
    case TODO_BTN:
      return openTodosCard(chatId);
    case GOAL_BTN:
      return openGoalsCard(chatId);
    case PRESETS_BTN:
      return openPresetsCard(chatId);
    case THINKING_BTN:
      return dispatchBarButton(chatId, REASONING_BTN);
    case COLLAPSE_BTN:
      return setBarCollapsed(chatId, true);
    case RETURN_BTN:
      return setBarCollapsed(chatId, false);
    case ABORT_BTN:
    case STOP_BTN: {
      const agentId = boundAgentId(chatId);
      if (agentId === undefined) {
        await uiSend(chatId, "\u274C No live agent in this session \u2014 Abort only stops this chat's current turn.", { parse_mode: "HTML" });
        return;
      }
      const res = sessionLifecycle.stop(requireCtx(), agentId);
      await uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return;
    }
    default:
      return;
  }
}

async function dispatchCommand(chatId: number, command: string, args: string, messageId?: number): Promise<void> {
  const ext = extensionForCommand(command);
  if (ext) {
    const host = buildExtensionHost();
    return ext.handler(chatId, args, host);
  }
  // A Telegram command can only arrive through a live transport; fail loudly
  // instead of silently returning and leaving the user with no feedback.
  const t = requireTransport();
  cardOrigins.set(chatId, "menu");
  const ctx = requireCtx();
  const agent = currentAgent(chatId);
  const send = async (text: string, okResult = true) => {
    log(`command reply chatId=${chatId} command=${command} kind=${okResult ? "ok" : "error"}`);
    await uiSend(chatId, okResult ? plain(text) : `\u274C ${plain(text)}`, { parse_mode: "HTML" });
  };
  switch (command) {
    case "start":
      state.chats.add(chatId);
      await t.setCommands(TELEGRAM_COMMANDS);
      await t.setMenuButtonToCommands(chatId);
      await sendWithLiveBar(chatId, `\u{1F916} dsh-telegram ${version} ready. Send a message to talk to the agent; the bar below carries all functions.`, {
        parse_mode: "HTML",
        ...(messageId === undefined ? {} : { reply_parameters: { message_id: messageId } }),
      });
      return;
    case "help":
      await send(
        [
          "Commands:",
          "/new /compact /abort /stop /models /sessions /workspaces /project [path] /goals /skills /subagents /presets /plugins /hostsettings /credentials /host /jobs /status /menu",
          "/history [sessionId] [turns] 轨迹 \u00B7 /rename <title> \u00B7 /fork [atSeq] \u00B7 /use <sessionId> \u00B7 /archive <sessionId>",
          "/queue \u00B7 /todo \u00B7 /steer <text> \u00B7 /cancel",
          "/goalcreate <objective> [maxRounds] \u00B7 /goaledit <text>",
          "/workspacecreate <path> [title] \u00B7 /workspacepin <workspaceId> <sessionId> [beforeSessionId]",
          "/pluginenable <name> \u00B7 /plugindisable <name> \u00B7 /settingsdescribe [ns] \u00B7 /settingsupdate <ns> <json> \u00B7 /settingsreplace <ns> <json> \u00B7 /settingsmutate <ns> <json ops>",
          "/credential <REF> [REF...] \u00B7 /credentialset <REF> <value> \u00B7 /credentialunset <REF> \u00B7 /answer <id> <question-number> <text>",
          "/attachment <attachmentId> \u00B7 /ls [path] \u00B7 /mkdir <path> \u00B7 /pickdir [path] \u00B7 /openpath [path] \u00B7 /discover <settingsNs> [baseURL] \u00B7 /subagentprompt <text>",
          "/pluginadd [json] \u00B7 install your own dynamic plugin (host half can call your own model to decode)",
          "/sessionlog [sessionId] \u00B7 /commands \u00B7 /capabilities \u00B7 /config get|set <path> [json]",
          "/menucheck \u00B7 self-checks every menu card's data source",
        ].join("\n"),
      );
      return;
    case "menu":
      return openMenuAt(chatId, 0);
    case "answer": {
      const [idText, numberText, ...rest] = args.trim().split(/\s+/);
      const id = Number(idText);
      const questionNumber = Number(numberText);
      const text = rest.join(" ").trim();
      if (!Number.isInteger(id) || !Number.isInteger(questionNumber) || questionNumber <= 0 || text === "") {
        await send("usage: /answer <questionId> <questionNumber> <text> \u2014 then tap Submit on the question card");
        return;
      }
      const questionId = questionIdAt(id, questionNumber - 1);
      if (questionId === undefined) {
        await send(`\u274C question ${questionNumber} not found for pending id ${id}.`, false);
        return;
      }
      const updated = state.interactive ? await state.interactive.setQuestionCustom(chatId, id, questionId, text) : false;
      await send(updated ? `\u270F Answer ${questionNumber} updated \u2014 tap Submit on the question card.` : "\u274C That question is no longer pending.", updated);
      return;
    }
    case "cancel": {
      if (pendingPresetCopy && pendingPresetCopy.chatId === chatId) {
        pendingPresetCopy = undefined;
        await send("Preset copy cancelled.");
      } else if (pendingWorkspaceCreate && pendingWorkspaceCreate.chatId === chatId) {
        pendingWorkspaceCreate = undefined;
        await send("Workspace create cancelled.");
      } else if (pendingMkdir && pendingMkdir.chatId === chatId) {
        pendingMkdir = undefined;
        await send("New-folder cancelled.");
      } else if (pendingPluginAdd && pendingPluginAdd.chatId === chatId) {
        pendingPluginAdd = undefined;
        await send("Plugin add cancelled.");
      } else {
        await send("Nothing to cancel.");
      }
      return;
    }
    case "pluginadd": {
      const agentId = boundAgentId(chatId);
      if (agentId === undefined) {
        await send("\u274C No live session in this chat \u2014 send a message first to create one, then /pluginadd.");
        return;
      }
      const json = args.trim();
      if (json === "") {
        pendingPluginAdd = { chatId };
        await send(
          [
            "\u{1F9E9} Reply with the plugin JSON (or /cancel):",
            "",
            '{"name": "my-decoder", "purpose": "decode with my own model", "host": "// js source"}',
            "",
            "Keys: name* \u00B7 purpose* \u00B7 host (JS source) \u00B7 client (JS source). At least one source half is required; a client half activates through the approval card. Optional pluginId appends a version to an existing plugin.",
          ].join("\n"),
          true,
        );
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(json);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
        parsed = value as Record<string, unknown>;
      } catch {
        await send('\u274C That is not a JSON object. Expected {"name", "purpose", "host"/"client"}.', false);
        return;
      }
      const str = (key: string): string | undefined => (typeof parsed[key] === "string" ? (parsed[key] as string) : undefined);
      const res = await defineDynamicCordis(ctx, agentId, {
        name: str("name") ?? "",
        purpose: str("purpose") ?? "",
        host: str("host"),
        client: str("client"),
      }, typeof parsed["pluginId"] === "string" ? (parsed["pluginId"] as string) : undefined);
      await send(res.text, res.ok);
      if (res.ok) refreshAllPanels();
      return;
    }
    case "new": {
      const { result: res, agentId } = await createSessionForChat(chatId);
      const bound = bindCreatedSession(chatId, agentId);
      await send(res.ok && !bound ? "Session created but the chat binding is not live yet \u2014 send any message to rebind." : res.text, res.ok);
      return;
    }
    case "compact": {
      const res = await compactCurrent(ctx, boundAgentId(chatId));
      await send(res.text, res.ok);
      return;
    }
    case "models":
      return openModelsCard(chatId);
    case "status":
      return openStatusPanel(chatId);
    case "abort": {
      const agentId = boundAgentId(chatId);
      if (agentId === undefined) {
        await send("No live agent in this session \u2014 Abort only stops this chat's current turn.", false);
        return;
      }
      const res = sessionLifecycle.stop(ctx, agentId);
      abortChatLoops(chatId);
      await send(res.text, res.ok);
      return;
    }
    case "stop": {
      const agentId = boundAgentId(chatId);
      if (agentId === undefined) {
        await send("No live agent in this session.", false);
        return;
      }
      const res = await sessionLifecycle.close(agentId, ctx);
      abortChatLoops(chatId);
      state.bridge?.bindAgent(chatId, undefined);
      await send(res.ok ? `${res.text} \u2014 send any message to start a new session.` : res.text, res.ok);
      return;
    }
    case "sessions":
      return openSessionsCard(chatId, lastProjectKey(chatId));
    case "bar": {
      const target = args.trim().toLowerCase();
      const collapsed = target === "on"
        ? false
        : target === "off"
          ? true
          : state.barCollapsed.get(chatId) !== true;
      await setBarCollapsed(chatId, collapsed);
      await send(collapsed ? "Bar hidden \u2014 use /bar or Menu \u2192 \u{1F4A1} \u663E\u793A Bar to restore." : "Bar shown.");
      return;
    }
    case "workspaces":
      return openWorkspacesCard(chatId);
    case "project":
      if (args.trim() !== "") return applyProjectPath(chatId, args.trim());
      return openProjectCard(chatId);
    case "goals":
      return openGoalsCard(chatId);
    case "todos":
      return openTodosCard(chatId);
    case "skills":
      return openSkillsCard(chatId);
    case "subagents":
      return openSubagentsCard(chatId);
    case "presets":
      return openPresetsCard(chatId);
    case "plugins":
      return openPluginsCard(chatId);
    case "hostsettings":
      return openHostSettingsCard(chatId);
    case "credentials":
      return openCredentialsCard(chatId);
    case "host":
      return openHostCard(chatId);
    case "jobs":
      return openJobsCard(chatId);
    case "capabilities":
      return openCapabilitiesCard(chatId);
    case "menucheck": {
      const checkCtx = requireCtx();
      const checkAgent = currentAgent(chatId);
      const checks: [string, () => unknown | Promise<unknown>][] = [
        ["status", () => statusSnapshot(checkCtx)],
        ["models", () => modelCatalog(checkCtx, {})],
        ["plugins", () => listPlugins(checkCtx)],
        ["sessions", () => listSessionDetails(checkCtx)],
        ["history", () => readHistory(checkCtx, checkAgent?.id ?? "", 1)],
        ["queue", () => (checkAgent ? listQueue(checkCtx, checkAgent.id) : [])],
        ["workspaces", () => listWorkspaces(checkCtx)],
        ["goals", () => getGoal(checkCtx, checkAgent?.id ?? "")],
        ["todos", () => (checkAgent ? listTodos(checkCtx, checkAgent.id) : [])],
        ["skills", () => listSkills(checkCtx)],
        ["subagents", () => listSubagents(checkCtx, checkAgent?.id ?? "")],
        ["presets", () => listAgentPresets(checkCtx)],
        ["settings", () => describeSettings(checkCtx)],
        ["credentials", () => describeCredential(checkCtx, "")],
        ["host", () => describeHost(checkCtx)],
        ["jobs", () => listJobs(checkCtx, checkAgent?.id)],
        ["dynamic", () => listDynamicCordis(checkCtx)],
        ["capabilities", () => probeCapabilities(checkCtx)],
        ["mode", () => modeSummary()],
      ];
      const lines = ["\u{1FA7A} Menu self-check", ""];
      let failures = 0;
      for (const [label, fn] of checks) {
        try {
          await fn();
          lines.push(`\u2705 ${label}`);
        } catch (err) {
          failures += 1;
          lines.push(`\u274C ${label} \u2014 ${plain(truncate(err instanceof Error ? err.message : String(err), 60))}`);
        }
      }
      lines.push("", failures === 0 ? "All menu data sources are healthy." : `${failures} check(s) failed.`);
      await openCard(chatId, lines.join("\n"), buildBackKeyboard());
      return;
    }
    case "config": {
      const [op, path, ...rest] = args.trim().split(/\s+/);
      if (!op || !path) {
        await send("/config get <path> \u00B7 /config set <path> <json> \u2014 hot-applies + persists under .pi/telegram.json\nForever-allow a tool: /config set interactive.allowByTool [\"bash\"] \u00B7 revoke: []");
        return;
      }
      try {
        if (op === "get") {
          await send(`${path} = ${JSON.stringify(getConfigPath(state.config, path))}`);
          return;
        }
        if (op === "set") {
          const value = JSON.parse(rest.join(" "));
          const { config, changed } = overlayConfig(state.config, patchFromPath(path, value));
          if (changed.length === 0) {
            await send(`Unknown config path ${path}.`, false);
            return;
          }
          state.config = config;
          applyConfigLive(changed);
          writeConfig(state.configRoot, state.config);
          await send(`\u2705 ${path} \u2192 applied live + persisted (${changed.join(", ")})`);
          return;
        }
      } catch (err) {
        await send(err instanceof Error ? err.message : String(err), false);
        return;
      }
      await send("Usage: /config get <path> \u00B7 /config set <path> <json>", false);
      return;
    }
    case "history": {
      const [id, limitText] = args.trim().split(/\s+/);
      const sessionId = id || boundAgentId(chatId);
      if (!sessionId) {
        await send("No session id given and none bound.");
        return;
      }
      // Structured trajectory view (issue #32): turn-grouped like the web's
      // 轨迹 ledger. The optional second arg caps how many turns are shown.
      const maxTurns = Math.max(1, Math.min(20, Number(limitText) || 6));
      const result = await readTrajectory(ctx, sessionId, maxTurns);
      await send(renderTrajectoryLines(sessionId, result).join("\n"));
      return;
    }
    case "search": {
      const query = args.trim();
      if (!query) {
        await send("usage: /search <query>");
        return;
      }
      return openSearchCard(chatId, query);
    }
    case "rename": {
      const title = args.trim();
      const sessionId = boundAgentId(chatId);
      if (!sessionId) {
        await send("No bound session \u2014 use the Sessions card.");
        return;
      }
      if (!title) {
        pendingRename = { chatId, sessionId };
        await send(`Reply with just the title to rename ${plain(truncate(sessionId, 24))}:`);
        return;
      }
      const res = renameSession(ctx, sessionId, title);
      await send(res.text, res.ok);
      return;
    }
    case "fork": {
      const sessionId = boundAgentId(chatId);
      if (!sessionId) {
        await send("No bound session \u2014 use the Sessions card.");
        return;
      }
      const atSeq = args.trim() ? Number(args.trim()) : undefined;
      const res = forkSession(ctx, sessionId, Number.isFinite(atSeq) ? atSeq : undefined);
      await send(res.text, res.ok);
      return;
    }
    case "use": {
      const id = args.trim();
      if (!id) {
        await send("usage: /use <sessionId>");
        return;
      }
      const live = sessionLifecycle.find(ctx, id);
      if (live) {
        state.bridge?.bindAgent(chatId, id);
        await send(`\u{1F3AF} Switched to ${plain(truncate(id, 24))}.`);
      } else {
        const res = await resumeSession(ctx, id);
        if (res.ok && res.agentId !== undefined) {
          if (res.handle !== undefined) sessionLifecycle.adopt(res.handle);
          state.bridge?.bindAgent(chatId, res.agentId);
          await send(res.text, true);
        } else {
          await send(res.text, false);
        }
      }
      return;
    }
    case "archive": {
      const res = await archiveSession(ctx, args.trim() || boundAgentId(chatId) || "");
      await send(res.text, res.ok);
      return;
    }
    case "steer": {
      const text = args.trim();
      const sessionId = boundAgentId(chatId);
      if (!sessionId || !text) {
        await send("usage: /steer <text> (needs a bound session)");
        return;
      }
      const res = promptSession(ctx, sessionId, text, "steer");
      await send(res.text, res.ok);
      return;
    }
    case "queue":
      return openQueueCard(chatId);
    case "queueedit": {
      const [itemId, ...rest] = args.trim().split(/\s+/);
      const text = rest.join(" ");
      const sessionId = boundAgentId(chatId);
      if (!sessionId || !itemId || !text) {
        await send("usage: /queueedit <itemId> <text>");
        return;
      }
      const res = updateQueueItem(ctx, sessionId, itemId, { kind: "edit", content: text });
      await send(res.text, res.ok);
      return;
    }
    case "goal":
    case "goalcreate": {
      const parts = args.trim().split(/\s+/);
      const maxRounds = parts.length > 1 ? Number(parts[parts.length - 1]) : undefined;
      const objective = Number.isFinite(maxRounds) ? parts.slice(0, -1).join(" ") : parts.join(" ");
      if (!agent) {
        await send("No live agent \u2014 goals are per-agent.", false);
        return;
      }
      if (!objective) {
        await send("usage: /goal <objective> [maxRounds]");
        return;
      }
      const res = await createGoal(ctx, agent.id, objective, Number.isFinite(maxRounds) ? maxRounds : undefined);
      await send(res.text, res.ok);
      return;
    }
    case "goaledit": {
      const parts = args.trim().split(/\s+/);
      const candidate = parts.length > 1 ? Number(parts[parts.length - 1]) : undefined;
      const maxRounds = Number.isFinite(candidate) ? candidate : undefined;
      const objective = (maxRounds === undefined ? parts : parts.slice(0, -1)).join(" ");
      const goal = agent ? getGoal(ctx, agent.id) : undefined;
      if (!agent || !goal || !objective) {
        await send("usage: /goaledit <objective> [maxRounds] (needs a current goal)");
        return;
      }
      const res = await editGoal(ctx, agent.id, goal.id, goal.revision, {
        objective,
        ...(maxRounds === undefined ? {} : { maxGoalRounds: maxRounds }),
      });
      await send(res.text, res.ok);
      return;
    }
    case "goalclear": {
      const goal = agent ? getGoal(ctx, agent.id) : undefined;
      if (!agent || !goal) {
        await send("No current goal to clear.", false);
        return;
      }
      const res = await clearGoal(ctx, agent.id, goal.id, goal.revision);
      await send(res.text, res.ok);
      refreshAllPanels();
      return;
    }
    case "workspacecreate": {
      const parts = args.trim().split(/\s+/);
      const path = parts[0] ?? "";
      const title = parts.slice(1).join(" ");
      const res = await createWorkspace(ctx, path, title || undefined);
      await send(res.text, res.ok);
      return;
    }
    case "workspacerename": {
      const [id, ...rest] = args.trim().split(/\s+/);
      const res = await renameWorkspace(ctx, id ?? "", rest.join(" "));
      await send(res.text, res.ok);
      return;
    }
    case "workspacepin": {
      const [workspaceId, sessionId, beforeSessionId] = args.trim().split(/\s+/);
      const res = await insertSessionBefore(ctx, workspaceId ?? "", sessionId ?? "", beforeSessionId || undefined);
      await send(res.text, res.ok);
      return;
    }
    case "pluginenable":
    case "plugindisable": {
      const name = args.trim();
      if (!name) {
        await send(`usage: /${command} <plugin-name>`);
        return;
      }
      const entryId = entryIdFor(ctx, name);
      if (!entryId) {
        await send(`plugin entry ${plain(name)} not found \u2014 check /plugins.`);
        return;
      }
      const res = await togglePlugin(ctx, entryId, command === "plugindisable");
      await send(res.text, res.ok);
      return;
    }
    case "settingsdescribe": {
      const ns = args.trim();
      const { writable, hasDocument, namespaces } = describeSettings(ctx);
      if (ns) {
        const view = namespaces.find((candidate) => candidate.ns === ns);
        if (!view) {
          await send(`namespace ${plain(ns)} not found`);
        } else {
          await send(`\u2699\uFE0F ${plain(ns)} \u00B7 applies ${view.applies} \u00B7 rev ${view.revision}\nvalue: ${plain(truncate(JSON.stringify(view.value), 800))}\nsecrets: ${view.secrets.map((s) => `${s.path.join(".")}=${s.set ? "set" : "unset"}`).join(", ") || "none"}`);
        }
      } else {
        await send(`writable: ${writable} \u00B7 document: ${hasDocument} \u00B7 namespaces: ${namespaces.map((n) => plain(n.ns)).join(", ") || "none"}`);
      }
      return;
    }
    case "settingsupdate": {
      const space = args.indexOf(" ");
      const ns = space === -1 ? args.trim() : args.slice(0, space);
      const raw = space === -1 ? "" : args.slice(space + 1).trim();
      if (!ns || !raw) {
        await send("usage: /settingsupdate <ns> <json patch> [expectedRevision]");
        return;
      }
      const parsed = parseJsonWithRevision(raw);
      if (parsed === undefined) {
        await send("patch must be valid JSON");
        return;
      }
      const patch = JSON.parse(parsed.json) as object;
      const res = await updateSettings(ctx, ns, patch, parsed.revision);
      await send(res.text, res.ok);
      return;
    }
    case "settingsreplace": {
      const space = args.indexOf(" ");
      const ns = space === -1 ? args.trim() : args.slice(0, space);
      const raw = space === -1 ? "" : args.slice(space + 1).trim();
      if (!ns || !raw) {
        await send("usage: /settingsreplace <ns> <json section> [expectedRevision]");
        return;
      }
      const parsed = parseJsonWithRevision(raw);
      if (parsed === undefined) {
        await send("section must be valid JSON");
        return;
      }
      const section = JSON.parse(parsed.json) as unknown;
      if (section === null || typeof section !== "object" || Array.isArray(section)) {
        await send("section must be a JSON object");
        return;
      }
      const res = await replaceSettings(ctx, ns, section as object, parsed.revision);
      await send(res.text, res.ok);
      return;
    }
    case "settingsmutate": {
      const space = args.indexOf(" ");
      const ns = space === -1 ? args.trim() : args.slice(0, space);
      const raw = space === -1 ? "" : args.slice(space + 1).trim();
      if (!ns || !raw) {
        await send("usage: /settingsmutate <ns> <json ops> [expectedRevision] \u2014 ops: [{\"op\":\"set|unset\",\"path\":[\"a\",\"b\"],\"value\":1}]");
        return;
      }
      const parsed = parseJsonWithRevision(raw);
      if (parsed === undefined) {
        await send("ops must be valid JSON");
        return;
      }
      const ops = JSON.parse(parsed.json) as unknown;
      if (!Array.isArray(ops)) {
        await send("ops must be a JSON array");
        return;
      }
      const res = await mutateSettings(ctx, ns, ops as { op: "set" | "unset"; path: string[]; value?: unknown }[], parsed.revision);
      await send(res.text, res.ok);
      return;
    }
    case "credential": {
      const res = await describeCredentials(ctx, args.trim().split(/\s+/));
      await send(res.text, res.ok);
      return;
    }
    case "credentialset": {
      const space = args.indexOf(" ");
      const ref = space === -1 ? args.trim() : args.slice(0, space);
      const value = space === -1 ? "" : args.slice(space + 1);
      // The value is a secret: queue the command-message deletion BEFORE the
      // follow-up so the same per-chat queue guarantees the secret is removed
      // before the bot's own result arrives — no timer race, no restart gap.
      if (messageId !== undefined) {
        void t.deleteMessageControl(chatId, messageId).catch((err) => log("credential command delete failed", err));
      }
      const res = await setCredential(ctx, ref, value);
      await send(res.text, res.ok);
      return;
    }
    case "credentialunset": {
      const res = await unsetCredential(ctx, args.trim());
      await send(res.text, res.ok);
      return;
    }
    case "ls": {
      const res = await listDirectory(args.trim() || state.workspaceRoot);
      await send(res.text, res.ok);
      return;
    }
    case "attachment": {
      const attachmentId = args.trim();
      if (!attachmentId) {
        await send("usage: /attachment <attachmentId> \u2014 send a photo first to create an attachment.");
        return;
      }
      const res = await readImageAttachment(ctx, attachmentId);
      if (!res.ok || res.data === undefined) {
        await send(res.text, res.ok);
        return;
      }
      const ext = res.mediaType === "image/png" ? "png" : res.mediaType === "image/jpeg" ? "jpg" : "img";
      const sent = await t.sendPhoto(chatId, Buffer.from(res.data, "base64"), `attachment-${attachmentId.slice(0, 16)}.${ext}`, `\u{1F5BC} ${plain(truncate(attachmentId, 24))}`);
      await send(sent === undefined ? `\u274C ${plain(res.text)}` : res.text, sent !== undefined);
      return;
    }
    case "mkdir": {
      const res = await createDirectory(args.trim());
      await send(res.text, res.ok);
      return;
    }
    case "pickdir": {
      const target = args.trim() || state.workspaceRoot;
      if (args.trim() !== "") return applyProjectPath(chatId, target);
      await send(pickDirectoryHint(state.workspaceRoot).text);
      return openProjectCard(chatId);
    }
    case "openpath": {
      const res = openPath(args.trim() || state.workspaceRoot);
      await send(res.text, res.ok);
      return;
    }
    case "discover": {
      const [settingsNs, baseURL] = args.trim().split(/\s+/);
      if (!settingsNs) {
        await send("usage: /discover <settingsNs> [baseURL]");
        return;
      }
      const res = await discoverModels(ctx, settingsNs, baseURL ? { baseURL } : {});
      await send(res.text, res.ok);
      return;
    }
    case "subagentprompt": {
      if (!pendingSubagentPrompt || pendingSubagentPrompt.chatId !== chatId) {
        await send("Open a subagent first, then reply with the prompt text.");
        return;
      }
      const res = await promptSubagent(ctx, pendingSubagentPrompt.parentId, pendingSubagentPrompt.childId, args.trim());
      pendingSubagentPrompt = undefined;
      await send(res.text, res.ok);
      return;
    }
    case "sessionlog": {
      const sessionId = args.trim() || boundAgentId(chatId);
      if (!sessionId) {
        await send("usage: /sessionlog <sessionId>");
        return;
      }
      await send("Building the session-log ZIP (same archive the web serves)\u2026");
      const exported = await exportSessionLog(ctx, sessionId, true);
      if (exported.result.ok && exported.buffer) {
        await t.sendDocument(chatId, exported.buffer, `${sessionId}.zip`, `${sessionId} \u00B7 session log`);
        await send(exported.result.text, true);
      } else {
        await send(exported.result.text, false);
      }
      return;
    }
    case "commands": {
      if (!agent) {
        await send("No live agent \u2014 commands are agent-scoped.");
        return;
      }
      const commands = listCommands(ctx, agent);
      const lines = [`\u2328\uFE0F Commands (${commands.length})`, ""];
      for (const entry of commands) lines.push(`/${entry.name}${entry.input ? ` ${entry.input}` : ""} \u2014 ${plain(truncate(entry.description, 60))}`);
      await send(lines.join("\n"));
      return;
    }
    default: {
      if (agent) {
        const res = await executeCommand(ctx, agent, `/${command}${args ? ` ${args}` : ""}`);
        if (res.text !== "unknown or malformed slash command: /" && !res.text.includes("unknown or malformed slash command")) {
          await send(res.text, res.ok);
          return;
        }
      }
      await send(`Unknown command /${command} \u2014 try /help.`);
      return;
    }
  }
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

// ---------------------------------------------------------------------------
// Watch + lifecycle
// ---------------------------------------------------------------------------

async function startWatching(): Promise<void> {
  if (state.watching) return;
  const t = requireTransport();
  await t.start();
  state.watching = true;
}

async function stopWatching(): Promise<void> {
  if (!state.watching) return;
  if (state.transport) await state.transport.stop();
  state.watching = false;
}

/** Send one compact incremental todo card (issue #10). First observation is
 * a baseline, never a notification burst. */
function notifyTodoChange(chatId: number, previous: readonly TodoView[], next: readonly TodoView[]): void {
  const diff = diffTodos(previous, next);
  const lines: string[] = [];
  for (const todo of diff.added.slice(0, 5)) lines.push(`\u{1F4CB} \u65B0\u589E\u4EFB\u52A1\uff1A${todo.content.slice(0, 80)}`);
  for (const todo of diff.started.slice(0, 5)) lines.push(`\u23F3 \u8FDB\u884C\u4E2D\uff1A${todo.content.slice(0, 80)}`);
  for (const todo of diff.completed.slice(0, 5)) lines.push(`\u2705 \u5DF2\u5B8C\u6210\uff1A${todo.content.slice(0, 80)}`);
  if (diff.completed.length > 0) lines.push(`\u{1F4CB} \u5269 ${diff.remaining} \u9879\u5F85\u529E`);
  if (lines.length === 0) return;
  void uiSend(chatId, lines.join("\n"), { parse_mode: "HTML" });
}

function refreshAllPanels(): void {
  if (!state.transport) return;
  const transport = state.transport;
  // Share one subagent-count refresh across event bursts; the panel rerender
  // waits for it so `Subagents: N` is current instead of one event behind.
  if (statusSubagentSync === undefined) {
    statusSubagentSync = refreshStatusSubagents()
      .catch((err) => log("status subagent refresh failed", err))
      .finally(() => {
        statusSubagentSync = undefined;
      });
  }
  void statusSubagentSync.then(() => {
    for (const chatId of state.chats) {
      void statusPanel.refresh(chatId, uiOps(transport), renderStatus(chatId));
      scheduleBarSync(chatId);
    }
  });
}

/** Live agent inbox size for one chat — the web's `status.queue` value. */
function currentQueueCount(chatId: number): number {
  try {
    return statusSnapshot(requireCtx(), boundAgentId(chatId), false).queue;
  } catch {
    return 0;
  }
}

function currentTodos(chatId: number): TodoView[] {
  const agent = currentAgent(chatId);
  return agent === undefined ? [] : listTodos(requireCtx(), agent.id);
}

function currentTodoCount(chatId: number): number {
  return pendingTodoCount(currentTodos(chatId));
}

function goalForChat(chatId: number): { objective: string } | undefined {
  const agent = currentAgent(chatId);
  if (!agent) return undefined;
  const goal = getGoal(requireCtx(), agent.id);
  return goal === undefined ? undefined : { objective: goal.objective };
}

function progressFor(chatId: number): ProgressSnapshot | undefined {
  return goalProgress?.snapshot(chatId);
}

/** Remove the previous dedicated bar carrier so history never accumulates them. */
async function dropBarCarrier(chatId: number, t: TelegramTransport): Promise<void> {
  const carrier = state.barCarriers.get(chatId);
  if (carrier === undefined) return;
  state.barCarriers.delete(chatId);
  await t.deleteMessageControl(chatId, carrier);
}

/** Send a normal message that carries the live bar (count embedded). */
async function sendWithLiveBar(chatId: number, text: string, options: Parameters<TelegramTransport["sendText"]>[2] = {}): Promise<number | undefined> {
  const t = state.transport;
  if (!t) return undefined;
  const count = currentQueueCount(chatId);
  state.barCounts.set(chatId, count);
  state.barTodoCounts.set(chatId, currentTodoCount(chatId));
  // Collapsed means no bar at all: the Menu first-page switch or `/bar`
  // restores it. Normal replies stay keyboard-free instead of re-asserting.
  if (state.barCollapsed.get(chatId) === true) return t.sendText(chatId, text, options);
  await dropBarCarrier(chatId, t);
  return t.sendText(chatId, text, { ...options, reply_markup: buildBarKeyboard(count, currentTodoCount(chatId)) });
}

/** Telegram reply keyboards cannot be edited in place, so the live count is
 * pushed by replacing a tiny carrier message (delete + resend). Debounced
 * per chat because agent/status and turn/end fire in bursts. */
function scheduleBarSync(chatId: number, delayMs = 1500): void {
  if (!state.barCounts.has(chatId)) return;
  const existing = state.barTimers.get(chatId);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => {
    state.barTimers.delete(chatId);
    void safeWrap(`bar-sync(${chatId})`, () => syncBar(chatId), log);
  }, delayMs);
  state.barTimers.set(chatId, timer);
}

/** Delete the current carrier and pin one fresh native bar message. */
async function replaceBarCarrier(chatId: number, t: TelegramTransport, count: number): Promise<void> {
  await dropBarCarrier(chatId, t);
  const id = await t.sendTextControl(chatId, queueBarLabel(count), {
    parse_mode: "HTML",
    disable_notification: true,
    reply_markup: buildBarKeyboard(count, currentTodoCount(chatId)),
  });
  if (id !== undefined) state.barCarriers.set(chatId, id);
}

/** Collapse/restore the bar. The state flips synchronously and the carrier
 * swap is fire-and-forget on the UI control lane: the tap acknowledges
 * immediately even while a turn is streaming (bar latency report). */
function setBarCollapsed(chatId: number, collapsed: boolean): void {
  const t = state.transport;
  if (!t) return;
  if (collapsed) {
    state.barCollapsed.set(chatId, true);
    void safeWrap(`bar-collapse(${chatId})`, async () => {
      await dropBarCarrier(chatId, t);
      // A persistent reply keyboard survives the carrier deletion; Telegram
      // only replaces it when another keyboard message lands. Send the
      // collapsed one-button keyboard as the new carrier (#17).
      const id = await t.sendTextControl(chatId, "\u{1F5DC}\uFE0F Bar \u5DF2\u6536\u8D77", {
        parse_mode: "HTML",
        disable_notification: true,
        reply_markup: buildCollapsedBarKeyboard(),
      });
      if (id !== undefined) state.barCarriers.set(chatId, id);
    }, log);
    return;
  }
  const count = currentQueueCount(chatId);
  state.barCounts.set(chatId, count);
  state.barTodoCounts.set(chatId, currentTodoCount(chatId));
  state.barCollapsed.delete(chatId);
  void safeWrap(`bar-restore(${chatId})`, () => replaceBarCarrier(chatId, t, count), log);
}

/** Swap the dedicated bar carrier in place when the queue/todo count changed. */
async function syncBar(chatId: number): Promise<void> {
  const t = state.transport;
  if (!t) return;
  const count = currentQueueCount(chatId);
  const todoCount = currentTodoCount(chatId);
  log(`bar sync chatId=${chatId} count=${count} todo=${todoCount} last=${state.barCounts.get(chatId)}`);
  // A collapsed bar stays gone until explicitly restored.
  if (state.barCollapsed.get(chatId) === true) return;
  if (count === state.barCounts.get(chatId) && todoCount === state.barTodoCounts.get(chatId)) return;
  state.barCounts.set(chatId, count);
  state.barTodoCounts.set(chatId, todoCount);
  await replaceBarCarrier(chatId, t, count);
}

export function apply(ctx: Context, loaderConfig?: unknown): void {
  if (state.context) teardownMount();
  state.context = ctx;

  state.workspaceRoot = findWorkspaceRoot(process.cwd()) ?? process.cwd();
  state.configRoot = state.workspaceRoot;
  state.config = overlayConfig(readConfig(state.configRoot), loaderConfig).config;
  // Restore the persisted project synchronously: an async restore races the
  // first session creation and silently moves the workspace back to the
  // boot directory ("workspace drifted without any project/session change").
  if (state.config.workspace.activePath) {
    if (existsSync(state.config.workspace.activePath)) {
      state.workspaceRoot = state.config.workspace.activePath;
    }
  }

  // The provided `telegram` service is the single seam external/subpath
  // plugins read. It carries both the public bridge API and the full
  // ExtensionHost surface (streaming draft, cards, stats, agent binding) so
  // a loader-mounted plugin like dsh-telegram/extensions/openclaw needs no
  // knowledge of core internals.
  telegramService = {
    ...buildExtensionHost(),
    getConfig: () => ({ ...state.config }),
    status: () => renderStatus(),
    chats: () => [...state.chats],
    sendText: (chatId: number, text: string) => requireTransport().sendText(chatId, plain(text), { parse_mode: "HTML" }),
    broadcast: async (text: string) => {
      const delivered: { chatId: number; messageId: number }[] = [];
      for (const chatId of [...state.chats]) {
        const id = await state.transport?.sendText(chatId, plain(text), { parse_mode: "HTML" });
        if (id !== undefined) delivered.push({ chatId, messageId: id });
      }
      return delivered;
    },
    start: () => startWatching(),
    stop: () => stopWatching(),
    /** Harness-style extension seam: any cordis plugin (this package's
     * subpath plugins or a third party) registers its domain through here.
     * Name-keyed, so double registration (builtin + loader entry) is safe.
     * Hot plug: the UI (open menus + status panels) refreshes immediately. */
    registerExtension: (extension: TelegramExtension) => {
      if (extensions.some((existing) => existing.name === extension.name)) return;
      extensions.push(extension);
      refreshExtensionUi();
    },
    unregisterExtension: (name: string) => {
      const index = extensions.findIndex((existing) => existing.name === name);
      if (index === -1) return;
      const [removed] = extensions.splice(index, 1);
      removed.detach?.();
      refreshExtensionUi();
    },
  };
  ctx.provide("telegram", telegramService);

  // Built-in extensions register directly (core's own apply cannot read its
  // freshly provided service — cordis provide registers through fiber.effect).
  // registerExtension is name-keyed, so loader-driven duplicates are safe.
  registerExtension(reasoningExtension);

  // opencode-go's chat/completions stream for Responses-native Go models
  // (gpt-5.6-luna / grok-4.5) never sends finish_reason. Provision the
  // additive Responses route once so model selection can route around it.
  try {
    if (ctx.get("llm") !== undefined) {
      void ensureOpencodeGoResponsesRoute(ctx, log).catch((err) => log("opencode-go responses route check failed", err));
    }
  } catch {
    /* no llm service in this profile */
  }

  ctx.on("internal/update", (incoming, _noSave, next) => {
    try {
      const { config, changed } = overlayConfig(state.config, incoming);
      if (changed.length === 0) return next();
      state.config = config;
      applyConfigLive(changed);
      log(`config hot-applied live: ${changed.join(", ")}`);
      return;
    } catch (err) {
      log("config hot-apply failed \u2014 falling back to the official restart path", err);
      return next();
    }
  });

  const botToken = resolveToken();
  if (botToken) {
    state.transport = new TelegramTransport({
      token: botToken,
      log,
      queue: new SendQueue({
        maxPerWindow: state.config.outbound.sendRatePerSecond,
        retry: { attempts: state.config.outbound.maxRetries, baseDelayMs: 500 },
      }),
      maxMessageLength: state.config.outbound.maxMessageLength,
    });
    state.bridge = new Bridge({
      ctx,
      transport: state.transport,
      getConfig: () => state.config,
      onStateChange: refreshAllPanels,
      onTurnRunning: (chatId, running) => {
        if (running) {
          runningTurns.add(chatId);
          // A genuine new turn gets a fresh keepalive budget (#48).
          typingRearms.delete(chatId);
          startTyping(chatId);
        } else {
          runningTurns.delete(chatId);
          typingRearms.delete(chatId);
          stopTyping(chatId);
        }
      },
      log,
    });
    state.bridge.attach();

    // Goal progress cards (issue #7): only when no streaming renderer owns
    // presentation. Completion collapses the card into the openclaw receipt,
    // hit-rate included.
    goalProgress = new GoalProgressFeed({
      ops: {
        send: uiOps(state.transport).sendText,
        edit: uiOps(state.transport).editText,
      },
      log,
      chatIdForAgent: (agentId) => state.bridge?.chatIdForAgent(agentId),
      goalFor: (chatId) => goalForChat(chatId),
      todosFor: (chatId) => currentTodos(chatId),
      statusStats: (chatId) => statusSnapshot(requireCtx(), boundAgentId(chatId), false).stats,
      liveRendererActive: () => state.bridge?.hasAssistantConsumer() ?? false,
      pendingInbound: (chatId) => state.bridge?.hasPendingInbound(chatId) ?? false,
      notifyOnComplete: () => state.config.notify?.onComplete !== false,
      notifyOnLongTask: () => state.config.notify?.onLongTask !== false,
    });
    goalProgress.attach(ctx);

    // Context-pressure watcher (issue #8). Approval cards are minted through
    // the single-use token registry and answered in dispatchToken.
    compactionWatcher = new CompactionWatcher({
      ctx,
      log,
      chatIdForAgent: (agentId) => state.bridge?.chatIdForAgent(agentId),
      threshold: () => state.config.compact.threshold,
      policy: () => state.config.compact.policy,
      cooldownMs: () => state.config.compact.cooldownMs,
      askApproval: (chatId, sessionId, usage) => {
        const pct = Math.round((usage.ratio ?? 0) * 100);
        void uiSend(chatId, `\u{1F4C8} Context ${pct}% of ${usage.window ?? "?"} tokens \u2014 compact before it overflows?`, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "\u2705 \u81EA\u52A8\u538B\u7F29", callback_data: token({ action: "compact-auto", sessionId }) },
              { text: "\u{1F4DD} \u6211\u6765\u624B\u52A8", callback_data: token({ action: "compact-manual", sessionId }) },
              { text: "\u{1F7E2} \u538B\u7F29\u5E76\u7EE7\u7EED", callback_data: token({ action: "compact-auto", sessionId }) },
            ]],
          },
        });
      },
      notify: (chatId, text) => {
        void uiSend(chatId, text, { parse_mode: "HTML" });
      },
    });
    compactionWatcher.attach();

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

    state.interactive = attachInteractive(
      ctx,
      {
        broadcast: async (text, keyboard, chatId) => {
          const delivered: { chatId: number; messageId: number }[] = [];
          const targets = chatId === undefined ? [...state.chats] : state.chats.has(chatId) ? [chatId] : [];
          for (const target of targets) {
            const id = await uiSend(target, plain(text), {
              parse_mode: "HTML",
              ...(keyboard === undefined ? {} : { reply_markup: keyboard as never }),
            });
            if (id !== undefined) delivered.push({ chatId: target, messageId: id });
          }
          return delivered;
        },
        chatForSession: (sessionId) => state.bridge?.chatIdForAgent(sessionId),
        edit: async (chatId, messageId, text, keyboard) => {
          const t = state.transport;
          if (!t) return false;
          const edited = await t.editTextControl(chatId, messageId, plain(text), {
            parse_mode: "HTML",
            // `undefined` means "settle this card": edit the text and remove
            // its inline keyboard in place instead of leaving dead buttons.
            reply_markup: keyboard === undefined ? { inline_keyboard: [] } : (keyboard as never),
          });
          return edited;
        },
      },
      {
        userQuestions: state.config.interactive?.userQuestions ?? "telegram",
        log,
        allowedTools: state.config.interactive?.allowByTool,
        persistToolAllow: (toolName) => {
          const next = [...new Set([...(state.config.interactive?.allowByTool ?? []), toolName])];
          const { config, changed } = overlayConfig(state.config, { interactive: { allowByTool: next } });
          state.config = config;
          writeConfig(state.configRoot, state.config);
          applyConfigLive(changed);
          return true;
        },
        goalIdForSession: (sessionId) => {
          const agent = requireCtx().agents?.get(sessionId as never);
          if (!agent) return undefined;
          return getGoal(requireCtx(), String(agent.id))?.id;
        },
      },
    );

    // Every restart the client keeps the previous reply keyboard, which can
    // be a stale static `⌛ Queue` label from an older build. Re-assert the
    // live bar (count embedded) for every whitelisted chat on mount.
    for (const chatId of state.config.security.allowedChatIds) {
      state.chats.add(chatId);
      state.barCounts.set(chatId, -1);
      scheduleBarSync(chatId, 1500);
    }

    attachRouter({
      transport: state.transport,
      isAllowed: (chatId) => {
        const allowed = isChatAllowed(state.config, chatId);
        // Track only whitelisted chats: broadcasts/panels must never reach a
        // chat that merely probed the bot while unauthorized.
        if (allowed) state.chats.add(chatId);
        return allowed;
      },
      onCommand: (chatId, command, args, messageId) => dispatchCommand(chatId, command, args, messageId).catch((err) => notifyDispatchFailure(chatId, `command /${command}`, err)),
      onBarButton: (chatId, label) => dispatchBarButton(chatId, label).catch((err) => notifyDispatchFailure(chatId, "Bar action", err)),
      onCallback: (chatId, data) => dispatchCallback(chatId, data).catch((err) => notifyDispatchFailure(chatId, "Button action", err)),
      onPhoto: (chatId, fileId, caption, messageId) => dispatchPhoto(chatId, fileId, caption, messageId).catch((err) => notifyDispatchFailure(chatId, "Photo upload", err)),
      onPhotos: (chatId, photos) => dispatchPhotos(chatId, photos).catch((err) => notifyDispatchFailure(chatId, "Photo batch upload", err)),
      onDocument: (chatId, kind, fileId, name, mimeType, messageId) =>
        dispatchDocument(chatId, kind, fileId, name, mimeType, messageId).catch((err) => notifyDispatchFailure(chatId, "Attachment upload", err)),
      onUnauthorized: (chatId, reason) => {
        if (reason === "command:start") pendingStartAfterAllow.add(chatId);
        log(`unauthorized prompt -> chatId ${chatId}${reason === undefined ? "" : ` (${reason})`}`);
        void uiSend(chatId, "\u{1F6AB} This chat is not allowed yet. Tap below to grant access:", {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "\u2795 Allow this chat", callback_data: "m:allowthis" }]] },
        });
      },
      onUserText: async (chatId, text, messageId) => {
        if (state.transport) void safeWrap(`typing(${chatId})`, () => state.transport!.sendChatActionControl(chatId, "typing"), log);
        if (pendingSearch && pendingSearch.chatId === chatId) {
          pendingSearch = undefined;
          void openSearchCard(chatId, text);
          return;
        }
        if (pendingMkdir && pendingMkdir.chatId === chatId) {
          const { path } = pendingMkdir;
          pendingMkdir = undefined;
          const name = text.trim();
          if (!name || name.includes("/") || name.includes("\\")) {
            void uiSend(chatId, "\u274C Folder name must be a single path segment (no / or \\).", { parse_mode: "HTML" });
            return openHostDirectoryCard(chatId, path);
          }
          void (async () => {
            const res = await createDirectory(join(path, name));
            void uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
            return openHostDirectoryCard(chatId, path);
          })().catch((err) => log("new folder failed", err));
          return;
        }
        if (pendingSteer && pendingSteer.chatId === chatId) {
          const { sessionId } = pendingSteer;
          pendingSteer = undefined;
          const res = promptSession(requireCtx(), sessionId, text, "steer");
          void uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
          return;
        }
        if (pendingWorkspaceCreate && pendingWorkspaceCreate.chatId === chatId) {
          pendingWorkspaceCreate = undefined;
          const trimmed = text.trim();
          if (!trimmed) {
            void uiSend(chatId, "\u274C Workspace path must not be blank.", { parse_mode: "HTML" });
            return openWorkspacesCard(chatId);
          }
          const space = trimmed.indexOf(" ");
          const path = space === -1 ? trimmed : trimmed.slice(0, space);
          const title = space === -1 ? undefined : trimmed.slice(space + 1).trim();
          void (async () => {
            const res = await createWorkspace(requireCtx(), path, title === "" ? undefined : title);
            void uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
            return openWorkspacesCard(chatId);
          })().catch((err) => log("workspace create failed", err));
          return;
        }
        if (pendingRename && pendingRename.chatId === chatId) {
          const sessionId = pendingRename.sessionId;
          pendingRename = undefined;
          const res = renameSession(requireCtx(), sessionId, text);
          void uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
          return;
        }
        if (pendingSubagentPrompt && pendingSubagentPrompt.chatId === chatId) {
          const { parentId, childId } = pendingSubagentPrompt;
          pendingSubagentPrompt = undefined;
          void safeWrap("subagent-prompt", () =>
            promptSubagent(requireCtx(), parentId, childId, text).then((res) =>
              uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" }),
            ),
          log).then((sent) => {
            if (sent === undefined) void uiSend(chatId, "\u274C Subagent prompt failed.", { parse_mode: "HTML" });
          });
          return;
        }
        if (pendingPresetCopy && pendingPresetCopy.chatId === chatId) {
          const { sourceId } = pendingPresetCopy;
          pendingPresetCopy = undefined;
          const newId = text.trim();
          if (!newId) {
            void uiSend(chatId, "\u274C Preset id must not be blank.", { parse_mode: "HTML" });
            return;
          }
          void safeWrap("preset-copy", () =>
            copyAgentPreset(requireCtx(), sourceId, newId).then((res) => {
              void uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
              if (res.ok) void openPresetsCard(chatId);
            }),
          log).then((done) => {
            if (done === undefined) void uiSend(chatId, "\u274C Preset copy failed.", { parse_mode: "HTML" });
          });
          return;
        }
        if (pendingPluginAdd && pendingPluginAdd.chatId === chatId) {
          pendingPluginAdd = undefined;
          const agentId = boundAgentId(chatId);
          if (agentId === undefined) {
            void uiSend(chatId, "\u274C No live session in this chat \u2014 send a message first to create one, then /pluginadd.", { parse_mode: "HTML" });
            return;
          }
          // Tolerate ```json fences and leading labels around the payload.
          const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
          let parsed: Record<string, unknown>;
          try {
            const value: unknown = JSON.parse(raw);
            if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
            parsed = value as Record<string, unknown>;
          } catch {
            void uiSend(chatId, '\u274C That is not a JSON object. Expected {"name", "purpose", "host"/"client"} — try again or /cancel.', { parse_mode: "HTML" });
            pendingPluginAdd = { chatId };
            return;
          }
          const str = (key: string): string | undefined => (typeof parsed[key] === "string" ? (parsed[key] as string) : undefined);
          void safeWrap("plugin-add", () =>
            defineDynamicCordis(requireCtx(), agentId, {
              name: str("name") ?? "",
              purpose: str("purpose") ?? "",
              host: str("host"),
              client: str("client"),
            }, typeof parsed["pluginId"] === "string" ? (parsed["pluginId"] as string) : undefined).then((res) => {
              void uiSend(chatId, res.ok ? `\u2705 ${plain(res.text)}\nTap \u25B6 Run on the Dynamic card to activate it.` : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
              if (res.ok) refreshAllPanels();
            }),
          log).then((done) => {
            if (done === undefined) void uiSend(chatId, "\u274C Plugin definition failed.", { parse_mode: "HTML" });
          });
          return;
        }
        // Per-chat binding: this chat's first message creates its own
        // session. Other chats keep their own agent and never share it.
        const boundId = state.bridge?.agentIdForChat(chatId);
        const chatAgent = boundId === undefined ? undefined : requireCtx().agents?.get(boundId as never);
        if (chatAgent === undefined) {
          // AWAITED, not fire-and-forget: the router's per-chat user FIFO can
          // only protect "two rapid first messages → two sessions" if the handler
          // promise spans the whole create+bind+deliver path. The shared
          // per-chat session gate additionally serializes a fast UI tap
          // (✨ New / model select) that races the first message.
          const created = await createSessionForChat(chatId, state.config.model, undefined, true);
          bindCreatedSession(chatId, created.agentId);
          if (!created.result.ok) {
            await uiSend(chatId, `\u274C ${plain(created.result.text)}`, { parse_mode: "HTML" });
            return;
          }
          const res = state.bridge!.deliver(chatId, text, messageId);
          if (!res.ok) await uiSend(chatId, `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
          else scheduleBarSync(chatId, 0);
          return;
        }
        const res = state.bridge!.deliver(chatId, text, messageId);
        if (!res.ok) await uiSend(chatId, `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
        else scheduleBarSync(chatId, 0);
      },
    });
    ctx.on("agent/created", () => {
      if (state.config.watch.autoStart && !state.watching) {
        void startWatching().catch((err) => log("auto start failed", err));
      }
    });
    if (state.config.watch.autoStart && !state.watching) {
      void startWatching().catch((err) => log("auto start failed", err));
    }
  }

  ctx.commands.register({
    name: "telegram",
    description: "Telegram bridge controls: status | start | stop | allow <chatId> | disallow <chatId> | watch on|off | config auto-start | config get <path> | config set <path> <json>",
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const parts = invocation.rawInput.trim().split(/\s+/);
      const [sub, arg] = parts as [string | undefined, string | undefined];
      try {
        if (!sub || sub === "status") return okCmd(renderStatus());
        if (sub === "start") {
          await startWatching();
          return okCmd("Telegram polling started.");
        }
        if (sub === "stop") {
          await stopWatching();
          return okCmd("Telegram polling stopped.");
        }
        if (sub === "allow" && arg) {
          const chatId = Number(arg);
          if (!Number.isInteger(chatId)) return failCmd("chatId must be an integer");
          if (!isChatAllowed(state.config, chatId)) {
            state.config.security.allowedChatIds.push(chatId);
            writeConfig(state.configRoot, state.config);
          }
          state.chats.add(chatId);
          return okCmd(`Allowed chat ${chatId}.`);
        }
        if (sub === "disallow" && arg) {
          const chatId = Number(arg);
          state.config.security.allowedChatIds = state.config.security.allowedChatIds.filter((id) => id !== chatId);
          writeConfig(state.configRoot, state.config);
          ejectChat(chatId);
          return okCmd(`Disallowed chat ${chatId}.`);
        }
        if (sub === "watch" && (arg === "on" || arg === "off")) {
          if (arg === "on") await startWatching();
          else await stopWatching();
          return okCmd(`watch=${arg}`);
        }
        if (sub === "config" && arg === "auto-start") {
          state.config.watch.autoStart = !state.config.watch.autoStart;
          writeConfig(state.configRoot, state.config);
          return okCmd(`autoStart=${state.config.watch.autoStart}`);
        }
        if (sub === "config" && arg === "get" && parts[2]) {
          return okCmd(JSON.stringify(getConfigPath(state.config, parts[2])));
        }
        if (sub === "config" && arg === "set" && parts[2]) {
          const value = JSON.parse(parts.slice(3).join(" "));
          const { config, changed } = overlayConfig(state.config, patchFromPath(parts[2], value));
          if (changed.length === 0) return failCmd(`unknown config path ${parts[2]}`);
          state.config = config;
          applyConfigLive(changed);
          writeConfig(state.configRoot, state.config);
          return okCmd(`config set ${parts[2]} \u2192 applied live + persisted`);
        }
        return failCmd("usage: /telegram status | start | stop | allow <chatId> | disallow <chatId> | watch on|off | config auto-start | config get <path> | config set <path> <json>");
      } catch (err) {
        return failCmd(err instanceof Error ? err.message : String(err));
      }
    },
  });

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

  ctx.effect(() => teardownMount);
}
