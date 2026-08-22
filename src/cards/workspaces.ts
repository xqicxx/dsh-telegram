/**
 * Workspace / project-picker cards for dsh-telegram.
 *
 * The workspace browser (openWorkspacesCard), per-workspace detail
 * (openWorkspaceDetailCard), the codex-style inline project folder picker
 * (openProjectCard + joinPath), the validate/persist/register step behind it
 * (applyProjectPath) and the workspace-create directory picker
 * (openWorkspaceCreatePicker).
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object so this module owns no mutable wiring of
 * its own.
 */
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { TelegramConfig } from "../config.js";
import { writeConfig } from "../config.js";
import { listWorkspaces } from "../harness/adapters/workspace.js";
import { isDirectory, listDirectory, parentOf } from "../harness/adapters/host.js";
import { plain, truncate } from "../telegram/html.js";
import { bold, headerLine, metaJoin, mono, relTime } from "../telegram/ui.js";
import { buildProjectKeyboard, buildWorkspaceDetailKeyboard, buildWorkspaceKeyboard } from "../telegram/keyboard.js";
import type { TelegramTransport } from "../telegram/transport.js";
import type { OpenCard } from "../core/cards.js";

/** Structural slice of the plugin-root state singleton this module reads and
 * mutates: applyProjectPath reassigns the active project root, persists the
 * config to disk and registers the folder with the workspace registry. */
interface WorkspaceCardsStateSlice {
  /** Active project folder — new sessions are created under it. */
  workspaceRoot: string;
  /** Boot workspace that owns `.pi/telegram.json` (config never moves). */
  configRoot: string;
  /** Live config; applyProjectPath writes workspace.activePath. */
  config: TelegramConfig;
}

export interface WorkspaceCardsDeps {
  state: WorkspaceCardsStateSlice;
  requireCtx(): Context;
  uiSend(chatId: number, text: string, options?: Parameters<TelegramTransport["sendText"]>[2]): Promise<number | undefined>;
  openCard: OpenCard;
  token(payload: Record<string, string>, chatId?: number): string;
  log(message: string, error?: unknown): void;
  openMenuAt(chatId: number, page: number): Promise<void>;
}

/** Build the workspace-domain cards. Called once by index.ts; every card
 * closes over the shared deps like the previous module-scope closures did
 * over index.ts singletons. */
export function createWorkspaceCards(deps: WorkspaceCardsDeps): {
  openWorkspacesCard(chatId: number): Promise<void>;
  openWorkspaceDetailCard(chatId: number, workspaceId: string): Promise<void>;
  openProjectCard(chatId: number, target?: string, offset?: number): Promise<void>;
  applyProjectPath(chatId: number, raw: string): Promise<void>;
  openWorkspaceCreatePicker(chatId: number, path: string, offset?: number): Promise<void>;
} {
  const { state, requireCtx, uiSend, openCard, token, log, openMenuAt } = deps;

  async function openWorkspacesCard(chatId: number): Promise<void> {
    log(`workspaces card open requested chatId=${chatId}`);
    try {
      const listed = listWorkspaces(requireCtx());
      const items = listed.items;
      const archivedSessionIds = listed.archivedSessionIds;
      log(`workspaces listed items=${items.length} archived=${archivedSessionIds.length}`);
      // Design language: bold header + count, bold workspace titles with an
      // indented mono path/sessions line beneath.
      const lines = [headerLine("\u{1F5C2}\uFE0F", "Workspaces", `${items.length}`), ""];
      for (const workspace of items.slice(0, 15)) {
        const title = typeof workspace.title === "string" && workspace.title !== "" ? workspace.title : basename(workspace.path || "workspace");
        lines.push(`\u2022 ${bold(truncate(title, 28))}`);
        lines.push(metaJoin(`  ${mono(truncate(workspace.path, 24))}`, `${workspace.sessionIds.length} sessions`, mono(truncate(workspace.workspaceId, 20))));
      }
      if (items.length === 0) {
        lines.push(`\u2022 Current project: ${mono(truncate(state.workspaceRoot, 48))}`);
        lines.push("No registered workspaces yet \u2014 /workspacecreate &lt;path&gt; [title], or use Project to register this one.");
      }
      if (archivedSessionIds.length > 0) lines.push("", `\u{1F5C4} Archived sessions: ${archivedSessionIds.length}`);
      log(`workspaces card rendering lines=${lines.length}`);
      await openCard(
        chatId,
        lines.join("\n"),
        buildWorkspaceKeyboard(items.map((workspace) => ({ id: workspace.workspaceId, title: typeof workspace.title === "string" ? workspace.title : basename(workspace.path || "workspace") }))),
        () => openWorkspacesCard(chatId),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`workspaces card ERROR chatId=${chatId}: ${message}`);
      await openCard(
        chatId,
        `\u{1F5C2} Workspaces\n\n\u26A0\uFE0F ${plain(truncate(message, 120))}`,
        buildWorkspaceKeyboard([]),
        () => openWorkspacesCard(chatId),
      );
    }
  }

  async function openWorkspaceDetailCard(chatId: number, workspaceId: string): Promise<void> {
    const { items } = listWorkspaces(requireCtx());
    const workspace = items.find((candidate) => candidate.workspaceId === workspaceId);
    if (!workspace) return openWorkspacesCard(chatId);
    // Design language: bold title header, mono id subtitle, quiet kv rows;
    // timestamps render as client-localized relative time.
    const lines = [
      headerLine("\u{1F5C2}\uFE0F", truncate(workspace.title, 40)),
      mono(workspace.workspaceId),
      "",
      metaJoin("path", mono(truncate(workspace.path, 60))),
      metaJoin(
        `sessions ${workspace.sessionIds.length}`,
        workspace.sessionIds.length > 0 ? mono(workspace.sessionIds.slice(0, 6).map((id) => truncate(id, 16)).join(",")) + (workspace.sessionIds.length > 6 ? "\u2026" : "") : undefined,
      ),
      workspace.createdAt !== undefined ? `created ${relTime(workspace.createdAt, "unknown")}` : "",
      workspace.updatedAt !== undefined ? `updated ${relTime(workspace.updatedAt, "unknown")}` : "",
    ].filter((line) => line !== "");
    await openCard(chatId, lines.join("\n"), buildWorkspaceDetailKeyboard(workspaceId, {
      use: token({ action: "workspace-use", workspaceId }, chatId),
      sessions: token({ action: "sessions-project", projectKey: workspaceId }, chatId),
    }));
  }

  /** Codex-style project picker: browse folders inline, then use one as the
   * active project for all new sessions. */
  const PROJECT_PAGE_SIZE = 24;

  async function openProjectCard(chatId: number, target?: string, offset = 0): Promise<void> {
    const path = target ?? state.workspaceRoot;

    const workspacePaths = listWorkspaces(requireCtx()).items.map((workspace) => workspace.path);
    const quick = [...new Set(workspacePaths.filter((candidate) => candidate !== path))].slice(0, 3).map((candidate) => ({
      label: `\u{1F5C2} ${basename(candidate)}`,
      cb: token({ action: "project-open", path: candidate }, chatId),
    }));

    const baseActions = {
        up: path === "/" ? undefined : token({ action: "project-up", path }, chatId),
        home: path === homedir() ? undefined : token({ action: "project-open", path: homedir() }, chatId),
        root: path === "/" ? undefined : token({ action: "project-open", path: "/" }, chatId),
        menu: "m:back",
        close: "m:close",
        quick,
    };

    if (!(await isDirectory(path))) {
      const lines = [headerLine("\u{1F4C1}", truncate(path, 60)), "", "\u274C Not a directory (or not readable).", "", "Go up a level, or pick a quick root below."];
      await openCard(chatId, lines.join("\n"), buildProjectKeyboard([], baseActions));
      return;
    }

    const listing = await listDirectory(path, state.config.security.browseRoots);
    if (!listing.ok) {
      const lines = [headerLine("\u{1F4C1}", truncate(path, 60)), "", `\u274C ${plain(listing.text)}`, "", "The folder itself is valid \u2014 use it as the project, or go up."];
      await openCard(chatId, lines.join("\n"), buildProjectKeyboard([], { ...baseActions, use: token({ action: "project-select", path }, chatId) }));
      return;
    }

    const entries = listing.entries ?? [];
    const dirs = entries.filter((entry) => entry.kind === "directory");
    const files = entries.length - dirs.length;
    const active = path === state.workspaceRoot;
    const lines = [
      headerLine("\u{1F4C1}", truncate(path, 60), active ? "\u2705 current" : undefined),
      "",
      metaJoin(`folders ${dirs.length}`, `files ${files}`),
      "",
      "Pick a folder to open it, or use this one as the project.",
    ];
    const page = dirs.slice(offset, offset + PROJECT_PAGE_SIZE).map((entry) => ({ label: entry.name, cb: token({ action: "project-open", path: joinPath(path, entry.name) }, chatId) }));
    const paging: { text: string; cb: string }[] = [];
    if (offset > 0) paging.push({ text: "\u2B05\uFE0F Prev", cb: token({ action: "project-open", path, offset: String(Math.max(0, offset - PROJECT_PAGE_SIZE)) }, chatId) });
    if (offset + PROJECT_PAGE_SIZE < dirs.length) paging.push({ text: "Next \u27A1\uFE0F", cb: token({ action: "project-open", path, offset: String(offset + PROJECT_PAGE_SIZE) }, chatId) });
    await openCard(
      chatId,
      lines.join("\n"),
      buildProjectKeyboard(page, {
        ...baseActions,
        paging,
        use: token({ action: "project-select", path }, chatId),
      }),
    );
  }

  function joinPath(parent: string, name: string): string {
    return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
  }

  /** Validate, switch, persist, and register the picked project folder. */
  async function applyProjectPath(chatId: number, raw: string): Promise<void> {
    const tilde = raw.startsWith("~") ? raw.replace(/^~/, homedir()) : raw;
    const target = tilde === "" ? state.workspaceRoot : resolve(tilde.startsWith("/") ? tilde : joinPath(state.workspaceRoot, tilde));
    const path = target;
    if (!(await isDirectory(path))) {
      await uiSend(chatId, `\u274C Not a directory: ${plain(truncate(path, 60))}`, { parse_mode: "HTML" });
      return openProjectCard(chatId, path);
    }
    state.workspaceRoot = path;
    state.config.workspace.activePath = path;
    writeConfig(state.configRoot, state.config);
    const registry = requireCtx().get("workspaceRegistry");
    if (registry) {
      const anyRegistry = registry as { list(): { path: string }[]; create(path: string, title?: string): Promise<unknown> };
      const existing = anyRegistry.list().find((workspace) => workspace.path === path);
      if (!existing) {
        await anyRegistry.create(path, basename(path) || path).catch((err) => log("project register failed", err));
      }
    }
    await uiSend(chatId, `\u{1F4C1} Project set: ${plain(path)}\n\u2728 New sessions will be created here.`, { parse_mode: "HTML" });
    return openMenuAt(chatId, 0);
  }

  /** Workspace-create directory picker: instead of typing an abstract path,
   * browse to a folder and tap "Create here". Mirrors the Project browser. */
  const WORKSPACE_PICK_PAGE_SIZE = 12;

  async function openWorkspaceCreatePicker(chatId: number, path: string, offset = 0): Promise<void> {
    const target = path || state.workspaceRoot;
    if (!(await isDirectory(target))) {
      await uiSend(chatId, `\u274C Not a directory: ${plain(truncate(target, 60))}`, { parse_mode: "HTML" });
      return openWorkspaceCreatePicker(chatId, parentOf(target));
    }
    const listing = await listDirectory(target, state.config.security.browseRoots);
    const dirs = (listing.ok ? listing.entries ?? [] : []).filter((entry) => entry.kind === "directory");
    const safe = Math.max(0, Math.min(offset, Math.max(0, Math.ceil(dirs.length / WORKSPACE_PICK_PAGE_SIZE) - 1)));
    const pageDirs = dirs.slice(safe * WORKSPACE_PICK_PAGE_SIZE, (safe + 1) * WORKSPACE_PICK_PAGE_SIZE);
    const paging: { text: string; cb: string }[] = [];
    if (safe > 0) paging.push({ text: "\u2B05\uFE0F Prev", cb: token({ action: "ws-pick-page", path: target, page: String(safe - 1) }, chatId) });
    if ((safe + 1) * WORKSPACE_PICK_PAGE_SIZE < dirs.length) paging.push({ text: "Next \u27A1\uFE0F", cb: token({ action: "ws-pick-page", path: target, page: String(safe + 1) }, chatId) });
    const lines = [headerLine("\u{1F5C2}\uFE0F", "Create workspace"), mono(truncate(target, 60)), "", metaJoin(`folders ${dirs.length}`), "", "Browse to a folder, then tap \u2705 Create here."];
    await openCard(chatId, lines.join("\n"), buildProjectKeyboard(
      pageDirs.map((entry) => ({ label: entry.name, cb: token({ action: "ws-pick-open", path: joinPath(target, entry.name) }, chatId) })),
      {
        up: target === "/" ? undefined : token({ action: "ws-pick-open", path: parentOf(target) }, chatId),
        home: target === homedir() ? undefined : token({ action: "ws-pick-open", path: homedir() }, chatId),
        root: target === "/" ? undefined : token({ action: "ws-pick-open", path: "/" }, chatId),
        paging,
        use: token({ action: "ws-create-here", path: target }, chatId),
        close: "m:workspaces",
      },
    ));
  }

  return { openWorkspacesCard, openWorkspaceDetailCard, openProjectCard, applyProjectPath, openWorkspaceCreatePicker };
}
