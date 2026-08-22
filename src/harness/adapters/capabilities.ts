/**
 * Capability matrix: probes which web-backing host services are composed.
 * This is a display matrix for the /capabilities card only (plus its
 * missing-services hint) — adapters do NOT consult it first; each one
 * degrades on its own via an optional `ctx.get` lookup when a headless
 * profile lacks a service. CAPABILITY_LABELS is accordingly just an identity
 * map that renders the matrix keys on the card.
 */
import type { Context } from "@deepseek-ai/cordis";

export interface CapabilityMatrix {
  sessions: boolean;
  agents: boolean;
  llm: boolean;
  loader: boolean;
  compaction: boolean;
  commands: boolean;
  goals: boolean;
  messageFeedback: boolean;
  workspaceRegistry: boolean;
  skills: boolean;
  subagents: boolean;
  agentPresets: boolean;
  settings: boolean;
  credentials: boolean;
  approval: boolean;
  userQuestions: boolean;
  sessionTitle: boolean;
  jobs: boolean;
  dynamicCordisRunner: boolean;
  attachments: boolean;
  sessionPersistence: boolean;
  agentDefaultModel: boolean;
}

export function probeCapabilities(ctx: Context): CapabilityMatrix {
  return {
    sessions: ctx.get("sessions") !== undefined,
    agents: ctx.get("agents") !== undefined,
    llm: ctx.get("llm") !== undefined,
    loader: ctx.get("loader") !== undefined,
    compaction: ctx.get("compaction") !== undefined,
    commands: ctx.get("commands") !== undefined,
    goals: ctx.get("goals") !== undefined,
    messageFeedback: ctx.get("messageFeedback") !== undefined,
    workspaceRegistry: ctx.get("workspaceRegistry") !== undefined,
    skills: ctx.get("skills") !== undefined,
    subagents: ctx.get("subagents") !== undefined,
    agentPresets: ctx.get("agentPresets") !== undefined,
    settings: ctx.get("settings") !== undefined,
    credentials: ctx.get("credentials") !== undefined,
    approval: ctx.get("approval") !== undefined,
    userQuestions: ctx.get("userQuestions") !== undefined,
    sessionTitle: ctx.get("sessionTitle") !== undefined,
    jobs: ctx.get("jobs") !== undefined,
    dynamicCordisRunner: ctx.get("dynamicCordisRunner") !== undefined,
    attachments: ctx.get("attachments") !== undefined,
    sessionPersistence: ctx.get("sessionPersistence") !== undefined,
    agentDefaultModel: ctx.get("agentDefaultModel") !== undefined,
  };
}

/** Human-readable labels used by the /capabilities card. */
export const CAPABILITY_LABELS: Readonly<Record<keyof CapabilityMatrix, string>> = {
  sessions: "sessions",
  agents: "agents",
  llm: "llm",
  loader: "loader",
  compaction: "compaction",
  commands: "commands",
  goals: "goals",
  messageFeedback: "messageFeedback",
  workspaceRegistry: "workspaceRegistry",
  skills: "skills",
  subagents: "subagents",
  agentPresets: "agentPresets",
  settings: "settings",
  credentials: "credentials",
  approval: "approval",
  userQuestions: "userQuestions",
  sessionTitle: "sessionTitle",
  jobs: "jobs",
  dynamicCordisRunner: "dynamicCordisRunner",
  attachments: "attachments",
  sessionPersistence: "sessionPersistence",
  agentDefaultModel: "agentDefaultModel",
};

export function missingServices(ctx: Context): string[] {
  const caps = probeCapabilities(ctx);
  return (Object.keys(CAPABILITY_LABELS) as (keyof CapabilityMatrix)[])
    .filter((key) => !caps[key])
    .map((key) => CAPABILITY_LABELS[key]);
}
