/**
 * Pure keyboard builders.
 *
 * - The persistent reply-keyboard bar carries the 9 hot functions
 *   (3 rows x 3). `BAR_LABELS` keeps superseded labels so stale
 *   persisted bars on clients still dispatch correctly.
 * - The `☰ Menu` inline card carries the paginated CORE rows.
 * - The "all functions" inline card is available through `⚙️ All` callbacks.
 *
 * Builders are pure: no dsh imports, no I/O, trivially unit-testable.
 */
import { InlineKeyboard, Keyboard } from "grammy";

export const MENU_BTN = "\u2630 Menu";
export const NEW_BTN = "\u2728 New";
export const COMPACT_BTN = "\u{1F9F9} Compact";
export const MODELS_BTN = "\u{1F9E9} Models";
export const PLUGINS_BTN = "\u{1F50C} Plugins";
export const MODE_BTN = "\u{1F3AD} Mode";
export const SESSIONS_BTN = "\u{1F9ED} Sessions";
export const STATUS_BTN = "\u{1F4CA} Status";
export const QUEUE_BTN = "\u231B Queue";
export const QUEUE_BTN_PREFIX = `${QUEUE_BTN} \u00B7 `;
export const GOAL_BTN = "\u{1F3AF} Goal";
export const TODO_BTN = "\u{1F4CB} Todos";
export const TODO_BTN_PREFIX = `${TODO_BTN} \u00B7 `;
/** Kept so clients with stale bars still dispatch; no longer rendered on the bar. */
export const PRESETS_BTN = "\u{1F3AD} Presets";
export const THINKING_BTN = "\u{1F9E0} Thinking";
/** Bar label for the reasoning picker (unified name; THINKING_BTN kept for
 * stale client bars). */
export const REASONING_BTN = "\u{1F9E0} Reasoning";
/** Abort the current turn only; `/stop` is the command that closes the session. */
export const ABORT_BTN = "\u23F9 Abort";
/** Legacy bar label from older clients; still dispatches to abort. */
export const STOP_BTN = "\u23F9 Stop";
/** Collapses the whole bar to a single return button (more chat history visible). */
export const COLLAPSE_BTN = "\u{1F5DC}\uFE0F \u6536\u8D77";
/** The one button left on a collapsed bar; tapping it restores the full bar. */
export const RETURN_BTN = "\u8FD4\u56DE";
/** Stale client bars from earlier builds keep these labels working. */
export const LEGACY_COLLAPSE_BTN = "\u{1F648} \u6536\u8D77";
export const LEGACY_RETURN_BTN = "\u{1F519} \u8FD4\u56DE";

export const BAR_LABELS: readonly string[] = [
  MENU_BTN,
  NEW_BTN,
  COMPACT_BTN,
  MODELS_BTN,
  PLUGINS_BTN,
  MODE_BTN,
  SESSIONS_BTN,
  STATUS_BTN,
  QUEUE_BTN,
  GOAL_BTN,
  TODO_BTN,
  REASONING_BTN,
  THINKING_BTN,
  PRESETS_BTN,
  ABORT_BTN,
  STOP_BTN,
  COLLAPSE_BTN,
  RETURN_BTN,
  LEGACY_COLLAPSE_BTN,
  LEGACY_RETURN_BTN,
];

/** Queue button label with a live count embedded (`⌛ Queue · 3`). */
export function queueBarLabel(queueCount: number): string {
  return `${QUEUE_BTN_PREFIX}${queueCount}`;
}

/** Todo button label with the remaining count embedded (`📋 Todos · 3`). */
export function todoBarLabel(todoCount: number): string {
  return `${TODO_BTN_PREFIX}${todoCount}`;
}

const callbackBytes = (value: string): number => new TextEncoder().encode(value).length;

/** Build `<prefix><url-encoded value>` bounded to Telegram's 64-byte
 * callback_data limit by trimming the raw value before encoding, so the
 * result is always valid percent-encoding (never truncated mid-sequence). */
export function encodedCallback(prefix: string, value: string): string {
  let trimmed = value;
  while (trimmed.length > 0 && callbackBytes(prefix + encodeURIComponent(trimmed)) > 64) {
    trimmed = trimmed.slice(0, -1);
  }
  return prefix + encodeURIComponent(trimmed);
}

/** Decode a callback payload that should be percent-encoded. Legacy cards or
 * providers whose ids contain a literal `%` are decoded best-effort; a
 * malformed sequence must return the raw value instead of killing the tap. */
export function decodeCallbackValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Always-visible bar grouped by frequency:
 * `Menu · New · Models` / `Sessions · Plugins · Status` /
 * `Goal · Queue · Compact` / `Todos · Abort · 收起`. `🧠 Reasoning` stays
 * reachable from the menu P1. Pass `queueCount`/`todoCount` for live counts. */
export function buildBarKeyboard(queueCount?: number, todoCount?: number): Keyboard {
  return new Keyboard()
    .text(MENU_BTN)
    .text(NEW_BTN)
    .text(MODELS_BTN)
    .row()
    .text(SESSIONS_BTN)
    .text(PLUGINS_BTN)
    .text(STATUS_BTN)
    .row()
    .text(GOAL_BTN)
    .text(queueCount === undefined ? QUEUE_BTN : queueBarLabel(queueCount))
    .text(COMPACT_BTN)
    .row()
    .text(todoCount === undefined ? TODO_BTN : todoBarLabel(todoCount))
    .text(ABORT_BTN)
    .text(COLLAPSE_BTN)
    .resized()
    .persistent();
}

/** Collapsed bar: only the return button, so the chat itself gets the screen. */
export function buildCollapsedBarKeyboard(): Keyboard {
  return new Keyboard().text(RETURN_BTN).resized().persistent();
}

/** Map inbound bar-button text back to its canonical label. The Queue
 * button's text changes as the live count is embedded (`⌛ Queue · 7`), so
 * exact BAR_LABELS matching alone would drop those taps. */
export function normalizeBarLabel(text: string): string | undefined {
  if (text === LEGACY_COLLAPSE_BTN) return COLLAPSE_BTN;
  if (text === LEGACY_RETURN_BTN) return RETURN_BTN;
  if (text === STOP_BTN) return ABORT_BTN;
  if ((BAR_LABELS as readonly string[]).includes(text)) return text;
  if (text.startsWith(QUEUE_BTN_PREFIX)) return QUEUE_BTN;
  if (text.startsWith(TODO_BTN_PREFIX)) return TODO_BTN;
  return undefined;
}

export interface CoreMenuState {
  model: string;
  /** Omitted for models without reasoning controls (hidden row, pi-style). */
  thinking?: string;
  queueCount: number;
  /** Active project folder name (Codex-style). */
  project?: string;
}

/** `☐ Menu` core card: pi-telegram status-menu style — full-width
 * status rows up top, then segmented domain rows, then full-width closers. */
export function buildCoreMenu(state: CoreMenuState): InlineKeyboard {
  const kb = new InlineKeyboard().text(`${MODELS_BTN} \u00B7 ${state.model}`, "m:models");
  if (state.thinking !== undefined) kb.row().text(`\u{1F9E0} Thinking \u00B7 ${state.thinking}`, "m:thinking");
  kb.row().text(`\u231B Queue \u00B7 ${state.queueCount}`, "m:queue");
  kb.row().text(`\u{1F4C1} Project \u00B7 ${state.project ?? "..."}`, "m:project");
  kb.row().text(NEW_BTN, "m:new").text(COMPACT_BTN, "m:compact");
  kb.row().text(SESSIONS_BTN, "m:sessions");
  kb.row().text(STATUS_BTN, "m:status").text(PLUGINS_BTN, "m:plugins");
  kb.row().text(MODE_BTN, "m:mode");
  kb.row().text("\u{1F5C2} Workspaces", "m:workspaces").text("\u{1F3AF} Goals", "m:goals");
  kb.row().text("\u{1F9EC} Skills", "m:skills").text("\u{1F916} Subagents", "m:subagents");
  kb.row().text("\u{1F3AD} Presets", "m:presets").text("\u{1F6E0}\uFE0F Host settings", "m:hostsettings");
  kb.row().text("\u{1F511} Credentials", "m:credentials").text("\u{1F4BB} Host", "m:host");
  kb.row().text("\u{1F4CB} Jobs", "m:jobs").text("\u269B\uFE0F Dynamic", "m:dynamic");
  kb.row().text("\u{1F9EC} Capabilities", "m:capabilities");
  kb.row().text("\u2699\uFE0F Settings", "m:settings");
  kb.row().text("\u2716 Close", "m:close");
  return kb;
}

export interface MenuItem {
  label: string;
  cb: string;
  /** Full-width row; otherwise items pair two-per-row. */
  full?: boolean;
}

/** Dense paginated menu (codex-bridge style): primary items full-width,
 * the rest paired two-per-row, then prev/page/next + close. */
export function buildMenuPage(items: readonly MenuItem[], page: number, total: number): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  const pair: { text: string; callback_data: string }[] = [];
  const flush = () => {
    if (pair.length > 0) {
      rows.push([...pair]);
      pair.length = 0;
    }
  };
  for (const item of items.slice(0, 30)) {
    const button = { text: item.label.slice(0, 32), callback_data: item.cb };
    if (item.full) {
      flush();
      rows.push([button]);
    } else {
      pair.push(button);
      if (pair.length === 2) flush();
    }
  }
  flush();
  const nav: { text: string; cb: string }[] = [];
  if (page > 0) nav.push({ text: "\u2B05\uFE0F Prev", cb: "m:prev" });
  // The header already carries `page X/Y`; a tappable page-number button is a
  // dead-looking control, so it is deliberately omitted.
  if (page < total - 1) nav.push({ text: "More \u27A1\uFE0F", cb: "m:more" });
  if (nav.length > 0) {
    rows.push(nav.map((button) => ({ text: button.text, callback_data: button.cb })));
  }
  rows.push([{ text: "\u2716 Close", callback_data: "m:close" }]);
  return InlineKeyboard.from(rows);
}

/** Single "back to menu" row for domain cards that only need one action. */
export function buildBackKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("\u2190 Back", "m:back");
}

/** Two-button confirmation row for destructive actions. */
export function buildConfirmKeyboard(callbacks: { confirm: string; cancel: string }): InlineKeyboard {
  return new InlineKeyboard()
    .text("\u2705 Confirm", callbacks.confirm)
    .text("\u2716 Cancel", callbacks.cancel);
}

export interface ProjectRow {
  label: string;
  cb: string;
}

export interface ProjectActions {
  up?: string;
  home?: string;
  root?: string;
  use?: string;
  close?: string;
  menu?: string;
  newFolder?: string;
  quick?: readonly ProjectRow[];
  paging?: readonly { text: string; cb: string }[];
  /** Breadcrumb segment buttons (host.listDirectory navigation), rendered
   * right below the Up/Home/Root row. */
  breadcrumb?: readonly ProjectRow[];
}

/** Folder picker: nav row (Up/Home/Root) + quick workspace paths, then
 * directory entries two per row, then Use/Close. Pure builder — callback
 * payloads are pre-encoded by index.ts. */
export function buildProjectKeyboard(dirs: readonly ProjectRow[], actions: ProjectActions): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  const nav: { text: string; cb: string }[] = [];
  if (actions.up !== undefined) nav.push({ text: "\u2B06\uFE0F Up", cb: actions.up });
  if (actions.home !== undefined) nav.push({ text: "\u{1F3E0} ~", cb: actions.home });
  if (actions.root !== undefined) nav.push({ text: "\u{1F5A5}\uFE0F /", cb: actions.root });
  if (nav.length > 0) {
    rows.push(nav.slice(0, 3).map((button) => ({ text: button.text, callback_data: button.cb })));
  }
  const breadcrumb = (actions.breadcrumb ?? []).slice(0, 3);
  if (breadcrumb.length > 0) {
    rows.push(breadcrumb.map((segment) => ({ text: `\u{1F4C2} ${segment.label.slice(0, 16)}`, callback_data: segment.cb })));
  }
  for (const quick of (actions.quick ?? []).slice(0, 3)) rows.push([{ text: quick.label.slice(0, 40), callback_data: quick.cb }]);
  const seen = new Set<string>();
  const pairs: { text: string; callback_data: string }[] = [];
  for (const entry of dirs) {
    if (seen.has(entry.cb)) continue;
    seen.add(entry.cb);
    pairs.push({ text: `\u{1F4C1} ${entry.label.slice(0, 26)}`, callback_data: entry.cb });
  }
  for (let index = 0; index < pairs.length; index += 2) {
    rows.push(index + 1 < pairs.length ? [pairs[index]!, pairs[index + 1]!] : [pairs[index]!]);
  }
  const paging: { text: string; callback_data: string }[] = [];
  for (const button of (actions.paging ?? []).slice(0, 3)) {
    paging.push({ text: button.text.slice(0, 40), callback_data: button.cb });
  }
  if (paging.length > 0) rows.push(paging);
  if (actions.newFolder !== undefined) rows.push([{ text: "\u{1F4C1} New folder", callback_data: actions.newFolder }]);
  if (actions.menu !== undefined) rows.push([{ text: "\u2630 Menu", callback_data: actions.menu }]);
  const footer: { text: string; callback_data: string }[] = [];
  if (actions.use !== undefined) footer.push({ text: "\u2705 Use this folder", callback_data: actions.use });
  if (actions.close !== undefined) footer.push({ text: "\u2716 Close", callback_data: actions.close });
  if (footer.length > 0) rows.push(footer);
  return InlineKeyboard.from(rows);
}

export const CALLBACK_RE = /^m:([a-z]+)(?::([\s\S]+))?$/;

// ---------------------------------------------------------------------------
// v0.2 web-parity cards: every domain gets a card + detail rows. Builders stay
// pure — callback payloads are encoded by index.ts and passed in as strings.
// ---------------------------------------------------------------------------

export interface SessionsPaging {
  previous?: string;
  next?: string;
}

/** Generic pagination row for text-heavy cards plus a back button. */
export function buildPagingKeyboard(callbacks: { previous?: string; next?: string; back: string }): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  if (callbacks.previous !== undefined || callbacks.next !== undefined) {
    const nav: { text: string; callback_data: string }[] = [];
    if (callbacks.previous !== undefined) nav.push({ text: "\u2039 Prev", callback_data: callbacks.previous });
    if (callbacks.next !== undefined) nav.push({ text: "More \u203A", callback_data: callbacks.next });
    rows.push(nav);
  }
  rows.push([{ text: "\u2190 Back", callback_data: callbacks.back }]);
  return InlineKeyboard.from(rows);
}

export function buildSearchKeyboard(ids: readonly string[], paging?: SessionsPaging): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  for (const id of ids.slice(0, 8)) {
    rows.push([{ text: `\u{1F9ED} ${id.slice(0, 30)}`, callback_data: `s:${id}`.slice(0, 64) }]);
  }
  if (paging !== undefined && (paging.previous !== undefined || paging.next !== undefined)) {
    const nav: { text: string; callback_data: string }[] = [];
    if (paging.previous !== undefined) nav.push({ text: "\u2039 Prev", callback_data: paging.previous });
    if (paging.next !== undefined) nav.push({ text: "More \u203A", callback_data: paging.next });
    rows.push(nav);
  }
  rows.push([{ text: "\u{1F50D} New search", callback_data: "m:search" }, { text: "\u2190 Sessions", callback_data: "m:sessions" }]);
  return InlineKeyboard.from(rows);
}

export interface SessionsKeyboardOptions {
  /** Project count for the switcher button; the button is omitted without a callback. */
  projectCount?: number;
  /** Token callback that opens the project switcher. */
  projectsCb?: string;
  paging?: SessionsPaging;
  back?: string;
}

export function buildSessionsKeyboard(
  items: readonly { id: string; title?: string; running?: boolean; archiveCb?: string; deleteCb?: string }[],
  options: SessionsKeyboardOptions = {},
): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  const top: { text: string; callback_data: string }[] = [];
  if (options.projectsCb !== undefined) {
    top.push({ text: `\u{1F504} \u9879\u76EE (${options.projectCount ?? 0})`, callback_data: options.projectsCb });
  }
  top.push({ text: "\u2728 New session", callback_data: "m:new" }, { text: "\u23F9 Stop", callback_data: "m:stop" });
  rows.push(top.slice(0, 3));
  for (const item of items.slice(0, 10)) {
    const label = item.title && item.title.trim() !== "" ? item.title : item.id;
    const suffix = item.title && item.title.trim() !== "" ? ` \u00B7 ${item.id.slice(0, 10)}` : "";
    const marker = item.running === true ? "\u25B6 " : "";
    const row: { text: string; callback_data: string }[] = [
      { text: `\u{1F9ED} ${marker}${label.slice(0, 22)}${suffix}`.slice(0, 48), callback_data: `s:${item.id}`.slice(0, 64) },
    ];
    if (item.archiveCb !== undefined) row.push({ text: "\u5F52\u6863", callback_data: item.archiveCb });
    if (item.deleteCb !== undefined) row.push({ text: "\u5220\u9664", callback_data: item.deleteCb });
    rows.push(row);
  }
  const paging = options.paging;
  if (paging !== undefined && (paging.previous !== undefined || paging.next !== undefined)) {
    const nav: { text: string; callback_data: string }[] = [];
    if (paging.previous !== undefined) nav.push({ text: "\u2039 Prev", callback_data: paging.previous });
    if (paging.next !== undefined) nav.push({ text: "More \u203A", callback_data: paging.next });
    rows.push(nav);
  }
  rows.push([{ text: "\u2190 Back", callback_data: options.back ?? "m:back" }]);
  return InlineKeyboard.from(rows);
}

export interface SessionProjectRow {
  label: string;
  running: number;
  total: number;
  cb: string;
}

export interface SessionProjectsKeyboardOptions {
  /** Optional "all sessions" flat-view callback. */
  all?: string;
  paging?: SessionsPaging;
  back: string;
}

/** Project switcher for the grouped Sessions card: running projects first
 * (the caller orders them), then paging and back. */
export function buildSessionProjectsKeyboard(
  items: readonly SessionProjectRow[],
  options: SessionProjectsKeyboardOptions,
): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  if (options.all !== undefined) {
    rows.push([{ text: "\u{1F310} \u5168\u90E8\u4F1A\u8BDD", callback_data: options.all }]);
  }
  for (const item of items.slice(0, 12)) {
    const status = item.running > 0 ? ` \u00B7 \u25B6${item.running}` : "";
    rows.push([{ text: `\u{1F4C1} ${item.label.slice(0, 26)}${status} \u00B7 \u5171${item.total}`.slice(0, 64), callback_data: item.cb }]);
  }
  if (options.paging !== undefined && (options.paging.previous !== undefined || options.paging.next !== undefined)) {
    const nav: { text: string; callback_data: string }[] = [];
    if (options.paging.previous !== undefined) nav.push({ text: "\u2039 Prev", callback_data: options.paging.previous });
    if (options.paging.next !== undefined) nav.push({ text: "More \u203A", callback_data: options.paging.next });
    rows.push(nav);
  }
  rows.push([{ text: "\u2190 Back", callback_data: options.back }]);
  return InlineKeyboard.from(rows);
}

export function buildHistoryKeyboard(sessionId: string, older?: string): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  if (older !== undefined) rows.push([{ text: "\u23EA Load older", callback_data: older }]);
  rows.push([{ text: "\u2190 Session", callback_data: `s:${sessionId}`.slice(0, 64) }]);
  return InlineKeyboard.from(rows);
}

export function buildSessionDetailKeyboard(id: string, archived: boolean, back = "m:sessions"): InlineKeyboard {
  const prefix = `s:${id}`.slice(0, 52);
  const kb = new InlineKeyboard();
  kb.row().text("\u{1F3AF} Use", `${prefix}:use`.slice(0, 64));
  kb.row().text("\u{1F4DC} History", `${prefix}:history`.slice(0, 64)).text("\u270F Rename", `${prefix}:rename`.slice(0, 64));
  kb.row().text("\u{1F500} Fork", `${prefix}:fork`.slice(0, 64)).text(archived ? "\u{1F4E5} Archived" : "\u{1F5C4} Archive", `${prefix}:archive`.slice(0, 64));
  kb.row().text("\u{1F4CE} Model", `${prefix}:model`.slice(0, 64)).text("\u231B Queue", `${prefix}:queue`.slice(0, 64));
  kb.row().text("\u{1F3AF} Steer", `${prefix}:steer`.slice(0, 64)).text("\u{1F4E6} Log", `${prefix}:log`.slice(0, 64));
  kb.row().text("\u23F9 Stop", `${prefix}:stop`.slice(0, 64)).text("\u{1F5D1} Delete", `${prefix}:delete`.slice(0, 64));
  return kb.row().text("\u2190 Sessions", back);
}

export function buildWorkspaceKeyboard(items: readonly { id: string; title: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const item of items.slice(0, 20)) {
    kb.text(`\u{1F5C2} ${item.title.slice(0, 30)}`, `w:${item.id}`.slice(0, 64)).row();
  }
  return kb.row().text("\u2795 Create", "w:create").text("\u2190 Back", "m:back");
}

export function buildWorkspaceDetailKeyboard(
  id: string,
  actions?: { use?: string; sessions?: string },
): InlineKeyboard {
  const prefix = `w:${id}`.slice(0, 52);
  const kb = new InlineKeyboard();
  if (actions?.use !== undefined) kb.row().text("\u2705 \u4F7F\u7528\u6B64\u9879\u76EE", actions.use);
  if (actions?.sessions !== undefined) kb.row().text("\u{1F9ED} \u4F1A\u8BDD", actions.sessions);
  kb.row().text("\u270F Rename", `${prefix}:rename`.slice(0, 64)).text("\u{1F5D1} Delete", `${prefix}:delete`.slice(0, 64));
  kb.row().text("\u2B06 Move up", `${prefix}:up`.slice(0, 64)).text("\u2193 Move down", `${prefix}:down`.slice(0, 64));
  kb.row().text("\u{1F4CC} Pin session first", `${prefix}:pin`.slice(0, 64));
  return kb.row().text("\u2190 Workspaces", "m:workspaces");
}

export interface QueueRow {
  itemId: string;
  kind: "next-turn" | "next-step";
  /** 0-based position in the combined inbox list; rendered as `#1`, `#2`, … */
  index?: number;
}

/** ForceReply keyboard for step-by-step text prompts: Telegram opens the
 * reply input automatically, which is much friendlier on a phone than asking
 * the user to find and quote a message manually. */
export function inputPromptKeyboard(placeholder: string): { force_reply: true; input_field_placeholder: string } {
  return { force_reply: true, input_field_placeholder: placeholder.slice(0, 64) };
}

export function buildQueueKeyboard(items: readonly QueueRow[]): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  for (const item of items.slice(0, 24)) {
    const prefix = `q:${item.itemId}`.slice(0, 52);
    const label = item.index === undefined ? item.itemId.slice(0, 8) : `#${item.index + 1}`;
    const kind = item.kind === "next-turn" ? "turn" : "step";
    // Editing text on a phone is the worst part of the queue UX. Instead of
    // asking for a reply-edited replacement, this card only offers delete
    // (then resend your message) and, for next-turn items, run-now.
    const row: { text: string; callback_data: string }[] = [
      { text: `\u{1F5D1} Delete ${label} \u00B7 ${kind}`, callback_data: `${prefix}:r`.slice(0, 64) },
    ];
    if (item.kind === "next-turn") row.push({ text: `\u26A1 Run ${label} now`, callback_data: `${prefix}:s`.slice(0, 64) });
    rows.push(row);
  }
  rows.push([{ text: "\u2190 Back", callback_data: "m:back" }]);
  return InlineKeyboard.from(rows);
}

export function buildModelsKeyboard(groups: readonly { id: string; name: string }[], providersCb?: string, currentProviderId?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const group of groups.slice(0, 20)) {
    // The current provider carries a check mark so the overview card shows
    // the selection at a glance, not only in the top-line string (#47).
    const marker = group.id === currentProviderId ? "\u2705 " : "";
    kb.text(`${marker}\u{1F4E1} ${group.name.slice(0, 30)}`, encodedCallback("mo:", group.id)).row();
  }
  if (providersCb !== undefined) kb.row().text("\u{1F6F0}\uFE0F Providers", providersCb);
  return kb.row().text("\u{1F50D} Discover models", "m:discover").text("\u2190 Back", "m:back");
}

/** Standalone Providers view (llm.providers): one row per provider plus back
 * to the Models card. Tapping a provider opens its model list. */
export function buildProvidersKeyboard(rows: readonly { label: string; cb: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const row of rows.slice(0, 20)) {
    kb.text(row.label.slice(0, 48), row.cb).row();
  }
  return kb.row().text("\u2190 Models", "m:models").text("\u2190 Back", "m:back");
}

/** New-session preset picker (web session.create's agentPreset): one
 * full-width default button plus a row per preset. */
export function buildNewSessionKeyboard(defaultCb: string, presets: readonly { id: string; isDefault: boolean; cb: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard().text("\u2728 Use default preset", defaultCb);
  for (const preset of presets.slice(0, 12)) {
    kb.row().text(`\u{1F3AD} ${preset.isDefault ? "\u2B50 " : ""}${preset.id.slice(0, 32)}`, preset.cb);
  }
  return kb.row().text("\u2716 Close", "m:close");
}

export interface ModelPaging {
  previous?: string;
  next?: string;
}

export function buildModelDetailKeyboard(
  models: readonly { id: string; name: string; cb: string }[],
  thinking?: { label: string; cb: string },
  paging?: ModelPaging,
): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  for (const model of models.slice(0, 12)) {
    rows.push([{ text: `${model.name.slice(0, 40)}${model.id === model.name ? "" : ` \u00B7 ${model.id.slice(0, 20)}`}`.slice(0, 60), callback_data: model.cb }]);
  }
  if (paging !== undefined && (paging.previous !== undefined || paging.next !== undefined)) {
    const nav: { text: string; callback_data: string }[] = [];
    if (paging.previous !== undefined) nav.push({ text: "\u2039 Prev", callback_data: paging.previous });
    if (paging.next !== undefined) nav.push({ text: "More \u203A", callback_data: paging.next });
    rows.push(nav);
  }
  if (thinking !== undefined) rows.push([{ text: `\u{1F9E0} Thinking \u00B7 ${thinking.label}`.slice(0, 64), callback_data: thinking.cb }]);
  rows.push([{ text: "\u2190 Providers", callback_data: "m:models" }]);
  return InlineKeyboard.from(rows);
}

/** Reasoning-effort picker: the fixed codex-telegram-bot levels
 * (minimal/low/medium/high/max), backend-independent. */
export function buildThinkingKeyboard(options: readonly { id: string; name: string; cb: string }[], current?: string): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  for (const option of options) {
    const checked = option.id === current;
    rows.push([{ text: `${checked ? "\u2705" : "\u25CB"} ${option.name.slice(0, 40)}`, callback_data: option.cb }]);
  }
  rows.push([{ text: "\u2190 Back", callback_data: "m:back" }]);
  return InlineKeyboard.from(rows);
}

export function buildGoalsKeyboard(
  hasGoal: boolean,
  callbacks: { edit?: string; toggle?: string; clear?: string },
  paused = false,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (hasGoal) {
    const actions: { text: string; callback_data: string }[] = [];
    if (callbacks.edit !== undefined) actions.push({ text: "\u270F Edit", callback_data: callbacks.edit });
    if (callbacks.toggle !== undefined) {
      actions.push({ text: paused ? "\u25B6 Resume" : "\u23F8 Pause", callback_data: callbacks.toggle });
    }
    if (actions.length > 0) kb.row(...actions.slice(0, 2));
    if (callbacks.clear !== undefined) kb.row().text("\u{1F5D1} Clear goal", callbacks.clear);
  }
  // No goal = display-only: starting a goal is the `/goal <objective>` command.
  return kb.row().text("\u2190 Back", "m:back");
}

export function buildSkillsKeyboard(): InlineKeyboard {
  return new InlineKeyboard().row().text("\u2190 Back", "m:back");
}

export function buildSubagentsKeyboard(entries: readonly { id: string; cb: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const entry of entries.slice(0, 20)) {
    kb.text(`\u{1F916} ${entry.id.slice(0, 30)}`, entry.cb).row();
  }
  return kb.row().text("\u2190 Back", "m:back");
}

export function buildSubagentDetailKeyboard(callbacks: { prompt?: string; interrupt?: string; history: string }): InlineKeyboard {
  const kb = new InlineKeyboard();
  const actions: { text: string; callback_data: string }[] = [];
  if (callbacks.prompt !== undefined) actions.push({ text: "\u{1F4E8} Prompt", callback_data: callbacks.prompt });
  if (callbacks.interrupt !== undefined) actions.push({ text: "\u23F9 Interrupt", callback_data: callbacks.interrupt });
  actions.push({ text: "\u{1F4DC} History", callback_data: callbacks.history });
  kb.row(...actions.slice(0, 3));
  return kb.row().text("\u2190 Subagents", "m:subagents");
}

export function buildPresetsKeyboard(entries: readonly { id: string; cb: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const entry of entries.slice(0, 20)) {
    kb.text(`${entry.id.slice(0, 34)}${entry.id.length > 34 ? "\u2026" : ""}`, entry.cb).row();
  }
  return kb.row().text("\u2190 Back", "m:back");
}

export function buildPresetDetailKeyboard(callbacks: { select: string; read: string; create: string; copy: string; remove: string; open: string; default: string }): InlineKeyboard {
  return new InlineKeyboard()
    .row()
    .text("\u{1F3AD} Select", callbacks.select)
    .text("\u{1F4C4} Read", callbacks.read)
    .row()
    .text("\u2728 New with this preset", callbacks.create)
    .row()
    .text("\u{1F4CB} Copy", callbacks.copy)
    .text("\u{1F5D1} Remove", callbacks.remove)
    .row()
    .text("\u2B50 Set default", callbacks.default)
    .row()
    .text("\u{1F4C2} Open document", callbacks.open)
    .row()
    .text("\u2190 Presets", "m:presets");
}

export function buildSettingsKeyboard(namespaces: readonly string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const ns of namespaces.slice(0, 20)) {
    kb.text(ns.slice(0, 40), encodedCallback("set:", ns)).row();
  }
  return kb.row().text("\u2190 Back", "m:back");
}

export function buildCredentialsKeyboard(refs?: readonly { ref: string; cb: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const row of (refs ?? []).slice(0, 12)) {
    kb.text(`\u{1F511} ${row.ref.slice(0, 40)}`, row.cb).row();
  }
  return kb.row().text("\u{1F511} Describe ref", "m:cred-describe").text("\u2190 Back", "m:back");
}

export function buildHostKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.row().text("\u{1F4C2} Browse cwd", "h:browse");
  kb.row().text("\u{1F4C1} Mkdir", "h:mkdir");
  return kb.row().text("\u2190 Back", "m:back");
}

export function buildJobsKeyboard(): InlineKeyboard {
  return new InlineKeyboard().row().text("\u2190 Back", "m:back");
}

export function buildDynamicCordisKeyboard(): InlineKeyboard {
  return new InlineKeyboard().row().text("\u2190 Back", "m:back");
}

export interface PluginRow {
  pluginId: string;
  running: boolean;
  callbacks: { run: string; stop: string; remove: string };
}

/** Issue #50: per-plugin lifecycle actions plus the Add entry. Long ids stay
 * out of the 64-byte callback limit — callers pass minted tokens. */
export function buildPluginLifecycleKeyboard(rows: readonly PluginRow[]): InlineKeyboard {
  const keyboard = new InlineKeyboard().text("\u2795 Add plugin", "p:add");
  for (const row of rows) {
    const label = row.pluginId.length > 24 ? `${row.pluginId.slice(0, 23)}\u2026` : row.pluginId;
    keyboard.row().text(`${row.running ? "\u23F8 Stop" : "\u25B6 Run"} ${label}`, row.running ? row.callbacks.stop : row.callbacks.run);
    keyboard.text("\u{1F5D1} Remove", row.callbacks.remove);
  }
  return keyboard.row().text("\u2190 Back", "m:back");
}

export function buildCapabilitiesKeyboard(): InlineKeyboard {
  return new InlineKeyboard().row().text("\u2190 Back", "m:back");
}

export function buildFeedbackKeyboard(callbacks: { positive: string; negative: string; list: string }): InlineKeyboard {
  return new InlineKeyboard().row().text("\u{1F44D}", callbacks.positive).text("\u{1F44E}", callbacks.negative).text("\u{1F4CB} Feedback list", callbacks.list);
}
