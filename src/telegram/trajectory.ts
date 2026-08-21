/**
 * Trajectory renderer (issue #32): the Web "轨迹" view is a turn-grouped
 * ledger (request header/model, tool calls with args and results, thinking,
 * per-turn outcome and duration) — not the flat `[seq] role text` event dump
 * `/history` used to print. This module renders `readTrajectory`'s data as
 * Telegram HTML lines shared by the History card and the `/history` command.
 */
import { escapeHtml, truncate } from "./html.js";
import type { TrajectoryResult, TrajectoryStep, TrajectoryTurn } from "../harness/adapters/sessions.js";

const STEP_ICONS: Record<TrajectoryStep["kind"], string> = {
  user: "\u{1F464}",
  assistant: "\u{1F916}",
  reasoning: "\u{1F9E0}",
  "tool-call": "\u{1F527}",
  "tool-result": "\u{1F4E5}",
};

/** A turn shows at most this many steps before folding the rest into a
 * counter line — a runaway tool loop must not blow Telegram's 4096-char
 * message ceiling. */
export const TRAJECTORY_MAX_STEPS_PER_TURN = 8;

/** Tool-call argument keys worth showing verbatim, in priority order: the
 * web trajectory surfaces the semantic argument (`read <path>`), not raw
 * JSON. */
const TOOL_ARG_KEYS = ["path", "cmd", "command", "query", "url", "file", "pattern", "id", "name", "objective"] as const;

/** Fold every whitespace run (including newlines) into one space — a step is
 * a single ledger line; multi-line text blew up the turn layout (#history). */
function foldWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `read {"path":"…"}` → `read …`: parse the JSON argument blob and show the
 * meaningful value instead of raw JSON. Unknown shapes fall back to compact
 * JSON; unparseable text falls back to the folded original. */
export function formatToolCallText(text: string): string {
  const folded = foldWhitespace(text);
  const match = folded.match(/^(\S+)\s+(\{.+\})$/);
  if (!match) return folded;
  const [, name, json] = match;
  try {
    const args = JSON.parse(json) as Record<string, unknown>;
    for (const key of TOOL_ARG_KEYS) {
      const value = args[key];
      if (typeof value === "string" && value.trim() !== "") return `${name} ${foldWhitespace(value)}`;
    }
    return `${name} ${JSON.stringify(args)}`;
  } catch {
    return folded;
  }
}

function outcomeIcon(outcome: string | undefined): string {
  if (outcome === undefined) return "\u23F3"; // still running (no turn/end)
  if (outcome.startsWith("error")) return "\u274C";
  if (outcome === "completed") return "\u2705";
  return "\u2699\uFE0F";
}

/** Header for one turn: `▸ Turn 3 · provider/model · ✅ completed · ⏱ 12s`.
 * The model comes from the turn's request/header (the web trajectory's model
 * line); `changes` (header reason) is appended when the provider recorded one. */
function turnHeaderLine(turn: TrajectoryTurn): string {
  const label = turn.index === 0 ? "Prelude" : `Turn ${turn.index}`;
  const parts = [`\u25B8 <b>${label}</b>`];
  if (turn.model !== undefined) parts.push(`<code>${escapeHtml(truncate(turn.model, 40))}</code>`);
  parts.push(`${outcomeIcon(turn.outcome)} ${escapeHtml(turn.outcome ?? "running")}`);
  if (turn.seconds !== undefined) parts.push(`\u23F1\uFE0F ${turn.seconds}s`);
  const line = parts.join(" \u00B7 ");
  return turn.changes === undefined ? line : `${line} \u00B7 ${escapeHtml(truncate(turn.changes, 40))}`;
}

function stepLine(step: TrajectoryStep): string {
  // Single-line ledger entries: newlines in assistant messages and tool
  // results used to blow up the turn list (#history rendering feedback).
  const text = step.kind === "tool-call" ? formatToolCallText(step.text) : foldWhitespace(step.text);
  return `  ${STEP_ICONS[step.kind]} ${escapeHtml(truncate(text, 120))}`;
}

/** Thin divider between turns for visual hierarchy. */
const TURN_DIVIDER = "\u2500".repeat(24);

/** Render the paged trajectory as HTML lines (header line first). */
export function renderTrajectoryLines(sessionId: string, result: TrajectoryResult): string[] {
  const count = result.turns.length;
  const lines = [
    `\u{1F4DC} Trajectory \u00B7 ${escapeHtml(truncate(sessionId, 32))} (${count} turn${count === 1 ? "" : "s"}${result.hasMore ? "+" : ""})`,
    "",
  ];
  if (count === 0) {
    lines.push("(no events)");
    return lines;
  }
  let renderedTurns = 0;
  for (const turn of result.turns) {
    // Empty turns are noise: a Prelude with no steps rendered a pointless
    // `(no steps)` placeholder — skip them entirely (#history rendering).
    if (turn.steps.length === 0) continue;
    if (renderedTurns > 0) lines.push(TURN_DIVIDER);
    renderedTurns += 1;
    lines.push(turnHeaderLine(turn));
    const visible = turn.steps.slice(0, TRAJECTORY_MAX_STEPS_PER_TURN);
    for (const step of visible) lines.push(stepLine(step));
    if (turn.steps.length > visible.length) {
      lines.push(`  \u2026 ${turn.steps.length - visible.length} more step(s)`);
    }
  }
  if (renderedTurns === 0) lines.push("(no steps)");
  return lines;
}
