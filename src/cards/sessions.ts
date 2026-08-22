/**
 * Sessions / projects / history / search cards for dsh-telegram.
 *
 * The session browser chain: web-style ordered project groups
 * (sessionProjectSnapshot), the paginated Sessions roster (openSessionsCard),
 * the project switcher (openSessionProjectsCard), per-session detail
 * (openSessionDetailCard), the turn-grouped trajectory view (openHistoryCard)
 * and full-text search (openSearchCard).
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object so this module owns no mutable wiring of
 * its own.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Bridge } from "../harness/bridge.js";
import {
  displayTitleFor,
  groupSessionsByProject,
  listSessionDetails,
  orderProjectGroups,
  searchSessions,
  readTrajectory,
  type ProjectGroup,
  type SessionDetail,
} from "../harness/adapters/sessions.js";
import { listWorkspaces } from "../harness/adapters/workspace.js";
import type { TelegramTransport } from "../telegram/transport.js";
import { escapeHtml, plain, truncate } from "../telegram/html.js";
import { bold, headerLine, metaJoin, mono, relTime } from "../telegram/ui.js";
import { renderTrajectoryLines } from "../telegram/trajectory.js";
import {
  buildHistoryKeyboard,
  buildSearchKeyboard,
  buildSessionDetailKeyboard,
  buildSessionProjectsKeyboard,
  buildSessionsKeyboard,
} from "../telegram/keyboard.js";
import type { CardLoad, OpenCard } from "../core/cards.js";

/** Structural slice of the plugin-root state singleton this module reads. */
interface SessionCardsStateSlice {
  /** Chat↔agent bridge (bound-agent highlight + reverse lookups). Undefined while unmounted. */
  readonly bridge: Bridge | undefined;
  /** Last project key shown on the per-chat Sessions card (back navigation). */
  readonly lastSessionsProject: Map<number, string>;
}

export interface SessionCardsDeps {
  state: SessionCardsStateSlice;
  requireCtx(): Context;
  cardLoad: CardLoad;
  openCard: OpenCard;
  uiSend(chatId: number, text: string, options?: Parameters<TelegramTransport["sendText"]>[2]): Promise<number | undefined>;
  token(payload: Record<string, string>): string;
}

/** Build the session-domain cards. Called once by index.ts; every card closes
 * over the shared deps like the previous module-scope closures did over
 * index.ts singletons. */
export function createSessionCards(deps: SessionCardsDeps): {
  lastProjectKey(chatId: number): string | undefined;
  openSessionsCard(chatId: number, projectKey?: string, page?: number): Promise<void>;
  openSessionProjectsCard(chatId: number, page?: number): Promise<void>;
  openSessionDetailCard(chatId: number, sessionId: string): Promise<void>;
  openHistoryCard(chatId: number, sessionId: string, beforeSeq?: number): Promise<void>;
  openSearchCard(chatId: number, query: string, page?: number): Promise<void>;
} {
  const { state, requireCtx, cardLoad, openCard, uiSend, token } = deps;

  const SESSIONS_PAGE_SIZE = 10;
  const SESSION_PROJECTS_PAGE_SIZE = 12;
  /** Synthetic project key for the legacy flat "all sessions" view. */
  const ALL_PROJECTS_KEY = "__all__";

  /** Load the Sessions roster once and project it into web-style ordered project groups. */
  async function sessionProjectSnapshot(chatId: number): Promise<{ details: SessionDetail[]; groups: ProjectGroup[]; bound?: string }> {
    const ctx = requireCtx();
    const details = await cardLoad(chatId, "sessions roster", () => listSessionDetails(ctx));
    const workspaces = details === undefined ? [] : listWorkspaces(ctx).items;
    if (details === undefined) return { details: [], groups: [], bound: undefined };
    const groups = groupSessionsByProject(details, workspaces);
    const bound = state.bridge?.agentIdForChat(chatId) ?? state.bridge?.currentAgentIdValue();
    return { details, groups: orderProjectGroups(groups, bound), bound };
  }

  /** Project key the user last viewed on this chat's Sessions card. */
  function lastProjectKey(chatId: number): string | undefined {
    return state.lastSessionsProject.get(chatId);
  }

  async function openSessionsCard(chatId: number, projectKey?: string, page = 0): Promise<void> {
    const { details, groups, bound } = await sessionProjectSnapshot(chatId);
    const requestedKey = projectKey ?? groups[0]?.key ?? ALL_PROJECTS_KEY;
    const group = requestedKey === ALL_PROJECTS_KEY ? undefined : groups.find((candidate) => candidate.key === requestedKey) ?? groups[0];
    const key = group?.key ?? ALL_PROJECTS_KEY;
    const sessions = (group?.sessions ?? details).filter((session) => !session.archived);
    const archivedCount = (group?.sessions ?? details).length - sessions.length;
    const totalPages = Math.max(1, Math.ceil(sessions.length / SESSIONS_PAGE_SIZE));
    const safe = Math.max(0, Math.min(page, totalPages - 1));
    const pageItems = sessions.slice(safe * SESSIONS_PAGE_SIZE, (safe + 1) * SESSIONS_PAGE_SIZE);
    const runningCount = sessions.filter((session) => session.running).length;
    const label = group?.label ?? "\u5168\u90E8\u4F1A\u8BDD";
    state.lastSessionsProject.set(chatId, key);
    // Design language: bold card title, a quiet meta strip, then one bold row
    // per session with its recency/id beneath — scannable on a phone.
    const lines = [
      headerLine("\u{1F9ED}", "Sessions", plain(truncate(label, 26))),
      metaJoin(
        runningCount > 0 ? `\u25B6\uFE0F ${runningCount} running` : undefined,
        `${sessions.length} \u4F1A\u8BDD`,
        archivedCount > 0 ? `\u{1F5C4}${archivedCount}` : undefined,
        `page ${safe + 1}/${totalPages}`,
      ),
      "",
    ];
    if (sessions.length === 0) lines.push("(\u8BE5\u9879\u76EE\u6682\u65E0\u4F1A\u8BDD)", "");
    for (const session of pageItems) {
      const title = displayTitleFor(session.title, session.cwd, session.id);
      const hasTitle = session.title !== undefined && session.title.trim() !== "";
      const marker = session.id === bound ? "\u25B8" : "\u2022";
      const state_ = session.running ? " \u25B6\uFE0F" : session.live ? "" : " \u00B7 cold";
      lines.push(`${marker} ${bold(truncate(title, 32))}${state_}`);
      if (session.lastPromptAt !== undefined) {
        lines.push(`   ${metaJoin(`\u23F1\uFE0F ${relTime(session.lastPromptAt)}`, hasTitle ? mono(truncate(session.id, 14)) : undefined)}`);
      } else if (hasTitle) {
        lines.push(`   ${mono(truncate(session.id, 14))}`);
      }
    }
    lines.push("", "\u4F1A\u8BDD\u6309\u94AE\u6253\u5F00\u8BE6\u60C5 \u00B7 \u5F52\u6863 / \u5220\u9664 \u76F4\u63A5\u64CD\u4F5C\u3002");
    await openCard(chatId, lines.join("\n"), buildSessionsKeyboard(pageItems.map((session) => ({
      id: session.id,
      title: displayTitleFor(session.title, session.cwd, session.id),
      running: session.running,
      archiveCb: token({ action: "session-archive", sessionId: session.id }),
      deleteCb: token({ action: "session-delete", sessionId: session.id }),
    })), {
      projectCount: groups.length,
      projectsCb: token({ action: "sessions-projects" }),
      paging: {
        ...(safe > 0 ? { previous: token({ action: "sessions-page", projectKey: key, page: String(safe - 1) }) } : {}),
        ...(safe + 1 < totalPages ? { next: token({ action: "sessions-page", projectKey: key, page: String(safe + 1) }) } : {}),
      },
    }), () => openSessionsCard(chatId, key, safe));
  }

  /** Project switcher page: running projects first, then current, then recency. */
  async function openSessionProjectsCard(chatId: number, page = 0): Promise<void> {
    const { groups, bound } = await sessionProjectSnapshot(chatId);
    const totalPages = Math.max(1, Math.ceil(groups.length / SESSION_PROJECTS_PAGE_SIZE));
    const safe = Math.max(0, Math.min(page, totalPages - 1));
    const pageGroups = groups.slice(safe * SESSION_PROJECTS_PAGE_SIZE, (safe + 1) * SESSION_PROJECTS_PAGE_SIZE);
    const lines = [headerLine("\u{1F504}", "\u9879\u76EE", `${groups.length}`, `page ${safe + 1}/${totalPages}`), ""];
    for (const group of pageGroups) {
      const current = bound !== undefined && group.sessions.some((session) => session.id === bound);
      lines.push(
        metaJoin(
          `${current ? "\u25B8" : "\u2022"} ${bold(truncate(group.label, 30))}`,
          group.runningCount > 0 ? `\u25B6\uFE0F${group.runningCount}` : undefined,
          `\u5171${group.sessions.length}`,
        ),
      );
    }
    lines.push("", "Tap a project to switch its Sessions page.");
    await openCard(chatId, lines.join("\n"), buildSessionProjectsKeyboard(pageGroups.map((group) => ({
      label: group.label,
      running: group.runningCount,
      total: group.sessions.length,
      cb: token({ action: "sessions-project", projectKey: group.key }),
    })), {
      all: token({ action: "sessions-project", projectKey: ALL_PROJECTS_KEY }),
      paging: {
        ...(safe > 0 ? { previous: token({ action: "sessions-projects-page", page: String(safe - 1) }) } : {}),
        ...(safe + 1 < totalPages ? { next: token({ action: "sessions-projects-page", page: String(safe + 1) }) } : {}),
      },
      back: token({ action: "sessions-open" }),
    }), () => openSessionProjectsCard(chatId, safe));
  }

  async function openSessionDetailCard(chatId: number, sessionId: string): Promise<void> {
    const ctx = requireCtx();
    const details = await cardLoad(chatId, "session details", () => listSessionDetails(ctx));
    if (details === undefined) return;
    const session = details.find((candidate) => candidate.id === sessionId);
    if (!session) {
      await uiSend(chatId, `\u274C Session ${plain(truncate(sessionId, 32))} not found.`, { parse_mode: "HTML" });
      return openSessionsCard(chatId, lastProjectKey(chatId));
    }
    const title = displayTitleFor(session.title, session.cwd, session.id);
    // Design language: bold title header, full id as monospace subtitle, then
    // quiet key-value rows. Only the non-default states are spelled out.
    const statusWords = [
      session.live ? "live" : "cold",
      session.running ? "\u25B6\uFE0F running" : "idle",
      ...(session.blank ? ["blank"] : []),
      ...(session.archived ? ["archived"] : []),
    ];
    const lines = [
      headerLine("\u{1F9ED}", truncate(title, 40)),
      mono(session.id),
      "",
      metaJoin(...statusWords),
      metaJoin(`events ${session.eventCount}`, session.cwd ? `cwd ${mono(truncate(session.cwd, 28))}` : undefined),
      session.lastPromptAt !== undefined ? `\u23F1\uFE0F last prompt ${relTime(session.lastPromptAt)}` : "",
    ].filter((line) => line !== "");
    await openCard(chatId, lines.join("\n"), buildSessionDetailKeyboard(session.id, session.archived, token({ action: "sessions-open" })));
  }

  async function openHistoryCard(chatId: number, sessionId: string, beforeSeq?: number): Promise<void> {
    // Turn-grouped trajectory view (issue #32), matching the web's 轨迹 ledger:
    // per-turn model/outcome/duration header plus user/thinking/tool/answer steps.
    const result = await cardLoad(chatId, "session history", () => readTrajectory(requireCtx(), sessionId, 6, beforeSeq));
    if (result === undefined) return;
    await openCard(chatId, renderTrajectoryLines(sessionId, result).join("\n"), buildHistoryKeyboard(
      sessionId,
      result.hasMore && result.nextBefore !== undefined
        ? token({ action: "history-older", sessionId, beforeSeq: String(result.nextBefore) })
        : undefined,
    ));
  }

  const SEARCH_PAGE_SIZE = 10;

  async function openSearchCard(chatId: number, query: string, page = 0): Promise<void> {
    const hits = await cardLoad(chatId, "search results", () => searchSessions(requireCtx(), query, 100));
    if (hits === undefined) return;
    const totalPages = Math.max(1, Math.ceil(hits.length / SEARCH_PAGE_SIZE));
    const safe = Math.max(0, Math.min(page, totalPages - 1));
    const pageHits = hits.slice(safe * SEARCH_PAGE_SIZE, (safe + 1) * SEARCH_PAGE_SIZE);
    const lines = [headerLine("\u{1F50D}", "Search", `\u201C${plain(truncate(query, 40))}\u201D`, `${hits.length} hit(s)`, `page ${safe + 1}/${totalPages}`), ""];
    for (const hit of pageHits) {
      lines.push(`\u2022 ${mono(truncate(hit.sessionId, 24))} #${hit.seq} ${escapeHtml(hit.type)}${hit.live ? "" : " (cold)"}`);
      lines.push(`  ${plain(truncate(hit.snippet, 80))}`);
    }
    if (hits.length === 0) lines.push("(no hits)");
    await openCard(chatId, lines.join("\n"), buildSearchKeyboard(pageHits.map((hit) => hit.sessionId), {
      ...(safe > 0 ? { previous: token({ action: "search-page", query, page: String(safe - 1) }) } : {}),
      ...(safe + 1 < totalPages ? { next: token({ action: "search-page", query, page: String(safe + 1) }) } : {}),
    }));
  }

  return { lastProjectKey, openSessionsCard, openSessionProjectsCard, openSessionDetailCard, openHistoryCard, openSearchCard };
}
