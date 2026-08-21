/**
 * Session lifecycle and session-domain operations, mirroring the web
 * ApiProxy `sessions` domain (session.list/search/create/history/models/
 * selectModel/rename/fork/prompt/attachment/updateQueue/cancel) over the
 * host seams: ctx.sessions, ctx.agents, ctx.llm, ctx.sessionTitle,
 * ctx.attachments, ctx.agentDefaultModel.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { installModelSelection, type ModelSelectionRef, type AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage, MessageId } from "@deepseek-ai/dsh-llm";
import { SessionId, type Session as DshSession } from "@deepseek-ai/dsh-session";
import { ensureOpencodeGoResponsesRoute, normalizeOpencodeGoModel, opencodeGoModelUsesResponses } from "./opencodeGo.js";
import { fail, ok, type AdapterResult } from "./types.js";

/** One event as read from a live or persisted session log (structural). */
export interface SessionEventLike {
  seq: number;
  type: string;
  at?: number;
  data?: Record<string, unknown>;
}

interface SessionLike {
  id: SessionId;
  events: readonly SessionEventLike[];
  header?: { cwd?: string };
}

interface SessionTitleServiceLike {
  get(session: SessionLike): { title: string; eventSeq: number } | undefined;
  rename(session: SessionLike, title: string): { title: string; eventSeq: number };
}

interface AttachmentRefLike {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

interface AttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<AttachmentRefLike>;
  readImage(ref: AttachmentRefLike): Promise<{ ref: AttachmentRefLike; data: Uint8Array }>;
}

interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string };
  saveSelection(next: { provider: string; model: string; reasoningEffort?: string }): Promise<void>;
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

interface AgentLike {
  id: SessionId;
  session: SessionLike;
  options?: { provider?: string; model?: string };
  status?: string;
}

interface AgentPresetsLike {
  defaultId?: string;
  resolve?(presetId?: string): Promise<{ id: string }>;
  mount(agentCtx: Context, presetId: string): Promise<unknown>;
}

function agentsOf(ctx: Context) {
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

function agentPresetsOf(ctx: Context): AgentPresetsLike | undefined {
  return ctx.get("agentPresets") as AgentPresetsLike | undefined;
}

function sessionTitleService(ctx: Context): SessionTitleServiceLike | undefined {
  return ctx.get("sessionTitle") as SessionTitleServiceLike | undefined;
}

function attachmentsOf(ctx: Context): AttachmentStoreLike | undefined {
  return ctx.get("attachments") as AttachmentStoreLike | undefined;
}

function defaultModelOf(ctx: Context): AgentDefaultModelLike | undefined {
  return ctx.get("agentDefaultModel") as AgentDefaultModelLike | undefined;
}

function persistenceOf(ctx: Context): PersistenceLike | undefined {
  return ctx.get("sessionPersistence") as PersistenceLike | undefined;
}

function sessionsOf(ctx: Context) {
  return ctx.get("sessions") as
    | {
        list(): SessionLike[];
        get(id: SessionId): SessionLike | undefined;
        fork(id: SessionId, boundary: number | undefined, childId: SessionId): SessionLike;
      }
    | undefined;
}

export interface SessionDetail {
  id: string;
  cwd?: string;
  live: boolean;
  running: boolean;
  title?: string;
  blank: boolean;
  lastPromptAt?: number;
  eventCount: number;
  archived: boolean;
}

/** Workspace rows consumed by project grouping (workspace adapter shape). */
export interface ProjectWorkspace {
  workspaceId: string;
  title: string;
  path: string;
  sessionIds: readonly string[];
}

/** One project bucket in the Sessions card: a real Workspace or a cwd-derived
 * pseudo project. Sessions are sorted running-first inside the group. */
export interface ProjectGroup {
  key: string;
  label: string;
  workspaceId?: string;
  path?: string;
  sessions: SessionDetail[];
  runningCount: number;
  latestPromptAt: number;
}

/** Group key for sessions whose header carries no usable cwd. */
export const UNGROUPED_KEY = "__ungrouped__";

/** Directory display basename, matching web `workspaceTitleOf` semantics. */
function pathBasename(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
}

/** Web session-list display title: durable title → cwd basename → raw id. */
export function displayTitleFor(title: string | undefined, cwd: string | undefined, id: string): string {
  if (title !== undefined && title.trim() !== "") return title.trim();
  if (cwd !== undefined && cwd !== "") {
    const base = pathBasename(cwd);
    if (base !== "") return base;
  }
  return id;
}

/** Parent directory basename for same-basename pseudo-project disambiguation. */
function parentBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index <= 0) return "";
  return pathBasename(trimmed.slice(0, index));
}

/** Running sessions first, then most-recently-prompted, then stable id. */
export function sortProjectSessions(details: readonly SessionDetail[]): SessionDetail[] {
  return [...details].sort((a, b) =>
    Number(b.running) - Number(a.running)
    || (b.lastPromptAt ?? Number.NEGATIVE_INFINITY) - (a.lastPromptAt ?? Number.NEGATIVE_INFINITY)
    || a.id.localeCompare(b.id));
}

/**
 * Group sessions into project buckets. Real Workspaces keep their registry
 * title and membership (`sessionIds`); every other session falls into a
 * cwd-derived pseudo project (same basenames are disambiguated), and
 * cwd-less sessions trail under {@link UNGROUPED_KEY}.
 */
export function groupSessionsByProject(
  details: readonly SessionDetail[],
  workspaces: readonly ProjectWorkspace[],
): ProjectGroup[] {
  const groups: ProjectGroup[] = [];
  const byWorkspaceId = new Map<string, ProjectGroup>();
  for (const workspace of workspaces) {
    const label = workspace.title.trim() !== "" ? workspace.title : (pathBasename(workspace.path) || workspace.path);
    const group: ProjectGroup = {
      key: workspace.workspaceId,
      label,
      workspaceId: workspace.workspaceId,
      path: workspace.path,
      sessions: [],
      runningCount: 0,
      latestPromptAt: Number.NEGATIVE_INFINITY,
    };
    groups.push(group);
    byWorkspaceId.set(workspace.workspaceId, group);
  }
  const ownedBySession = new Map<string, ProjectGroup>();
  for (const workspace of workspaces) {
    const group = byWorkspaceId.get(workspace.workspaceId);
    if (group === undefined) continue;
    for (const sessionId of workspace.sessionIds) ownedBySession.set(String(sessionId), group);
  }
  const usedLabels = new Set(groups.map((group) => group.label));
  const pseudo = new Map<string, ProjectGroup>();
  for (const detail of details) {
    let group = ownedBySession.get(detail.id);
    if (group === undefined) {
      const cwd = typeof detail.cwd === "string" ? detail.cwd : "";
      const key = cwd === "" ? UNGROUPED_KEY : cwd;
      group = pseudo.get(key);
      if (group === undefined) {
        const base = cwd === "" ? "" : pathBasename(cwd);
        let label = base === "" ? "\u672A\u5206\u7EC4" : base;
        if (usedLabels.has(label)) {
          const parent = base === "" ? "" : parentBasename(cwd);
          label = parent === "" ? cwd : `${base} (${parent})`;
          if (usedLabels.has(label) && cwd !== "") label = cwd;
        }
        usedLabels.add(label);
        group = {
          key,
          label,
          path: cwd === "" ? undefined : cwd,
          sessions: [],
          runningCount: 0,
          latestPromptAt: Number.NEGATIVE_INFINITY,
        };
        pseudo.set(key, group);
      }
    }
    group.sessions.push(detail);
  }
  for (const group of [...groups, ...pseudo.values()]) {
    group.sessions = sortProjectSessions(group.sessions);
    group.runningCount = group.sessions.filter((session) => session.running).length;
    group.latestPromptAt = group.sessions.reduce(
      (latest, session) => Math.max(latest, session.lastPromptAt ?? Number.NEGATIVE_INFINITY),
      Number.NEGATIVE_INFINITY,
    );
  }
  return [...groups, ...pseudo.values()];
}

/**
 * Project display order: bound running project first, then running projects
 * by recent activity, then the bound project, then everything else by recent
 * activity; the cwd-less bucket is always last.
 */
export function orderProjectGroups(groups: readonly ProjectGroup[], boundSessionId?: string): ProjectGroup[] {
  const rank = (group: ProjectGroup): number => {
    if (group.key === UNGROUPED_KEY) return 4;
    const bound = boundSessionId !== undefined && group.sessions.some((session) => session.id === boundSessionId);
    if (bound && group.runningCount > 0) return 0;
    if (group.runningCount > 0) return 1;
    if (bound) return 2;
    return 3;
  };
  return [...groups].sort((a, b) =>
    rank(a) - rank(b)
    || b.latestPromptAt - a.latestPromptAt
    || a.label.localeCompare(b.label));
}

function liveSessions(ctx: Context): Map<string, SessionLike> {
  const map = new Map<string, SessionLike>();
  const store = sessionsOf(ctx);
  if (!store) return map;
  for (const session of store.list()) map.set(session.id, session as unknown as SessionLike);
  return map;
}

function sessionById(ctx: Context, id: string): SessionLike | undefined {
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
      for (const header of await persistence.list()) {
        const id = String(header.id);
        if (entries.has(id)) continue;
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
        if (!session) continue;
        const meta = scanMeta(session);
        entries.set(id, {
          id,
          cwd: typeof header.cwd === "string" ? header.cwd : undefined,
          live: false,
          running: false,
          title: titleFor(ctx, session),
          blank: meta.blank,
          lastPromptAt: meta.lastPromptAt,
          eventCount: meta.eventCount,
          archived: archived.has(id),
        });
      }
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

function textOfContent(content: unknown): string {
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
  for (const [id, session] of liveSessions(ctx)) pushHits(id, session.events, true);
  if (hits.length >= limit) return hits;
  const persistence = persistenceOf(ctx);
  const live = liveSessions(ctx);
  if (persistence) {
    try {
      for (const header of await persistence.list()) {
        const id = String(header.id);
        if (live.has(id)) continue;
        try {
          const events = await loadSessionEvents(ctx, id);
          if (events !== undefined) pushHits(id, events, false);
        } catch {
          /* skip unreadable logs */
        }
        if (hits.length >= limit) break;
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
    const endAt = raw.endSeq !== undefined ? events.find((e) => e.seq === raw.endSeq)?.at : undefined;
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

/** session.rename over ctx.sessionTitle (the web's exact seam). */
export function renameSession(ctx: Context, sessionId: string, title: string): AdapterResult {
  const session = sessionById(ctx, sessionId);
  if (!session) return fail(`session ${sessionId} is not live (rename needs a live session)`);
  const titles = sessionTitleService(ctx);
  if (!titles) return fail("this profile mounts no session-title service");
  const trimmed = title.trim();
  if (!trimmed) return fail("title must not be blank");
  try {
    const accepted = titles.rename(session, trimmed);
    return ok(`\u270F Renamed to "${accepted.title}"`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** session.fork over ctx.sessions.fork (web semantics: boundary anchors to turn ends). */
export function forkSession(ctx: Context, sessionId: string, atSeq?: number): AdapterResult & { childId?: string } {
  const store = sessionsOf(ctx);
  if (!store) return fail("sessions service is unavailable in this profile");
  try {
    const source = sessionById(ctx, sessionId);
    if (!source) return fail(`session ${sessionId} not found`);
    const events = source.events;
    const lastSeq = events.length ? events[events.length - 1].seq : -1;
    let boundary: number | undefined;
    if (atSeq !== undefined) {
      const found = events.find((e) => e.type === "turn/end" && e.seq >= atSeq);
      if (found) boundary = found.seq;
      else if (atSeq > lastSeq) boundary = [...events].reverse().find((e) => e.type === "turn/end")?.seq;
      if (boundary === undefined) return fail("fork-unavailable: no turn boundary at that position");
    }
    const child = store.fork(SessionId(sessionId), boundary, SessionId(`telegram-${randomUUID()}`));
    return { ok: true, text: `\u{1F500} Forked to ${child.id}`, childId: child.id };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Resume a persisted session as a live agent (session.open equivalent). */
export async function resumeSession(ctx: Context, sessionId: string): Promise<AdapterResult & { agentId?: string; handle?: AgentHandle }> {
  const agents = agentsOf(ctx);
  if (!agents) return fail("agents service is unavailable in this profile");
  try {
    const previous = agents.list()[0];
    const handle = await agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: { provider: previous?.options?.provider, model: previous?.options?.model },
    });
    return { ok: true, text: `\u{1F4C2} Resumed ${handle.agent.id}`, agentId: handle.agent.id, handle };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** session.prompt: route text to queue or steer, mirroring the web modes. */
export function promptSession(ctx: Context, sessionId: string, text: string, mode: "queue" | "steer" | "followup"): AdapterResult {
  const agents = agentsOf(ctx);
  const agent = agents?.get(SessionId(sessionId));
  if (!agent) return fail(`session ${sessionId} has no live agent`);
  const message = createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
  const target = agent as unknown as {
    followup(message: unknown): void;
    send(message: unknown, target: string, wakeup: boolean): void;
    steer(message: unknown): void;
  };
  try {
    if (mode === "steer") target.steer(message);
    else if (mode === "queue") target.send(message, "next-turn", false);
    else target.followup(message);
    return ok(mode === "queue" ? "Queued." : mode === "steer" ? "Steered." : "Delivered.");
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const selections = new Map<string, { ref: ModelSelectionRef; dispose: () => void }>();

/** session.selectModel: per-session ModelSelectionRef + default persistence. */
export async function selectSessionModel(
  ctx: Context,
  sessionId: string,
  provider: string,
  model: string,
  reasoningEffort?: string,
): Promise<AdapterResult> {
  const agents = agentsOf(ctx);
  const agent = agents?.get(SessionId(sessionId));
  if (!agent) return fail(`session ${sessionId} has no live agent`);
  // `ctx.get("llm")`, not `ctx.llm`: this plugin's inject list does not
  // include "llm", and direct property access throws `cannot get property
  // "llm" without inject` in strict Cordis contexts.
  const llm = ctx.get("llm") as unknown as
    | {
        resolveCallConfig(config: {
          provider: string;
          model: string;
          reasoningEffort?: string;
        }): Promise<{ provider: string; model: string; reasoningEffort?: string }>;
      }
    | undefined;
  if (!llm) return fail("llm service is unavailable in this profile");
  try {
    const selected = normalizeOpencodeGoModel(provider, model);
    if (opencodeGoModelUsesResponses(provider, model)) {
      const ready = await ensureOpencodeGoResponsesRoute(ctx, (message, error) => console.error(`[dsh-telegram] ${message}`, error ?? ""));
      if (!ready) {
        return fail(`${selected.provider} route is not registered in the llm registry \u2014 restart dsh so the newly persisted route loads, then tap again`);
      }
    }
    const resolved = await llm.resolveCallConfig({ provider: selected.provider, model: selected.model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
    let entry = selections.get(sessionId);
    if (!entry) {
      const ref: ModelSelectionRef = { current: undefined, assembled: undefined };
      const dispose = installModelSelection((agent as unknown as { ctx: Context }).ctx, ref);
      entry = { ref, dispose };
      selections.set(sessionId, entry);
    }
    entry.ref.current = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort as never }),
    };
    const defaults = defaultModelOf(ctx);
    try {
      await defaults?.saveSelection({
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      });
    } catch {
      /* the switch applies to this session even when the default is not saved */
    }
    return ok(`\u{1F4CE} Model switched to ${resolved.provider}/${resolved.model}`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** session.models.current: the per-session selection or the live agent default. */
export function currentSessionModel(ctx: Context, sessionId: string): { provider?: string; model?: string; reasoningEffort?: string } {
  const entry = selections.get(sessionId);
  if (entry?.ref.current) return entry.ref.current as { provider?: string; model?: string; reasoningEffort?: string };
  const agent = agentsOf(ctx)?.get(SessionId(sessionId));
  if (!agent) return {};
  return { provider: agent.options?.provider, model: agent.options?.model };
}

export interface QueueItem {
  itemId: string;
  target: "next-turn" | "next-step";
  text: string;
}

/** session/queue snapshot (the web's events.mux `session/queue` frame). */
export function listQueue(ctx: Context, sessionId: string): QueueItem[] {
  const agents = agentsOf(ctx);
  const agent = agents?.get(SessionId(sessionId));
  if (!agent) return [];
  const inbox = (agent as unknown as { inbox: { nextTurn: { id: string; content: unknown }[]; nextStep: { id: string; content: unknown }[] } }).inbox;
  const out: QueueItem[] = [];
  for (const message of inbox.nextTurn) out.push({ itemId: message.id, target: "next-turn", text: textOfContent(message.content) });
  for (const message of inbox.nextStep) out.push({ itemId: message.id, target: "next-step", text: textOfContent(message.content) });
  return out;
}

export type QueueAction = { kind: "edit"; content: string } | { kind: "remove" } | { kind: "steer" };

/** session.updateQueue over agent.inbox (exact web semantics). */
export function updateQueueItem(ctx: Context, sessionId: string, itemId: string, action: QueueAction): AdapterResult {
  const agents = agentsOf(ctx);
  const agent = agents?.get(SessionId(sessionId));
  if (!agent) return fail("queue-item-not-found: no live agent");
  const inbox = (agent as unknown as {
    inbox: {
      nextTurn: { id: string; content: unknown }[];
      nextStep: { id: string; content: unknown }[];
      replace(id: string, message: unknown): boolean;
      remove(id: string): boolean;
    };
  }).inbox;
  const target = inbox.nextTurn.some((m) => m.id === itemId) ? "next-turn" : inbox.nextStep.some((m) => m.id === itemId) ? "next-step" : undefined;
  if (target === undefined) return fail("queue-item-not-found: item is no longer pending");
  const message = target === "next-turn" ? inbox.nextTurn.find((m) => m.id === itemId) : inbox.nextStep.find((m) => m.id === itemId);
  if (!message) return fail("queue-item-not-found: item is no longer pending");
  if (action.kind === "steer") {
    const status = (agent as unknown as { status: string }).status;
    if (target !== "next-turn" || status !== "running") return fail("steer-unavailable: current turn no longer accepts steering");
  }
  if (action.kind === "edit") {
    inbox.replace(itemId, { ...message, content: [{ type: "text", text: action.content }] });
  } else {
    inbox.remove(itemId);
    if (action.kind === "steer") (agent as unknown as { steer(message: unknown): void }).steer(message);
  }
  return ok("Queue updated.");
}

/** Durable refs for images this bridge saved; `ctx.attachments.readImage`
 * verifies the exact recorded ref, so a read-back must use the real one. */
const savedAttachments = new Map<string, AttachmentRefLike>();

/** session.attachment admission: promote image bytes, mirroring the web gate. */
export async function saveImageAttachment(
  ctx: Context,
  data: Uint8Array,
  mediaType: string,
  name?: string,
): Promise<AdapterResult & { attachment?: AttachmentRefLike }> {
  const attachments = attachmentsOf(ctx);
  if (!attachments) return fail("attachments service is unavailable in this profile");
  try {
    const ref = await attachments.saveImage({ data, mediaType, ...(name === undefined ? {} : { name }) });
    savedAttachments.set(String(ref.attachmentId), ref);
    if (savedAttachments.size > 500) {
      const oldest = savedAttachments.keys().next().value;
      if (oldest !== undefined) savedAttachments.delete(oldest);
    }
    return { ok: true, text: `\u{1F5BC} Attachment ${ref.attachmentId}`, attachment: ref };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** session.attachment read (base64, same as the web response). The web seam
 * verifies bytes against the exact durable ref, so only attachments this
 * bridge saved can be read back through Telegram. */
export async function readImageAttachment(ctx: Context, attachmentId: string): Promise<AdapterResult & { data?: string; mediaType?: string }> {
  const attachments = attachmentsOf(ctx);
  if (!attachments) return fail("attachments service is unavailable in this profile");
  const ref = savedAttachments.get(attachmentId);
  if (!ref) return fail(`attachment ${attachmentId} was not saved by this bridge (send a photo first)`);
  try {
    const stored = await attachments.readImage(ref);
    return {
      ok: true,
      text: `\u{1F5BC} ${attachmentId} (${stored.data.byteLength} bytes)`,
      data: Buffer.from(stored.data).toString("base64"),
      mediaType: stored.ref.mediaType,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Plugin teardown: drop the in-memory ref registry (durable refs stay). */
export function releaseSavedAttachments(): void {
  savedAttachments.clear();
}

export function releaseModelSelection(sessionId: string): void {
  const entry = selections.get(sessionId);
  if (!entry) return;
  entry.dispose();
  selections.delete(sessionId);
}

export function releaseAllModelSelections(): void {
  for (const [sessionId, entry] of selections) {
    entry.dispose();
    selections.delete(sessionId);
  }
}

export interface CreatedSession {
  result: AdapterResult;
  agentId?: string;
  /** Preset the new session was composed from (web session.create echo). */
  agentPreset?: string;
}

export interface SessionCreateOptions {
  /** Close this previously-owned session after the new one is published. */
  replaceSessionId?: string;
  /** Compose the new agent from this preset (omitted = default preset). */
  agentPreset?: string;
}

/** Session-directory segment encoding (mirrors the JSONL backend's
 * `encodeSegment`: safe path segment, `--` wrapped, separators folded). */
function encodeSegment(text: string): string {
  let readable = "";
  let separatorRun = true;
  for (const ch of text) {
    if (ch === "/" || ch === "\\" || ch === "\u0000") {
      separatorRun = true;
      continue;
    }
    if (separatorRun) {
      readable += "~";
      separatorRun = false;
    }
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** Delete one session entirely: dispose its live agent, drop the in-memory
 * model selection, and remove its durable session directory. There is no web
 * RPC for this — it is a Telegram-side convenience. */
export async function deleteSession(ctx: Context, sessionId: string): Promise<AdapterResult> {
  const agents = agentsOf(ctx);
  const agent = agents?.get(SessionId(sessionId));
  if (agent) {
    await (agent as unknown as { dispose(): Promise<void> }).dispose().catch(() => {});
    releaseModelSelection(sessionId);
  }
  const { dshHome } = await import("./mode.js");
  const root = join(dshHome(), "sessions");
  // Backends have used both `encodeSegment(id)` (wrapped `--…--`) and the raw
  // id as the session directory name; delete whichever one exists.
  const candidates = [...new Set([encodeSegment(sessionId), sessionId])];
  let removed = false;
  try {
    for (const project of await readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      for (const candidate of candidates) {
        const dir = join(root, project.name, candidate);
        if (existsSync(dir)) {
          await rm(dir, { recursive: true, force: true });
          removed = true;
        }
      }
    }
  } catch {
    /* scan errors are non-fatal */
  }
  return ok(`\u{1F5D1} Session ${sessionId} deleted${removed ? "" : " (no stored files)"}.`);
}

/**
 * Owns the agents this plugin created through `/new` so they can be torn down
 * (and persisted by the session-persistence plugins) when their OWN chat
 * replaces them. Creation never disposes a global "previous" agent anymore:
 * chat A's session must survive chat B pressing `✨ New`.
 */
/** Disposing a replaced agent is cleanup, not a user operation: a hung
 * dispose must not wedge the per-chat session-create chain (LOOP_AUDIT #6). */
const AGENT_DISPOSE_TIMEOUT_MS = 10_000;

function disposeWithin(dispose: Promise<unknown>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    dispose.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.error(`[dsh-telegram] ${label} dispose timed out after ${AGENT_DISPOSE_TIMEOUT_MS}ms`);
        resolve();
      }, AGENT_DISPOSE_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export class SessionLifecycle {
  private readonly handles = new Map<string, AgentHandle>();

  /**
   * Create a session, mirroring web `session.create`:
   * - `model` (optional telegram-owned default) overrides the profile default
   *   (`ctx.agentDefaultModel.currentSelection()`), so prompt assembly always
   *   has a `{{model}}` value.
   * - `agentPreset` (optional) is resolved BEFORE the agent exists and mounted
   *   through the creation `setup` hook; the resolved id is recorded on the
   *   session header. Omitted = the roster's default preset (or no setup when
   *   the profile composes no preset roster).
   * - `replaceSessionId` (optional) names the agent THIS chat is leaving; only
   *   that agent is disposed after the new one publishes. Other chats' agents
   *   are never touched.
   */
  async create(
    ctx: Context,
    cwd: string,
    model?: { provider?: string; model?: string },
    options?: SessionCreateOptions,
  ): Promise<CreatedSession> {
    if (!ctx.agents) return { result: fail("agents service is unavailable in this profile") };
    const defaultModel = (
      ctx.get("agentDefaultModel") as { currentSelection(): { provider: string; model: string } } | undefined
    )?.currentSelection();
    const presets = agentPresetsOf(ctx);
    let resolvedPreset: string | undefined;
    let presetSetup: ((agentCtx: Context) => Promise<void>) | undefined;
    if (presets !== undefined) {
      try {
        const resolve = presets.resolve?.bind(presets) ?? ((id?: string) => Promise.resolve({ id: id ?? presets.defaultId ?? "default" }));
        resolvedPreset = (await resolve(options?.agentPreset)).id;
        presetSetup = async (agentCtx: Context) => {
          await presets.mount(agentCtx, resolvedPreset!);
        };
      } catch (err) {
        return { result: fail(err instanceof Error ? err.message : String(err)) };
      }
    } else if (options?.agentPreset !== undefined) {
      return { result: fail("this profile composes no agent presets") };
    }
    try {
      const handle = await ctx.agents.create({
        sessionId: SessionId(`telegram-${randomUUID()}`),
        meta: {
          cwd,
          ...(resolvedPreset === undefined ? {} : { agentPreset: resolvedPreset }),
        },
        agentOptions: {
          provider: model?.provider ?? defaultModel?.provider,
          model: model?.model ?? defaultModel?.model,
        },
        ...(presetSetup === undefined ? {} : { setup: presetSetup }),
      });
      console.error(
        `[dsh-telegram] session create model=${handle.agent.options.model} provider=${handle.agent.options.provider} preset=${resolvedPreset ?? "-"} (telegram config: ${model?.provider ?? "-"}/${model?.model ?? "-"})`,
      );
      this.handles.set(handle.agent.id, handle);
      const replaced = options?.replaceSessionId;
      if (replaced !== undefined && replaced !== handle.agent.id) {
        // close() owns the model-selection release for every destroy path
        // that passes through it.
        await this.close(replaced, ctx).catch((err) => console.error("[dsh-telegram] failed to dispose replaced agent", err));
      }
      return {
        result: ok(`\u2728 New session ${handle.agent.id} in ${cwd}`),
        agentId: handle.agent.id,
        ...(resolvedPreset === undefined ? {} : { agentPreset: resolvedPreset }),
      };
    } catch (err) {
      return { result: fail(err instanceof Error ? err.message : String(err)) };
    }
  }

  /** Resolve a live agent by id (agent id === session id). */
  find(ctx: Context, agentId: string) {
    return ctx.agents?.get(SessionId(agentId));
  }

  /** Track a handle this plugin did not create (e.g. a resumed fork). */
  adopt(handle: AgentHandle): void {
    this.handles.set(handle.agent.id, handle);
  }

  /** Close (dispose) one live agent. Tracked handles are preferred; a live
   * agent this plugin adopted externally falls back to its own dispose. The
   * per-session model selection is released here so every destroy path that
   * funnels through close() drops it exactly once (`releaseModelSelection`
   * is idempotent; deleteSession disposes outside close() and keeps its own
   * release call). */
  async close(agentId: string, ctx?: Context): Promise<AdapterResult> {
    releaseModelSelection(agentId);
    const handle = this.handles.get(agentId);
    if (handle !== undefined) {
      this.handles.delete(agentId);
      await disposeWithin(handle.dispose().catch((err) => console.error("[dsh-telegram] failed to dispose agent", err)), agentId);
      return ok(`\u23F9 Closed ${agentId}`);
    }
    const live = ctx !== undefined ? agentsOf(ctx) : undefined;
    const agent = live?.get(SessionId(agentId));
    if (agent === undefined) return fail(`no disposal handle for agent ${agentId}`);
    await disposeWithin(
      (agent as unknown as { dispose(): Promise<void> }).dispose().catch((err) =>
        console.error("[dsh-telegram] failed to dispose agent", err),
      ),
      agentId,
    );
    return ok(`\u23F9 Closed ${agentId}`);
  }

  /** Cancel the current turn of one agent (defaults to the first live agent).
   * `keepInbox: true` preserves queued messages: only the in-flight turn is
   * aborted, the session and its pending work stay alive. */
  stop(ctx: Context, agentId?: string): AdapterResult {
    const agents = ctx.agents?.list() ?? [];
    const agent = agentId !== undefined ? agents.find((a) => String(a.id) === String(agentId)) : agents[0];
    if (!agent) return agentId === undefined ? ok("Nothing is running.") : fail("no live agent in this session");
    agent.cancel({ kind: "user" }, { keepInbox: true });
    return ok("\u23F9 Stopping the current turn \u2014 queued messages are kept.");
  }

  /** Plugin teardown: dispose every agent this plugin created or adopted. */
  async dispose(): Promise<void> {
    const pending = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(pending.map((handle) => handle.dispose().catch(() => {})));
  }
}

export { MessageId };
