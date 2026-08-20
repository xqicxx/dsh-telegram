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
  return `  ${STEP_ICONS[step.kind]} ${escapeHtml(truncate(step.text, 120))}`;
}

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
  for (const turn of result.turns) {
    lines.push(turnHeaderLine(turn));
    const visible = turn.steps.slice(0, TRAJECTORY_MAX_STEPS_PER_TURN);
    for (const step of visible) lines.push(stepLine(step));
    if (turn.steps.length > visible.length) {
      lines.push(`  \u2026 ${turn.steps.length - visible.length} more step(s)`);
    }
    if (turn.steps.length === 0) lines.push("  (no steps)");
    lines.push("");
  }
  // Drop the trailing blank line after the last turn.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
