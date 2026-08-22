/**
 * Misc-domain cards for dsh-telegram.
 *
 * Everything that has no tighter home: the plugins roster (openPluginsCard),
 * skills (openSkillsCard), the subagents browser + detail + continuable
 * probe (openSubagentsCard / openSubagentDetailCard / isContinuableSubagent),
 * background jobs (openJobsCard), dynamic cordis plugins
 * (openDynamicCordisCard), host capabilities (openCapabilitiesCard), message
 * feedback (openFeedbackListCard) and the small display cards — mode,
 * allowed chats, watch, telegram settings, about (openModeCard ..
 * openAboutCard).
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object so this module owns no mutable wiring of
 * its own.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { TelegramConfig } from "../config.js";
import { resolveToken } from "../config.js";
import { listPlugins } from "../harness/adapters/plugins.js";
import { listSkills } from "../harness/adapters/skills.js";
import { listSubagents } from "../harness/adapters/subagents.js";
import { listFeedback } from "../harness/adapters/feedback.js";
import { listJobs } from "../harness/adapters/jobs.js";
import { listDynamicCordis } from "../harness/adapters/dynamicCordis.js";
import { missingServices, probeCapabilities } from "../harness/adapters/capabilities.js";
import { modeSummary } from "../harness/adapters/mode.js";
import { plain, truncate } from "../telegram/html.js";
import { DOT, bold, headerLine, metaJoin, mono, relTime } from "../telegram/ui.js";
import {
  buildBackKeyboard,
  buildCapabilitiesKeyboard,
  buildPagingKeyboard,
  buildPluginLifecycleKeyboard,
  buildSkillsKeyboard,
  buildSubagentDetailKeyboard,
  buildSubagentsKeyboard,
  type PluginRow,
} from "../telegram/keyboard.js";
import type { TelegramTransport } from "../telegram/transport.js";
import { withTimeout, type CardLoad, type OpenCard } from "../core/cards.js";

/** One slow subagent listing must never latch a shared sync promise forever:
 * every later panel refresh would otherwise await the same stuck promise.
 * Shared with index.ts's refreshStatusSubagents. */
export const STATUS_SUBAGENTS_TIMEOUT_MS = 5000;

/** Structural slice of the plugin-root state singleton this module reads. */
interface MiscCardsStateSlice {
  /** Active project root (skills cwd fallback, About card). */
  readonly workspaceRoot: string;
  /** Live config (mode name, allowed chats, watch, outbound settings). */
  readonly config: TelegramConfig;
  /** Live transport (About card bot info). Undefined while unmounted. */
  readonly transport: TelegramTransport | undefined;
  /** Whether Telegram long-polling is on (Watch card). */
  readonly watching: boolean;
}

export interface MiscCardsDeps {
  state: MiscCardsStateSlice;
  /** Plugin version reported by the About card (index.ts export). */
  version: string;
  requireCtx(): Context;
  currentAgent(chatId?: number): Agent | undefined;
  boundSessionCwd(ctx: Context, agentId: string | undefined): string | undefined;
  cardLoad: CardLoad;
  openCard: OpenCard;
  token(payload: Record<string, string>): string;
  log(message: string, error?: unknown): void;
}

/** Build the misc-domain cards. Called once by index.ts; every card closes
 * over the shared deps like the previous module-scope closures did over
 * index.ts singletons. */
export function createMiscCards(deps: MiscCardsDeps): {
  openPluginsCard(chatId: number, page?: number): Promise<void>;
  openSkillsCard(chatId: number): Promise<void>;
  openSubagentsCard(chatId: number): Promise<void>;
  isContinuableSubagent(parentId: string, childId: string): Promise<boolean>;
  openSubagentDetailCard(chatId: number, parentId: string, childId: string): Promise<void>;
  openJobsCard(chatId: number, page?: number): Promise<void>;
  openDynamicCordisCard(chatId: number): Promise<void>;
  openCapabilitiesCard(chatId: number): Promise<void>;
  openFeedbackListCard(chatId: number, sessionId: string): Promise<void>;
  openModeCard(chatId: number): Promise<void>;
  openAllowedCard(chatId: number): Promise<void>;
  openWatchCard(chatId: number): Promise<void>;
  openSettingsCard(chatId: number): Promise<void>;
  openAboutCard(chatId: number): Promise<void>;
} {
  const { state, version, requireCtx, currentAgent, boundSessionCwd, cardLoad, openCard, token, log } = deps;

  /** Reasoning-effort picker card: the fixed codex-telegram-bot levels. */
  const PLUGINS_PAGE_SIZE = 20;

  async function openPluginsCard(chatId: number, page = 0): Promise<void> {
    const ctx = requireCtx();
    const plugins = listPlugins(ctx);
    const totalPages = Math.max(1, Math.ceil(plugins.length / PLUGINS_PAGE_SIZE));
    const safe = Math.max(0, Math.min(page, totalPages - 1));
    const pageItems = plugins.slice(safe * PLUGINS_PAGE_SIZE, (safe + 1) * PLUGINS_PAGE_SIZE);
    const lines = [headerLine("\u{1F50C}", "Plugins", `${plugins.length}`, `page ${safe + 1}/${totalPages}`), ""];
    for (const plugin of pageItems) {
      lines.push(`${plugin.enabled ? "\u2705" : "\u26AA"} ${bold(truncate(plugin.moduleName ?? plugin.entryId, 36))} ${DOT}${plain(plugin.fiberPhase ?? "\u2014")}`);
    }
    const dynamic = listDynamicCordis(ctx);
    if (dynamic.length > 0) {
      lines.push("", `Dynamic plugin packages: ${dynamic.length}`);
      for (const row of dynamic.slice(0, 10)) lines.push(`\u2022 ${mono(String(row.pluginId))}`);
    }
    lines.push("", "Toggle: /pluginenable &lt;name&gt; \u00B7 /plugindisable &lt;name&gt;");
    await openCard(chatId, lines.join("\n"), buildPagingKeyboard({
      ...(safe > 0 ? { previous: token({ action: "plugins-page", page: String(safe - 1) }) } : {}),
      ...(safe + 1 < totalPages ? { next: token({ action: "plugins-page", page: String(safe + 1) }) } : {}),
      back: "m:back",
    }));
  }

  async function openSkillsCard(chatId: number): Promise<void> {
    const ctx = requireCtx();
    const agent = currentAgent(chatId);
    // Web skill.list is addressed by session + cwd + scope: pass the live
    // session's project root (header cwd, else the workspace root) and ask for
    // the user-invocable scope, then filter client-side for registries that
    // ignore the scope option.
    const cwd = boundSessionCwd(ctx, agent?.id) ?? state.workspaceRoot;
    const skills = await cardLoad(chatId, "skills list", () => listSkills(ctx, { ...(agent?.id === undefined ? {} : { sessionId: agent.id }), cwd, scope: "user" }));
    if (skills === undefined) return;
    const userSkills = skills.filter((skill) => skill.userInvocable);
    const lines = [headerLine("\u{1F9D1}\u200D\u{1F3EB}", "Skills", `${userSkills.length} user-invocable`), ""];
    for (const skill of userSkills.slice(0, 30)) {
      lines.push(metaJoin(`\u2022 ${bold(skill.name)}`, plain(skill.source)));
      lines.push(`  ${plain(truncate(skill.description, 80))}`);
      lines.push(metaJoin(`  model ${skill.modelInvocable ? "yes" : "no"}`, `provider ${plain(skill.provider)}`));
    }
    if (skills.length === 0) lines.push("No skills registered in this profile.");
    else if (userSkills.length === 0) lines.push("No user-invocable skills for this session's project.");
    else if (userSkills.length < skills.length) lines.push("", `Model-only skills hidden: ${skills.length - userSkills.length}`);
    await openCard(chatId, lines.join("\n"), buildSkillsKeyboard());
  }

  async function openSubagentsCard(chatId: number): Promise<void> {
    const agent = currentAgent(chatId);
    if (!agent) {
      await openCard(chatId, "No live agent \u2014 subagents hang off a parent session.", buildBackKeyboard());
      return;
    }
    const entries = await cardLoad(chatId, "subagents list", () => listSubagents(requireCtx(), agent.id));
    if (entries === undefined) return;
    const lines = [headerLine("\u{1F916}", "Subagents", mono(truncate(agent.id, 24)), `${entries.length}`), ""];
    for (const entry of entries.slice(0, 15)) {
      const flags: string[] = [entry.kind, entry.activity];
      if (entry.mode !== undefined) flags.push(entry.mode);
      if (entry.hasChildren === true) flags.push("children");
      flags.push(entry.parentAvailable === false ? "parent:unavailable" : "parent:available");
      lines.push(metaJoin(`\u2022 ${mono(truncate(entry.id, 28))}`, ...flags, entry.label !== undefined ? plain(truncate(entry.label, 20)) : undefined));
      if (entry.kind === "diagnostic") lines.push(`  reason: ${plain(entry.reason ?? "unavailable")}`);
    }
    if (entries.length === 0) lines.push("(none)");
    const rows = entries.slice(0, 12).map((entry) => ({ id: entry.id, cb: token({ action: "subagent", parentId: agent.id, childId: entry.id }) }));
    await openCard(chatId, lines.join("\n"), buildSubagentsKeyboard(rows));
  }

  async function isContinuableSubagent(parentId: string, childId: string): Promise<boolean> {
    try {
      const entries = await withTimeout(listSubagents(requireCtx(), parentId), STATUS_SUBAGENTS_TIMEOUT_MS, "subagents.listChildren");
      return entries.some((entry) => entry.id === childId && entry.kind === "child" && entry.mode === "continuable");
    } catch {
      return false;
    }
  }

  async function openSubagentDetailCard(chatId: number, parentId: string, childId: string): Promise<void> {
    const entries = await cardLoad(chatId, "subagents list", () => listSubagents(requireCtx(), parentId));
    if (entries === undefined) return;
    const entry = entries.find((candidate) => candidate.id === childId);
    const lines = [
      headerLine("\u{1F916}", truncate(childId, 32)),
      "",
      metaJoin("parent", mono(truncate(parentId, 24))),
      entry === undefined
        ? "catalog entry: not listed"
        : metaJoin(
            `kind ${entry.kind}`,
            `activity ${entry.activity}`,
            entry.mode !== undefined ? `mode ${entry.mode}` : undefined,
            entry.hasChildren === true ? "has children" : undefined,
            entry.parentAvailable === false ? "parent unavailable" : undefined,
          ),
      entry?.label !== undefined ? metaJoin("label", plain(truncate(entry.label, 40))) : "",
      entry?.kind === "diagnostic" ? `reason: ${plain(entry.reason ?? "unavailable")}` : "",
    ].filter((line) => line !== "");
    const continuable = entry?.kind === "child" && entry.mode === "continuable";
    const callbacks = {
      ...(continuable
        ? {
            prompt: token({ action: "subagent-prompt", parentId, childId }),
            interrupt: token({ action: "subagent-interrupt", parentId, childId }),
          }
        : {}),
      history: token({ action: "subagent-history", parentId, childId }),
    };
    if (!continuable) lines.push("", "This subagent is not continuable \u2014 history is read-only.");
    await openCard(chatId, lines.join("\n"), buildSubagentDetailKeyboard(callbacks));
  }

  const JOBS_PAGE_SIZE = 20;

  async function openJobsCard(chatId: number, page = 0): Promise<void> {
    const agent = currentAgent(chatId);
    const jobs = listJobs(requireCtx(), agent?.id);
    const totalPages = Math.max(1, Math.ceil(jobs.length / JOBS_PAGE_SIZE));
    const safe = Math.max(0, Math.min(page, totalPages - 1));
    const pageItems = jobs.slice(safe * JOBS_PAGE_SIZE, (safe + 1) * JOBS_PAGE_SIZE);
    const lines = [headerLine("\u{1F3D7}\uFE0F", "Jobs", `${jobs.length}`, `page ${safe + 1}/${totalPages}`), ""];
    for (const job of pageItems) {
      lines.push(metaJoin(`\u2022 ${bold(job.kind)} ${mono(job.id)}`, job.status, job.detail !== undefined ? plain(truncate(job.detail, 30)) : undefined));
      lines.push(`  ${plain(truncate(job.label, 60))} \u00B7 started ${relTime(job.startedAt)}`);
    }
    if (jobs.length === 0) lines.push("(none)");
    await openCard(chatId, lines.join("\n"), buildPagingKeyboard({
      ...(safe > 0 ? { previous: token({ action: "jobs-page", page: String(safe - 1) }) } : {}),
      ...(safe + 1 < totalPages ? { next: token({ action: "jobs-page", page: String(safe + 1) }) } : {}),
      back: "m:back",
    }));
  }

  async function openDynamicCordisCard(chatId: number): Promise<void> {
    const rows = listDynamicCordis(requireCtx());
    const lines = [headerLine("\u{1F9F0}", "Dynamic plugins", `${rows.length}`), ""];
    const pluginRows: PluginRow[] = [];
    for (const row of rows.slice(0, 15)) {
      const pluginId = String(row.pluginId);
      const running = row.activeRun !== undefined && row.activeRun !== null;
      const current = row.currentPackageId === undefined || row.currentPackageId === null ? undefined : String(row.currentPackageId);
      const versions = Array.isArray(row.packages) ? row.packages.length : 0;
      lines.push(
        metaJoin(
          `\u2022 ${bold(pluginId)}`,
          `${versions} pkg`,
          current !== undefined ? `@ ${mono(truncate(current, 18))}` : undefined,
          running ? "\u25B6\uFE0F running" : undefined,
        ),
      );
      pluginRows.push({
        pluginId,
        running,
        callbacks: {
          run: token({ action: "plugin-run", pluginId }),
          stop: token({ action: "plugin-stop", pluginId }),
          remove: token({ action: "plugin-remove", pluginId }),
        },
      });
    }
    if (rows.length === 0) {
      lines.push("(none)", "", "Install your own plugin from the phone:", "tap \u2795 Add plugin, then reply with a JSON:", '{"name": "my-decoder", "purpose": "...", "host": "<js source>"}', "The host half can call your own model to decode.");
    }
    await openCard(chatId, lines.join("\n"), buildPluginLifecycleKeyboard(pluginRows));
  }

  async function openCapabilitiesCard(chatId: number): Promise<void> {
    const caps = probeCapabilities(requireCtx());
    // 🧪 probe: this card literally probes which host services answer.
    const lines = [headerLine("\u{1F9EA}", "Host capabilities"), ""];
    for (const [key, available] of Object.entries(caps) as [string, boolean][]) {
      lines.push(`${available ? "\u2705" : "\u274C"} ${mono(key)}`);
    }
    const missing = missingServices(requireCtx());
    if (missing.length > 0) lines.push("", `Missing (cards degrade with hints): ${missing.map(plain).join(", ")}`);
    await openCard(chatId, lines.join("\n"), buildCapabilitiesKeyboard());
  }

  async function openFeedbackListCard(chatId: number, sessionId: string): Promise<void> {
    const items = await cardLoad(chatId, "feedback list", () => listFeedback(requireCtx(), sessionId));
    if (items === undefined) return;
    const lines = [headerLine("\u{1F4CB}", "Feedback", mono(truncate(sessionId, 24)), `${items.length}`), ""];
    const rows: { text: string; callback_data: string }[][] = [];
    for (const item of items.slice(0, 20)) {
      lines.push(`\u2022 ${item.rating === "positive" ? "\u{1F44D}" : "\u{1F44E}"} [${item.messageId.slice(0, 8)}]${item.note ? ` ${plain(truncate(item.note, 40))}` : ""}`);
      rows.push([
        {
          text: `\u{1F5D1} Delete [${item.messageId.slice(0, 8)}]`,
          callback_data: token({ action: "feedback-delete", sessionId, messageId: item.messageId, ifVersion: item.version }),
        },
      ]);
    }
    if (items.length === 0) lines.push("(no feedback yet \u2014 tap \u{1F44D}/\u{1F44E} under an assistant reply)");
    rows.push([{ text: "\u2190 Back", callback_data: "m:back" }]);
    await openCard(chatId, lines.join("\n"), { inline_keyboard: rows });
  }

  async function openModeCard(chatId: number): Promise<void> {
    const mode = modeSummary();
    const displayName = state.config.mode?.name;
    const lines = [
      headerLine("\u{1F3AD}", "Mode", displayName !== undefined ? bold(displayName) : undefined),
      "",
      plain(mode.note),
      metaJoin("Profiles", mode.profiles.length > 0 ? mode.profiles.map(plain).join(", ") : "none found"),
    ];
    lines.push("", "Switch profile by restarting dsh with `dsh --profile &lt;name&gt;`.");
    await openCard(chatId, lines.join("\n"), buildBackKeyboard());
  }

  async function openAllowedCard(chatId: number): Promise<void> {
    const allowed = state.config.security.allowedChatIds;
    const lines = [headerLine("\u{1F510}", "Allowed chats", `${allowed.length}`), ""];
    for (const id of allowed) lines.push(`\u2022 ${mono(String(id))}`);
    if (allowed.length === 0) lines.push("Nobody is allowed yet \u2014 inbound messages are ignored.");
    await openCard(chatId, lines.join("\n"), {
      inline_keyboard: [
        [{ text: "\u2795 Allow this chat", callback_data: "m:allowthis" }],
        [{ text: "\u2190 Back", callback_data: "m:back" }],
      ],
    });
  }

  async function openWatchCard(chatId: number): Promise<void> {
    // The icon carries the state: green while polling, red while paused.
    const lines = [
      headerLine(state.watching ? "\u{1F7E2}" : "\u{1F534}", "Watch", state.watching ? "polling ON" : "polling OFF", `autoStart ${state.config.watch.autoStart ? "yes" : "no"}`),
    ];
    await openCard(chatId, lines.join("\n"), {
      inline_keyboard: [
        [{ text: state.watching ? "\u23F8 Pause polling" : "\u25B6 Start polling", callback_data: "m:watchtoggle" }],
        [{ text: "\u2190 Back", callback_data: "m:back" }],
      ],
    });
  }

  async function openSettingsCard(chatId: number): Promise<void> {
    const c = state.config.outbound;
    const lines = [
      headerLine("\u2699\uFE0F", "Telegram settings"),
      "",
      metaJoin("parseMode", mono(c.parseMode)),
      metaJoin("disableNotification", String(c.disableNotification)),
      metaJoin(`maxRetries ${c.maxRetries}`, `sendRate/s ${c.sendRatePerSecond}`),
      metaJoin("maxMessageLength", mono(String(c.maxMessageLength))),
      "",
      "Edit .pi/telegram.json in the workspace to change these values.",
      "",
      "Host settings live under /hostsettings; credentials under /credentials.",
    ];
    await openCard(chatId, lines.join("\n"), {
      inline_keyboard: [[{ text: "\u2190 Back", callback_data: "m:back" }]],
    });
  }

  async function openAboutCard(chatId: number): Promise<void> {
    const bot = state.transport ? await state.transport.botInfo().catch(() => undefined) : undefined;
    const lines = [
      headerLine("\u2139\uFE0F", "dsh-telegram", `v${version}`),
      "",
      metaJoin("bot", bot !== undefined ? mono(`@${bot.username} (${bot.id})`) : "not connected"),
      metaJoin("token", resolveToken() !== undefined ? mono("set") : mono("missing")),
      metaJoin("workspace", mono(truncate(state.workspaceRoot, 40))),
    ];
    await openCard(chatId, lines.join("\n"), {
      inline_keyboard: [[{ text: "\u2190 Back", callback_data: "m:back" }]],
    });
  }

  return {
    openPluginsCard, openSkillsCard, openSubagentsCard, isContinuableSubagent, openSubagentDetailCard,
    openJobsCard, openDynamicCordisCard, openCapabilitiesCard, openFeedbackListCard,
    openModeCard, openAllowedCard, openWatchCard, openSettingsCard, openAboutCard,
  };
}
