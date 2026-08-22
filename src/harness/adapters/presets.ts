/**
 * Agent preset domain (web ApiProxy agentPreset.list/select/read/copy/
 * openDocument/remove) over ctx.agentPresets.
 */
import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { deleteSession, forkSession, resumeSession } from "./sessions.js";
import { fail, ok, type AdapterResult } from "./types.js";

export interface AgentPresetEntry {
  id: string;
  trust: "system" | "user";
  isDefault: boolean;
  name?: string;
  description?: string;
  broken?: string;
}

interface PresetLike {
  id: string;
  trust: "system" | "user";
  name?: string;
  description?: string;
  broken?: string;
}

interface AgentPresetsLike {
  defaultId?: string;
  authorable?: boolean;
  hasDocument?: boolean;
  list(): Promise<PresetLike[]>;
  read(id: string): Promise<string>;
  copy(from: string, id: string, name?: string): Promise<void>;
  remove(id: string): Promise<void>;
  mount(agentCtx: Context, id?: string): Promise<unknown>;
  /** Re-bind an existing scope link (repeat-safe) — web ApiProxy uses this. */
  recompose(agentCtx: Context, id?: string): Promise<unknown>;
}

function presetsOf(ctx: Context): AgentPresetsLike | undefined {
  return ctx.get("agentPresets") as AgentPresetsLike | undefined;
}

export async function listAgentPresets(ctx: Context): Promise<{ presets: AgentPresetEntry[]; authorable: boolean; hasDocument: boolean }> {
  const presets = presetsOf(ctx);
  if (!presets) return { presets: [], authorable: false, hasDocument: false };
  try {
    const defaultId = presets.defaultId;
    return {
      presets: (await presets.list()).map((preset) => ({
        id: preset.id,
        trust: preset.trust,
        isDefault: preset.id === defaultId,
        ...(preset.name === undefined ? {} : { name: preset.name }),
        ...(preset.description === undefined ? {} : { description: preset.description }),
        ...(preset.broken === undefined ? {} : { broken: preset.broken }),
      })),
      authorable: presets.authorable ?? false,
      hasDocument: presets.hasDocument ?? false,
    };
  } catch {
    return { presets: [], authorable: false, hasDocument: false };
  }
}

/** agentPreset.select — allowed only while the session is blank. */
export function selectAgentPreset(ctx: Context, sessionId: string, presetId: string): Promise<AdapterResult> {
  const presets = presetsOf(ctx);
  if (!presets) return Promise.resolve(fail("this profile composes no agent presets"));
  const agent = ctx.agents?.get(SessionId(sessionId));
  if (!agent) return Promise.resolve(fail(`session ${sessionId} has no live agent`));
  const events = (agent as unknown as { session?: { events?: readonly { type: string }[] } }).session?.events;
  // A malformed live agent (no readable event log) must fail like every
  // sibling adapter instead of throwing synchronously out of the boundary.
  if (!Array.isArray(events)) {
    return Promise.resolve(fail(`session ${sessionId} exposes no readable event log \u2014 cannot verify it is blank`));
  }
  if (events.some((event) => event.type === "turn/start")) {
    return Promise.resolve(fail("agent-preset-locked: presets can only be selected while the session is blank"));
  }
  // Invoked lazily so even a synchronous throw from a malformed seam lands
  // in the catch below as a clean AdapterResult failure.
  return Promise.resolve()
    .then(() => presets.recompose((agent as unknown as { ctx: Context }).ctx, presetId))
    .then((installed) => {
      const preset = installed as { id: string };
      // Recorded only after the swap committed: the log states what the
      // agent runs, and a rejected mount leaves the previous composition.
      ((agent as unknown as { session: { append(type: string, data: Record<string, unknown>): void } }).session).append("agent-preset/selected", {
        agentPreset: preset.id,
      });
      return ok(`\u{1F3AD} Preset ${presetId} selected`);
    })
    .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
}

/** The latest completed-turn boundary of a live session, if any. */
function lastTurnEndSeq(agent: { session: { events: readonly { seq: number; type: string }[] } }): number | undefined {
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index];
    if (event !== undefined && event.type === "turn/end") return event.seq;
  }
  return undefined;
}

/** Whether the session has already produced a turn (web's sessionBlank inverse). */
export function sessionHasStarted(ctx: Context, sessionId: string): boolean {
  const agent = ctx.agents?.get(SessionId(sessionId));
  const events = (agent as unknown as { session?: { events: readonly { type: string }[] } } | undefined)?.session?.events ?? [];
  return events.some((event) => event.type === "turn/start");
}

/**
 * Mid-session preset switch: fork the source session through its last
 * completed turn, resume the fork as a live agent, re-link the fork to the
 * new preset, and record the selection. The CALLER closes the original
 * session and re-binds the chat to the returned child id. The blank-check
 * is deliberately bypassed here — dsh's recompose leaves that check to the
 * caller, and this is the caller's documented mid-conversation escape hatch
 * (history moves to the fork; the original is closed, so no conversation
 * continues under the old toolset).
 */
export async function switchAgentPresetMidSession(
  ctx: Context,
  sourceSessionId: string,
  presetId: string,
): Promise<AdapterResult & { childId?: string; handle?: unknown }> {
  const presets = presetsOf(ctx);
  if (!presets) return fail("this profile composes no agent presets");
  const source = ctx.agents?.get(SessionId(sourceSessionId));
  if (!source) return fail(`session ${sourceSessionId} has no live agent`);
  const boundary = lastTurnEndSeq(source as unknown as { session: { events: readonly { seq: number; type: string }[] } });
  if (boundary === undefined) return fail("the current turn has not finished — wait for it to end, then switch again");
  const fork = forkSession(ctx, sourceSessionId, boundary);
  if (!fork.ok || fork.childId === undefined) return fail(fork.text);
  const childId = fork.childId;
  // From here on, a failed switch must not strand the freshly forked child:
  // nobody re-binds a chat to it, so its durable record would linger forever
  // as an orphan session. Rollback is best-effort (dispose + record removal)
  // and never replaces the original failure as the reported outcome.
  const discardOrphanFork = async (): Promise<void> => {
    try {
      await deleteSession(ctx, childId);
    } catch {
      /* rollback is best-effort */
    }
  };
  // Inherit the SOURCE session's provider/model explicitly: letting the
  // resume fall back to "the only/first live agent" could pick another
  // chat's model in multi-chat rosters (🟠-17).
  const resumed = await resumeSession(ctx, childId, sourceSessionId);
  if (!resumed.ok || resumed.agentId === undefined) {
    await discardOrphanFork();
    return fail(`forked to ${childId}, but resuming it failed: ${resumed.text}`);
  }
  const disposeHandle = (handle: unknown) => {
    const candidate = handle as { dispose?: () => unknown } | undefined;
    try {
      void candidate?.dispose?.();
    } catch {
      /* already disposed */
    }
  };
  const child = ctx.agents?.get(SessionId(resumed.agentId));
  if (!child) {
    disposeHandle(resumed.handle);
    await discardOrphanFork();
    return fail(`forked agent ${resumed.agentId} is not live after resume`);
  }
  try {
    const installed = (await presets.recompose((child as unknown as { ctx: Context }).ctx, presetId)) as { id: string };
    ((child as unknown as { session: { append(type: string, data: Record<string, unknown>): void } }).session).append("agent-preset/selected", {
      agentPreset: installed.id,
    });
  } catch (err) {
    disposeHandle(resumed.handle);
    await discardOrphanFork();
    return fail(err instanceof Error ? err.message : String(err));
  }
  return {
    ok: true,
    text: `\u{1F3AD} Preset ${presetId} applied to forked session ${resumed.agentId}`,
    childId: resumed.agentId,
    handle: resumed.handle,
  };
}

export async function readAgentPreset(ctx: Context, presetId: string): Promise<AdapterResult & { content?: string }> {
  const presets = presetsOf(ctx);
  if (!presets) return fail("this profile composes no agent presets");
  try {
    const content = await presets.read(presetId);
    return { ok: true, text: `\u{1F4C4} ${presetId}`, content };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function copyAgentPreset(ctx: Context, from: string, presetId: string, name?: string): Promise<AdapterResult> {
  const presets = presetsOf(ctx);
  if (!presets) return fail("this profile composes no agent presets");
  try {
    await presets.copy(from, presetId, name);
    return ok(`\u{1F4CB} Copied to ${presetId}`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function removeAgentPreset(ctx: Context, presetId: string): Promise<AdapterResult> {
  const presets = presetsOf(ctx);
  if (!presets) return fail("this profile composes no agent presets");
  try {
    await presets.remove(presetId);
    return ok(`\u{1F5D1} Preset ${presetId} removed`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Set the agent-presets settings default: applied to NEW sessions only. */
export async function setDefaultAgentPreset(ctx: Context, presetId: string): Promise<AdapterResult> {
  const settings = ctx.get("settings") as
    | {
        mutate(
          ns: string,
          ops: readonly { op: "set" | "unset"; path: string[]; value?: unknown }[],
          expectedRevision?: number,
        ): Promise<void>;
      }
    | undefined;
  if (!settings) return fail("settings service is unavailable in this profile");
  try {
    await settings.mutate("agent-presets", [{ op: "set", path: ["default"], value: presetId }]);
    return ok(`\u2B50 Default preset set to ${presetId} \u2014 new sessions will use it.`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** agentPreset.openDocument: no native opener on a phone — give the directory hint. */
export function openAgentPresetDocument(ctx: Context, presetId: string): AdapterResult {
  const presets = presetsOf(ctx);
  if (!presets) return fail("this profile composes no agent presets");
  return ok(`\u{1F4C2} Edit ${presetId} on the host: the preset directory is owned by the agent-presets roots (open it in the web UI or on the host filesystem).`);
}
