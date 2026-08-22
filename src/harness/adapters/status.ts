import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import { currentSessionModel } from "./sessions.js";

/** Whole-session figures mirrored from the web stats strip sources:
 * `sessionStats` + `tokenUsage` projections, plus a live tool-call counter. */
export interface StatusStats {
  turns: number;
  steps: number;
  toolCalls: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  decodeTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StatusSnapshot {
  agentId?: string;
  status: "idle" | "running" | "none";
  provider?: string;
  model?: string;
  /** Reasoning effort of the live selection (web session.models.current). */
  reasoningEffort?: string;
  /** Agent preset in effect (web resolveSessionPreset: latest
   * agent-preset/selected event, falling back to the session header). */
  preset?: string;
  queue: number;
  sessions: number;
  /** Present when any stats source contributed a number (web profile). */
  stats?: StatusStats;
}

/** Live tool/call counts per session — the web trajectory's call count. */
const toolCallCounts = new Map<string, number>();
/** Incremental per-agent event scan cache (issue #20/#1): `eventStatsFor` and
 * the preset lookup were re-walking the whole event list on every tool/step
 * event, which made long sessions degrade O(n²). */
interface EventScanCache {
  scannedEnd: number;
  stats?: StatusStats;
  preset?: string;
  /** Session header preset (first `session` event) — cached independently of
   * the append-only `agent-preset/selected` tail scan (#22). */
  headerPreset?: string;
}
/**
 * Keyed by the EVENTS ARRAY object, not the agent: a compaction/reset can
 * swap in a fresh array with the SAME length, which a length-only check would
 * silently accept as "nothing appended" and keep serving the stale fold.
 * Identity keying makes any replaced array miss the cache and force one full
 * re-scan; scannedEnd still short-circuits pure appends on the same array.
 */
const eventScanCache = new WeakMap<object, EventScanCache>();

/** Increment the bound session's tool-call counter (called from the bridge). */
export function noteToolCall(sessionId: string): void {
  toolCallCounts.set(sessionId, (toolCallCounts.get(sessionId) ?? 0) + 1);
}

/** Drop in-memory stats counters on hot unplug / re-mount. */
export function resetStatusStats(): void {
  toolCallCounts.clear();
}

/** Session disposal cleanup (LOOP_AUDIT #8): the live tool-call counter must
 * not accumulate entries for every session the bot ever touched. */
export function forgetStatusSession(sessionId: string): void {
  toolCallCounts.delete(sessionId);
}

interface SessionLike {
  id?: unknown;
}

interface ProjectionRegistryLike {
  snapshot(session: unknown): { values?: Record<string, unknown> } | undefined;
}

/** Read the web's projection snapshot for one session, fail-soft when the
 * projection registry is not mounted (headless assemblies). */
function projectionValuesFor(ctx: Context, sessionId: string | undefined): Record<string, unknown> | undefined {
  try {
    const get = (ctx as unknown as { get(key: string): unknown }).get.bind(ctx);
    const registry = get("sessionProjections") as ProjectionRegistryLike | undefined;
    if (!registry) return undefined;
    const sessions = (get("sessions") as { list(): SessionLike[] } | undefined)?.list() ?? [];
    const session = sessionId !== undefined ? sessions.find((entry) => String(entry.id) === sessionId) : sessions[0];
    if (!session) return undefined;
    return registry.snapshot(session)?.values;
  } catch {
    return undefined;
  }
}

/** Prefer the projected value when it is present AND nonzero; otherwise fall
 * back to the live event count (a zeroed projection must not shadow data). */
function pickTokens(projected: number | undefined, eventCount: number | undefined): number {
  if (projected !== undefined && projected > 0) return projected;
  return eventCount ?? 0;
}

/** Exact mirror of the web stats strip formatters (dsh-client-ui-conversation). */
function formatTokensWeb(tokens: number): string {
  const scaled = (v: number) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
  if (tokens < 1e3) return String(tokens);
  if (tokens < 1e6) return `${scaled(tokens / 1e3)}K`;
  return `${scaled(tokens / 1e6)}M`;
}

function formatDurationWeb(ms: number): string {
  const s = ms / 1e3;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

/** One-line variant for the openclaw turn summary:
 * `📊 4 轮 · 279 步 | ⚡ LLM 46m41s · 工具调用 5m10s | 🎯 首 token 平均 3.5s · 68 tok/s` */
export function renderStatsLine(stats: StatusStats): string | undefined {
  const segments: string[] = [];
  if (stats.steps > 0) {
    segments.push(`\u{1F4CA} ${stats.turns} \u8F6E \u00B7 ${stats.steps} \u6B65`);
  }
  const durations: string[] = [];
  if (stats.llmMs > 0) durations.push(`LLM ${formatDurationWeb(stats.llmMs)}`);
  if (stats.toolMs > 0) durations.push(`\u5DE5\u5177\u8C03\u7528 ${formatDurationWeb(stats.toolMs)}`);
  if (durations.length > 0) segments.push(`\u26A1 ${durations.join(" \u00B7 ")}`);
  const speeds: string[] = [];
  if (stats.ttftSteps > 0) speeds.push(`\u9996 token \u5E73\u5747 ${formatDurationWeb(stats.ttftMs / stats.ttftSteps)}`);
  if (stats.decodeMs > 0) speeds.push(`${formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3))} tok/s`);
  if (speeds.length > 0) segments.push(`\u{1F3AF} ${speeds.join(" \u00B7 ")}`);
  return segments.length > 0 ? segments.join(" | ") : undefined;
}

/** Conversation stats, multi-line grouped: turn/step, durations, speeds,
 * cache hit, and tokens. Shared by the status card and the streamed draft
 * finalization. */
export function renderStatsStrip(stats: NonNullable<ReturnType<typeof statusSnapshot>["stats"]>): string | undefined {
  const lines: string[] = [];
  if (stats.steps > 0) {
    lines.push(`\u{1F4CA} ${stats.turns} \u8F6E \u00B7 ${stats.steps} \u6B65`);
    const durations: string[] = [];
    if (stats.llmMs > 0) durations.push(`LLM ${formatDurationWeb(stats.llmMs)}`);
    if (stats.toolMs > 0) durations.push(`\u5DE5\u5177\u8C03\u7528 ${formatDurationWeb(stats.toolMs)}`);
    if (durations.length > 0) lines.push(`\u26A1 ${durations.join(" \u00B7 ")}`);
    const speeds: string[] = [];
    if (stats.ttftSteps > 0) speeds.push(`\u9996 token \u5E73\u5747 ${formatDurationWeb(stats.ttftMs / stats.ttftSteps)}`);
    if (stats.decodeMs > 0) speeds.push(`${formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3))} tok/s`);
    if (speeds.length > 0) lines.push(`\u{1F3AF} ${speeds.join(" \u00B7 ")}`);
  }
  const billed = stats.uncachedInputTokens + stats.cacheReadTokens + stats.cacheWriteTokens;
  if (billed > 0 || stats.outputTokens > 0) {
    const hit = billed === 0 ? null : Math.round((stats.cacheReadTokens / billed) * 100);
    if (hit !== null) lines.push(`\u{1F4BE} \u7F13\u5B58\u547D\u4E2D ${hit}%`);
    lines.push(`\u{1F4DD} \u8F93\u5165 ${formatTokensWeb(billed)} tok \u00B7 \u8F93\u51FA ${formatTokensWeb(stats.outputTokens)} tok`);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Per-agent figures counted from the in-memory session event log
 * (turns/steps/tool calls/token usage incl. cache reads). Works in every
 * profile; the projection registry only adds LLM/tool latency figures. */
interface EventLike {
  type?: string;
  /** Some session-header projections flatten `agentPreset` onto the envelope
   * instead of nesting it under `data` (#22). */
  agentPreset?: unknown;
  data?: {
    agentPreset?: unknown;
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    chunk?: { type?: string; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } };
  };
}

interface SessionEventsSource {
  session?: { events?: readonly EventLike[] };
}

function emptyEventStats(): NonNullable<StatusStats> {
  return {
    turns: 0,
    steps: 0,
    toolCalls: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function foldEvent(stats: NonNullable<StatusStats>, event: EventLike): void {
  if (event.type === "turn/start") stats.turns += 1;
  else if (event.type === "step/start") stats.steps += 1;
  else if (event.type === "tool/call") stats.toolCalls += 1;
  else if (event.type === "assistant/chunk") {
    const usage = event.data?.chunk?.type === "usage" ? event.data.chunk.usage : event.data?.usage;
    if (usage !== undefined) {
      stats.uncachedInputTokens += usage.inputTokens ?? 0;
      stats.outputTokens += usage.outputTokens ?? 0;
      stats.cacheReadTokens += usage.cacheReadTokens ?? 0;
      stats.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    }
  }
}

function meaningfulStats(stats: StatusStats): boolean {
  return stats.turns > 0 || stats.steps > 0 || stats.toolCalls > 0 || stats.outputTokens > 0 || stats.cacheReadTokens > 0;
}

function eventStatsFor(agent: unknown): StatusStats | undefined {
  const source = agent as SessionEventsSource | undefined;
  const events = source?.session?.events;
  if (!events) return undefined;
  const cached = eventScanCache.get(events);
  const end = events.length - 1;
  if (cached !== undefined && cached.scannedEnd === end) return cached.stats;

  // Append-only fast path: fold only the newly appended tail. A replaced or
  // shrunk array (compaction/reset) misses the identity-keyed cache and falls
  // through to a full rescan.
  let stats: StatusStats | undefined;
  let start = 0;
  const fullRescan = cached === undefined || cached.scannedEnd >= end;
  if (cached !== undefined && cached.scannedEnd < end) {
    stats = cached.stats;
    start = cached.scannedEnd + 1;
  }
  const folded = stats === undefined ? emptyEventStats() : { ...stats };
  for (let index = start; index <= end; index += 1) foldEvent(folded, events[index]!);
  const result = meaningfulStats(folded) ? folded : undefined;
  // Official resolveSessionPreset order: latest agent-preset/selected event
  // wins, otherwise the preset the session was created with (issue #22).
  // The header preset only changes when the event log itself is rebuilt.
  // fullRescan is false only when a cache entry exists (line above), so the
  // incremental path can always reuse its cached header preset.
  const headerPreset = fullRescan ? sessionHeaderPreset(source) : cached!.headerPreset;
  const preset = latestPreset(source, cached?.preset, cached?.scannedEnd) ?? headerPreset;
  eventScanCache.set(events, { scannedEnd: end, stats: result, preset, headerPreset });
  return result;
}

/** First `session` event carries the session header (created from the roster
 * preset). web's resolveSessionPreset falls back to it when no
 * `agent-preset/selected` event has switched the preset yet (issue #22). */
function sessionHeaderPreset(source: SessionEventsSource | undefined): string | undefined {
  const events = source?.session?.events;
  if (!Array.isArray(events)) return undefined;
  for (const event of events) {
    if (event?.type !== "session") continue;
    const preset = event.data?.agentPreset ?? event.agentPreset;
    if (preset !== undefined && preset !== null) return String(preset);
  }
  return undefined;
}

/** Latest `agent-preset/selected` with the same incremental-tail strategy. */
function latestPreset(source: SessionEventsSource | undefined, cachedPreset: string | undefined, cachedEnd: number | undefined): string | undefined {
  const events = source?.session?.events;
  if (!events) return undefined;
  let preset = cachedPreset;
  const start = cachedEnd !== undefined && cachedEnd < events.length - 1 ? cachedEnd + 1 : 0;
  for (let index = events.length - 1; index >= start; index -= 1) {
    const event = events[index];
    if (event?.type === "agent-preset/selected") {
      preset = String(event.data?.agentPreset ?? "");
      break;
    }
  }
  return preset;
}

export function statusSnapshot(ctx: Context, preferAgentId?: string, fallbackToFirst = true): StatusSnapshot {
  const agents = ctx.agents?.list() ?? [];
  // The bridge-bound session drives the bar/status figures; `agents[0]` is
  // only a fallback for profiles/views without a bound chat. Chat-scoped
  // callers pass `fallbackToFirst: false` so an unbound chat shows "none"
  // instead of borrowing another chat's live agent.
  const preferred = preferAgentId !== undefined ? agents.find((entry) => String(entry.id) === preferAgentId) : undefined;
  const agent = preferred ?? (fallbackToFirst ? agents[0] : undefined);
  const sessions = ctx.get("sessions");
  const agentId = agent?.id;
  const values = projectionValuesFor(ctx, agentId === undefined ? undefined : String(agentId));
  const projected = values?.["sessionStats"] as
    | Partial<{ turns: number; steps: number; llmMs: number; toolMs: number; ttftMs: number; ttftSteps: number; decodeMs: number; decodeTokens: number }>
    | undefined;
  const usage = values?.["tokenUsage"] as
    | Partial<{ uncachedInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>
    | undefined;
  const toolCalls = agentId === undefined ? 0 : (toolCallCounts.get(String(agentId)) ?? 0);
  const eventStats = agent === undefined ? undefined : eventStatsFor(agent);
  const hasStats = eventStats !== undefined || projected !== undefined || usage !== undefined || toolCalls > 0;
  const selection = agentId === undefined ? {} : currentSessionModel(ctx, String(agentId));
  // eventStatsFor above populates the shared scan cache (preset tail cache +
  // session-header fallback) for the same agent's event array, so this is
  // O(1) after the first scan; the direct call only covers agents without
  // event logs. The cache is keyed by the events array itself (see above).
  const scanEvents = (agent as SessionEventsSource | undefined)?.session?.events;
  const cachedScan = scanEvents === undefined ? undefined : eventScanCache.get(scanEvents);
  const preset = cachedScan?.preset ?? cachedScan?.headerPreset ?? (cachedScan === undefined ? sessionHeaderPreset(agent as SessionEventsSource | undefined) : undefined);
  const presetText = preset === undefined ? undefined : String(preset);
  return {
    agentId: agent?.id,
    status: agent ? agent.status : "none",
    provider: selection.provider ?? agent?.options.provider,
    model: selection.model ?? agent?.options.model,
    reasoningEffort: selection.reasoningEffort,
    preset: presetText,
    queue: agent ? agent.inbox.nextTurn.length + agent.inbox.nextStep.length : 0,
    sessions: sessions ? sessions.list().length : 0,
    ...(!hasStats
      ? {}
      : {
          stats: {
            // A projection that exists but is all zeros must not shadow the
            // live event counts (fresh process: token-meter folds are empty).
            turns: (projected?.turns ?? 0) > 0 ? projected!.turns! : (eventStats?.turns ?? 0),
            steps: (projected?.steps ?? 0) > 0 ? projected!.steps! : (eventStats?.steps ?? 0),
            toolCalls: Math.max(eventStats?.toolCalls ?? 0, toolCalls),
            llmMs: projected?.llmMs ?? 0,
            toolMs: projected?.toolMs ?? 0,
            ttftMs: projected?.ttftMs ?? 0,
            ttftSteps: projected?.ttftSteps ?? 0,
            decodeMs: projected?.decodeMs ?? 0,
            decodeTokens: projected?.decodeTokens ?? 0,
            uncachedInputTokens: pickTokens(usage?.uncachedInputTokens, eventStats?.uncachedInputTokens),
            outputTokens: pickTokens(usage?.outputTokens, eventStats?.outputTokens),
            cacheReadTokens: pickTokens(usage?.cacheReadTokens, eventStats?.cacheReadTokens),
            cacheWriteTokens: pickTokens(usage?.cacheWriteTokens, eventStats?.cacheWriteTokens),
          },
        }),
  };
}
