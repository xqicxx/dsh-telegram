/**
 * Session display helpers: durable-title fallback chain, directory basename
 * disambiguation, project grouping, and running-first ordering. Pure
 * functions over plain data — no Context, no services, no I/O — so both the
 * read queries (session-read.ts) and the Telegram cards can consume them
 * without coupling to the host seams.
 */

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
