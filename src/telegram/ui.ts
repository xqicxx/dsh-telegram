/**
 * dsh-telegram Design Language (DTL): the one typography/glyph vocabulary
 * shared by every card, receipt and progress renderer.
 *
 * Grounded in the official Bot API formatting contract
 * (https://core.telegram.org/bots/api#formatting-options):
 *
 * - HTML parse mode supports exactly these tags: b/strong, i/em, u/ins,
 *   s/strike/del, tg-spoiler, a[href], code, pre, pre>code[class=language-x],
 *   blockquote, blockquote[expandable] and tg-time date-time entities.
 * - blockquote (and its expandable variant) can never nest.
 * - Only &lt; &gt; &amp; &quot; exist as named entities; numeric entities are
 *   fine — `escapeHtml` already respects this.
 * - Messages cap at 4096 chars; the transport splitter re-balances any markup
 *   produced here across parts.
 *
 * Convention: text-level helpers (`bold`, `mono`, …) take PLAIN strings and
 * escape them; line builders (`metaJoin`, `headerLine`) take already-rendered
 * HTML fragments and only compose layout. Never feed rendered HTML into a
 * text-level helper — it would be double-escaped and show tags literally.
 */

import { escapeHtml } from "./html.js";

/** Metadata separator between segments of one header/status line. */
export const DOT = " \u00B7 ";

/** Join metadata fragments with the mid-dot separator, dropping empties. */
export function metaJoin(...parts: readonly (string | undefined | false)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join(DOT);
}

// ── Text-level primitives (escape their input) ────────────────────────────

export function bold(value: string): string {
  return `<b>${escapeHtml(value)}</b>`;
}

export function italic(value: string): string {
  return `<i>${escapeHtml(value)}</i>`;
}

/** Inline fixed-width text for ids, paths, models, counts-that-are-code. */
export function mono(value: string): string {
  return `<code>${escapeHtml(value)}</code>`;
}

/** Strikethrough for completed list items. */
export function strike(value: string): string {
  return `<s>${escapeHtml(value)}</s>`;
}

/**
 * Bot API date-time entity rendering a client-localized RELATIVE time
 * ("3 minutes ago", localized on the user's phone). The escaped fallback
 * keeps older clients / notifications readable.
 *
 * Host seams occasionally deliver a timestamp that violates the number
 * contract despite the adapter types — session event `at` folds are blind-cast
 * (`event.at ?? event.data?.createdAt as number`) and workspace registry rows
 * pass through unvalidated. A NaN/undefined-coerced/non-positive value would
 * render `<tg-time unix="NaN">`, which Telegram's entity parser rejects with
 * an HTTP 400 that kills the whole card, so garbage degrades here to the
 * escaped fallback text WITHOUT the tg-time wrapper.
 */
export function relTime(atMs: number, fallback?: string): string {
  const at = Number(atMs);
  const unix = Math.floor(at / 1000);
  if (!Number.isFinite(unix) || unix <= 0) return escapeHtml(fallback ?? "\u2014");
  const shown = fallback ?? new Date(at).toLocaleString();
  return `<tg-time unix="${unix}" format="r">${escapeHtml(shown)}</tg-time>`;
}

// ── Line builders (take rendered HTML fragments) ──────────────────────────

/**
 * Card header: `${icon} <b>Title</b> · meta…`. One emoji, one bold title,
 * at most a couple of quiet metadata segments — the scannable top line every
 * card shares.
 */
export function headerLine(icon: string, title: string, ...meta: readonly (string | undefined | false)[]): string {
  return metaJoin(`${icon} ${bold(title)}`, ...meta);
}

/** Thin horizontal rule between groups; pure text so plain-text lanes match. */
export function divider(width = 24): string {
  return "\u2500".repeat(Math.max(4, width));
}

/**
 * Progress bar in Telegram-safe block glyphs: `▓▓▓▓░░░░░░ 40%`. Pure text —
 * renders identically in HTML and plain lanes, no font assumptions beyond
 * the monospace-friendly blocks every client ships.
 */
export function progressBar(done: number, total: number, width = 10): string {
  const safeTotal = Math.max(0, total);
  const ratio = safeTotal === 0 ? 0 : Math.max(0, Math.min(1, done / safeTotal));
  const filled = Math.round(ratio * width);
  return `${"\u2593".repeat(filled)}${"\u2591".repeat(width - filled)} ${Math.round(ratio * 100)}%`;
}
