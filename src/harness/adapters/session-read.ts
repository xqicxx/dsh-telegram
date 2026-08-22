/**
 * Read-only session queries: list (live + persisted roster), search, flat
 * history windows, and turn-grouped trajectory views — mirroring the web
 * ApiProxy `sessions` domain over the host seams (`ctx.sessions`,
 * `ctx.sessionTitle`, `ctx.sessionPersistence`).
 *
 * This module is also the dependency root of the sessions family: the
 * structural event/session shapes and the `ctx` seam accessors shared with
 * session-lifecycle.ts live here and are exported within the family only
 * (the public barrel in sessions.ts re-exports just the query API).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionDetail } from "./session-render.js";

/** One event as read from a live or persisted session log (structural). */
export interface SessionEventLike {
  seq: number;
  type: string;
  at?: number;
  data?: Record<string, unknown>;
}

export interface SessionLike {
  id: SessionId;
  events: readonly SessionEventLike[];
  header?: { cwd?: string };
}

export interface SessionTitleServiceLike {
  get(session: SessionLike): { title: string; eventSeq: number } | undefined;
  rename(session: SessionLike, title: string): { title: string; eventSeq: number };
}

export interface AgentLike {
  id: SessionId;
  session: SessionLike;
  options?: { provider?: string; model?: string };
  status?: string;
}

interface PersistenceHeaderLike {
  id: SessionId;
  cwd?: string;
}

interface PersistenceLike {
  list(signal?: AbortSignal): Promise<PersistenceHeaderLike[]>;
  /** The real `SessionPersistence.readRaw` returns `{ meta, filename, content }`
   * (verbatim JSONL text); older test seams return parsed `events` directly. */
  readRaw(id: SessionId, signal?: AbortSignal): Promise<{ content?: string; events?: readonly SessionEventLike[] } | undefined>;
}

export function agentsOf(ctx: Context) {
  // The real `ctx.agents` is an `AgentRegistry`; we only consume the stable
  // structural subset below so this adapter never hard-couples to that class.
  return (ctx.agents ?? undefined) as unknown as
    | {
        list(): AgentLike[];
        get(id: SessionId): AgentLike | undefined;
        create(options: {
          sessionId: SessionId;
          meta?: { cwd?: string; agentPreset?: string };
          agentOptions?: { provider?: string; model?: string };
          setup?: (agentCtx: Context) => Promise<void>;
        }): Promise<AgentHandle>;
        resume(options: { resumeSessionId: SessionId; agentOptions?: { provider?: string; model?: string } }): Promise<AgentHandle>;
      }
    | undefined;
}

export function sessionTitleService(ctx: Context): SessionTitleServiceLike | undefined {
  return ctx.get("sessionTitle") as SessionTitleServiceLike | undefined;
}

function persistenceOf(ctx: Context): PersistenceLike | undefined {
  return ctx.get("sessionPersistence") as PersistenceLike | undefined;
}

export function sessionsOf(ctx: Context) {
  return ctx.get("sessions") as
    | {
        list(): SessionLike[];
        get(id: SessionId): SessionLike | undefined;
        fork(id: SessionId, boundary: number | undefined, childId: SessionId): SessionLike;
      }
    | undefined;
}

function liveSessions(ctx: Context): Map<string, SessionLike> {
  const map = new Map<string, SessionLike>();
  const store = sessionsOf(ctx);
  if (!store) return map;
  for (const session of store.list()) map.set(session.id, session as unknown as SessionLike);
  return map;
}

export function sessionById(ctx: Context, id: string): SessionLike | undefined {
  const session = sessionsOf(ctx)?.get(SessionId(id));
  return session as unknown as SessionLike | undefined;
}

function titleFor(ctx: Context, session: SessionLike): string | undefined {
  const titles = sessionTitleService(ctx);
  try {
    const snapshot = titles?.get(session);
    if (snapshot?.title) return snapshot.title;
  } catch {
    /* title service may not own this session */
  }
  // Durable titles are `session/title` events (latest wins), same as the
  // web's foldSessionTitle projection. This is how cold sessions keep names.
  // No first-message fallback: the caller falls back to the cwd basename so
  // Telegram shows exactly the web display-title chain.
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event?.type !== "session/title") continue;
    const title = (event.data as { title?: unknown } | undefined)?.title;
    if (typeof title === "string" && title.trim() !== "") return title.trim();
  }
  return undefined;
}

/** Parse the JSONL text of a cold log back into structural events. */
function parseRawEvents(content: string): SessionEventLike[] {
  const events: SessionEventLike[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as {
        seq?: unknown;
        type?: unknown;
        at?: unknown;
        data?: unknown;
      };
      if (typeof value.type !== "string" || typeof value.seq !== "number") continue;
      events.push({
        seq: value.seq,
        type: value.type,
        ...(typeof value.at === "number" ? { at: value.at } : {}),
        ...(typeof value.data === "object" && value.data !== null ? { data: value.data as Record<string, unknown> } : {}),
      });
    } catch {
      /* a torn tail line must not hide the titles that precede it */
    }
  }
  return events;
}

/**
 * Events for one session: the live log while resident in memory, else the
 * persisted raw log parsed back to structural events. Production
 * `PersistenceLike.readRaw` returns JSONL text under `content`; older test
 * seams hand back parsed `events` (see the interface comment above). Returns
 * `undefined` when neither source can serve this session.
 */
async function loadSessionEvents(ctx: Context, sessionId: string): Promise<readonly SessionEventLike[] | undefined> {
  const session = sessionById(ctx, sessionId);
  if (session) return session.events;
  const persistence = persistenceOf(ctx);
  if (!persistence) return undefined;
  const raw = await persistence.readRaw(SessionId(sessionId)).catch(() => undefined);
  if (raw === undefined) return undefined;
  return raw.events ?? (typeof raw.content === "string" ? parseRawEvents(raw.content) : []);
}

function scanMeta(session: SessionLike): { blank: boolean; lastPromptAt?: number; eventCount: number } {
  let blank = true;
  let lastPromptAt: number | undefined;
  for (const event of session.events) {
    if (event.type === "turn/start") blank = false;
    if (event.type === "user/message") {
      blank = false;
      lastPromptAt = (event.at ?? event.data?.createdAt) as number | undefined;
    }
  }
  return { blank, lastPromptAt, eventCount: session.events.length };
}

/** Expensive derivations of one cold log (parsed events → summary metadata +
 * durable title). Only these are cached per session id between panel
 * refreshes; everything assembled around them (cwd from the fresh header,
 * archived flag from the registry, live/running constants) is recomputed so
 * registry changes still show up immediately. */
interface ColdDetailCore {
  title?: string;
  blank: boolean;
  lastPromptAt?: number;
  eventCount: number;
}

interface ColdDetailCache {
  /** Roster signature the entries were filled under: any list change drops
   * the whole cache (the documented invalidation rule). */
  signature: string;
  byId: Map<string, { key: string | undefined; core: ColdDetailCore }>;
}

/**
 * Per-ctx cache over parsed cold logs (review 🔵-3): every Sessions-card open
 * AND every panel refresh used to pay N sequential file reads + full JSONL
 * parses for the whole persisted roster. Cache validity per id is keyed by
 * the header's mtime when a backend exposes one (`mtimeMs`/`mtime`), else by
 * id alone — then correctness rides on the roster signature above. That is
 * safe because cold logs are append-only files with no live writer: a session
 * only stops being live through agent disposal, and while it IS live its
 * detail comes from the in-memory branch (never cached). The real JSONL
 * backend's `list()` headers carry no mtime today, so the id+signature path
 * is the production one; the mtime hook keeps backends that expose it exact.
 */
const coldDetailCaches = new WeakMap<object, ColdDetailCache>();

/** Content key for one cold header: mtime string when available, else `undefined`. */
function coldCacheKey(header: PersistenceHeaderLike): string | undefined {
  const mutable = header as { mtimeMs?: unknown; mtime?: unknown };
  const mtime = mutable.mtimeMs ?? mutable.mtime;
  return typeof mtime === "number" ? String(mtime) : undefined;
}

/** Assemble the cold {@link SessionDetail} from a (possibly cached) core. */
function coldDetail(id: string, header: PersistenceHeaderLike, core: ColdDetailCore, archived: ReadonlySet<string>): SessionDetail {
  return {
    id,
    cwd: typeof header.cwd === "string" ? header.cwd : undefined,
    live: false,
    running: false,
    title: core.title,
    blank: core.blank,
    lastPromptAt: core.lastPromptAt,
    eventCount: core.eventCount,
    archived: archived.has(id),
  };
}

/** Max cold-log reads in flight during one roster build (review 🔵-3). */
const COLD_READ_CONCURRENCY = 4;

/** session.list: live + persisted sessions with web-style summary metadata. */
export async function listSessionDetails(ctx: Context): Promise<SessionDetail[]> {
  const live = liveSessions(ctx);
  const archived = new Set(archivedSessionIds(ctx));
  const entries = new Map<string, SessionDetail>();
  for (const [id, session] of live) {
    const meta = scanMeta(session);
    entries.set(id, {
      id,
      cwd: session.header?.cwd,
      live: true,
      running: agentsOf(ctx)?.get(SessionId(id))?.status === "running",
      title: titleFor(ctx, session),
      blank: meta.blank,
      lastPromptAt: meta.lastPromptAt,
      eventCount: meta.eventCount,
      archived: archived.has(id),
    });
  }
  const persistence = persistenceOf(ctx);
  if (persistence) {
    try {
      const headers = await persistence.list();
      // Cache scope: per ctx, invalidated wholesale whenever the persisted
      // roster changes (see ColdDetailCache).
      const signature = headers.map((header) => String(header.id)).join("\n");
      const previous = coldDetailCaches.get(ctx);
      const cache = previous !== undefined && previous.signature === signature
        ? previous
        : { signature, byId: new Map<string, { key: string | undefined; core: ColdDetailCore }>() };
      coldDetailCaches.set(ctx, cache);
      // A session that is live NOW must not keep a cold-cache entry: its log
      // may have grown while resident (resume → work → dispose), and once it
      // goes cold again the next build must re-read instead of serving the
      // pre-live snapshot. Per-id drop only — never fold live ids into the
      // roster signature, or a permanently-live session would keep the whole
      // cache evicted.
      for (const id of live.keys()) cache.byId.delete(id);
      const pending: PersistenceHeaderLike[] = [];
      for (const header of headers) {
        const id = String(header.id);
        if (entries.has(id)) continue;
        const key = coldCacheKey(header);
        const cached = cache.byId.get(id);
        if (cached !== undefined && cached.key === key) {
          entries.set(id, coldDetail(id, header, cached.core, archived));
          continue;
        }
        pending.push(header);
      }
      let cursor = 0;
      const loadCold = async (header: PersistenceHeaderLike): Promise<void> => {
        const id = String(header.id);
        try {
          let session: SessionLike | undefined;
          try {
            const raw = await persistence.readRaw(header.id);
            if (raw !== undefined) {
              const events = raw.events ?? (typeof raw.content === "string" ? parseRawEvents(raw.content) : []);
              session = { id: header.id, events } as SessionLike;
            }
          } catch {
            /* a broken cold log must not hide the rest of the roster */
          }
          if (!session) return;
          const meta = scanMeta(session);
          const core: ColdDetailCore = {
            title: titleFor(ctx, session),
            blank: meta.blank,
            lastPromptAt: meta.lastPromptAt,
            eventCount: meta.eventCount,
          };
          cache.byId.set(id, { key: coldCacheKey(header), core });
          entries.set(id, coldDetail(id, header, core, archived));
        } catch {
          /* defensive: one broken entry must not fail the whole roster */
        }
      };
      // Bounded-concurrency cold reads instead of N sequential read+parse
      // passes. Completion order cannot affect output: the sort below is a
      // total order (unique ids), so the roster comes out byte-identical.
      await Promise.all(Array.from({ length: Math.min(COLD_READ_CONCURRENCY, pending.length) }, async () => {
        while (cursor < pending.length) {
          const header = pending[cursor]!;
          cursor += 1;
          await loadCold(header);
        }
      }));
    } catch {
      /* persistence listing failure degrades to the live roster */
    }
  }
  // Web session.list order: most recently prompted first (`updatedAt desc`),
  // with never-prompted sessions at the bottom in stable id order.
  return [...entries.values()].sort((a, b) => (b.lastPromptAt ?? -Infinity) - (a.lastPromptAt ?? -Infinity) || a.id.localeCompare(b.id));
}

function archivedSessionIds(ctx: Context): string[] {
  const registry = ctx.get("workspaceRegistry") as { archivedSessionIds?: readonly string[] } | undefined;
  return [...(registry?.archivedSessionIds ?? [])].map(String);
}

export function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: string; text?: string } => typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
    .map((block) => block.text ?? "")
    .join(" ")
    .trim();
}

function snippetOf(event: SessionEventLike): string | undefined {
  if (event.type === "user/message" || event.type === "assistant/message") {
    const text = textOfContent((event.data as { content?: unknown } | undefined)?.content);
    if (text) return text;
  }
  if (event.type === "tool/call") {
    const data = event.data as { name?: unknown; arguments?: unknown; args?: unknown } | undefined;
    const name = typeof data?.name === "string" && data.name !== "" ? data.name : "tool";
    const raw = data?.arguments ?? data?.args;
    let detail = "";
    if (typeof raw === "string" && raw.trim() !== "") detail = ` ${raw.trim()}`;
    else if (raw !== undefined) detail = ` ${JSON.stringify(raw)}`;
    return `\u{1F6E0}\uFE0F ${name}${detail}`;
  }
  if (event.type === "tool/result") {
    const text = String((event.data as { output?: unknown } | undefined)?.output ?? "");
    if (text.trim()) return text.trim();
  }
  return undefined;
}

export interface SearchHit {
  sessionId: string;
  seq: number;
  type: string;
  snippet: string;
  live: boolean;
}

/** session.search: scan live logs + persisted logs, web-style snippet cap 240. */
export async function searchSessions(ctx: Context, query: string, limit = 20): Promise<SearchHit[]> {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  const pushHits = (id: string, events: readonly SessionEventLike[], live: boolean) => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const snippet = snippetOf(events[i]);
      if (!snippet || !snippet.toLowerCase().includes(needle)) continue;
      hits.push({ sessionId: id, seq: events[i].seq, type: events[i].type, snippet: snippet.slice(0, 240), live });
      if (hits.length >= limit) return;
    }
  };
  const live = liveSessions(ctx); // one roster snapshot for both scan phases (was computed twice)
  for (const [id, session] of live) {
    if (hits.length >= limit) break; // stop scanning once full — the check used to sit OUTSIDE the live loop
    pushHits(id, session.events, true);
  }
  if (hits.length >= limit) return hits;
  const persistence = persistenceOf(ctx);
  if (persistence) {
    try {
      for (const header of await persistence.list()) {
        if (hits.length >= limit) break; // hoisted BEFORE the read so a full hit list skips the next log entirely
        const id = String(header.id);
        if (live.has(id)) continue;
        try {
          const events = await loadSessionEvents(ctx, id);
          if (events !== undefined) pushHits(id, events, false);
        } catch {
          /* skip unreadable logs */
        }
      }
    } catch {
      /* degrade to live hits */
    }
  }
  return hits;
}

export interface HistoryItem {
  seq: number;
  type: string;
  role: string;
  text: string;
}

/** session.history: read a flat window of events (legacy; prefer readTrajectory). */
export async function readHistory(ctx: Context, sessionId: string, limit = 20, beforeSeq?: number): Promise<HistoryItem[]> {
  const events = (await loadSessionEvents(ctx, sessionId)) ?? [];
  const end = beforeSeq === undefined ? events.length : events.findIndex((e) => e.seq >= beforeSeq);
  const start = Math.max(0, (end === -1 ? events.length : end) - limit);
  const out: HistoryItem[] = [];
  for (const event of events.slice(start, end === -1 ? undefined : end)) {
    const text = snippetOf(event) ?? "";
    let role = event.type;
    if (event.type === "user/message") role = "user";
    else if (event.type === "assistant/message") role = "assistant";
    else if (event.type === "tool/call") role = "tool-call";
    else if (event.type === "tool/result") role = "tool-result";
    out.push({ seq: event.seq, type: event.type, role, text: text.slice(0, 400) });
  }
  return out;
}

export interface TrajectoryStep {
  seq: number;
  kind: "user" | "assistant" | "reasoning" | "tool-call" | "tool-result";
  text: string;
}

export interface TrajectoryTurn {
  startSeq: number;
  endSeq?: number;
  index: number;
  seconds?: number;
  outcome?: string;
  model?: string;
  changes?: string;
  steps: TrajectoryStep[];
}

export interface TrajectoryResult {
  turns: TrajectoryTurn[];
  hasMore: boolean;
  nextBefore?: number;
}

/** session.trajectory: turn-grouped structured view (issue #32). */
export async function readTrajectory(
  ctx: Context,
  sessionId: string,
  maxTurns = 6,
  beforeSeq?: number,
): Promise<TrajectoryResult> {
  const events = (await loadSessionEvents(ctx, sessionId)) ?? [];
  if (events.length === 0) return { turns: [], hasMore: false };

  // Build turns: one turn spans turn/start .. turn/end. Events before the
  // first turn/start form a headless "prelude" turn.
  const rawTurns: { start: number; end: number; startSeq: number; endSeq?: number; headless: boolean }[] = [];
  let openStart: number | undefined;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]!.type === "turn/start") {
      if (openStart !== undefined) rawTurns.push({ start: openStart, end: i, startSeq: events[openStart]!.seq, endSeq: undefined, headless: false });
      openStart = i;
    } else if (events[i]!.type === "turn/end") {
      if (openStart !== undefined) {
        rawTurns.push({ start: openStart, end: i + 1, startSeq: events[openStart]!.seq, endSeq: events[i]!.seq, headless: false });
        openStart = undefined;
      }
    }
  }
  if (openStart !== undefined) rawTurns.push({ start: openStart, end: events.length, startSeq: events[openStart]!.seq, endSeq: undefined, headless: false });

  // Prelude: events before the first turn/start or turn/end.
  const firstAnchor = rawTurns.length > 0 ? rawTurns[0]!.start : events.length;
  if (firstAnchor > 0) {
    rawTurns.unshift({ start: 0, end: firstAnchor, startSeq: events[0]!.seq, endSeq: undefined, headless: true });
  }

  // Paging: take the last `maxTurns` turns whose startSeq < beforeSeq.
  if (beforeSeq !== undefined) {
    const cutoff = rawTurns.findIndex((t) => t.startSeq >= beforeSeq);
    if (cutoff !== -1) rawTurns.splice(cutoff);
  }
  const hasMore = rawTurns.length > maxTurns;
  const page = hasMore ? rawTurns.slice(rawTurns.length - maxTurns) : rawTurns;
  const nextBefore = page.length > 0 ? page[0]!.startSeq : undefined;

  // Build TrajectoryTurn objects. Turn numbers count real turns only (the
  // headless prelude is not Turn 1) and stay stable across paged windows.
  const turns: TrajectoryTurn[] = [];
  const offset = rawTurns.length - page.length;
  const headlessBefore = offset > 0 && rawTurns[0]?.headless === true ? 1 : 0;
  let turnIndex = offset - headlessBefore;
  for (const raw of page) {
    if (!raw.headless) turnIndex += 1;
    const steps: TrajectoryStep[] = [];
    let model: string | undefined;
    let changes: string | undefined;
    let outcome: string | undefined;
    let seconds: number | undefined;
    const startAt = events[raw.start]?.at;
    // rawTurns records the closing turn/end index whenever endSeq is set
    // (`end: i + 1` beside `endSeq: events[i].seq`), so the end timestamp
    // reads by index — the old events.find() was an O(n) seq scan per turn
    // (review 🔵-5). The find() fallback only fires if that invariant above
    // ever changes, keeping the old behavior as a safety net.
    let endAt: number | undefined;
    if (raw.endSeq !== undefined) {
      const closed = events[raw.end - 1];
      endAt = closed !== undefined && closed.seq === raw.endSeq ? closed.at : events.find((e) => e.seq === raw.endSeq)?.at;
    }
    if (startAt !== undefined && endAt !== undefined) seconds = Math.round((endAt - startAt) / 1000);

    for (let i = raw.start; i < raw.end; i += 1) {
      const event = events[i]!;
      if (event.type === "request/header") {
        const header = (event.data as { header?: { config?: { provider?: string; model?: string } } } | undefined)?.header;
        model = header?.config?.provider !== undefined && header.config.model !== undefined
          ? `${header.config.provider}/${header.config.model}`
          : undefined;
        changes = (event.data as { reason?: string } | undefined)?.reason ?? changes;
      } else if (event.type === "turn/end") {
        const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } } | undefined)?.reason;
        if (reason?.kind === "error") {
          outcome = `error: ${reason.error?.message?.slice(0, 50) ?? "unknown"}`;
        } else {
          outcome = reason?.kind ?? "completed";
        }
      } else if (event.type === "user/message") {
        const text = textOfContent((event.data as { content?: unknown } | undefined)?.content);
        if (text) steps.push({ seq: event.seq, kind: "user", text: text.slice(0, 200) });
      } else if (event.type === "assistant/message") {
        const content = (event.data as { message?: { content?: readonly { type?: string; text?: string }[] } } | undefined)?.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "reasoning" && block.text) {
              steps.push({ seq: event.seq, kind: "reasoning", text: block.text.slice(0, 200) });
            } else if (block.type === "text" && block.text) {
              steps.push({ seq: event.seq, kind: "assistant", text: block.text.slice(0, 200) });
            }
          }
        }
      } else if (event.type === "tool/call") {
        const data = event.data as { name?: unknown; arguments?: unknown; args?: unknown } | undefined;
        const name = typeof data?.name === "string" && data.name !== "" ? data.name : "tool";
        const raw = data?.arguments ?? data?.args;
        let detail = "";
        if (typeof raw === "string" && raw.trim() !== "") detail = ` ${raw.trim().slice(0, 80)}`;
        else if (raw !== undefined) detail = ` ${JSON.stringify(raw).slice(0, 80)}`;
        steps.push({ seq: event.seq, kind: "tool-call", text: `${name}${detail}` });
      } else if (event.type === "tool/result") {
        const text = String((event.data as { output?: unknown } | undefined)?.output ?? "");
        if (text.trim()) steps.push({ seq: event.seq, kind: "tool-result", text: text.trim().slice(0, 120) });
      }
    }
    if (raw.headless) {
      turns.push({ startSeq: raw.startSeq, endSeq: raw.endSeq, index: 0, steps });
    } else {
      turns.push({ startSeq: raw.startSeq, endSeq: raw.endSeq, index: turnIndex, seconds, outcome, model, changes, steps });
    }
  }
  return { turns, hasMore, nextBefore };
}
