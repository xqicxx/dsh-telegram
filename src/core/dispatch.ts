/**
 * Routing layer for dsh-telegram (yellow-1 step 4).
 *
 * The four dispatch surfaces — token callbacks (t:\d+ payloads), raw callback
 * data (m:/s:/w:/q:/mo:/set:/h:/p:/ap:/qu:), persistent-bar buttons and slash
 * commands — plus the cross-surface action registry live here. Slash-command
 * implementations live in ./commands.ts and are called from dispatchCommand.
 *
 * Plugin-root layer: may import ./harness/..., ./telegram/..., ../cards/...
 * and sibling core modules; never media/, never index.ts. Every plugin-root
 * singleton and card opener arrives through one DispatchDeps object provided
 * once by index.ts (createDispatchers); bodies are moved verbatim from the
 * former index.ts closures, so bare names resolve through one destructure.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { basename } from "node:path";
import { isChatAllowed, writeConfig, type ConfigSection, type TelegramConfig } from "../config.js";
import type { Bridge } from "../harness/bridge.js";
import { compactCurrent } from "../harness/adapters/compact.js";
import { forkSession, resumeSession, deleteSession, selectSessionModel, currentSessionModel, listQueue, updateQueueItem, SessionLifecycle } from "../harness/adapters/sessions.js";
import { listWorkspaces, createWorkspace, deleteWorkspace, insertWorkspaceBefore, archiveSession } from "../harness/adapters/workspace.js";
import { getGoal, pauseGoal, resumeGoal, clearGoal } from "../harness/adapters/goals.js";
import { putFeedback, deleteFeedback } from "../harness/adapters/feedback.js";
import { interruptSubagent, subagentHistory } from "../harness/adapters/subagents.js";
import { selectAgentPreset, setDefaultAgentPreset, readAgentPreset, removeAgentPreset, openAgentPresetDocument, switchAgentPresetMidSession, sessionHasStarted } from "../harness/adapters/presets.js";
import { describeCredentials } from "../harness/adapters/credentials.js";
import { isReasoningEffort } from "../reasoning.js";
import type { TelegramExtension, ExtensionHost } from "../extensions/types.js";
import { parentOf } from "../harness/adapters/host.js";
import { executeCommand } from "../harness/adapters/commands.js";
import { exportSessionLog } from "../harness/adapters/downloads.js";
import { runDynamicPlugin, stopDynamicPlugin, undefineDynamicPlugin } from "../harness/adapters/dynamicCordis.js";
import { type Interactive, questionIdAt } from "../harness/adapters/interactive.js";
import { normalizeOpencodeGoModel } from "../harness/adapters/opencodeGo.js";
import { CompactionWatcher } from "../harness/adapters/compaction-watch.js";
import { plain, truncate } from "../telegram/html.js";
import {
  buildBackKeyboard,
  buildQueueKeyboard,
  inputPromptKeyboard,
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
} from "../telegram/keyboard.js";
import { TokenRegistry } from "../telegram/tokens.js";
import { Ephemeral, type ChatOps } from "../telegram/ephemeral.js";
import type { TelegramTransport } from "../telegram/transport.js";
import {
  startCommand,
  helpCommand,
  answerCommand,
  cancelCommand,
  pluginAddCommand,
  barCommand,
  menuSelfCheckCommand,
  configCommand,
  historyCommand,
  searchCommand,
  renameCommand,
  forkCommand,
  useCommand,
  archiveCommand,
  steerCommand,
  queueEditCommand,
  goalCreateCommand,
  goalEditCommand,
  goalClearCommand,
  workspaceCreateCommand,
  workspaceRenameCommand,
  workspacePinCommand,
  pluginToggleCommand,
  settingsDescribeCommand,
  settingsUpdateCommand,
  settingsReplaceCommand,
  settingsMutateCommand,
  credentialDescribeCommand,
  credentialSetCommand,
  credentialUnsetCommand,
  lsCommand,
  attachmentCommand,
  mkdirCommand,
  pickdirCommand,
  openpathCommand,
  discoverCommand,
  subagentpromptCommand,
  sessionlogCommand,
  commandsListCommand,
  type CommandCall,
} from "./commands.js";
import type { ChatPendingSlots } from "./chat-hub.js";
import { type CardLoad, type OpenCard } from "./cards.js";
import type { createModelCards } from "../cards/models.js";
import type { createMiscCards } from "../cards/misc.js";
import type { createSessionCards } from "../cards/sessions.js";
import type { createQueueCards } from "../cards/queue.js";
import type { createWorkspaceCards } from "../cards/workspaces.js";
import type { createGoalCards } from "../cards/goals.js";
import type { createPresetCards } from "../cards/presets.js";
import type { createHostCards } from "../cards/host.js";

/** Exact opener/loader shapes returned by the cards/* factories wired in
 * index.ts; deps fields borrow them so signatures cannot drift. */
type ModelCards = ReturnType<typeof createModelCards>;
type MiscCards = ReturnType<typeof createMiscCards>;
type SessionCards = ReturnType<typeof createSessionCards>;
type QueueCards = ReturnType<typeof createQueueCards>;
type WorkspaceCards = ReturnType<typeof createWorkspaceCards>;
type GoalCards = ReturnType<typeof createGoalCards>;
type PresetCards = ReturnType<typeof createPresetCards>;
type HostCards = ReturnType<typeof createHostCards>;

/** Structural slice of the plugin-root state singleton the routing layer
 * touches. `config` stays writable: /config hot-applies a new object and the
 * model-select tap persists the chosen default model into it. */
export interface DispatchStateSlice {
  readonly workspaceRoot: string;
  /** Boot workspace owning .pi/telegram.json (config never moves). */
  readonly configRoot: string;
  config: TelegramConfig;
  readonly bridge: Bridge | undefined;
  readonly interactive: Interactive | undefined;
  watching: boolean;
  readonly chats: Set<number>;
  readonly barCollapsed: Map<number, boolean>;
}


// ---------------------------------------------------------------------------
// Action registry (structural yellow-2)
// ---------------------------------------------------------------------------
// ONE home for every action reachable from more than one dispatch surface.
// The dispatchers resolve their own case to a registry key and thin-route
// here, so behavior cannot drift between origins. Origin differences are
// explicit in the entries instead of duplicated case bodies:
//  - `reply(text, ok)` mirrors each surface's historical send path:
//    callback/bar = `uiSend(ok ? plain : ❌plain, HTML)`; command = the
//    dispatcher's logging `send()` wrapper. Byte-identical output per origin.
//  - `new` has THREE behaviors: callback `new` only opens the picker card,
//    while callback `new-default` / bar ✨ / /new all create+bind and differ
//    only in the announcement (sendWithLiveBar + ✨ vs a plain send() reply).
//    `new-default` stays a distinct key because the callback surface carries
//    two separate actions; `new` origin-branches between opener and create.
//  - `abort` covers callback abort/stop, bar ⏹/🛑 and /abort: one core
//    (sessionLifecycle.stop + abortChatLoops) with an origin branch — only the
//    callback navigates back to the remembered menu page afterwards, and the
//    no-agent line is historically RAW from callback/bar but escaped (via
//    send()) from /abort, so both byte shapes are preserved.
//  - `close-session` is command /stop ONLY (sessionLifecycle.close + unbind +
//    its own texts). Deliberately NOT merged with `abort`: callback/bar
//    "stop" mean abort, the command means close — a semantic split.
export type ActionOrigin = "token" | "callback" | "bar" | "command";
export type ActionReply = (text: string, ok?: boolean) => Promise<void>;
export interface ActionContext {
  chatId: number;
  origin: ActionOrigin;
  reply: ActionReply;
  payload?: Record<string, string>;
  args?: string;
  messageId?: number;
}

/** Everything the routing layer closes over, provided once by index.ts.
 * Singletons/registries pass whole; hub containers and card openers pass by
 * reference so destructured dispatch code mutates the same live state. */
export interface DispatchDeps {
  // ---- plugin-root singletons ----
  state: DispatchStateSlice;
  /** Plugin version (welcome text). */
  version: string;
  /** Live-session lifecycle (stop/close/create/adopt/find). */
  sessionLifecycle: SessionLifecycle;
  /** Transient-card lane (close/back clear the chat's card message). */
  ephemeral: Ephemeral;
  /** Single-use callback-token registry ("t:<id>" callbacks). */
  tokens: TokenRegistry;
  /** Context-pressure compaction watcher; assigned on transport mount, so it
   * must be read through this getter at dispatch time (issue #8). */
  compactionWatcher(): CompactionWatcher | undefined;

  // ---- plugin-root helpers ----
  log(message: string, error?: unknown): void;
  requireTransport(): TelegramTransport;
  requireCtx(): Context;
  uiSend(chatId: number, text: string, options?: Parameters<TelegramTransport["sendText"]>[2]): Promise<number | undefined>;
  uiOps(t: TelegramTransport): ChatOps;
  currentAgent(chatId?: number): Agent | undefined;
  boundAgentId(chatId?: number): string | undefined;
  createSessionForChat(
    chatId: number,
    model?: { provider?: string; model?: string },
    agentPreset?: string,
    onlyIfUnbound?: boolean,
  ): Promise<ReturnType<SessionLifecycle["create"]>>;
  bindCreatedSession(chatId: number, agentId: string | undefined): boolean;
  applyConfigLive(changed: readonly ConfigSection[]): void;
  refreshAllPanels(): void;
  sendWithLiveBar(chatId: number, text: string, options?: Parameters<TelegramTransport["sendText"]>[2]): Promise<number | undefined>;
  scheduleBarSync(chatId: number, delayMs?: number): void;
  setBarCollapsed(chatId: number, collapsed: boolean): void;
  startWatching(): Promise<void>;
  stopWatching(): Promise<void>;
  openStatusPanel(chatId: number): Promise<void>;
  openMenuAt(chatId: number, page: number): Promise<void>;

  // ---- extension registry seams (registry lives in index.ts) ----
  extensionForCallback(action: string): { extension: TelegramExtension; handler: NonNullable<TelegramExtension["callbacks"]>[string] } | undefined;
  extensionForCommand(command: string): { extension: TelegramExtension; handler: NonNullable<TelegramExtension["commands"]>[string] } | undefined;
  extensionForBar(label: string): { extension: TelegramExtension; handler: NonNullable<TelegramExtension["barButtons"]>[string] } | undefined;
  buildExtensionHost(): ExtensionHost;

  // ---- card registry (core/cards.ts wiring) ----
  activeCardRenderers: Map<number, () => Promise<void>>;
  openCard: OpenCard;
  askConfirm(chatId: number, text: string, confirmPayload: Record<string, string>, cancelPayload: Record<string, string>): Promise<void>;
  cardLoad: CardLoad;

  // ---- chat-hub containers + loops (core/chat-hub.ts wiring) ----
  menuPageIndex: Map<number, number>;
  cardOrigins: Map<number, "menu" | "bar">;
  pending: ChatPendingSlots;
  pendingStartAfterAllow: Set<number>;
  abortChatLoops(chatId: number): void;
  stopTodoCardRefresh(chatId: number): void;

  // ---- card openers (cards/* factories wired in index.ts) ----
  lastProjectKey: SessionCards["lastProjectKey"];
  openSessionsCard: SessionCards["openSessionsCard"];
  openSessionProjectsCard: SessionCards["openSessionProjectsCard"];
  openSessionDetailCard: SessionCards["openSessionDetailCard"];
  openHistoryCard: SessionCards["openHistoryCard"];
  openSearchCard: SessionCards["openSearchCard"];
  openQueueCard: QueueCards["openQueueCard"];
  openWorkspacesCard: WorkspaceCards["openWorkspacesCard"];
  openWorkspaceDetailCard: WorkspaceCards["openWorkspaceDetailCard"];
  openProjectCard: WorkspaceCards["openProjectCard"];
  applyProjectPath: WorkspaceCards["applyProjectPath"];
  openWorkspaceCreatePicker: WorkspaceCards["openWorkspaceCreatePicker"];
  openTodosCard: GoalCards["openTodosCard"];
  openGoalsCard: GoalCards["openGoalsCard"];
  openNewSessionCard: PresetCards["openNewSessionCard"];
  openPresetsCard: PresetCards["openPresetsCard"];
  openPresetDetailCard: PresetCards["openPresetDetailCard"];
  openHostSettingsCard: HostCards["openHostSettingsCard"];
  openSettingsNamespaceCard: HostCards["openSettingsNamespaceCard"];
  openCredentialsCard: HostCards["openCredentialsCard"];
  openHostCard: HostCards["openHostCard"];
  openHostDirectoryCard: HostCards["openHostDirectoryCard"];
  openModelsCard: ModelCards["openModelsCard"];
  openProvidersCard: ModelCards["openProvidersCard"];
  openProviderModelsCard: ModelCards["openProviderModelsCard"];
  openModelThinkingCard: ModelCards["openModelThinkingCard"];
  openPluginsCard: MiscCards["openPluginsCard"];
  openSkillsCard: MiscCards["openSkillsCard"];
  openSubagentsCard: MiscCards["openSubagentsCard"];
  isContinuableSubagent: MiscCards["isContinuableSubagent"];
  openSubagentDetailCard: MiscCards["openSubagentDetailCard"];
  openJobsCard: MiscCards["openJobsCard"];
  openDynamicCordisCard: MiscCards["openDynamicCordisCard"];
  openCapabilitiesCard: MiscCards["openCapabilitiesCard"];
  openFeedbackListCard: MiscCards["openFeedbackListCard"];
  openModeCard: MiscCards["openModeCard"];
  openAllowedCard: MiscCards["openAllowedCard"];
  openWatchCard: MiscCards["openWatchCard"];
  openSettingsCard: MiscCards["openSettingsCard"];
  openAboutCard: MiscCards["openAboutCard"];
}

/** Build the routing layer. Called once by index.ts; the returned dispatchers
 * close over the shared deps exactly like the former module-scope closures
 * closed over index.ts locals. Bodies are verbatim moves. */
export function createDispatchers(deps: DispatchDeps): {
  dispatchToken(chatId: number, payload: Record<string, string>): Promise<void>;
  dispatchCallback(chatId: number, data: string): Promise<void>;
  dispatchBarButton(chatId: number, label: string): Promise<void>;
  dispatchCommand(chatId: number, command: string, args: string, messageId?: number): Promise<void>;
} {
  const {
    // Plugin-root singletons + helpers.
    state,
    version,
    sessionLifecycle,
    ephemeral,
    tokens,
    log,
    requireTransport,
    uiOps,
    uiSend,
    requireCtx,
    currentAgent,
    boundAgentId,
    createSessionForChat,
    bindCreatedSession,
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
  } = deps;
  /** Late-assigned on transport mount (issue #8): always read through the
   * getter so a remount's fresh watcher instance is picked up. */
  const compactionWatcher = deps.compactionWatcher;

  /** Serializes watchtoggle's read-modify-write of the GLOBAL watching flag.
   * Two concurrent taps both reading `watching === false` used to interleave
   * transport start/stop (check-then-act race); the flag is bot-global, so
   * one chain guards it across all chats. Each link strips rejection first,
   * so a failed toggle never poisons later ones. */
  let watchToggleChain: Promise<unknown> = Promise.resolve();



/** The callback/bar reply shape: inline ❌ on failure, HTML parse mode. */
function uiReply(chatId: number): ActionReply {
  return async (text, ok = true) => {
    await uiSend(chatId, ok ? plain(text) : `❌ ${plain(text)}`, { parse_mode: "HTML" });
  };
}

/** Shared create+bind behind callback `new-default`, bar ✨ and /new. Only the
 * announcement differs: surfaces with a live bar get ✨ and a bar refresh;
 * /new gets a plain send() reply (no ✨, no bar refresh). */
async function runNewSessionCreate(c: ActionContext): Promise<void> {
  const { result: res, agentId } = await createSessionForChat(c.chatId);
  const bound = bindCreatedSession(c.chatId, agentId);
  if (c.origin === "command") {
    await c.reply(res.ok && !bound ? "Session created but the chat binding is not live yet — send any message to rebind." : res.text, res.ok);
    return;
  }
  await sendWithLiveBar(c.chatId, res.ok
    ? (bound ? `✨ ${plain(res.text)}` : "❌ Session created but the chat binding is not live yet — send any message to rebind.")
    : `❌ ${plain(res.text)}`);
}

const actions: Record<string, (c: ActionContext) => Promise<void> | void> = {
  // Card openers — verbatim identical on every surface that carries them.
  "menu": (c) => openMenuAt(c.chatId, 0),
  "sessions": (c) => openSessionsCard(c.chatId, lastProjectKey(c.chatId)),
  "models": (c) => openModelsCard(c.chatId),
  "status": (c) => openStatusPanel(c.chatId),
  "queue": (c) => openQueueCard(c.chatId),
  "todos": (c) => openTodosCard(c.chatId),
  "goals": (c) => openGoalsCard(c.chatId),
  "presets": (c) => openPresetsCard(c.chatId),
  "plugins": (c) => openPluginsCard(c.chatId),
  "mode": (c) => openModeCard(c.chatId),
  "workspaces": (c) => openWorkspacesCard(c.chatId),
  "skills": (c) => openSkillsCard(c.chatId),
  "jobs": (c) => openJobsCard(c.chatId),
  "host": (c) => openHostCard(c.chatId),
  // Core actions.
  "compact": async (c) => {
    const res = await compactCurrent(requireCtx(), boundAgentId(c.chatId));
    await c.reply(res.text, res.ok);
  },
  "new": (c) => {
    if (c.origin === "callback") return openNewSessionCard(c.chatId);
    return runNewSessionCreate(c);
  },
  "new-default": (c) => runNewSessionCreate(c),
  "abort": async (c) => {
    const agentId = boundAgentId(c.chatId);
    if (agentId === undefined) {
      if (c.origin === "command") await c.reply("No live agent in this session — Abort only stops this chat's current turn.", false);
      else await uiSend(c.chatId, "❌ No live agent in this session — Abort only stops this chat's current turn.", { parse_mode: "HTML" });
      if (c.origin === "callback") return openMenuAt(c.chatId, menuPageIndex.get(c.chatId) ?? 0);
      return;
    }
    const res = sessionLifecycle.stop(requireCtx(), agentId);
    // Abort is terminal for background loops too, not just the UI (#48).
    abortChatLoops(c.chatId);
    await c.reply(res.text, res.ok);
    if (c.origin === "callback") return openMenuAt(c.chatId, menuPageIndex.get(c.chatId) ?? 0);
  },
  "close-session": async (c) => {
    const agentId = boundAgentId(c.chatId);
    if (agentId === undefined) {
      await c.reply("No live agent in this session.", false);
      return;
    }
    const res = await sessionLifecycle.close(agentId, requireCtx());
    abortChatLoops(c.chatId);
    state.bridge?.bindAgent(c.chatId, undefined);
    await c.reply(res.ok ? `${res.text} — send any message to start a new session.` : res.text, res.ok);
  },
};

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
      pending.mkdir = { chatId, path };
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
        const { result: res, agentId, reusedLive } = await createSessionForChat(chatId, { provider, model }, undefined, true);
        bindCreatedSession(chatId, agentId);
        const selected = normalizeOpencodeGoModel(provider, model);
        if (res.ok && reusedLive) {
          // The onlyIfUnbound gate reused this chat's already-live session
          // (e.g. a first message raced the tap, or the binding outlived its
          // released agent and another path re-bound it): the chosen model
          // was never applied to any live session, so persisting it as the
          // default would silently lie. Report the miss instead (#47 follow-up).
          log(`model-select (no agent) provider=${provider} model=${model} -> not applied: ${res.text}`);
          await uiSend(chatId, `\u274C ${plain(res.text)} The selected model was not applied \u2014 use \u2728 New for a session with ${plain(selected.provider)}/${plain(selected.model)}.`, { parse_mode: "HTML" });
          return openModelsCard(chatId);
        }
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
      // The confirm token carries the agentId minted when the card rendered
      // (review orange-5): if the chat rebinds a different session between
      // the tap and the confirmation, clearing must hit the minted session's
      // goal, not whatever the chat resolves to now. Fall back to the current
      // resolution only when the payload carries no id.
      const mintedId = payload["agentId"] ?? "";
      const clearAgent = (mintedId !== "" ? requireCtx().agents?.get(mintedId as never) : undefined) ?? agent;
      const goal = clearAgent ? getGoal(requireCtx(), clearAgent.id) : undefined;
      if (!clearAgent || !goal) {
        await uiSend(chatId, "\u274C No current goal to clear.", { parse_mode: "HTML" });
        return openGoalsCard(chatId);
      }
      const res = await clearGoal(requireCtx(), clearAgent.id, goal.id, goal.revision);
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
      pending.subagentPrompt = { chatId, parentId, childId };
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
      // A missing/empty beforeSeq must read as "no cursor": Number("") === 0
      // would wrongly page from the top of the log. Only a present, finite,
      // >= 0 value is a valid cursor; anything else reopens page 1.
      const rawSeq = payload["beforeSeq"];
      const beforeSeq = rawSeq === undefined || rawSeq === "" ? Number.NaN : Number(rawSeq);
      return openHistoryCard(chatId, payload["sessionId"] ?? "", Number.isFinite(beforeSeq) && beforeSeq >= 0 ? beforeSeq : undefined);
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
      pending.presetCopy = { chatId, sourceId };
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
      compactionWatcher()?.approve(payload["sessionId"] ?? boundAgentId(chatId) ?? "");
      await uiSend(chatId, "\u2705 Compaction queued \u2014 it runs at the next safe boundary.", { parse_mode: "HTML" });
      return;
    }
    case "compact-manual": {
      compactionWatcher()?.snooze(payload["sessionId"] ?? boundAgentId(chatId) ?? "");
      await uiSend(chatId, "Send /compact when the agent is idle (or press Abort first).", { parse_mode: "HTML" });
      return;
    }
    case "compact-skip": {
      compactionWatcher()?.snooze(payload["sessionId"] ?? boundAgentId(chatId) ?? "");
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
        // Inherit this chat's own live agent's provider/model explicitly —
        // never another chat's (🟠-17).
        const res = await resumeSession(requireCtx(), id, boundAgentId(chatId)).catch(() => undefined);
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
      pending.rename = { chatId, sessionId: id };
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
      pending.steer = { chatId, sessionId: id };
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
      pending.pluginAdd = { chatId };
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
  const actionCtx: ActionContext = { chatId, origin: "callback", reply: uiReply(chatId) };
  switch (action) {
    case "close":
      stopTodoCardRefresh(chatId);
      // The menu is no longer open: drop the remembered page so an extension
      // hot-plug cannot resurrect a card the user already closed, and so the
      // per-chat map cannot grow without bound.
      menuPageIndex.delete(chatId);
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
    case "stop":
      return actions["abort"](actionCtx);
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
      return actions["models"](actionCtx);
    case "plugins":
      return actions["plugins"](actionCtx);
    case "sessions":
      return actions["sessions"](actionCtx);
    case "search": {
      pending.search = { chatId };
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
      return actions["mode"](actionCtx);
    case "queue":
      return actions["queue"](actionCtx);
    case "allowed":
      return openAllowedCard(chatId);
    case "watch":
      return openWatchCard(chatId);
    case "settings":
      return openSettingsCard(chatId);
    case "about":
      return openAboutCard(chatId);
    case "status":
      return actions["status"](actionCtx);
    case "new":
      return actions["new"](actionCtx);
    case "new-default":
      return actions["new-default"](actionCtx);
    case "compact":
      return actions["compact"](actionCtx);
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
    case "watchtoggle": {
      // Read-modify-write of `state.watching` runs on the shared chain so a
      // second tap cannot interleave its check between this one's check and
      // its transport start/stop.
      const toggle = watchToggleChain.catch(() => {}).then(async () => {
        if (state.watching) await stopWatching();
        else await startWatching();
      });
      watchToggleChain = toggle;
      await toggle;
      await uiSend(
        chatId,
        state.watching
          ? "\u{1F4E1} Polling resumed."
          : "\u23F8 Polling stopped \u2014 tap Watch \u2192 Start to resume, or send /telegram start.",
        { parse_mode: "HTML" },
      );
      return openWatchCard(chatId);
    }
    case "workspaces":
      return actions["workspaces"](actionCtx);
    case "goals":
      return actions["goals"](actionCtx);
    case "todos":
      return actions["todos"](actionCtx);
    case "skills":
      return actions["skills"](actionCtx);
    case "subagents":
      return openSubagentsCard(chatId);
    case "presets":
      return actions["presets"](actionCtx);
    case "hostsettings":
      return openHostSettingsCard(chatId);
    case "credentials":
      return openCredentialsCard(chatId);
    case "host":
      return actions["host"](actionCtx);
    case "jobs":
      return actions["jobs"](actionCtx);
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

// Pending single-slot prompt inputs + the start-after-allow replay set live
// in core/chat-hub.ts (yellow-1 step 3) and are destructured from the hub
// above (`pending.rename`, `pending.steer`, …).

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
  const actionCtx: ActionContext = { chatId, origin: "bar", reply: uiReply(chatId) };
  switch (label) {
    case MENU_BTN:
      return actions["menu"](actionCtx);
    case NEW_BTN:
      return actions["new"](actionCtx);
    case COMPACT_BTN:
      return actions["compact"](actionCtx);
    case MODELS_BTN:
      return actions["models"](actionCtx);
    case PLUGINS_BTN:
      return actions["plugins"](actionCtx);
    case MODE_BTN:
      return actions["mode"](actionCtx);
    case SESSIONS_BTN:
      return actions["sessions"](actionCtx);
    case STATUS_BTN:
      return actions["status"](actionCtx);
    case QUEUE_BTN:
      return actions["queue"](actionCtx);
    case TODO_BTN:
      return actions["todos"](actionCtx);
    case GOAL_BTN:
      return actions["goals"](actionCtx);
    case PRESETS_BTN:
      return actions["presets"](actionCtx);
    case THINKING_BTN:
      return dispatchBarButton(chatId, REASONING_BTN);
    case COLLAPSE_BTN:
      return setBarCollapsed(chatId, true);
    case RETURN_BTN:
      return setBarCollapsed(chatId, false);
    case ABORT_BTN:
    case STOP_BTN:
      return actions["abort"](actionCtx);
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
  const actionCtx: ActionContext = { chatId, origin: "command", args, messageId, reply: send };
  // Per-invocation bundle for the implementations in ./commands.ts — this
  // function's own locals, passed whole so the moved bodies stay verbatim.
  const cmd: CommandCall = { chatId, command, args, messageId, ctx, agent, t, send };
  switch (command) {
    case "start":
      return startCommand(deps, cmd);
    case "help":
      return helpCommand(deps, cmd);
    case "answer":
      return answerCommand(deps, cmd);
    case "cancel":
      return cancelCommand(deps, cmd);
    case "pluginadd":
      return pluginAddCommand(deps, cmd);
    case "bar":
      return barCommand(deps, cmd);
    case "menucheck":
      return menuSelfCheckCommand(deps, cmd);
    case "config":
      return configCommand(deps, cmd);
    case "history":
      return historyCommand(deps, cmd);
    case "search":
      return searchCommand(deps, cmd);
    case "rename":
      return renameCommand(deps, cmd);
    case "fork":
      return forkCommand(deps, cmd);
    case "use":
      return useCommand(deps, cmd);
    case "archive":
      return archiveCommand(deps, cmd);
    case "steer":
      return steerCommand(deps, cmd);
    case "queueedit":
      return queueEditCommand(deps, cmd);
    case "goal":
    case "goalcreate":
      return goalCreateCommand(deps, cmd);
    case "goaledit":
      return goalEditCommand(deps, cmd);
    case "goalclear":
      return goalClearCommand(deps, cmd);
    case "workspacecreate":
      return workspaceCreateCommand(deps, cmd);
    case "workspacerename":
      return workspaceRenameCommand(deps, cmd);
    case "workspacepin":
      return workspacePinCommand(deps, cmd);
    case "pluginenable":
    case "plugindisable":
      return pluginToggleCommand(deps, cmd);
    case "settingsdescribe":
      return settingsDescribeCommand(deps, cmd);
    case "settingsupdate":
      return settingsUpdateCommand(deps, cmd);
    case "settingsreplace":
      return settingsReplaceCommand(deps, cmd);
    case "settingsmutate":
      return settingsMutateCommand(deps, cmd);
    case "credential":
      return credentialDescribeCommand(deps, cmd);
    case "credentialset":
      return credentialSetCommand(deps, cmd);
    case "credentialunset":
      return credentialUnsetCommand(deps, cmd);
    case "ls":
      return lsCommand(deps, cmd);
    case "attachment":
      return attachmentCommand(deps, cmd);
    case "mkdir":
      return mkdirCommand(deps, cmd);
    case "pickdir":
      return pickdirCommand(deps, cmd);
    case "openpath":
      return openpathCommand(deps, cmd);
    case "discover":
      return discoverCommand(deps, cmd);
    case "subagentprompt":
      return subagentpromptCommand(deps, cmd);
    case "sessionlog":
      return sessionlogCommand(deps, cmd);
    case "commands":
      return commandsListCommand(deps, cmd);
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

  return { dispatchToken, dispatchCallback, dispatchBarButton, dispatchCommand };
}
