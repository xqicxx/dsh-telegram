/**
 * Skill domain (web ApiProxy skill.list) over ctx.skills.
 */
import type { Context } from "@deepseek-ai/cordis";

export interface SkillEntry {
  name: string;
  description: string;
  whenToUse?: string;
  source: string;
  provider: string;
  modelInvocable: boolean;
  userInvocable: boolean;
}

interface SkillSummaryLike {
  name: string;
  description: string;
  whenToUse?: string;
  source: string;
  provider: string;
  invocation?: { model?: boolean; user?: boolean } | { modelInvocable?: boolean; userInvocable?: boolean };
}

interface SkillRegistryLike {
  list(options?: Record<string, unknown>): Promise<SkillSummaryLike[]>;
}

function skillsOf(ctx: Context): SkillRegistryLike | undefined {
  return ctx.get("skills") as SkillRegistryLike | undefined;
}

/** Web skill.list request envelope: the session addressing the catalog,
 * the session's project cwd (the host scopes project skills by it), and the
 * invocation scope (`user` = user-invocable entries only, like the web's
 * command palette; omitted = everything). */
export interface SkillListOptions {
  sessionId?: string;
  cwd?: string;
  scope?: string;
}

function normalizeSkillOptions(options?: string | SkillListOptions): SkillListOptions | undefined {
  if (options === undefined) return undefined;
  return typeof options === "string" ? { sessionId: options } : options;
}

export async function listSkills(ctx: Context, options?: string | SkillListOptions): Promise<SkillEntry[]> {
  const skills = skillsOf(ctx);
  if (!skills) return [];
  try {
    // Web skill.list is addressed by session + cwd + scope: the host resolves
    // the session's project root and returns its user-invocable catalog.
    // Structural fallback: registries that take no options still work.
    const normalized = normalizeSkillOptions(options);
    const summaries = await skills.list(normalized === undefined ? undefined : { ...normalized });
    return summaries.map((skill) => {
      const invocation = skill.invocation as { model?: boolean; user?: boolean } | { modelInvocable?: boolean; userInvocable?: boolean } | undefined;
      const modelInvocable =
        "model" in (invocation ?? {}) ? (invocation as { model?: boolean }).model !== false : (invocation as { modelInvocable?: boolean } | undefined)?.modelInvocable ?? true;
      const userInvocable =
        "user" in (invocation ?? {}) ? (invocation as { user?: boolean }).user !== false : (invocation as { userInvocable?: boolean } | undefined)?.userInvocable ?? true;
      return {
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        source: skill.source,
        provider: skill.provider,
        modelInvocable,
        userInvocable,
      };
    });
  } catch {
    return [];
  }
}
