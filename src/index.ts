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
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import { existsSync } from "node:fs";
import { basename, join, parse, resolve } from "node:path";
import { isChatAllowed, readConfig, resolveToken, writeConfig, overlayConfig, getConfigPath, patchFromPath, type ConfigSection, type TelegramConfig } from "./config.js";
import { Bridge } from "./harness/bridge.js";
import { modeSummary } from "./harness/adapters/mode.js";
import { renameSession, promptSession, releaseSavedAttachments, SessionLifecycle, releaseAllModelSelections } from "./harness/adapters/sessions.js";
import { getGoal } from "./harness/adapters/goals.js";
import { listSubagents, promptSubagent } from "./harness/adapters/subagents.js";
import { copyAgentPreset } from "./harness/adapters/presets.js";
import { reasoningLabel } from "./reasoning.js";
import { reasoningExtension } from "./extensions/reasoning.js";
import type { TelegramExtension, ExtensionHost } from "./extensions/types.js";
import { createDirectory } from "./harness/adapters/host.js";
import { listJobs } from "./harness/adapters/jobs.js";
import { defineDynamicCordis } from "./harness/adapters/dynamicCordis.js";
import { attachInteractive, type Interactive } from "./harness/adapters/interactive.js";
import { ensureOpencodeGoResponsesRoute, normalizeOpencodeGoModel, opencodeGoModelUsesResponses } from "./harness/adapters/opencodeGo.js";
import { renderStatsStrip, resetStatusStats, statusSnapshot } from "./harness/adapters/status.js";
import { CompactionWatcher } from "./harness/adapters/compaction-watch.js";
import { diffTodos, listTodos, pendingTodoCount, type TodoView } from "./harness/adapters/todos.js";
import { GoalProgressFeed, type ProgressSnapshot } from "./telegram/goal-progress.js";
import { Ephemeral } from "./telegram/ephemeral.js";
import { plain, truncate } from "./telegram/html.js";
import { buildBarKeyboard, buildCollapsedBarKeyboard, buildMenuPage, queueBarLabel, type MenuItem } from "./telegram/keyboard.js";
import { SendQueue } from "./telegram/queue.js";
import { safeWrap } from "./telegram/safe.js";
import { TokenRegistry } from "./telegram/tokens.js";
import { attachRouter } from "./telegram/router.js";
import { StatusPanel } from "./telegram/status-panel.js";
import { TelegramTransport } from "./telegram/transport.js";
import { findWorkspaceRoot } from "./workspace.js";
import { makeAttachmentHandlers } from "./media/attachments.js";
import { attachSessionEvents } from "./core/events.js";
import { createChatHub } from "./core/chat-hub.js";
import { registerTelegramTools } from "./core/tools.js";
import { createDispatchers } from "./core/dispatch.js";
import { createCardRegistry, withTimeout, widenCard } from "./core/cards.js";
import { createModelCards } from "./cards/models.js";
import { createSessionCards } from "./cards/sessions.js";
import { createPresetCards } from "./cards/presets.js";
import { createWorkspaceCards } from "./cards/workspaces.js";
import { createHostCards } from "./cards/host.js";
import { createGoalCards } from "./cards/goals.js";
import { createQueueCards } from "./cards/queue.js";
import { createMiscCards, STATUS_SUBAGENTS_TIMEOUT_MS } from "./cards/misc.js";

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

/** Per-chat lifecycle hub (yellow-1 step 3): single owner of the per-chat
 * containers teardown/eject used to hand-enumerate (and twice leaked,
 * review 🔴-8). Groups migrate here step by step; teardownMount/ejectChat
 * delegate to disposeAll()/disposeChat() so a new container cannot be
 * forgotten at a second call site. All deps are late-bound closures: the
 * transport and the `telegram` service are assigned later on apply. */
const {
  abortChatLoops,
  setTurnRunning,
  menuPageIndex,
  cardOrigins,
  sessionCreateChains,
  statusSubagentCounts,
  todoSnapshots,
  pendingStartAfterAllow,
  pending,
  disposeChat,
  disposeAll,
} = createChatHub({
  getTransport: () => state.transport,
  currentAgent,
  stopLiveFeed: (chatId) => telegramService?.stopLiveFeed?.(chatId),
  log,
});

/** Reverse every live mount effect (hot unplug / HMR / config restart). */
function teardownMount(): void {
  state.interactive?.detach();
  state.interactive = undefined;
  for (const dispose of refreshEventDisposers.splice(0)) dispose();
  state.bridge?.detach();
  state.bridge = undefined;
  const teardownTransport = state.transport;
  // The transport itself is stopped by apply() (which awaits the stop before
  // building its replacement); teardown only reuses it for control-path
  // cleanup below. Two concurrent stops would be harmless, but one owner
  // keeps the 409 window closed deterministically.
  state.transport = undefined;
  // Remove dedicated bar-carrier messages so a hot reload never leaves a
  // stale reply keyboard button behind.
  for (const [carrierChat, carrierId] of state.barCarriers) {
    if (teardownTransport) void safeWrap(`bar-carrier-cleanup(${carrierChat})`, () => teardownTransport.deleteMessageControl(carrierChat, carrierId), log);
  }
  state.watching = false;
  state.chats.clear();
  state.context = null;
  // Every hub-owned per-chat container (typing loops + turn flags + rearm
  // budgets, menu pages, card origins, session-create chains, pending
  // inputs, start-after-allow flags, subagent counts, todo snapshots) is
  // reversed by the hub's single disposal trunk — the hand enumeration that
  // used to live here leaked twice (review 🔴-8) and cannot happen again.
  disposeAll();
  for (const timer of todoCardTimers.values()) clearInterval(timer);
  todoCardTimers.clear();
  for (const timer of state.barTimers.values()) clearTimeout(timer);
  state.barTimers.clear();
  // A pending coalesced panel refresh must not fire after teardown.
  cancelScheduledPanelRefresh();
  state.lastSessionsProject.clear();
  state.barCollapsed.clear();
  state.barCounts.clear();
  state.barTodoCounts.clear();
  state.barCarriers.clear();
  releaseAllModelSelections();
  releaseSavedAttachments();
  tokens.reset();
  statusSubagentSync = undefined;
  goalProgress?.detach();
  goalProgress = undefined;
  compactionWatcher?.detach();
  compactionWatcher = undefined;
  activeCardRenderers.clear();
  void safeWrap("session-lifecycle-dispose", () => sessionLifecycle.dispose(), log);
  ephemeral.reset();
  statusPanel.reset();
  resetStatusStats();
}

/** Stop every Telegram-side artifact owned by a chat that just lost its
 * whitelist entry: bridge binding, roster slot, every hub-owned per-chat
 * container (typing loop, turn flag, rearm budget, menu page, card origin,
 * session-create chain, armed pending inputs, start-after-allow replay,
 * todo snapshot — one `disposeChat` call instead of a hand-enumerated list),
 * the Todo auto-refresh loop and the bar counts + debounced carrier refresh.
 * The dsh session itself stays live so a re-allowed chat can be bound to it
 * again explicitly. Like before, an ejected chat must not touch the
 * live-feed seam, so abortChatLoops() is still not reused here. */
function ejectChat(chatId: number): void {
  state.bridge?.bindAgent(chatId, undefined);
  state.chats.delete(chatId);
  // The rearm budget is per-chat loop state too; leaving it behind would
  // throttle typing on the chat's next mount (#48) — the hub drops it here.
  disposeChat(chatId);
  const todoTimer = todoCardTimers.get(chatId);
  if (todoTimer !== undefined) clearInterval(todoTimer);
  todoCardTimers.delete(chatId);
  activeCardRenderers.delete(chatId);
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
      // Persist BEFORE committing to memory: a failed write (read-only disk)
      // used to leave the runtime running on config the disk never saw
      // (silently rolled back on restart) and threw raw into the extension
      // callback. An empty result is the existing "nothing applied" signal
      // callers already handle.
      try {
        writeConfig(state.configRoot, config);
      } catch (err) {
        log("applyConfig: persist failed \u2014 keeping the previous config", err);
        return [];
      }
      state.config = config;
      applyConfigLive(changed);
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

const okCmd = (text: string): CommandResult => ({ kind: "success", text });
const failCmd = (text: string): CommandResult => ({ kind: "error", text });

function requireTransport(): TelegramTransport {
  if (!state.transport) throw new Error("Telegram is not running: set TELEGRAM_BOT_TOKEN and send /telegram start.");
  return state.transport;
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

/** Keepalive decision (#48): a live agent's own status is authoritative —
 * the sticky running-turn flag goes stale when a turn/end event is lost,
 * which used to re-arm the typing loop forever. The flag is only trusted
 * when no live agent can answer, and the rearm budget caps that stale path.
 * A genuinely running agent is never budget-killed: turns legitimately
 * outlast a few windows, so the budget must not fire before the agent check.
 * Lives in core/chat-hub.ts (yellow-1 step 3); re-exported so the public
 * dist/index.js contract (test/issue-47-48.test.mjs) is unchanged. */
export { typingKeepaliveActive } from "./core/chat-hub.js";

/** The provided `telegram` service instance (assigned on plugin apply) so
 * core paths can reach renderer-assigned seams like stopLiveFeed (#48). */
let telegramService: (ExtensionHost & Record<string, unknown>) | undefined;

/** Terminal loop cleanup for one chat (#48) lives in core/chat-hub.ts and is
 * destructured from the hub above; the live-feed seam arrives as a dep. */

export { renderStatsStrip };

/** Live subagent counts per agent id live in core/chat-hub.ts (yellow-1
 * step 3) and are destructured from the hub above. */
let statusSubagentSync: Promise<void> | undefined;

/** Bound one in-process service promise so `refreshStatusSubagents` always
 * settles and clears the shared latch, even when a service hangs. */
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

/** Per-chat serialization for session creation lives in core/chat-hub.ts
 * (yellow-1 step 3) and is destructured from the hub above. */

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
          if (live) return { result: { ok: true, text: "Session is already live." }, agentId: boundId, reusedLive: true };
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

/** Card registry plumbing lives in core/cards.ts (yellow-1 step 2): openCard
 * replace/refresh, the per-chat renderer map, cardLoad's deadline and the
 * destructive-action confirmation. This is their single wiring point. */
const { activeCardRenderers, openCard, refreshActiveCards, askConfirm, cardLoad } = createCardRegistry({
  requireTransport,
  uiOps,
  ephemeral,
  token,
  log,
  uiSend,
});

// Menu page + card origin bookkeeping live in core/chat-hub.ts (yellow-1
// step 3) and are destructured from the hub above.

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

/** Models/providers/reasoning cards live in cards/models.ts (yellow-1 step 2). */
const { openModelsCard, openProvidersCard, openProviderModelsCard, openModelThinkingCard, currentReasoningEffort } = createModelCards({
  state,
  requireCtx,
  currentAgent,
  cardLoad,
  openCard,
  token,
  log,
});

/** Plugins/skills/subagents/jobs/dynamic/capabilities/feedback and the small
 * display cards (mode/allowed/watch/settings/about) live in cards/misc.ts
 * (yellow-1 step 2). */
const {
  openPluginsCard, openSkillsCard, openSubagentsCard, isContinuableSubagent, openSubagentDetailCard,
  openJobsCard, openDynamicCordisCard, openCapabilitiesCard, openFeedbackListCard,
  openModeCard, openAllowedCard, openWatchCard, openSettingsCard, openAboutCard,
} = createMiscCards({
  state,
  requireCtx,
  currentAgent,
  boundSessionCwd,
  cardLoad,
  openCard,
  token,
  log,
  version,
});

/** Sessions/projects/detail/history/search cards live in cards/sessions.ts
 * (yellow-1 step 2); lastProjectKey feeds the dispatchers' back-navigation. */
const { lastProjectKey, openSessionsCard, openSessionProjectsCard, openSessionDetailCard, openHistoryCard, openSearchCard } = createSessionCards({
  state,
  requireCtx,
  cardLoad,
  openCard,
  uiSend,
  token,
});

/** Queue card lives in cards/queue.ts (yellow-1 step 2). */
const { openQueueCard } = createQueueCards({
  state,
  requireCtx,
  currentAgent,
  boundAgentId,
  progressFor,
  openCard,
});

/** Workspaces / project picker / workspace-create picker cards live in
 * cards/workspaces.ts (yellow-1 step 2); applyProjectPath is shared with the
 * /project and /workspacecreate commands. */
const { openWorkspacesCard, openWorkspaceDetailCard, openProjectCard, applyProjectPath, openWorkspaceCreatePicker } = createWorkspaceCards({
  state,
  requireCtx,
  uiSend,
  openCard,
  token,
  log,
  openMenuAt,
});

/** Todos auto-refresh loop + Todos/Goals cards live in cards/goals.ts
 * (yellow-1 step 2); the timer map is shared with teardown/ejectChat and
 * stopTodoCardRefresh with openStatusPanel. */
const { todoCardTimers, stopTodoCardRefresh, openTodosCard, openGoalsCard } = createGoalCards({
  requireTransport,
  requireCtx,
  currentAgent,
  ephemeral,
  uiOps,
  activeCardRenderers,
  openCard,
  token,
  log,
  uiSend,
});


/** New-session / presets / preset-detail cards live in cards/presets.ts
 * (yellow-1 step 2). */
const { openNewSessionCard, openPresetsCard, openPresetDetailCard } = createPresetCards({
  requireCtx,
  currentAgent,
  cardLoad,
  openCard,
  token,
});

/** Host settings/credentials/host/host-directory cards live in cards/host.ts
 * (yellow-1 step 2). */
const { openHostSettingsCard, openSettingsNamespaceCard, openCredentialsCard, openHostCard, openHostDirectoryCard } = createHostCards({
  state,
  requireCtx,
  openCard,
  token,
});


// ---------------------------------------------------------------------------
// Routing (yellow-1 step 4): dispatch surfaces live in core/dispatch.ts
// ---------------------------------------------------------------------------
// ONE wiring point per surface. The four dispatchers, the cross-surface
// action registry and the token/callback/bar/command vocabulary live in
// core/dispatch.ts; every plugin-root singleton and card opener arrives
// through the one deps object below, and the router/transport callbacks near
// the bottom of this file consume the returned dispatch* functions exactly
// as they consumed the former module-scope closures.

const { dispatchToken, dispatchCallback, dispatchBarButton, dispatchCommand } = createDispatchers({
  // Plugin-root singletons + helpers.
  state,
  version,
  sessionLifecycle,
  ephemeral,
  tokens,
  compactionWatcher: () => compactionWatcher,
  log,
  requireTransport,
  uiOps,
  uiSend,
  requireCtx,
  currentAgent,
  boundAgentId,
  createSessionForChat,
  bindCreatedSession,
  applyConfigLive,
  refreshAllPanels,
  sendWithLiveBar,
  scheduleBarSync,
  setBarCollapsed,
  startWatching,
  stopWatching,
  openStatusPanel,
  openMenuAt,
  // Extension registry seams.
  extensionForCallback,
  extensionForCommand,
  extensionForBar,
  buildExtensionHost,
  // Card registry.
  activeCardRenderers,
  openCard,
  askConfirm,
  cardLoad,
  // Chat-hub containers + loops.
  menuPageIndex,
  cardOrigins,
  pending,
  pendingStartAfterAllow,
  abortChatLoops,
  stopTodoCardRefresh,
  // Card openers.
  lastProjectKey,
  openSessionsCard,
  openSessionProjectsCard,
  openSessionDetailCard,
  openHistoryCard,
  openSearchCard,
  openQueueCard,
  openWorkspacesCard,
  openWorkspaceDetailCard,
  openProjectCard,
  applyProjectPath,
  openWorkspaceCreatePicker,
  openTodosCard,
  openGoalsCard,
  openNewSessionCard,
  openPresetsCard,
  openPresetDetailCard,
  openHostSettingsCard,
  openSettingsNamespaceCard,
  openCredentialsCard,
  openHostCard,
  openHostDirectoryCard,
  openModelsCard,
  openProvidersCard,
  openProviderModelsCard,
  openModelThinkingCard,
  openPluginsCard,
  openSkillsCard,
  openSubagentsCard,
  isContinuableSubagent,
  openSubagentDetailCard,
  openJobsCard,
  openDynamicCordisCard,
  openCapabilitiesCard,
  openFeedbackListCard,
  openModeCard,
  openAllowedCard,
  openWatchCard,
  openSettingsCard,
  openAboutCard,
});

// Outbound + inbound attachment handlers live in media/attachments.ts. This
// is their single wiring point: the router callbacks below consume the
// dispatch* names and the tool registration consumes sendWorkspaceAttachments.
const { dispatchPhoto, dispatchPhotos, dispatchDocument, sendWorkspaceAttachments } = makeAttachmentHandlers({
  state,
  requireTransport,
  requireCtx,
  uiSend,
  currentAgent,
  createSessionForChat,
  bindCreatedSession,
  scheduleBarSync,
});

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

/** Blue-1 refresh-storm guard: bridge.notifyStateChange fires on every
 * tool/call, tool/result, step/start, step/end, assistant/message and
 * turn/start event, and each notification used to pay a full renderStatus +
 * editMessage sweep over every chat. Event-driven callers enter through
 * schedulePanelRefresh, which coalesces a burst into one dirty flag and
 * renders once at the trailing edge — so the LAST state change always lands
 * on the panels. User-initiated seams (dispatchers, extension host, config
 * apply, extension hot-plug) keep calling refreshAllPanels directly, which
 * doubles as the immediate flush: it renders now and cancels the pending
 * trailing edge so one action never pays two sweeps. The subagent-count
 * latch inside refreshAllPanels and StatusPanel's same-text skip are
 * untouched; only WHEN panels render changes, never WHAT. */
const PANEL_REFRESH_DEBOUNCE_MS = 400;
let panelsRefreshDirty = false;
let panelsRefreshTimer: ReturnType<typeof setTimeout> | undefined;

function schedulePanelRefresh(): void {
  panelsRefreshDirty = true;
  if (panelsRefreshTimer !== undefined) return;
  panelsRefreshTimer = setTimeout(() => {
    panelsRefreshTimer = undefined;
    if (!panelsRefreshDirty) return;
    panelsRefreshDirty = false;
    refreshAllPanels();
  }, PANEL_REFRESH_DEBOUNCE_MS);
}

/** Cancel a coalesced refresh that a direct render just made redundant. */
function cancelScheduledPanelRefresh(): void {
  panelsRefreshDirty = false;
  if (panelsRefreshTimer !== undefined) {
    clearTimeout(panelsRefreshTimer);
    panelsRefreshTimer = undefined;
  }
}

function refreshAllPanels(): void {
  cancelScheduledPanelRefresh();
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

/** Construct the transport and every chat-facing consumer (bridge, cards,
 * router, tools' UI seams). Contains no await, so a FIRST mount executes
 * synchronously inside apply(); on re-apply it runs only after the old
 * transport's stop has been awaited, keeping two pollers from racing
 * Telegram's 409 Conflict window. */
async function mountTransport(ctx: Context): Promise<void> {
  const botToken = resolveToken();
  if (botToken === undefined) return;
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
    // Blue-1: the bridge notifies on every streaming event; coalesce bursts
    // behind the debounce instead of sweeping all panels per event.
    onStateChange: schedulePanelRefresh,
    onTurnRunning: setTurnRunning,
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

  // Harness-event forwarding (session/event todo/bar sync, web-forwarded
  // refresh events, session/disposed bookkeeping) lives in core/events.ts.
  // Disposers join the same teardown list, in registration order.
  refreshEventDisposers.push(...attachSessionEvents(ctx, {
    state,
    todoSnapshots,
    statusSubagentCounts,
    refreshActiveCards,
    // Blue-1: forwarded/host refresh events ride the same coalescing window
    // as bridge notifications (trailing edge still renders the final state).
    refreshAllPanels: schedulePanelRefresh,
    scheduleBarSync,
    notifyTodoChange,
  }));

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
      if (pending.search && pending.search.chatId === chatId) {
        pending.search = undefined;
        void openSearchCard(chatId, text);
        return;
      }
      if (pending.mkdir && pending.mkdir.chatId === chatId) {
        const { path } = pending.mkdir;
        pending.mkdir = undefined;
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
      if (pending.steer && pending.steer.chatId === chatId) {
        const { sessionId } = pending.steer;
        pending.steer = undefined;
        const res = promptSession(requireCtx(), sessionId, text, "steer");
        void uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
        return;
      }
      if (pending.rename && pending.rename.chatId === chatId) {
        const sessionId = pending.rename.sessionId;
        pending.rename = undefined;
        const res = renameSession(requireCtx(), sessionId, text);
        void uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
        return;
      }
      if (pending.subagentPrompt && pending.subagentPrompt.chatId === chatId) {
        const { parentId, childId } = pending.subagentPrompt;
        pending.subagentPrompt = undefined;
        void safeWrap("subagent-prompt", () =>
          promptSubagent(requireCtx(), parentId, childId, text).then((res) =>
            uiSend(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" }),
          ),
        log).then((sent) => {
          if (sent === undefined) void uiSend(chatId, "\u274C Subagent prompt failed.", { parse_mode: "HTML" });
        });
        return;
      }
      if (pending.presetCopy && pending.presetCopy.chatId === chatId) {
        const { sourceId } = pending.presetCopy;
        pending.presetCopy = undefined;
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
      if (pending.pluginAdd && pending.pluginAdd.chatId === chatId) {
        pending.pluginAdd = undefined;
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
          pending.pluginAdd = { chatId };
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

export function apply(ctx: Context, loaderConfig?: unknown): void | Promise<void> {
  // Captured BEFORE teardownMount() clears state.transport: the re-apply
  // dispatch below must await THIS transport's stop before rebuilding.
  const previousTransport = state.transport;
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

  // Re-apply (hot reload / config restart) must fully stop the previous
  // polling loop BEFORE constructing its replacement: two live getUpdates
  // pollers race Telegram's 409 Conflict window. The remount promise is
  // RETURNED at the end of apply() so awaited callers (cordis awaits thenable
  // plugin results; the loader awaits fiber.await()) block until the
  // replacement is live. First mounts stay fully synchronous
  // (mountTransport has no await before its effects), so apply() still
  // registers the router and tools before it returns.
  let remount: Promise<void>;
  if (previousTransport !== undefined) {
    remount = previousTransport.stop()
      .catch((err) => log("old transport stop failed during re-apply", err))
      .then(() => mountTransport(ctx));
  } else {
    remount = mountTransport(ctx);
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

  // Model tools live in core/tools.ts; this is their single wiring point.
  registerTelegramTools(ctx, {
    state,
    requireTransport,
    renderStatus,
    sendWorkspaceAttachments,
  });

  ctx.effect(() => teardownMount);

  return remount;
}
