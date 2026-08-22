/**
 * Per-chat lifecycle hub for dsh-telegram (yellow-1 step 3).
 *
 * Single owner of every per-chat container that `teardownMount()` and
 * `ejectChat()` used to hand-enumerate — and twice leaked (review 2026-08-21
 * 🔴-8): the typing keepalive loops, the sticky turn flags and their rearm
 * budgets, the remembered menu page + card origin, the per-chat session-create
 * serialization chains, the per-chat pending prompt inputs (audit B-4r:
 * one `Map<chatId, PendingInput>` with a lazy 5-minute TTL), the
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
  /** Injectable clock for the pending-input TTL (tests); defaults to Date.now. */
  now?(): number;
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
// Pending prompt inputs (per-chat store, B-4r)
// ---------------------------------------------------------------------------

/** How long an armed free-text prompt stays valid (audit B-4r). Expiry is
 * lazy — checked on the next take/cancel for that chat — so an abandoned
 * flow can no longer hijack the chat's next ordinary message, and no timer
 * bookkeeping is needed. */
export const PENDING_INPUT_TTL_MS = 5 * 60_000;

/** One armed free-text prompt. The owning chat is the `pendingInputs` Map
 * key (the former slots carried a redundant `chatId` field), so two chats
 * arming the same kind never clobber each other and arming a different kind
 * in one chat replaces that chat's previous input. */
export type PendingInput =
  | { kind: "rename"; expiresAt: number; sessionId: string }
  | { kind: "steer"; expiresAt: number; sessionId: string }
  | { kind: "search"; expiresAt: number }
  | { kind: "presetCopy"; expiresAt: number; sourceId: string }
  | { kind: "mkdir"; expiresAt: number; path: string }
  /** Issue #50: awaiting the plugin-definition JSON reply. */
  | { kind: "pluginAdd"; expiresAt: number }
  | { kind: "subagentPrompt"; expiresAt: number; parentId: string; childId: string };

/** What an arming call site provides: the kind-specific payload without
 * `expiresAt`, which `armPending` stamps (`now() + PENDING_INPUT_TTL_MS`). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type PendingInputSpec = DistributiveOmit<PendingInput, "expiresAt">;

/** Per-chat pending inputs: at most one armed flow per chat (arming a new
 * kind supersedes the old one instead of leaving both behind). */
const pendingInputs = new Map<number, PendingInput>();

function hubNow(deps: ChatHubDeps): number {
  return (deps.now ?? Date.now)();
}

/** Drop the entry when it has passed its TTL; absent and expired look
 * identical to consumers ("no pending input"). */
function livePending(chatId: number, deps: ChatHubDeps): PendingInput | undefined {
  const input = pendingInputs.get(chatId);
  if (input === undefined) return undefined;
  if (hubNow(deps) >= input.expiresAt) {
    pendingInputs.delete(chatId);
    return undefined;
  }
  return input;
}

/** Arm one pending input for this chat with a fresh TTL window. */
function armPending(chatId: number, input: PendingInputSpec, deps: ChatHubDeps): void {
  pendingInputs.set(chatId, { ...input, expiresAt: hubNow(deps) + PENDING_INPUT_TTL_MS } as PendingInput);
}

/** Consume this chat's armed input (lazily expiring it first); absent or
 * expired → undefined, which callers treat exactly like "nothing armed".
 * With `kind`, a non-matching entry stays armed instead of being swallowed
 * (/subagentprompt must not eat an armed rename). */
function takePending(chatId: number, kind: PendingInput["kind"] | undefined, deps: ChatHubDeps): PendingInput | undefined {
  const input = livePending(chatId, deps);
  if (input === undefined) return undefined;
  if (kind !== undefined && input.kind !== kind) return undefined;
  pendingInputs.delete(chatId);
  return input;
}

/** Cancel this chat's armed input whatever its kind; returns the removed
 * input's kind so /cancel can name what it cancelled, or undefined. */
function cancelPending(chatId: number, deps: ChatHubDeps): PendingInput["kind"] | undefined {
  return takePending(chatId, undefined, deps)?.kind;
}

/** Chats whose first touch was `/start` while unauthorized: once they tap
 * Allow, replay the welcome instead of making them resend the command. */
const pendingStartAfterAllow = new Set<number>();

// ---------------------------------------------------------------------------
// Disposal trunk
// ---------------------------------------------------------------------------

/** Drop one chat's slice of every chat-keyed hub container: typing loop
 * (clearTimer semantics), sticky turn flag, rearm budget, remembered menu
 * page, card origin, session-create chain, the chat's armed pending input,
 * the start-after-allow replay flag and the last todo snapshot.
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
  pendingInputs.delete(chatId);
  pendingStartAfterAllow.delete(chatId);
  todoSnapshots.delete(chatId);
}

/** Reverse every hub-owned per-chat container (hot unplug / HMR / config
 * restart). Timers get clearInterval, maps/sets clear wholesale, pending
 * inputs drop with them. */
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
  pendingInputs.clear();
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
  /** Arm/consume/cancel the chat's pending free-text input (B-4r per-chat
   * store; `PENDING_INPUT_TTL_MS` expiry is evaluated lazily on take). */
  armPending(chatId: number, input: PendingInputSpec): void;
  takePending(chatId: number, kind?: PendingInput["kind"]): PendingInput | undefined;
  cancelPending(chatId: number): PendingInput["kind"] | undefined;
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
    armPending: (chatId, input) => armPending(chatId, input, deps),
    takePending: (chatId, kind) => takePending(chatId, kind, deps),
    cancelPending: (chatId) => cancelPending(chatId, deps),
    typingKeepaliveActive,
    setTurnRunning: (chatId, running) => setTurnRunning(chatId, running, deps),
    startTyping: (chatId) => startTyping(chatId, deps),
    stopTyping,
    abortChatLoops: (chatId) => abortChatLoops(chatId, deps),
    disposeChat,
    disposeAll,
  };
}
