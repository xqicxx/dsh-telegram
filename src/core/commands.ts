/**
 * Slash-command implementations for dsh-telegram (yellow-1 step 4).
 *
 * Every substantive /command body that used to be inlined in dispatchCommand
 * lives here as one function; dispatchCommand (core/dispatch.ts) resolves the
 * command word and hands over the per-invocation CommandCall bundle plus the
 * shared DispatchDeps. Thin delegations (cases that only route into the
 * action registry or a card opener) stayed inline in the dispatcher.
 *
 * Bodies are verbatim moves: bare names resolve through one destructure of
 * the call bundle and the deps object, exactly like the former closures over
 * dispatchCommand locals. Purely structural layer — may import harness/,
 * telegram/, config.js and sibling core modules; never index.ts.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  getConfigPath,
  overlayConfig,
  patchFromPath,
  writeConfig,
} from "../config.js";
import { statusSnapshot } from "../harness/adapters/status.js";
import { modelCatalog, discoverModels } from "../harness/adapters/llm.js";
import { listPlugins, togglePlugin, entryIdFor } from "../harness/adapters/plugins.js";
import {
  listSessionDetails,
  readHistory,
  readTrajectory,
  renameSession,
  forkSession,
  resumeSession,
  promptSession,
  updateQueueItem,
  readImageAttachment,
  listQueue,
} from "../harness/adapters/sessions.js";
import { listWorkspaces, createWorkspace, renameWorkspace, insertSessionBefore, archiveSession } from "../harness/adapters/workspace.js";
import { getGoal, createGoal, editGoal, clearGoal } from "../harness/adapters/goals.js";
import { listSkills } from "../harness/adapters/skills.js";
import { listSubagents, promptSubagent } from "../harness/adapters/subagents.js";
import { listAgentPresets } from "../harness/adapters/presets.js";
import {
  describeSettings,
  updateSettings,
  replaceSettings,
  mutateSettings,
  parseJsonWithRevision,
} from "../harness/adapters/settings.js";
import { describeCredential, describeCredentials, setCredential, unsetCredential } from "../harness/adapters/credentials.js";
import { describeHost, listDirectory, createDirectory, pickDirectoryHint, openPath } from "../harness/adapters/host.js";
import { listCommands } from "../harness/adapters/commands.js";
import { listJobs } from "../harness/adapters/jobs.js";
import { exportSessionLog } from "../harness/adapters/downloads.js";
import { listDynamicCordis, defineDynamicCordis } from "../harness/adapters/dynamicCordis.js";
import { probeCapabilities } from "../harness/adapters/capabilities.js";
import { questionIdAt } from "../harness/adapters/interactive.js";
import { modeSummary } from "../harness/adapters/mode.js";
import { listTodos } from "../harness/adapters/todos.js";
import { plain, truncate } from "../telegram/html.js";
import { buildBackKeyboard } from "../telegram/keyboard.js";
import type { TelegramTransport } from "../telegram/transport.js";
import { renderTrajectoryLines } from "../telegram/trajectory.js";
import type { DispatchDeps } from "./dispatch.js";

/** Per-invocation values dispatchCommand computes once for every command and
 * passes to the extracted implementations below (its own locals, bundled). */
export interface CommandCall {
  /** Chat the command came from. */
  chatId: number;
  /** Canonical command word (no slash); distinguishes enable/disable text. */
  command: string;
  /** Raw argument tail after the command word. */
  args: string;
  /** message_id of the inbound command message, when the router saw one. */
  messageId?: number;
  /** Attached dsh context (requireCtx() at dispatch time). */
  ctx: Context;
  /** The chat's live agent, if any. */
  agent: Agent | undefined;
  /** Live transport (requireTransport() at dispatch time). */
  t: TelegramTransport;
  /** The dispatcher's logging reply wrapper: plain text on success, ❌-prefixed
   * HTML on failure. */
  send(text: string, okResult?: boolean): Promise<void>;
}

/** Complete Telegram command menu. Registered once per chat on /start so the
 * phone's native autocomplete exposes every implemented command. */
const TELEGRAM_COMMANDS = [
  { command: "start", description: "Welcome + persistent button bar" },
  { command: "menu", description: "Core menu card" },
  { command: "new", description: "Fresh session in the workspace" },
  { command: "compact", description: "Compact the current session" },
  { command: "abort", description: "Abort the current turn" },
  { command: "stop", description: "Close this chat's session" },
  { command: "models", description: "Browse providers and models" },
  { command: "status", description: "Live status card" },
  { command: "queue", description: "Inspect or edit the agent inbox" },
  { command: "todo", description: "Show the current session todo list" },
  { command: "sessions", description: "Sessions list" },
  { command: "history", description: "Session trajectory (turn-grouped)" },
  { command: "rename", description: "Rename the current session" },
  { command: "fork", description: "Fork the current session" },
  { command: "use", description: "Switch to a session" },
  { command: "archive", description: "Archive a session" },
  { command: "workspaces", description: "Workspaces list" },
  { command: "workspacecreate", description: "Create a workspace" },
  { command: "project", description: "Pick the active project folder" },
  { command: "goals", description: "Current goal" },
  { command: "bar", description: "Show or hide the button bar" },
  { command: "goal", description: "Start a goal: /goal <objective> [maxRounds]" },
  { command: "goalcreate", description: "Create a goal" },
  { command: "goalclear", description: "Clear the current goal" },
  { command: "skills", description: "Skills list" },
  { command: "subagents", description: "Subagents list" },
  { command: "presets", description: "Agent presets" },
  { command: "plugins", description: "Plugin inventory" },
  { command: "hostsettings", description: "Host settings" },
  { command: "credentials", description: "Credential list" },
  { command: "host", description: "Host details and files" },
  { command: "ls", description: "List a directory" },
  { command: "attachment", description: "Send a saved photo attachment back" },
  { command: "mkdir", description: "Create a directory" },
  { command: "pluginadd", description: "Install your own dynamic plugin (JSON)" },
  { command: "jobs", description: "Jobs list" },
  { command: "capabilities", description: "Profile capability matrix" },
  { command: "menucheck", description: "Self-check every menu data source" },
  { command: "answer", description: "Answer a free-text question by id" },
  { command: "settingsreplace", description: "Replace a settings namespace" },
  { command: "settingsmutate", description: "Mutate settings paths" },
  { command: "pickdir", description: "Pick the active project folder" },
  { command: "openpath", description: "Show a host path for opening" },
  { command: "config", description: "Get/set bridge config live" },
  { command: "help", description: "All commands" },
];


/** /start — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function startCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, t, messageId } = c;
  const { state, version, sendWithLiveBar } = deps;
      state.chats.add(chatId);
      await t.setCommands(TELEGRAM_COMMANDS);
      await t.setMenuButtonToCommands(chatId);
      await sendWithLiveBar(chatId, `\u{1F916} dsh-telegram ${version} ready. Send a message to talk to the agent; the bar below carries all functions.`, {
        parse_mode: "HTML",
        ...(messageId === undefined ? {} : { reply_parameters: { message_id: messageId } }),
      });
      return;
}


/** /help — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function helpCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { send } = c;
      await send(
        [
          "Commands:",
          "/new /compact /abort /stop /models /sessions /workspaces /project [path] /goals /skills /subagents /presets /plugins /hostsettings /credentials /host /jobs /status /menu",
          "/history [sessionId] [turns] 轨迹 \u00B7 /rename <title> \u00B7 /fork [atSeq] \u00B7 /use <sessionId> \u00B7 /archive <sessionId>",
          "/queue \u00B7 /todo \u00B7 /steer <text> \u00B7 /cancel",
          "/goalcreate <objective> [maxRounds] \u00B7 /goaledit <text>",
          "/workspacecreate <path> [title] \u00B7 /workspacepin <workspaceId> <sessionId> [beforeSessionId]",
          "/pluginenable <name> \u00B7 /plugindisable <name> \u00B7 /settingsdescribe [ns] \u00B7 /settingsupdate <ns> <json> \u00B7 /settingsreplace <ns> <json> \u00B7 /settingsmutate <ns> <json ops>",
          "/credential <REF> [REF...] \u00B7 /credentialset <REF> <value> \u00B7 /credentialunset <REF> \u00B7 /answer <id> <question-number> <text>",
          "/attachment <attachmentId> \u00B7 /ls [path] \u00B7 /mkdir <path> \u00B7 /pickdir [path] \u00B7 /openpath [path] \u00B7 /discover <settingsNs> [baseURL] \u00B7 /subagentprompt <text>",
          "/pluginadd [json] \u00B7 install your own dynamic plugin (host half can call your own model to decode)",
          "/sessionlog [sessionId] \u00B7 /commands \u00B7 /capabilities \u00B7 /config get|set <path> [json]",
          "/menucheck \u00B7 self-checks every menu card's data source",
        ].join("\n"),
      );
      return;
}


/** /answer — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function answerCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, send } = c;
  const { state } = deps;
      const [idText, numberText, ...rest] = args.trim().split(/\s+/);
      const id = Number(idText);
      const questionNumber = Number(numberText);
      const text = rest.join(" ").trim();
      if (!Number.isInteger(id) || !Number.isInteger(questionNumber) || questionNumber <= 0 || text === "") {
        await send("usage: /answer <questionId> <questionNumber> <text> \u2014 then tap Submit on the question card");
        return;
      }
      const questionId = questionIdAt(id, questionNumber - 1);
      if (questionId === undefined) {
        await send(`\u274C question ${questionNumber} not found for pending id ${id}.`, false);
        return;
      }
      const updated = state.interactive ? await state.interactive.setQuestionCustom(chatId, id, questionId, text) : false;
      await send(updated ? `\u270F Answer ${questionNumber} updated \u2014 tap Submit on the question card.` : "\u274C That question is no longer pending.", updated);
      return;
}


/** /cancel — body moved verbatim from the former
 * dispatchCommand switch case. B-4r: cancels the chat's armed pending input
 * whatever its kind; the four kinds that previously had no cancel path now
 * answer with consistent texts instead of "Nothing to cancel.". */
export async function cancelCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, send } = c;
  const { cancelPending } = deps;
      const kind = cancelPending(chatId);
      if (kind === "presetCopy") {
        await send("Preset copy cancelled.");
      } else if (kind === "mkdir") {
        await send("New-folder cancelled.");
      } else if (kind === "pluginAdd") {
        await send("Plugin add cancelled.");
      } else if (kind === "rename") {
        await send("Rename cancelled.");
      } else if (kind === "steer") {
        await send("Steer cancelled.");
      } else if (kind === "search") {
        await send("Search cancelled.");
      } else if (kind === "subagentPrompt") {
        await send("Subagent prompt cancelled.");
      } else {
        await send("Nothing to cancel.", false);
      }
      return;
}


/** /pluginadd — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function pluginAddCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, ctx, send } = c;
  const { boundAgentId, armPending, refreshAllPanels } = deps;
      const agentId = boundAgentId(chatId);
      if (agentId === undefined) {
        await send("\u274C No live session in this chat \u2014 send a message first to create one, then /pluginadd.");
        return;
      }
      const json = args.trim();
      if (json === "") {
        armPending(chatId, { kind: "pluginAdd" });
        await send(
          [
            "\u{1F9E9} Reply with the plugin JSON (or /cancel):",
            "",
            '{"name": "my-decoder", "purpose": "decode with my own model", "host": "// js source"}',
            "",
            "Keys: name* \u00B7 purpose* \u00B7 host (JS source) \u00B7 client (JS source). At least one source half is required; a client half activates through the approval card. Optional pluginId appends a version to an existing plugin.",
          ].join("\n"),
          true,
        );
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(json);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
        parsed = value as Record<string, unknown>;
      } catch {
        await send('\u274C That is not a JSON object. Expected {"name", "purpose", "host"/"client"}.', false);
        return;
      }
      const str = (key: string): string | undefined => (typeof parsed[key] === "string" ? (parsed[key] as string) : undefined);
      const res = await defineDynamicCordis(ctx, agentId, {
        name: str("name") ?? "",
        purpose: str("purpose") ?? "",
        host: str("host"),
        client: str("client"),
      }, typeof parsed["pluginId"] === "string" ? (parsed["pluginId"] as string) : undefined);
      await send(res.text, res.ok);
      if (res.ok) refreshAllPanels();
      return;
}


/** /bar — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function barCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, send } = c;
  const { state, setBarCollapsed } = deps;
      const target = args.trim().toLowerCase();
      const collapsed = target === "on"
        ? false
        : target === "off"
          ? true
          : state.barCollapsed.get(chatId) !== true;
      await setBarCollapsed(chatId, collapsed);
      await send(collapsed ? "Bar hidden \u2014 use /bar or Menu \u2192 \u{1F4A1} \u663E\u793A Bar to restore." : "Bar shown.");
      return;
}


/** /menucheck — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function menuSelfCheckCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, send } = c;
  const { requireCtx, currentAgent, openCard } = deps;
      const checkCtx = requireCtx();
      const checkAgent = currentAgent(chatId);
      const checks: [string, () => unknown | Promise<unknown>][] = [
        ["status", () => statusSnapshot(checkCtx)],
        ["models", () => modelCatalog(checkCtx, {})],
        ["plugins", () => listPlugins(checkCtx)],
        ["sessions", () => listSessionDetails(checkCtx)],
        ["history", () => readHistory(checkCtx, checkAgent?.id ?? "", 1)],
        ["queue", () => (checkAgent ? listQueue(checkCtx, checkAgent.id) : [])],
        ["workspaces", () => listWorkspaces(checkCtx)],
        ["goals", () => getGoal(checkCtx, checkAgent?.id ?? "")],
        ["todos", () => (checkAgent ? listTodos(checkCtx, checkAgent.id) : [])],
        ["skills", () => listSkills(checkCtx)],
        ["subagents", () => listSubagents(checkCtx, checkAgent?.id ?? "")],
        ["presets", () => listAgentPresets(checkCtx)],
        ["settings", () => describeSettings(checkCtx)],
        ["credentials", () => describeCredential(checkCtx, "")],
        ["host", () => describeHost(checkCtx)],
        ["jobs", () => listJobs(checkCtx, checkAgent?.id)],
        ["dynamic", () => listDynamicCordis(checkCtx)],
        ["capabilities", () => probeCapabilities(checkCtx)],
        ["mode", () => modeSummary()],
      ];
      const lines = ["\u{1FA7A} Menu self-check", ""];
      let failures = 0;
      for (const [label, fn] of checks) {
        try {
          await fn();
          lines.push(`\u2705 ${label}`);
        } catch (err) {
          failures += 1;
          lines.push(`\u274C ${label} \u2014 ${plain(truncate(err instanceof Error ? err.message : String(err), 60))}`);
        }
      }
      lines.push("", failures === 0 ? "All menu data sources are healthy." : `${failures} check(s) failed.`);
      await openCard(chatId, lines.join("\n"), buildBackKeyboard());
      return;
}


/** Secret-shaped config leaf paths (RE-3): a get of these echoes only the
 * last four characters, so API keys never land in the Telegram cloud chat
 * record. Exported so the `/telegram config` twin in index.ts can mask with
 * the exact same rule. */
const SECRET_CONFIG_PATH_RE = /(api[-_]?key|token|secret|password)$/i;

export function maskConfigValue(path: string, value: unknown): string {
  return SECRET_CONFIG_PATH_RE.test(path) ? `***${String(value).slice(-4)}` : `${JSON.stringify(value)}`;
}

/** /config — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function configCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, send } = c;
  const { state, applyConfigLive } = deps;
      // RH-1: tokens split at the FIRST space after each position instead of
      // `split(/\s+/)` + join(" "), which silently collapsed runs of spaces
      // inside JSON values before persisting them (same discipline as
      // settingsupdate). Leading whitespace between tokens is trimmed away —
      // only value-interior spacing must survive.
      const opEnd = args.indexOf(" ");
      const op = (opEnd === -1 ? args : args.slice(0, opEnd)).trim();
      const tail = (opEnd === -1 ? "" : args.slice(opEnd + 1)).trim();
      const pathEnd = tail.indexOf(" ");
      const path = (pathEnd === -1 ? tail : tail.slice(0, pathEnd)).trim();
      const jsonText = pathEnd === -1 ? "" : tail.slice(pathEnd + 1).trimStart();
      if (!op || !path) {
        await send("/config get <path> \u00B7 /config set <path> <json> \u2014 hot-applies + persists under .pi/telegram.json\nForever-allow a tool: /config set interactive.allowByTool [\"bash\"] \u00B7 revoke: []");
        return;
      }
      try {
        if (op === "get") {
          await send(`${path} = ${maskConfigValue(path, getConfigPath(state.config, path))}`);
          return;
        }
        if (op === "set") {
          const value = JSON.parse(jsonText);
          const { config, changed } = overlayConfig(state.config, patchFromPath(path, value));
          if (changed.length === 0) {
            await send(`Unknown config path ${path}.`, false);
            return;
          }
          state.config = config;
          applyConfigLive(changed);
          writeConfig(state.configRoot, state.config);
          await send(`\u2705 ${path} \u2192 applied live + persisted (${changed.join(", ")})`);
          return;
        }
      } catch (err) {
        await send(err instanceof Error ? err.message : String(err), false);
        return;
      }
      await send("Usage: /config get <path> \u00B7 /config set <path> <json>", false);
      return;
}


/** /history — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function historyCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, ctx, send, t } = c;
  const { boundAgentId } = deps;
      const [id, limitText] = args.trim().split(/\s+/);
      const sessionId = id || boundAgentId(chatId);
      if (!sessionId) {
        await send("No session id given and none bound.");
        return;
      }
      // Structured trajectory view (issue #32): turn-grouped like the web's
      // 轨迹 ledger. The optional second arg caps how many turns are shown.
      const maxTurns = Math.max(1, Math.min(20, Number(limitText) || 6));
      const result = await readTrajectory(ctx, sessionId, maxTurns);
      // Design language: the trajectory renders Telegram HTML (bold turn
      // labels, monospace models, expandable fold). Send it through the UI
      // control lane with parse_mode HTML; if the API ever rejects the
      // markup, degrade to the escaped plain reply instead of dropping it.
      const html = renderTrajectoryLines(sessionId, result).join("\n");
      try {
        await t.sendTextControl(chatId, html, { parse_mode: "HTML" });
      } catch {
        await send(html.replace(/<[^>]+>/g, ""));
      }
      return;
}


/** /search — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function searchCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, send } = c;
  const { openSearchCard } = deps;
      const query = args.trim();
      if (!query) {
        await send("usage: /search <query>");
        return;
      }
      return openSearchCard(chatId, query);
}


/** /rename — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function renameCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, ctx, send } = c;
  const { boundAgentId, armPending } = deps;
      const title = args.trim();
      const sessionId = boundAgentId(chatId);
      if (!sessionId) {
        await send("No bound session \u2014 use the Sessions card.");
        return;
      }
      if (!title) {
        armPending(chatId, { kind: "rename", sessionId });
        await send(`Reply with just the title to rename ${plain(truncate(sessionId, 24))}:`);
        return;
      }
      const res = renameSession(ctx, sessionId, title);
      await send(res.text, res.ok);
      return;
}


/** /fork — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function forkCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, ctx, send } = c;
  const { boundAgentId } = deps;
      const sessionId = boundAgentId(chatId);
      if (!sessionId) {
        await send("No bound session \u2014 use the Sessions card.");
        return;
      }
      const atSeq = args.trim() ? Number(args.trim()) : undefined;
      const res = forkSession(ctx, sessionId, Number.isFinite(atSeq) ? atSeq : undefined);
      await send(res.text, res.ok);
      return;
}


/** /use — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function useCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, ctx, send } = c;
  const { boundAgentId, sessionLifecycle, state } = deps;
      const id = args.trim();
      if (!id) {
        await send("usage: /use <sessionId>");
        return;
      }
      const live = sessionLifecycle.find(ctx, id);
      if (live) {
        state.bridge?.bindAgent(chatId, id);
        await send(`\u{1F3AF} Switched to ${plain(truncate(id, 24))}.`);
      } else {
        // Same explicit inheritance as the Sessions-card `Use` tap (🟠-17).
        const res = await resumeSession(ctx, id, boundAgentId(chatId));
        if (res.ok && res.agentId !== undefined) {
          if (res.handle !== undefined) sessionLifecycle.adopt(res.handle);
          state.bridge?.bindAgent(chatId, res.agentId);
          await send(res.text, true);
        } else {
          await send(res.text, false);
        }
      }
      return;
}


/** /archive — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function archiveCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, ctx, send } = c;
  const { boundAgentId } = deps;
      const res = await archiveSession(ctx, args.trim() || boundAgentId(chatId) || "");
      await send(res.text, res.ok);
      return;
}


/** /steer — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function steerCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, ctx, send } = c;
  const { boundAgentId } = deps;
      const text = args.trim();
      const sessionId = boundAgentId(chatId);
      if (!sessionId || !text) {
        await send("usage: /steer <text> (needs a bound session)");
        return;
      }
      const res = promptSession(ctx, sessionId, text, "steer");
      await send(res.text, res.ok);
      return;
}


/** /queueedit — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function queueEditCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, ctx, send } = c;
  const { boundAgentId } = deps;
      const [itemId, ...rest] = args.trim().split(/\s+/);
      const text = rest.join(" ");
      const sessionId = boundAgentId(chatId);
      if (!sessionId || !itemId || !text) {
        await send("usage: /queueedit <itemId> <text>");
        return;
      }
      const res = updateQueueItem(ctx, sessionId, itemId, { kind: "edit", content: text });
      await send(res.text, res.ok);
      return;
}


/** /goal / /goalcreate — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function goalCreateCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, ctx, agent, send } = c;
      const parts = args.trim().split(/\s+/);
      // RH-2: only a positive INTEGER final token counts as maxRounds —
      // "Deploy 2.0 to prod" keeps its version number, and -3 / 0 / 2.5 are
      // no longer silently accepted as round limits.
      const last = parts[parts.length - 1] ?? "";
      const n = Number(last);
      const maxRounds = parts.length > 1 && Number.isInteger(n) && n > 0 ? n : undefined;
      const objective = maxRounds !== undefined ? parts.slice(0, -1).join(" ") : parts.join(" ");
      if (!agent) {
        await send("No live agent \u2014 goals are per-agent.", false);
        return;
      }
      if (!objective) {
        await send("usage: /goal <objective> [maxRounds]");
        return;
      }
      const res = await createGoal(ctx, agent.id, objective, maxRounds);
      await send(res.text, res.ok);
      return;
}


/** /goaledit — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function goalEditCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, ctx, agent, send } = c;
      const parts = args.trim().split(/\s+/);
      // RH-2: same positive-integer rule as /goal — a non-integer or
      // non-positive trailing token stays inside the objective text.
      const last = parts[parts.length - 1] ?? "";
      const n = Number(last);
      const maxRounds = parts.length > 1 && Number.isInteger(n) && n > 0 ? n : undefined;
      const objective = (maxRounds === undefined ? parts : parts.slice(0, -1)).join(" ");
      const goal = agent ? getGoal(ctx, agent.id) : undefined;
      if (!agent || !goal || !objective) {
        await send("usage: /goaledit <objective> [maxRounds] (needs a current goal)");
        return;
      }
      const res = await editGoal(ctx, agent.id, goal.id, goal.revision, {
        objective,
        ...(maxRounds === undefined ? {} : { maxGoalRounds: maxRounds }),
      });
      await send(res.text, res.ok);
      return;
}


/** /goalclear — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function goalClearCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, ctx, agent, send } = c;
  const { refreshAllPanels } = deps;
      const goal = agent ? getGoal(ctx, agent.id) : undefined;
      if (!agent || !goal) {
        await send("No current goal to clear.", false);
        return;
      }
      const res = await clearGoal(ctx, agent.id, goal.id, goal.revision);
      await send(res.text, res.ok);
      refreshAllPanels();
      return;
}


/** /workspacecreate — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function workspaceCreateCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, ctx, send } = c;
      const parts = args.trim().split(/\s+/);
      const path = parts[0] ?? "";
      const title = parts.slice(1).join(" ");
      const res = await createWorkspace(ctx, path, title || undefined, deps.state.config.security.browseRoots);
      await send(res.text, res.ok);
      return;
}


/** /workspacerename — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function workspaceRenameCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, ctx, send } = c;
      const [id, ...rest] = args.trim().split(/\s+/);
      const res = await renameWorkspace(ctx, id ?? "", rest.join(" "));
      await send(res.text, res.ok);
      return;
}


/** /workspacepin — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function workspacePinCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, ctx, send } = c;
      const [workspaceId, sessionId, beforeSessionId] = args.trim().split(/\s+/);
      const res = await insertSessionBefore(ctx, workspaceId ?? "", sessionId ?? "", beforeSessionId || undefined);
      await send(res.text, res.ok);
      return;
}


/** /pluginenable / /plugindisable — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function pluginToggleCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { command, args, ctx, send } = c;
      const name = args.trim();
      if (!name) {
        await send(`usage: /${command} <plugin-name>`);
        return;
      }
      const entryId = entryIdFor(ctx, name);
      if (!entryId) {
        await send(`plugin entry ${plain(name)} not found \u2014 check /plugins.`);
        return;
      }
      const res = await togglePlugin(ctx, entryId, command === "plugindisable");
      await send(res.text, res.ok);
      return;
}


/** /settingsdescribe — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function settingsDescribeCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, ctx, send } = c;
      const ns = args.trim();
      const { writable, hasDocument, namespaces } = describeSettings(ctx);
      if (ns) {
        const view = namespaces.find((candidate) => candidate.ns === ns);
        if (!view) {
          await send(`namespace ${plain(ns)} not found`);
        } else {
          await send(`\u2699\uFE0F ${plain(ns)} \u00B7 applies ${view.applies} \u00B7 rev ${view.revision}\nvalue: ${plain(truncate(JSON.stringify(view.value), 800))}\nsecrets: ${view.secrets.map((s) => `${s.path.join(".")}=${s.set ? "set" : "unset"}`).join(", ") || "none"}`);
        }
      } else {
        await send(`writable: ${writable} \u00B7 document: ${hasDocument} \u00B7 namespaces: ${namespaces.map((n) => plain(n.ns)).join(", ") || "none"}`);
      }
      return;
}


/** /settingsupdate — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function settingsUpdateCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, ctx, send } = c;
      const space = args.indexOf(" ");
      const ns = space === -1 ? args.trim() : args.slice(0, space);
      const raw = space === -1 ? "" : args.slice(space + 1).trim();
      if (!ns || !raw) {
        await send("usage: /settingsupdate <ns> <json patch> [expectedRevision]");
        return;
      }
      const parsed = parseJsonWithRevision(raw);
      if (parsed === undefined) {
        await send("patch must be valid JSON");
        return;
      }
      const patch = JSON.parse(parsed.json) as object;
      const res = await updateSettings(ctx, ns, patch, parsed.revision);
      await send(res.text, res.ok);
      return;
}


/** /settingsreplace — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function settingsReplaceCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, ctx, send } = c;
      const space = args.indexOf(" ");
      const ns = space === -1 ? args.trim() : args.slice(0, space);
      const raw = space === -1 ? "" : args.slice(space + 1).trim();
      if (!ns || !raw) {
        await send("usage: /settingsreplace <ns> <json section> [expectedRevision]");
        return;
      }
      const parsed = parseJsonWithRevision(raw);
      if (parsed === undefined) {
        await send("section must be valid JSON");
        return;
      }
      const section = JSON.parse(parsed.json) as unknown;
      if (section === null || typeof section !== "object" || Array.isArray(section)) {
        await send("section must be a JSON object");
        return;
      }
      const res = await replaceSettings(ctx, ns, section as object, parsed.revision);
      await send(res.text, res.ok);
      return;
}


/** /settingsmutate — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function settingsMutateCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, ctx, send } = c;
      const space = args.indexOf(" ");
      const ns = space === -1 ? args.trim() : args.slice(0, space);
      const raw = space === -1 ? "" : args.slice(space + 1).trim();
      if (!ns || !raw) {
        await send("usage: /settingsmutate <ns> <json ops> [expectedRevision] \u2014 ops: [{\"op\":\"set|unset\",\"path\":[\"a\",\"b\"],\"value\":1}]");
        return;
      }
      const parsed = parseJsonWithRevision(raw);
      if (parsed === undefined) {
        await send("ops must be valid JSON");
        return;
      }
      const ops = JSON.parse(parsed.json) as unknown;
      if (!Array.isArray(ops)) {
        await send("ops must be a JSON array");
        return;
      }
      const res = await mutateSettings(ctx, ns, ops as { op: "set" | "unset"; path: string[]; value?: unknown }[], parsed.revision);
      await send(res.text, res.ok);
      return;
}


/** /credential — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function credentialDescribeCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, ctx, send } = c;
      const res = await describeCredentials(ctx, args.trim().split(/\s+/));
      await send(res.text, res.ok);
      return;
}


/** /credentialset — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function credentialSetCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, messageId, ctx, t, send } = c;
  const { log } = deps;
      const space = args.indexOf(" ");
      const ref = space === -1 ? args.trim() : args.slice(0, space);
      const value = space === -1 ? "" : args.slice(space + 1);
      // The value is a secret: queue the command-message deletion BEFORE the
      // follow-up so the same per-chat queue guarantees the secret is removed
      // before the bot's own result arrives — no timer race, no restart gap.
      if (messageId !== undefined) {
        void t.deleteMessageControl(chatId, messageId).catch((err) => log("credential command delete failed", err));
      }
      const res = await setCredential(ctx, ref, value);
      await send(res.text, res.ok);
      return;
}


/** /credentialunset — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function credentialUnsetCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, ctx, send } = c;
      const res = await unsetCredential(ctx, args.trim());
      await send(res.text, res.ok);
      return;
}


/** /ls — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function lsCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, send } = c;
  const { state } = deps;
      const res = await listDirectory(args.trim() || state.workspaceRoot, state.config.security.browseRoots);
      await send(res.text, res.ok);
      return;
}


/** /attachment — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function attachmentCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, ctx, t, send } = c;
      const attachmentId = args.trim();
      if (!attachmentId) {
        await send("usage: /attachment <attachmentId> \u2014 send a photo first to create an attachment.");
        return;
      }
      const res = await readImageAttachment(ctx, attachmentId);
      if (!res.ok || res.data === undefined) {
        await send(res.text, res.ok);
        return;
      }
      const ext = res.mediaType === "image/png" ? "png" : res.mediaType === "image/jpeg" ? "jpg" : "img";
      const sent = await t.sendPhoto(chatId, Buffer.from(res.data, "base64"), `attachment-${attachmentId.slice(0, 16)}.${ext}`, `\u{1F5BC} ${plain(truncate(attachmentId, 24))}`);
      await send(sent === undefined ? `\u274C ${plain(res.text)}` : res.text, sent !== undefined);
      return;
}


/** /mkdir — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function mkdirCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, send } = c;
  const { state } = deps;
      const res = await createDirectory(args.trim(), state.config.security.browseRoots);
      await send(res.text, res.ok);
      return;
}


/** /pickdir — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function pickdirCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, send } = c;
  const { state, applyProjectPath, openProjectCard } = deps;
      const target = args.trim() || state.workspaceRoot;
      if (args.trim() !== "") return applyProjectPath(chatId, target);
      await send(pickDirectoryHint(state.workspaceRoot).text);
      return openProjectCard(chatId);
}


/** /openpath — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function openpathCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, send } = c;
  const { state } = deps;
      const res = openPath(args.trim() || state.workspaceRoot, state.config.security.browseRoots);
      await send(res.text, res.ok);
      return;
}


/** /discover — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function discoverCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { args, ctx, send } = c;
      const [settingsNs, baseURL] = args.trim().split(/\s+/);
      if (!settingsNs) {
        await send("usage: /discover <settingsNs> [baseURL]");
        return;
      }
      const res = await discoverModels(ctx, settingsNs, baseURL ? { baseURL } : {});
      await send(res.text, res.ok);
      return;
}


/** /subagentprompt — body moved verbatim from the former
 * dispatchCommand switch case. B-4r: kind-filtered take so an input of
 * another kind stays armed instead of being swallowed here. */
export async function subagentpromptCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, ctx, send } = c;
  const { takePending } = deps;
      const input = takePending(chatId, "subagentPrompt");
      if (input?.kind !== "subagentPrompt") {
        await send("Open a subagent first, then reply with the prompt text.");
        return;
      }
      const res = await promptSubagent(ctx, input.parentId, input.childId, args.trim());
      await send(res.text, res.ok);
      return;
}


/** /sessionlog — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function sessionlogCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { chatId, args, ctx, t, send } = c;
  const { boundAgentId } = deps;
      const sessionId = args.trim() || boundAgentId(chatId);
      if (!sessionId) {
        await send("usage: /sessionlog <sessionId>");
        return;
      }
      await send("Building the session-log ZIP (same archive the web serves)\u2026");
      const exported = await exportSessionLog(ctx, sessionId, true);
      if (exported.result.ok && exported.buffer) {
        // RH-8: sanitize the id into a filename the uploader accepts — raw
        // session ids with path-ish characters made sendDocument fail on the
        // very last step (same shape as the s:log card's `session-<id>.zip`).
        const fileName = `session-${sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 32)}.zip`;
        await t.sendDocument(chatId, exported.buffer, fileName, `${sessionId} \u00B7 session log`);
        await send(exported.result.text, true);
      } else {
        await send(exported.result.text, false);
      }
      return;
}


/** /commands — body moved verbatim from the former
 * dispatchCommand switch case. */
export async function commandsListCommand(deps: DispatchDeps, c: CommandCall): Promise<void> {
  const { agent, ctx, send } = c;
      if (!agent) {
        await send("No live agent \u2014 commands are agent-scoped.");
        return;
      }
      const commands = listCommands(ctx, agent);
      const lines = [`\u2328\uFE0F Commands (${commands.length})`, ""];
      for (const entry of commands) lines.push(`/${entry.name}${entry.input ? ` ${entry.input}` : ""} \u2014 ${plain(truncate(entry.description, 60))}`);
      await send(lines.join("\n"));
      return;
}
