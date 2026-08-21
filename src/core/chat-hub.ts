/**
 * Per-chat lifecycle hub for dsh-telegram (yellow-1 step 3).
 *
 * Single owner of every per-chat container that `teardownMount()` and
 * `ejectChat()` used to hand-enumerate — and twice leaked (review 2026-08-21
 * 🔴-8): the typing keepalive loops, the sticky turn flags and their rearm
 * budgets, the remembered menu page + card origin, the per-chat session-create
 * serialization chains, the pending single-slot prompt inputs, the
 * start-after-allow replay set, per-agent subagent counts and per-chat todo
 * snapshots. Teardown delegates to `disposeAll()` and per-chat ejection to
 * `disposeChat()`, so adding a container can no longer be forgotten at a
 * second call site.
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. Deliberately no cards/ or
 * media/ imports: already-extracted modules (core/events.ts) keep receiving
 * the containers they read as plain deps passed by index.ts, so no import
 * cycle can form. All plugin-root singletons (transport, live-feed seam,
 * ctx access) are assigned on apply and therefore arrive as late-bound dep
 * closures read at call time.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { TodoView } from "../harness/adapters/todos.js";
import { safeWrap } from "../telegram/safe.js";
import type { TelegramTransport } from "../telegram/transport.js";

/** Late-bound seams from the plugin root. Every field is read through its
 * closure only when a hub function runs, never at factory time. */
export interface ChatHubDeps {
  /** Live transport (typing keepalive needs it); undefined while unmounted. */
  getTransport(): TelegramTransport | undefined;
  /** Chat-scoped live-agent lookup backing the keepalive decision (#48). */
  currentAgent(chatId?: number): Agent | undefined;
  /** Live-feed seam (#48); a no-op until the `telegram` service mounts. */
  stopLiveFeed(chatId: number): void;
  log(message: string, error?: unknown): void;
}

// ---------------------------------------------------------------------------
// Typing keepalive + sticky turn flags
// ---------------------------------------------------------------------------

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
 * when no live agent can answer, and the rearm budget caps that stale path.
 * A genuinely running agent is never budget-killed: turns legitimately
 * outlast a few windows, so the budget must not fire before the agent check. */
export function typingKeepaliveActive(agentRunning: boolean | undefined, stickyRunning: boolean, rearmCount: number, rearmLimit = TYPING_REARM_LIMIT): boolean {
  if (agentRunning === true) return true;
  if (agentRunning === false) return false;
  if (rearmCount > rearmLimit) return false;
  return stickyRunning;
}

function turnStillRunning(chatId: number, deps: ChatHubDeps): boolean {
  const agent = deps.currentAgent(chatId);
  const agentRunning = agent === undefined ? undefined : agent.status === "running";
  return typingKeepaliveActive(agentRunning, runningTurns.has(chatId), typingRearms.get(chatId) ?? 0);
}

function startTyping(chatId: number, deps: ChatHubDeps): void {
  stopTyping(chatId);
  const transport = deps.getTransport();
  if (!transport) return;
  const fire = () => safeWrap(`typing(${chatId})`, () => transport.sendChatActionControl(chatId, "typing"), deps.log);
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
    // A genuinely running turn RENEWS its budget instead of spending it (#48):
    // the cap exists for the stale no-live-agent path, not to kill typing on
    // a single turn that legitimately outlasts ~30-40 minutes.
    const agent = deps.currentAgent(chatId);
    if (agent?.status === "running") typingRearms.delete(chatId);
    if (turnStillRunning(chatId, deps)) startTyping(chatId, deps);
    else stopTyping(chatId);
  }, TYPING_KEEPALIVE_MAX_MS);
}

function stopTyping(chatId: number): void {
  const timer = typingLoops.get(chatId);
  if (timer !== undefined) {
    clearInterval(timer);
    typingLoops.delete(chatId);
  }
}

/** Terminal cleanup for one chat's background loops (#48): Abort must kill
 * the typing keepalive, the sticky turn flag, its rearm budget, and every
 * live-feed timer — not just hide the UI. Kept verbatim from index.ts: an
 * abort touches ONLY these four things (unlike disposeChat, it must not drop
 * menu/pending/chain state, and unlike eject it must stop the live feed). */
function abortChatLoops(chatId: number, deps: ChatHubDeps): void {
  stopTyping(chatId);
  runningTurns.delete(chatId);
  typingRearms.delete(chatId);
  deps.stopLiveFeed(chatId);
}

/** Bridge turn/start–turn/end seam: a genuine new turn gets a fresh
 * keepalive budget (#48); turn/end stops typing and drops the sticky flag. */
function setTurnRunning(chatId: number, running: boolean, deps: ChatHubDeps): void {
  if (running) {
    runningTurns.add(chatId);
    typingRearms.delete(chatId);
    startTyping(chatId, deps);
  } else {
    runningTurns.delete(chatId);
    typingRearms.delete(chatId);
    stopTyping(chatId);
  }
}

// ---------------------------------------------------------------------------
// Menu page + card origin bookkeeping
// ---------------------------------------------------------------------------

/** Last menu page each chat had open, so Back/More land where the user was. */
const menuPageIndex = new Map<number, number>();
/** Which entry point opened the current card: bar-opened cards close on Back,
 * menu-opened cards return to the last menu page (issue #16). */
const cardOrigins = new Map<number, "menu" | "bar">();

// ---------------------------------------------------------------------------
// Status subagent counts + todo snapshots
// ---------------------------------------------------------------------------

/** Live subagent counts per agent id. `subagents.listChildren` is async, so
 * the Status card renders the latest snapshot and refreshAllPanels updates it
 * before the next in-place edit. Agent-keyed (not chat-keyed): entries are
 * dropped on session/disposed by core/events.ts, so disposeChat has no chat
 * key to remove and only disposeAll clears the map wholesale. */
const statusSubagentCounts = new Map<string, number>();
/** Latest durable todo snapshot per chat (todo/write is whole-list). */
const todoSnapshots = new Map<number, TodoView[]>();

// ---------------------------------------------------------------------------
// Session-create serialization chains
// ---------------------------------------------------------------------------

/** Per-chat serialization for session creation. With router UI lanes, a
 * first inbound message and a fast `✨ New` / model-select tap can run
 * concurrently; this gate guarantees they still produce one session. The
 * stored promise is already settled-shaped and removes itself, so dropping
 * an entry never cancels an in-flight creation. */
const sessionCreateChains = new Map<number, Promise<unknown>>();

// ---------------------------------------------------------------------------
// Pending single-slot prompt inputs
// ---------------------------------------------------------------------------

/** The one armed free-text prompt per intent (issue 🟠-4 keeps them
 * single-slot on purpose for now: two chats arming the same intent overwrite
 * each other, and the chatId guard prevents cross-chat consumption). Hub
 * ownership only adds: ejection/teardown now reliably unarm them. */
export interface ChatPendingSlots {
  rename?: { chatId: number; sessionId: string };
  steer?: { chatId: number; sessionId: string };
  search?: { chatId: number };
  presetCopy?: { chatId: number; sourceId: string };
  mkdir?: { chatId: number; path: string };
  /** Issue #50: awaiting the plugin-definition JSON reply. */
  pluginAdd?: { chatId: number };
  subagentPrompt?: { chatId: number; parentId: string; childId: string };
}
const pending: ChatPendingSlots = {};

/** Chats whose first touch was `/start` while unauthorized: once they tap
 * Allow, replay the welcome instead of making them resend the command. */
const pendingStartAfterAllow = new Set<number>();

// ---------------------------------------------------------------------------
// Disposal trunk
// ---------------------------------------------------------------------------

/** Drop one chat's slice of every chat-keyed hub container: typing loop
 * (clearTimer semantics), sticky turn flag, rearm budget, remembered menu
 * page, card origin, session-create chain, every pending input slot armed by
 * this chat, the start-after-allow replay flag and the last todo snapshot.
 * Deliberately NOT covered: the live-feed seam (eject must not touch it, see
 * abortChatLoops) and the agent-keyed statusSubagentCounts (no chat key;
 * dropped on session/disposed by core/events.ts). */
function disposeChat(chatId: number): void {
  stopTyping(chatId);
  runningTurns.delete(chatId);
  typingRearms.delete(chatId);
  menuPageIndex.delete(chatId);
  cardOrigins.delete(chatId);
  sessionCreateChains.delete(chatId);
  if (pending.rename?.chatId === chatId) pending.rename = undefined;
  if (pending.steer?.chatId === chatId) pending.steer = undefined;
  if (pending.search?.chatId === chatId) pending.search = undefined;
  if (pending.mkdir?.chatId === chatId) pending.mkdir = undefined;
  if (pending.presetCopy?.chatId === chatId) pending.presetCopy = undefined;
  if (pending.pluginAdd?.chatId === chatId) pending.pluginAdd = undefined;
  if (pending.subagentPrompt?.chatId === chatId) pending.subagentPrompt = undefined;
  pendingStartAfterAllow.delete(chatId);
  todoSnapshots.delete(chatId);
}

/** Reverse every hub-owned per-chat container (hot unplug / HMR / config
 * restart). Timers get clearInterval, maps/sets clear wholesale, pending
 * inputs reset to unarmed. */
function disposeAll(): void {
  for (const timer of typingLoops.values()) clearInterval(timer);
  typingLoops.clear();
  runningTurns.clear();
  // Stale rearm budgets must not survive a remount (#48): a same-chat long
  // turn after hot reload would otherwise hit a budget it never spent.
  typingRearms.clear();
  menuPageIndex.clear();
  cardOrigins.clear();
  sessionCreateChains.clear();
  pending.rename = undefined;
  pending.steer = undefined;
  pending.search = undefined;
  pending.mkdir = undefined;
  pending.presetCopy = undefined;
  pending.pluginAdd = undefined;
  pending.subagentPrompt = undefined;
  pendingStartAfterAllow.clear();
  statusSubagentCounts.clear();
  todoSnapshots.clear();
}

/** Build the per-chat lifecycle hub. Called once by index.ts; the returned
 * functions and containers close over the shared deps like the previous
 * module-scope closures did over index.ts singletons. Maps and Sets are
 * returned by reference so destructured call sites keep mutating the hub's
 * own state. */
export function createChatHub(deps: ChatHubDeps): {
  // Containers (index.ts destructures once; Maps/Sets mutate in place).
  todoSnapshots: Map<number, TodoView[]>;
  statusSubagentCounts: Map<string, number>;
  sessionCreateChains: Map<number, Promise<unknown>>;
  menuPageIndex: Map<number, number>;
  cardOrigins: Map<number, "menu" | "bar">;
  pendingStartAfterAllow: Set<number>;
  pending: ChatPendingSlots;
  // Typing cluster (typingKeepaliveActive is also a module-level export so
  // dist/index.js can re-export it for the test suite).
  typingKeepaliveActive: typeof typingKeepaliveActive;
  setTurnRunning(chatId: number, running: boolean): void;
  startTyping(chatId: number): void;
  stopTyping(chatId: number): void;
  abortChatLoops(chatId: number): void;
  // Disposal trunk.
  disposeChat(chatId: number): void;
  disposeAll(): void;
} {
  return {
    todoSnapshots,
    statusSubagentCounts,
    sessionCreateChains,
    menuPageIndex,
    cardOrigins,
    pendingStartAfterAllow,
    pending,
    typingKeepaliveActive,
    setTurnRunning: (chatId, running) => setTurnRunning(chatId, running, deps),
    startTyping: (chatId) => startTyping(chatId, deps),
    stopTyping,
    abortChatLoops: (chatId) => abortChatLoops(chatId, deps),
    disposeChat,
    disposeAll,
  };
}
