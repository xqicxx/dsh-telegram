/**
 * Stateful session operations, mirroring the web ApiProxy `sessions` domain
 * (session.create/rename/fork/prompt/models/selectModel/attachment/
 * updateQueue + the Telegram-side delete) over the host seams: ctx.agents,
 * ctx.llm, ctx.attachments, ctx.agentDefaultModel, and the agent-preset
 * roster. Read-only queries live in session-read.ts; pure display helpers in
 * session-render.ts; sessions.ts re-exports the whole family.
 *
 * Destruction trunk: the tracked agent handles, the per-session model
 * selections, and the saved-attachment refs are module-level registries.
 * Every destroy path — SessionLifecycle.close, deleteSession, and plugin
 * teardown — funnels through the same release calls (🟠-14).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { installModelSelection, type ModelSelectionRef, type AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { agentsOf, sessionById, sessionTitleService, sessionsOf, textOfContent } from "./session-read.js";
import { ensureOpencodeGoResponsesRoute, normalizeOpencodeGoModel, opencodeGoModelUsesResponses } from "./opencodeGo.js";
import { fail, ok, type AdapterResult } from "./types.js";

export interface AttachmentRefLike {
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

interface AgentPresetsLike {
  defaultId?: string;
  resolve?(presetId?: string): Promise<{ id: string }>;
  mount(agentCtx: Context, presetId: string): Promise<unknown>;
}

function agentPresetsOf(ctx: Context): AgentPresetsLike | undefined {
  return ctx.get("agentPresets") as AgentPresetsLike | undefined;
}

function attachmentsOf(ctx: Context): AttachmentStoreLike | undefined {
  return ctx.get("attachments") as AttachmentStoreLike | undefined;
}

function defaultModelOf(ctx: Context): AgentDefaultModelLike | undefined {
  return ctx.get("agentDefaultModel") as AgentDefaultModelLike | undefined;
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

export interface QueueItem {
  itemId: string;
  target: "next-turn" | "next-step";
  text: string;
}

export type QueueAction = { kind: "edit"; content: string } | { kind: "remove" } | { kind: "steer" };

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

/** Resume a persisted session as a live agent (session.open equivalent).
 * `inheritFrom` names the live agent whose provider/model the resumed agent
 * inherits. Without it the source is only resolvable when exactly ONE live
 * agent exists: among several, defaulting to list()[0] could inherit another
 * chat's model, so the request fails instead of guessing (🟠-17). */
export async function resumeSession(
  ctx: Context,
  sessionId: string,
  inheritFrom?: string,
): Promise<AdapterResult & { agentId?: string; handle?: AgentHandle }> {
  const agents = agentsOf(ctx);
  if (!agents) return fail("agents service is unavailable in this profile");
  try {
    const live = agents.list();
    const previous = inheritFrom !== undefined
      ? live.find((agent) => String(agent.id) === String(inheritFrom)) ?? agents.get?.(SessionId(inheritFrom))
      : live.length === 1 ? live[0] : undefined;
    if (inheritFrom !== undefined && previous === undefined) {
      return fail(`cannot inherit provider/model: ${inheritFrom} has no live agent`);
    }
    if (previous === undefined && live.length > 1) {
      return fail(`${live.length} live sessions are running \u2014 cannot tell whose provider/model to inherit`);
    }
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

export interface CreatedSession {
  result: AdapterResult;
  agentId?: string;
  /** Preset the new session was composed from (web session.create echo). */
  agentPreset?: string;
  /** True when no session was created because the chat already had a live
   * one (onlyIfUnbound short-circuit): the requested model was NOT applied
   * to any session, so callers must not treat this as "model set". */
  reusedLive?: boolean;
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

/** Destruction trunk for agent handles this plugin created or adopted. One
 * SessionLifecycle instance exists per process (index.ts), so the registry
 * lives beside `selections`/`savedAttachments` at module level and
 * close()/deleteSession()/teardown share ONE bookkeeping table — deleteSession
 * must never leave handle residue behind (🟠-14). */
const handles = new Map<string, AgentHandle>();

/** Claim and drop the tracked handle for `agentId`, if any. */
function takeTrackedHandle(agentId: string): AgentHandle | undefined {
  const handle = handles.get(agentId);
  if (handle !== undefined) handles.delete(agentId);
  return handle;
}

/** Delete one session entirely: dispose its live agent, drop the in-memory
 * model selection, and remove its durable session directory. There is no web
 * RPC for this — it is a Telegram-side convenience. */
export async function deleteSession(ctx: Context, sessionId: string): Promise<AdapterResult> {
  // 🟠-14: disposal funnels through SessionLifecycle's own bookkeeping —
  // claim the tracked handle first (so plugin teardown sees no residue) and
  // dispose it through the same guarded path as close(); only untracked
  // agents fall back to the registry dispose. The model selection is
  // released unconditionally (`releaseModelSelection` is idempotent), which
  // also cleans the leak left when the agent is already gone.
  const tracked = takeTrackedHandle(sessionId);
  if (tracked !== undefined) {
    await disposeWithin(tracked.dispose().catch((err) => console.error("[dsh-telegram] failed to dispose agent", err)), sessionId);
  } else {
    const agent = agentsOf(ctx)?.get(SessionId(sessionId));
    if (agent) {
      await (agent as unknown as { dispose(): Promise<void> }).dispose().catch(() => {});
    }
  }
  releaseModelSelection(sessionId);
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

export class SessionLifecycle {
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
      handles.set(handle.agent.id, handle);
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
    handles.set(handle.agent.id, handle);
  }

  /** Close (dispose) one live agent. Tracked handles are preferred; a live
   * agent this plugin adopted externally falls back to its own dispose. The
   * per-session model selection is released here so every destroy path that
   * funnels through close() drops it exactly once (`releaseModelSelection`
   * is idempotent; deleteSession claims the tracked handle through the same
   * trunk and releases the selection itself). */
  async close(agentId: string, ctx?: Context): Promise<AdapterResult> {
    releaseModelSelection(agentId);
    const handle = takeTrackedHandle(agentId);
    if (handle !== undefined) {
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

  /** Cancel the current turn of one agent (defaults to the only live agent).
   * `keepInbox: true` preserves queued messages: only the in-flight turn is
   * aborted, the session and its pending work stay alive. With several live
   * agents the default is refused — cancelling list()[0] could kill another
   * chat's turn (🟠-17). */
  stop(ctx: Context, agentId?: string): AdapterResult {
    const agents = ctx.agents?.list() ?? [];
    const agent = agentId !== undefined
      ? agents.find((a) => String(a.id) === String(agentId))
      : agents.length === 1 ? agents[0] : undefined;
    if (!agent) {
      if (agentId !== undefined) return fail("no live agent in this session");
      if (agents.length > 1) return fail(`${agents.length} live sessions are running \u2014 stop needs an explicit session id`);
      return ok("Nothing is running.");
    }
    agent.cancel({ kind: "user" }, { keepInbox: true });
    return ok("\u23F9 Stopping the current turn \u2014 queued messages are kept.");
  }

  /** Plugin teardown: dispose every agent this plugin created or adopted. */
  async dispose(): Promise<void> {
    const pending = [...handles.values()];
    handles.clear();
    await Promise.all(pending.map((handle) => handle.dispose().catch(() => {})));
  }
}
