/**
 * HTML formatting helpers. User/agent content is ALWAYS escaped before it is
 * wrapped, so a message can never inject markup we did not intend.
 *
 * `splitText` is HTML-aware: Telegram rejects malformed HTML (HTTP 400), so a
 * long message must never be cut inside a tag or leave a tag unclosed. Plain
 * text keeps the historical newline/space/hard-split behavior byte-for-byte.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Tag shape captured by `TAG_PATTERN`. Attribute values may contain `>` only
 * in user-controlled raw HTML; generated markup always escapes it. */
const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*?)?(\/?)>/g;

interface ParsedTag {
  raw: string;
  name: string;
  closing: boolean;
  selfClosing: boolean;
  index: number;
  end: number;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

export function bold(value: string): string {
  return `<b>${escapeHtml(value)}</b>`;
}

export function code(value: string): string {
  return `<code>${escapeHtml(value)}</code>`;
}

export function link(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

export function plain(value: string): string {
  return escapeHtml(value);
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}\u2026` : value;
}

function parseTags(text: string): ParsedTag[] {
  const tags: ParsedTag[] = [];
  TAG_PATTERN.lastIndex = 0;
  for (;;) {
    const match = TAG_PATTERN.exec(text);
    if (match === null) break;
    tags.push({
      raw: match[0],
      name: match[2]!.toLowerCase(),
      closing: match[1] === "/",
      selfClosing: match[3] === "/",
      index: match.index,
      end: match.index + match[0].length,
    });
  }
  return tags;
}

/** Opening tags still pending at the end of `prefix` (innermost last), kept
 * as their raw source text: a tag reopened after a split must replay its
 * attributes, because Telegram rejects a bare `<a>` (no href) with a
 * non-retryable 400 that loses that part and everything after it (RE-2). */
function openStackFor(prefix: string): ParsedTag[] {
  const stack: ParsedTag[] = [];
  for (const tag of parseTags(prefix)) {
    if (tag.selfClosing || VOID_TAGS.has(tag.name)) continue;
    if (tag.closing) {
      let at = -1;
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index]!.name === tag.name) {
          at = index;
          break;
        }
      }
      if (at !== -1) stack.splice(at, 1);
      continue;
    }
    stack.push(tag);
  }
  return stack;
}

function closersFor(stack: readonly ParsedTag[]): string {
  let out = "";
  for (let index = stack.length - 1; index >= 0; index -= 1) out += `</${stack[index]!.name}>`;
  return out;
}

function reopenFor(stack: readonly ParsedTag[]): string {
  return stack.map((tag) => tag.raw).join("");
}

/** A cut may never land inside a tag (or an HTML entity); Telegram's HTML
 * parser rejects both malformed tags and split entity names. */
function isSafeCut(text: string, cut: number): boolean {
  if (cut <= 0 || cut >= text.length) return true;
  const lastOpen = text.lastIndexOf("<", cut - 1);
  if (lastOpen !== -1) {
    const close = text.indexOf(">", lastOpen);
    if (close === -1 || close >= cut) return false;
  }
  const lastAmp = text.lastIndexOf("&", cut - 1);
  if (lastAmp !== -1) {
    const tail = text.slice(lastAmp, cut);
    if (!tail.includes(";") && tail.length <= 12 && /^&[a-zA-Z#0-9]{0,11}$/.test(tail)) return false;
  }
  return true;
}

/** Preferred cut position inside `text` no longer than `max`. Matches the
 * historical plain-text behavior and refuses positions inside tags/entities. */
function findCut(text: string, max: number): number {
  const hard = Math.min(max, text.length);
  const newline = text.lastIndexOf("\n", hard - 1);
  if (newline >= 0) {
    const cut = newline + 1;
    if (cut <= max && isSafeCut(text, cut)) return cut;
  }
  const space = text.lastIndexOf(" ", hard - 1);
  if (space > hard / 2) {
    const cut = space;
    if (isSafeCut(text, cut)) return cut;
  }
  for (let cut = hard; cut >= 1; cut -= 1) {
    if (isSafeCut(text, cut)) return cut;
  }
  return 0;
}

/**
 * Split a payload into Telegram-safe parts. Newlines are the preferred
 * boundary; an overlong single line is hard-split at the last space within
 * the limit (or exactly at the limit when it has no spaces at all). HTML
 * parts are additionally rebalanced: a tag that would span the cut is closed
 * at the end of the first part and reopened at the start of the next one, so
 * every part parses on its own.
 */
export function splitText(text: string, max: number): string[] {
  if (max <= 0) return [text];
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = findCut(rest, max);
    if (cut <= 0) {
      // No safe cut exists (a single tag/entity exceeds the limit). Degrade
      // to a raw hard split rather than looping forever.
      parts.push(rest.slice(0, max));
      rest = rest.slice(max);
      continue;
    }

    let prefix = rest.slice(0, cut);
    let stack = openStackFor(prefix);
    let closers = closersFor(stack);

    // Closing tags appended to the first part count against Telegram's limit.
    // Re-find a shorter safe cut that still fits the closers.
    if (cut + closers.length > max) {
      const available = max - closers.length;
      if (available <= 0) {
        parts.push(rest.slice(0, max));
        rest = rest.slice(max);
        continue;
      }
      cut = findCut(rest, available);
      if (cut <= 0) {
        parts.push(rest.slice(0, max));
        rest = rest.slice(max);
        continue;
      }
      prefix = rest.slice(0, cut);
      stack = openStackFor(prefix);
      closers = closersFor(stack);
      if (cut + closers.length > max) {
        parts.push(rest.slice(0, max));
        rest = rest.slice(max);
        continue;
      }
    }

    if (stack.length === 0) {
      parts.push(prefix);
      rest = rest.slice(cut);
      continue;
    }

    parts.push(prefix + closers);
    rest = reopenFor(stack) + rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}
