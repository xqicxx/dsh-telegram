/**
 * Assistant-output Markdown normalizer.
 *
 * The model speaks Markdown; Telegram Bot API HTML mode does not. Rather than
 * asking every deployment to choose a second parse mode (and maintain a second
 * entity-aware splitter), assistant prose is normalized to Telegram HTML here:
 *
 * - `**bold**` / `__bold__`          -> <b>
 * - `*italic*` / `_italic_`          -> <i> (word-boundary aware)
 * - `~~strike~~`                     -> <s>
 * - `` `code` `` / fenced blocks     -> <code> / <pre>
 * - `[label](url)`                   -> <a>
 * - ATX headings                     -> a bold line (Telegram HTML has no h1-h6)
 * - unordered lists                  -> bullet glyphs; ordered lists keep numbers
 * - block quotes                     -> <blockquote>
 *
 * Everything else is HTML-escaped, so malformed model markup degrades to
 * readable text instead of being sent raw to Telegram. Internal cards,
 * keyboards, approvals, questions, and the openclaw progress draft keep their
 * own deliberate HTML and never pass through this function.
 */

import { escapeHtml } from "./html.js";

const isWord = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9]/.test(ch);

/** Pathological deeply-nested model markup must degrade instead of
 * overflowing the call stack (a crash that looks like a frozen bot). */
const MAX_INLINE_DEPTH = 32;

/** Emphasis openers are valid at a word/punctuation boundary; closers must not
 * run into another word character. This keeps `snake_case` and `2*3*4` intact. */
function canOpen(delimiter: string, input: string, index: number): boolean {
  const before = input[index - 1];
  const after = input[index + delimiter.length];
  if (delimiter === "_") return !isWord(before) && after !== undefined;
  return !isWord(before) || !isWord(after);
}

function canClose(delimiter: string, input: string, index: number): boolean {
  const before = input[index - 1];
  const after = input[index + delimiter.length];
  if (delimiter === "_") return before !== undefined && !isWord(after);
  return before !== undefined && (!isWord(before) || !isWord(after));
}

/** Find a same-length closing delimiter that respects word boundaries. */
function findClosing(input: string, start: number, delimiter: string): number {
  let cursor = start + delimiter.length;
  for (;;) {
    const at = input.indexOf(delimiter, cursor);
    if (at === -1) return -1;
    if (at === start + delimiter.length) {
      cursor = at + delimiter.length;
      continue;
    }
    if (canClose(delimiter, input, at)) return at;
    cursor = at + delimiter.length;
  }
}

function safeHref(href: string): boolean {
  return /^(https?|tg|mailto):\/\/\S+$/i.test(href) || /^mailto:[^@\s]+@[^@\s]+$/i.test(href);
}

/** Telegram accepts `class="language-X"` on <code>; keep only a conservative
 * token so model-provided fence info can never leak markup or attributes. */
function telegramCodeLanguage(raw: string): string | undefined {
  const language = raw.trim();
  if (!/^[A-Za-z0-9_+#.-]{1,20}$/.test(language)) return undefined;
  return language;
}


/** GFM table support (issue #19): Telegram HTML has no <table>, so a pipe
 * table becomes a monospace <pre><code> block with columns aligned to the
 * widest cell. Cells are escaped text (bold/code inside a table stay
 * readable). The <code> wrapper is required: Telegram only guarantees the
 * monospace font for <pre><code>, not for a bare <pre> (issue #30). */
function parseTableRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return undefined;
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function isTableSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderTableBlock(rows: readonly string[]): string | undefined {
  const parsed = rows.map((row) => parseTableRow(row)).filter((row): row is string[] => row !== undefined);
  if (parsed.length < 2) return undefined;
  const header = parsed[0]!;
  if (!isTableSeparator(parsed[1]!)) return undefined;
  const body = parsed.slice(2).filter((row) => row.length > 0);
  const columns = header.length;
  const widths = header.map((cell, index) => Math.max(cell.length, ...body.map((row) => (row[index] ?? "").length)));
  const pad = (cell: string, index: number): string => `${cell}${" ".repeat(Math.max(0, widths[index]! - cell.length))}`;
  const rowText = (cells: string[]): string => `| ${cells.map((cell, index) => pad(escapeHtml(cell), index)).join(" | ")} |`;
  const separator = `| ${header.map((_, index) => "-".repeat(widths[index]!)).join(" | ")} |`;
  return `<pre><code>${[rowText(header), separator, ...body.map((row) => rowText([...Array(columns)].map((_, index) => row[index] ?? "")))].join("\n")}</code></pre>`;
}

/** First GFM table found anywhere in a text, as an aligned monospace block.
 * Streaming progress lines use this so a table snapshot renders as a table
 * instead of leaking raw `|`/`---` pipes (issue #26). Full assistant answers
 * go through `markdownToHtml`, which already handles the same blocks (#19). */
export function markdownTablePreBlock(markdown: string): string | undefined {
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (parseTableRow(lines[index]!) === undefined || index + 1 >= lines.length) continue;
    if (!isTableSeparator(parseTableRow(lines[index + 1]!) ?? [])) continue;
    const rows: string[] = [];
    while (index < lines.length && parseTableRow(lines[index]!) !== undefined) {
      rows.push(lines[index]!);
      index += 1;
    }
    return renderTableBlock(rows);
  }
  return undefined;
}

/** Inline Markdown on one line. Escapes every literal character, so generated
 * HTML is always balanced enough for the transport splitter. */
function renderInline(input: string, depth = 0): string {
  if (depth > MAX_INLINE_DEPTH) return escapeHtml(input);
  let out = "";
  for (let index = 0; index < input.length; ) {
    const ch = input[index];

    if (ch === "`") {
      const close = input.indexOf("`", index + 1);
      if (close === -1) {
        out += "`";
        index += 1;
        continue;
      }
      out += `<code>${escapeHtml(input.slice(index + 1, close))}</code>`;
      index = close + 1;
      continue;
    }

    if (ch === "[") {
      const labelEnd = input.indexOf("](", index + 1);
      if (labelEnd !== -1) {
        const hrefStart = labelEnd + 2;
        let depth = 0;
        let hrefEnd = -1;
        for (let cursor = hrefStart; cursor < input.length; cursor += 1) {
          const candidate = input[cursor];
          if (candidate === "(") depth += 1;
          else if (candidate === ")") {
            if (depth === 0) {
              hrefEnd = cursor;
              break;
            }
            depth -= 1;
          }
        }
        if (hrefEnd > hrefStart) {
          const href = input.slice(hrefStart, hrefEnd);
          const label = input.slice(index + 1, labelEnd);
          if (safeHref(href) && label !== "") {
            out += `<a href="${escapeHtml(href)}">${renderInline(label, depth + 1)}</a>`;
            index = hrefEnd + 1;
            continue;
          }
        }
      }
      out += "[";
      index += 1;
      continue;
    }

    const triple = input.startsWith("***", index) ? "***" : input.startsWith("___", index) ? "___" : undefined;
    if (triple !== undefined && canOpen(triple, input, index)) {
      const close = findClosing(input, index, triple);
      if (close !== -1) {
        out += `<b><i>${renderInline(input.slice(index + 3, close), depth + 1)}</i></b>`;
        index = close + 3;
        continue;
      }
    }

    const strong = input.startsWith("**", index) ? "**" : input.startsWith("__", index) ? "__" : undefined;
    if (strong !== undefined && canOpen(strong, input, index)) {
      let close = findClosing(input, index, strong);
      if (close !== -1) {
        // `**bold *nested***`: the first two of the trailing `***` are the
        // strong closer; the third star is the nested emphasis closer.
        if (input[close + strong.length] === strong[0] && input.slice(index + strong.length, close).includes(strong[0])) {
          close += 1;
        }
        out += `<b>${renderInline(input.slice(index + strong.length, close), depth + 1)}</b>`;
        index = close + strong.length;
        continue;
      }
    }

    const strike = input.startsWith("~~", index) ? "~~" : undefined;
    if (strike !== undefined && canOpen(strike, input, index)) {
      const close = findClosing(input, index, strike);
      if (close !== -1) {
        out += `<s>${renderInline(input.slice(index + 2, close), depth + 1)}</s>`;
        index = close + 2;
        continue;
      }
    }

    if ((ch === "*" || ch === "_") && canOpen(ch, input, index)) {
      const close = findClosing(input, index, ch);
      if (close !== -1) {
        out += `<i>${renderInline(input.slice(index + 1, close), depth + 1)}</i>`;
        index = close + 1;
        continue;
      }
    }

    out += escapeHtml(ch);
    index += 1;
  }
  return out;
}

function renderInlineSafely(input: string): string {
  const rendered = renderInline(input);
  // A label/content pair could render to nothing; keep the original text.
  return rendered === "" ? escapeHtml(input) : rendered;
}

function bulletLine(line: string): string | undefined {
  const match = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (!match) return undefined;
  return `${match[1]}\u2022 ${renderInlineSafely(match[2])}`;
}

function orderedLine(line: string): string | undefined {
  const match = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line);
  if (!match) return undefined;
  return `${match[1]}${match[2]}. ${renderInlineSafely(match[3])}`;
}

function headingLine(line: string): string | undefined {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!match) return undefined;
  return `<b>${renderInlineSafely(match[2].trim())}</b>`;
}

function blockquoteLine(line: string): string | undefined {
  const match = /^>\s?(.*)$/.exec(line);
  if (!match) return undefined;
  return match[1] ?? "";
}

function isFence(line: string): { marker: string; len: number; language?: string } | undefined {
  const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  const marker = match[1]![0]!;
  const language = telegramCodeLanguage(match[2] ?? "");
  return { marker, len: match[1]!.length, ...(language === undefined ? {} : { language }) };
}

/** Normalize one block line of model Markdown into Telegram HTML. */
function renderBlockLine(line: string): string {
  if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) return "\u2500".repeat(8);
  const heading = headingLine(line);
  if (heading !== undefined) return heading;
  const ordered = orderedLine(line);
  if (ordered !== undefined) return ordered;
  const bullet = bulletLine(line);
  if (bullet !== undefined) return bullet;
  return renderInlineSafely(line);
}

/** Convert model Markdown to Telegram Bot API HTML parse mode. */
export function markdownToHtml(markdown: string): string {
  if (markdown === "") return "";
  const lines = markdown.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!;

    const fence = isFence(line);
    if (fence !== undefined) {
      const code: string[] = [];
      index += 1;
      let closed = false;
      while (index < lines.length) {
        const candidate = lines[index]!;
        const end = /^\s*(`{3,}|~{3,})/.exec(candidate);
        if (end && end[1]![0] === fence.marker && end[1]!.length >= fence.len) {
          index += 1;
          closed = true;
          break;
        }
        code.push(candidate);
        index += 1;
      }
      const body = code.join("\n");
      const open = fence.language === undefined ? "<pre><code>" : `<pre><code class="language-${fence.language}">`;
      out.push(`${open}${escapeHtml(body)}</code></pre>`);
      if (!closed) {
        // Unterminated fence: the rest of the message was consumed as code.
      }
      continue;
    }

    const tableRows: string[] = [];
    if (parseTableRow(line) !== undefined && index + 1 < lines.length && isTableSeparator(parseTableRow(lines[index + 1]!) ?? [])) {
      while (index < lines.length && parseTableRow(lines[index]!) !== undefined) {
        tableRows.push(lines[index]!);
        index += 1;
      }
      const table = renderTableBlock(tableRows);
      if (table !== undefined) {
        out.push(table);
        continue;
      }
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index]!)) {
        quote.push(blockquoteLine(lines[index]!) ?? "");
        index += 1;
      }
      out.push(`<blockquote>${quote.map((entry) => renderInlineSafely(entry)).join("\n")}</blockquote>`);
      continue;
    }

    out.push(renderBlockLine(line));
    index += 1;
  }
  return out.join("\n");
}
