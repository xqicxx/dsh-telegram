/**
 * Manual compaction through the host-provided `ctx.compaction` engine — the
 * exact seam `/compact` uses, so behavior stays consistent with the harness.
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-compaction";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import { fail, ok, type AdapterResult } from "./types.js";

/** Manual compaction summarizes long histories, so it gets real room — but a
 * hung compaction engine must not suspend Telegram command processing forever
 * (the AbortController used to never fire). Same race shape as host.ts's
 * withFsTimeout; the controller is also aborted so signal-aware engines stop
 * their work immediately. */
const COMPACT_TIMEOUT_MS = 120_000;

export async function compactCurrent(ctx: Context, agentId?: string): Promise<AdapterResult> {
  const agents = ctx.agents?.list() ?? [];
  const agent = agentId !== undefined ? agents.find((a) => a.id === agentId) : agents[0];
  if (!agent) return fail("No live agent in this session.");
  if (agent.status !== "idle") return fail("The agent is busy \u2014 compacting is only available while it is idle.");
  if (!ctx.compaction) return fail("The compaction service is unavailable in this profile.");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      ctx.compaction.compactNow(agent, controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`compaction timed out after ${COMPACT_TIMEOUT_MS}ms`);
          controller.abort(err);
          reject(err);
        }, COMPACT_TIMEOUT_MS);
      }),
    ]);
    if (result === null) return ok("No compactable history yet.");
    return ok(`\u{1F9F9} Compacted ${result.shadowedSeqs.length} items (~${result.shadowedTokenCount} tokens).`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
