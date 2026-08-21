/**
 * Subagent domain (web ApiProxy subagent.list/history/prompt/interrupt) over
 * ctx.subagents.
 */
import type { Context } from "@deepseek-ai/cordis";
import { MessageId } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { fail, ok, type AdapterResult } from "./types.js";
import { readHistory } from "./sessions.js";

export interface SubagentEntry {
  id: string;
  kind: "child" | "diagnostic";
  activity: "running" | "inactive";
  /** One-shot terminal child or resumable conversation (web catalog row). */
  mode?: "one-shot" | "continuable";
  label?: string;
  hasChildren?: boolean;
  reason?: "corrupt" | "unsupported" | "unavailable";
  /** Web catalog row fact: whether the parent session still has a live agent
   * (prompt/interrupt need it). */
  parentAvailable?: boolean;
}

interface AgentLike {
  id: SessionId;
}

interface SubagentListEntryLike {
  kind: "child" | "diagnostic";
  id: SessionId;
  activity?: "running" | "inactive";
  mode?: "one-shot" | "continuable";
  label?: string;
  hasChildren?: boolean;
  reason?: "corrupt" | "unsupported" | "unavailable";
}

interface SubagentRuntimeLike {
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntryLike[]>;
  followup(
    parent: AgentLike,
    childId: SessionId,
    content: unknown[],
    options: { source: { kind: string; clientTimeZone?: string }; signal?: AbortSignal },
  ): Promise<MessageId>;
  interrupt(targetSessionId: SessionId, authority: { kind: string; parentSessionId: SessionId }): void;
}

function subagentsOf(ctx: Context): SubagentRuntimeLike | undefined {
  return ctx.get("subagents") as SubagentRuntimeLike | undefined;
}

export async function listSubagents(ctx: Context, parentSessionId: string): Promise<SubagentEntry[]> {
  const subagents = subagentsOf(ctx);
  if (!subagents) return [];
  // Web subagent.list reports `parentAvailable`: whether the parent session
  // still has a live agent to address prompt/interrupt through.
  const parentAvailable = ctx.agents?.get(SessionId(parentSessionId)) !== undefined;
  try {
    const entries = await subagents.listChildren(SessionId(parentSessionId));
    return entries.map((entry) => ({
      parentAvailable,
      id: entry.id,
      kind: entry.kind,
      // Web api-proxy remaps every child row to the LIVE AGENT status at the
      // host sampling boundary; the durable `entry.activity` snapshot is not
      // what the browser catalog exposes.
      activity: ctx.agents?.get(entry.id)?.status === "running" ? "running" : "inactive",
      ...(entry.mode === undefined ? {} : { mode: entry.mode }),
      ...(entry.label === undefined ? {} : { label: entry.label }),
      ...(entry.hasChildren === undefined ? {} : { hasChildren: entry.hasChildren }),
      ...(entry.kind === "diagnostic" ? { reason: entry.reason ?? "unavailable" } : {}),
    }));
  } catch {
    return [];
  }
}

export function subagentHistory(ctx: Context, childSessionId: string, limit = 20) {
  return readHistory(ctx, childSessionId, limit);
}

export async function promptSubagent(
  ctx: Context,
  parentSessionId: string,
  childSessionId: string,
  text: string,
  options?: { clientTimeZone?: string; signal?: AbortSignal },
): Promise<AdapterResult> {
  const subagents = subagentsOf(ctx);
  if (!subagents) return fail("subagents service is unavailable in this profile");
  const parent = ctx.agents?.get(SessionId(parentSessionId));
  if (!parent) return fail(`parent session ${parentSessionId} has no live agent`);
  // Web contract: only continuable child subagents accept prompts. Verify
  // against the live catalog instead of trusting the caller.
  let children: SubagentListEntryLike[];
  try {
    children = await subagents.listChildren(SessionId(parentSessionId));
  } catch (err) {
    return fail(`subagent catalog is unavailable \u2014 cannot verify ${childSessionId} is continuable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entry = children.find((candidate) => String(candidate.id) === childSessionId);
  if (entry === undefined) return fail(`subagent ${childSessionId} is not listed under parent ${parentSessionId}`);
  if (entry.kind !== "child" || entry.mode !== "continuable") {
    return fail("subagent-prompt-locked: only continuable child subagents accept prompts");
  }
  try {
    const clientTimeZone = options?.clientTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const signal = options?.signal ?? new AbortController().signal;
    const messageId = await subagents.followup(parent as unknown as AgentLike, SessionId(childSessionId), [{ type: "text", text }], {
      source: { kind: "user", ...(clientTimeZone === undefined ? {} : { clientTimeZone }) },
      signal,
    });
    return ok(`\u{1F4E8} Delivered to subagent ${childSessionId} (${String(messageId)})`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export function interruptSubagent(ctx: Context, parentSessionId: string, childSessionId: string): AdapterResult {
  const subagents = subagentsOf(ctx);
  if (!subagents) return fail("subagents service is unavailable in this profile");
  try {
    subagents.interrupt(SessionId(childSessionId), { kind: "user", parentSessionId: SessionId(parentSessionId) });
    return ok(`\u23F9 Interrupting ${childSessionId}\u2026`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
