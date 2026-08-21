/**
 * Goal domain (web ApiProxy goal.* six methods) over ctx.goals.
 */
import type { Context } from "@deepseek-ai/cordis";
import { fail, ok, type AdapterResult } from "./types.js";

export interface GoalView {
  id: string;
  revision: number;
  objective: string;
  maxGoalRounds?: number;
  phase: "active" | "paused" | "blocked" | "complete";
  activation: "armed" | "disarmed";
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
}

interface AgentLike {
  id: string;
}

interface GoalServiceLike {
  get(agent: AgentLike): GoalView | undefined;
  create(agent: AgentLike, request: { objective: string; maxGoalRounds?: number }): GoalView;
  edit(agent: AgentLike, ref: { id: string; revision: number }, request: { objective?: string; maxGoalRounds?: number }): GoalView;
  pause(agent: AgentLike, ref: { id: string; revision: number }): GoalView;
  resume(agent: AgentLike, ref: { id: string; revision: number }): GoalView;
  complete(agent: AgentLike, ref: { id: string; revision: number }): GoalView;
  clear(agent: AgentLike, ref: { id: string; revision: number }): { id: string; revision: number };
}

function goalsOf(ctx: Context): GoalServiceLike | undefined {
  return ctx.get("goals") as GoalServiceLike | undefined;
}

/** Resolve the current goal for one exact live agent. */
export function getGoal(ctx: Context, agentId: string): GoalView | undefined {
  const goals = goalsOf(ctx);
  if (!goals) return undefined;
  const agent = ctx.agents?.get(agentId as never);
  if (!agent) return undefined;
  try {
    return goals.get(agent as unknown as AgentLike) ?? undefined;
  } catch {
    return undefined;
  }
}

function run(ctx: Context, agentId: string, fn: (goals: GoalServiceLike, agent: AgentLike) => GoalView | { id: string; revision: number }): AdapterResult & { goal?: GoalView } {
  const goals = goalsOf(ctx);
  if (!goals) return fail("goals service is unavailable in this profile");
  const agent = ctx.agents?.get(agentId as never);
  if (!agent) return fail("no live agent in this session");
  try {
    const result = fn(goals, agent as unknown as AgentLike);
    return { ok: true, text: renderGoal(result), goal: "phase" in result ? result : undefined };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function renderGoal(goal: { id: string; revision: number } | GoalView): string {
  if (!("objective" in goal)) return `\u{1F5D1} Goal cleared (revision ${goal.revision})`;
  return `\u{1F3AF} Goal ${goal.phase}/${goal.activation} \u00B7 ${goal.objective.slice(0, 80)}`;
}

export function createGoal(ctx: Context, agentId: string, objective: string, maxGoalRounds?: number) {
  const trimmed = objective.trim();
  if (!trimmed) return Promise.resolve(fail("goal objective must not be blank"));
  return Promise.resolve(run(ctx, agentId, (goals, agent) => goals.create(agent, { objective: trimmed, ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }) })));
}

export function editGoal(ctx: Context, agentId: string, id: string, revision: number, request: { objective?: string; maxGoalRounds?: number }) {
  return Promise.resolve(run(ctx, agentId, (goals, agent) => goals.edit(agent, { id, revision }, request)));
}

export function pauseGoal(ctx: Context, agentId: string, id: string, revision: number) {
  return Promise.resolve(run(ctx, agentId, (goals, agent) => goals.pause(agent, { id, revision })));
}

export function resumeGoal(ctx: Context, agentId: string, id: string, revision: number) {
  return Promise.resolve(run(ctx, agentId, (goals, agent) => goals.resume(agent, { id, revision })));
}

export function clearGoal(ctx: Context, agentId: string, id: string, revision: number) {
  return Promise.resolve(run(ctx, agentId, (goals, agent) => goals.clear(agent, { id, revision })));
}
