import MarkdownIt from "markdown-it";
import markdownItContainer from "markdown-it-container";
import { parse } from "node-html-parser";

type MarkdownItToken = {
  type: string;
  tag: string;
  nesting: number;
  content: string;
  info: string;
  children?: MarkdownItToken[];
  attrs?: Array<[string, string]>;
  attrGet?: (name: string) => string | null;
  markup?: string;
  meta?: Record<string, unknown>;
};

export type TelegramMarkdownRenderOptions = {
  linkify?: boolean;
  preserveRawTelegramHtml?: boolean;
  tableMode?: "code" | "plain";
};

const DEFAULT_MESSAGE_LIMIT = 4000;
const HTML_TAG_PATTERN = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s+[^<>]*?)?>/g;
const SELF_CLOSING_TAGS = new Set(["br"]);

const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
});

markdown.use(markdownItContainer, "expandable");

export function renderTelegramHtml(
  source: string,
  options: TelegramMarkdownRenderOptions = {},
): string {
  const input = preprocessTelegramMarkdown(source ?? "");
  const tokens = markdown.parse(input, {} as object) as MarkdownItToken[];
  const rendered = renderBlocks(tokens, {
    listDepth: 0,
    preserveRawTelegramHtml: options.preserveRawTelegramHtml ?? true,
    tableMode: options.tableMode ?? "code",
  }).trim();

  return rendered;
}

export function splitTelegramHtml(html: string, maxLength = DEFAULT_MESSAGE_LIMIT): string[] {
  if (!html) return [];
  const limit = Math.max(1, Math.floor(maxLength));
  if (html.length <= limit) return [html];

  const chunks: string[] = [];
  const stack: Array<{ name: string; openTag: string; closeTag: string }> = [];
  let current = "";
  let lastIndex = 0;

  const resetCurrent = () => {
    current = stack.map((tag) => tag.openTag).join("");
  };

  const closeSuffix = () => stack.slice().reverse().map((tag) => tag.closeTag).join("");
  const closeSuffixLength = () => stack.reduce((sum, tag) => sum + tag.closeTag.length, 0);

  const flush = () => {
    if (!current.trim()) return;
    chunks.push(`${current}${closeSuffix()}`);
    resetCurrent();
  };

  const appendText = (text: string) => {
    let remaining = text;
    while (remaining.length > 0) {
      const available = limit - current.length - closeSuffixLength();
      if (available <= 0) {
        if (!current.trim()) {
          throw new Error(`Telegram HTML chunk limit ${limit} is too small for the current formatting stack.`);
        }
        flush();
        continue;
      }
      if (remaining.length <= available) {
        current += remaining;
        remaining = "";
        continue;
      }
      const splitAt = findSafeHtmlSplitIndex(remaining, available);
      if (splitAt <= 0) {
        flush();
        continue;
      }
      current += remaining.slice(0, splitAt);
      remaining = remaining.slice(splitAt);
      flush();
    }
  };

  resetCurrent();
  let match: RegExpExecArray | null;
  HTML_TAG_PATTERN.lastIndex = 0;

  while ((match = HTML_TAG_PATTERN.exec(html)) !== null) {
    const tagStart = match.index;
    const tagEnd = HTML_TAG_PATTERN.lastIndex;
    appendText(html.slice(lastIndex, tagStart));

    const rawTag = html.slice(tagStart, tagEnd);
    const isClosing = rawTag.startsWith("</");
    const isSelfClosing = rawTag.endsWith("/>");
    const tagName = normalizeTagName(match[1] ?? "");

    if (current.length + rawTag.length + closeSuffixLength() > limit) {
      if (!current.trim()) {
        throw new Error(`Telegram HTML chunk limit ${limit} is too small for tag ${rawTag}.`);
      }
      flush();
    }

    current += rawTag;

    if (!isSelfClosing && !SELF_CLOSING_TAGS.has(tagName)) {
      if (isClosing) {
        popTag(stack, tagName);
      } else {
        stack.push({
          name: tagName,
          openTag: rawTag,
          closeTag: `</${tagName}>`,
        });
      }
    }

    lastIndex = tagEnd;
  }

  appendText(html.slice(lastIndex));
  if (current.trim()) {
    chunks.push(`${current}${closeSuffix()}`);
  }

  return chunks;
}

export function renderTelegramMessageChunks(
  source: string,
  maxLength = DEFAULT_MESSAGE_LIMIT,
  options: TelegramMarkdownRenderOptions = {},
): string[] {
  return splitTelegramHtml(renderTelegramHtml(source, options), maxLength);
}

export const renderTelegramHtmlChunks = splitTelegramHtml;

function preprocessTelegramMarkdown(source: string): string {
  const lines = source.split(/\r?\n/);
  const output: string[] = [];
  let activeFence: { marker: "`" | "~"; length: number } | null = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}([`~]{3,})/);
    if (fenceMatch) {
      const markerText = fenceMatch[1] ?? "";
      const marker = markerText[0] as "`" | "~";
      const length = markerText.length;

      if (!activeFence) {
        activeFence = { marker, length };
        output.push(line);
        continue;
      }

      if (activeFence.marker === marker && length >= activeFence.length) {
        activeFence = null;
      }

      output.push(line);
      continue;
    }

    if (activeFence) {
      output.push(line);
      continue;
    }

    output.push(applyInlineCustomSyntax(line));
  }

  return output.join("\n");
}

function applyInlineCustomSyntax(line: string): string {
  if (!line) return line;

  let output = "";
  let index = 0;

  while (index < line.length) {
    if (line[index] === "`") {
      const tickCount = countRun(line, index, "`");
      const closingIndex = findClosingRun(line, index + tickCount, "`", tickCount);
      if (closingIndex === -1) {
        output += transformPlainInline(line.slice(index));
        break;
      }
      output += transformPlainInline(line.slice(index, index));
      output += line.slice(index, closingIndex + tickCount);
      index = closingIndex + tickCount;
      continue;
    }

    const nextTick = line.indexOf("`", index);
    const plain = nextTick === -1 ? line.slice(index) : line.slice(index, nextTick);
    output += transformPlainInline(plain);
    if (nextTick === -1) break;
    index = nextTick;
  }

  return output;
}

function transformPlainInline(segment: string): string {
  return replaceBalancedDelimiter(
    replaceBalancedDelimiter(segment, "||", "<tg-spoiler>", "</tg-spoiler>"),
    "++",
    "<u>",
    "</u>",
  );
}

function replaceBalancedDelimiter(
  text: string,
  delimiter: string,
  openTag: string,
  closeTag: string,
): string {
  if (!text.includes(delimiter)) return text;

  const pattern = new RegExp(
    escapeForRegExp(delimiter) + "([\\s\\S]+?)" + escapeForRegExp(delimiter),
    "g",
  );
  return text.replace(pattern, (_match, inner: string) => `${openTag}${inner}${closeTag}`);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countRun(text: string, start: number, char: string): number {
  let index = start;
  while (text[index] === char) index += 1;
  return index - start;
}

function findClosingRun(text: string, start: number, char: string, length: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] !== char) continue;
    if (countRun(text, index, char) >= length) {
      return index;
    }
  }
  return -1;
}

type RenderContext = {
  listDepth: number;
  preserveRawTelegramHtml: boolean;
  tableMode: "code" | "plain";
};

function renderBlocks(tokens: MarkdownItToken[], context: RenderContext): string {
  let output = "";

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    switch (token.type) {
      case "paragraph_open": {
        const { inner, nextIndex } = collectNestedTokens(tokens, index);
        const content = renderParagraph(inner, context);
        if (content) {
          output += `${content}\n\n`;
        }
        index = nextIndex;
        break;
      }
      case "heading_open": {
        const { inner, nextIndex } = collectNestedTokens(tokens, index);
        const content = renderParagraph(inner, context);
        if (content) {
          output += `<b>${content}</b>\n\n`;
        }
        index = nextIndex;
        break;
      }
      case "bullet_list_open": {
        const { inner, nextIndex } = collectNestedTokens(tokens, index);
        output += renderList(inner, { ...context, listDepth: context.listDepth + 1 }, false, 1);
        output += "\n";
        index = nextIndex;
        break;
      }
      case "ordered_list_open": {
        const { inner, nextIndex } = collectNestedTokens(tokens, index);
        const start = Number.parseInt(getAttr(token, "start") ?? "1", 10) || 1;
        output += renderList(inner, { ...context, listDepth: context.listDepth + 1 }, true, start);
        output += "\n";
        index = nextIndex;
        break;
      }
      case "blockquote_open": {
        const { inner, nextIndex } = collectNestedTokens(tokens, index);
        const content = renderBlocks(inner, context).trim();
        if (content) {
          output += `<blockquote>${content}</blockquote>\n\n`;
        }
        index = nextIndex;
        break;
      }
      case "container_expandable_open": {
        const { inner, nextIndex } = collectNestedTokens(tokens, index);
        const content = renderBlocks(inner, context).trim();
        if (content) {
          output += `<blockquote expandable>${content}</blockquote>\n\n`;
        }
        index = nextIndex;
        break;
      }
      case "fence": {
        output += `${renderFence(token)}\n\n`;
        break;
      }
      case "code_block": {
        output += `${renderCodeBlock(token.content)}\n\n`;
        break;
      }
      case "hr": {
        output += `────────\n\n`;
        break;
      }
      case "html_block": {
        if (context.preserveRawTelegramHtml) {
          const sanitized = sanitizeTelegramHtmlFragment(token.content);
          if (sanitized) {
            output += `${sanitized}\n\n`;
          }
        } else {
          const plain = escapeHtml(token.content);
          if (plain.trim()) {
            output += `${plain}\n\n`;
          }
        }
        break;
      }
      case "table_open": {
        const { inner, nextIndex } = collectNestedTokens(tokens, index);
        output += `${renderTable(inner, context)}\n\n`;
        index = nextIndex;
        break;
      }
      case "inline": {
        const content = renderInlineTokens(token.children ?? [], context).trim();
        if (content) {
          output += `${content}\n\n`;
        }
        break;
      }
      default:
        break;
    }
  }

  return output;
}

function renderParagraph(tokens: MarkdownItToken[], context: RenderContext): string {
  const inline = tokens.find((token) => token.type === "inline");
  if (!inline) {
    return renderBlocks(tokens, context).trim();
  }
  return renderInlineTokens(inline.children ?? [], context).trim();
}

function renderInlineTokens(tokens: MarkdownItToken[], context: RenderContext): string {
  let output = "";

  for (const token of tokens) {
    switch (token.type) {
      case "text":
        output += escapeHtml(token.content);
        break;
      case "softbreak":
      case "hardbreak":
        output += "\n";
        break;
      case "code_inline":
        output += `<code>${escapeHtml(token.content)}</code>`;
        break;
      case "strong_open":
        output += "<b>";
        break;
      case "strong_close":
        output += "</b>";
        break;
      case "em_open":
        output += "<i>";
        break;
      case "em_close":
        output += "</i>";
        break;
      case "s_open":
        output += "<s>";
        break;
      case "s_close":
        output += "</s>";
        break;
      case "link_open": {
        const href = sanitizeHref(getAttr(token, "href"));
        output += href ? `<a href="${escapeHtmlAttr(href)}">` : "";
        break;
      }
      case "link_close":
        output += "</a>";
        break;
      case "image": {
        const src = sanitizeHref(getAttr(token, "src") ?? getAttr(token, "href"));
        const alt = escapeHtml(token.content || getAttr(token, "alt") || "image");
        output += src ? `<a href="${escapeHtmlAttr(src)}">${alt}</a>` : alt;
        break;
      }
      case "html_inline":
        output += context.preserveRawTelegramHtml
          ? sanitizeTelegramRawTag(token.content)
          : escapeHtml(token.content);
        break;
      default:
        output += token.content ? escapeHtml(token.content) : "";
        break;
    }
  }

  return output;
}

function renderFence(token: MarkdownItToken): string {
  const language = normalizeLanguage(token.info);
  const classAttr = language ? ` class="language-${escapeHtmlAttr(language)}"` : "";
  return `<pre><code${classAttr}>${escapeHtml(token.content)}</code></pre>`;
}

function renderCodeBlock(content: string): string {
  return `<pre><code>${escapeHtml(content)}</code></pre>`;
}

function renderList(
  tokens: MarkdownItToken[],
  context: RenderContext,
  ordered: boolean,
  startIndex: number,
): string {
  let output = "";
  let counter = startIndex;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.type !== "list_item_open") continue;

    const { inner, nextIndex } = collectNestedTokens(tokens, index);
    const itemContent = renderBlocks(inner, context).trim();
    const indent = "  ".repeat(Math.max(0, context.listDepth - 1));
    const prefix = ordered ? `${counter}. ` : "• ";
    output += `${indent}${prefix}${indentMultiline(itemContent, indent + " ".repeat(prefix.length))}\n`;
    counter += 1;
    index = nextIndex;
  }

  return output.trimEnd();
}

function indentMultiline(text: string, continuationIndent: string): string {
  const lines = text.split("\n");
  return lines
    .map((line, index) => (index === 0 ? line : `${continuationIndent}${line}`))
    .join("\n");
}

function renderTable(tokens: MarkdownItToken[], context: RenderContext): string {
  const rows: string[][] = [];
  let currentRow: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    if (token.type === "tr_open") {
      currentRow = [];
      continue;
    }

    if (token.type === "tr_close") {
      rows.push(currentRow);
      currentRow = [];
      continue;
    }

    if (token.type === "th_open" || token.type === "td_open") {
      const { inner, nextIndex } = collectNestedTokens(tokens, index);
      currentRow.push(renderTableCell(inner, context));
      index = nextIndex;
    }
  }

  if (rows.length === 0) {
    return "";
  }

  const tableText = renderMonospaceTable(rows);
  if (context.tableMode === "plain") {
    return escapeHtml(tableText);
  }
  return `<pre><code>${escapeHtml(tableText)}</code></pre>`;
}

const MONOSPACE_TABLE_MAX_WIDTH = 68;
const MONOSPACE_TABLE_MIN_COL_WIDTH = 8;

function renderMonospaceTable(rows: string[][]): string {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => (row[index] ?? "").trim()),
  );

  const widths = computeTableColumnWidths(normalizedRows, MONOSPACE_TABLE_MAX_WIDTH);
  const header = normalizedRows[0] ?? [];
  const body = normalizedRows.slice(1);

  const lines: string[] = [];
  lines.push(buildTableBorder(widths, "┌", "┬", "┐"));
  lines.push(...renderWrappedTableRow(header, widths));
  if (body.length > 0) {
    lines.push(buildTableBorder(widths, "├", "┼", "┤"));
    for (const row of body) {
      lines.push(...renderWrappedTableRow(row, widths));
    }
  }
  lines.push(buildTableBorder(widths, "└", "┴", "┘"));
  return lines.join("\n");
}

function computeTableColumnWidths(rows: string[][], maxWidth: number): number[] {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const natural = Array.from({ length: columnCount }, (_, column) => {
    return Math.max(...rows.map((row) => measureDisplayWidth(row[column] ?? "")), 0, 3);
  });

  const minWidth = Math.min(
    MONOSPACE_TABLE_MIN_COL_WIDTH,
    Math.max(3, Math.floor((maxWidth - (columnCount + 1)) / Math.max(1, columnCount) - 2)),
  );
  const widths = natural.map((width) => Math.max(minWidth, width));

  while (tableWidth(widths) > maxWidth) {
    let widestIndex = -1;
    for (let index = 0; index < widths.length; index += 1) {
      const width = widths[index];
      if (width === undefined || width <= minWidth) continue;
      const widestWidth = widestIndex === -1 ? undefined : widths[widestIndex];
      if (widestWidth === undefined || width > widestWidth) {
        widestIndex = index;
      }
    }

    if (widestIndex === -1) {
      break;
    }

    widths[widestIndex] = (widths[widestIndex] ?? minWidth) - 1;
  }

  return widths;
}

function tableWidth(widths: number[]): number {
  return widths.reduce((sum, width) => sum + width, 0) + widths.length * 3 + 1;
}

function buildTableBorder(widths: number[], left: string, middle: string, right: string): string {
  return `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;
}

function renderWrappedTableRow(row: string[], widths: number[]): string[] {
  const wrappedCells = widths.map((width, index) => wrapTableCell(row[index] ?? "", width));
  const height = Math.max(...wrappedCells.map((cell) => cell.length), 1);
  const lines: string[] = [];

  for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
    const line = widths
      .map((width, columnIndex) => {
        const cellLine = wrappedCells[columnIndex]?.[lineIndex] ?? "";
        return ` ${cellLine.padEnd(width)} `;
      })
      .join("│");
    lines.push(`│${line}│`);
  }

  return lines;
}

function wrapTableCell(text: string, width: number): string[] {
  if (!text) {
    return [""];
  }

  const paragraphs = text.split(/\n+/);
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      if (measureDisplayWidth(word) > width) {
        if (current) {
          lines.push(current);
          current = "";
        }
        lines.push(...hardWrapWord(word, width));
        continue;
      }

      const candidate = current ? `${current} ${word}` : word;
      if (measureDisplayWidth(candidate) <= width) {
        current = candidate;
      } else {
        if (current) {
          lines.push(current);
        }
        current = word;
      }
    }

    if (current) {
      lines.push(current);
    }
  }

  return lines.length > 0 ? lines : [""];
}

function hardWrapWord(word: string, width: number): string[] {
  const parts: string[] = [];
  let remaining = word;
  while (measureDisplayWidth(remaining) > width) {
    parts.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }
  if (remaining) {
    parts.push(remaining);
  }
  return parts;
}

function measureDisplayWidth(text: string): number {
  return text.length;
}

function renderTableCell(tokens: MarkdownItToken[], context: RenderContext): string {
  const inline = tokens.find((token) => token.type === "inline");
  if (!inline) return "";
  return decodeHtmlEntities(stripHtml(renderInlineTokens(inline.children ?? [], context))).replace(/\s+/g, " ").trim();
}

function collectNestedTokens(
  tokens: MarkdownItToken[],
  openIndex: number,
): { inner: MarkdownItToken[]; nextIndex: number } {
  const openToken = tokens[openIndex];
  const closeType = openToken?.type.endsWith("_open")
    ? `${openToken.type.slice(0, -5)}_close`
    : `${openToken?.type}_close`;

  let depth = 1;
  let index = openIndex + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token?.type === openToken?.type) {
      depth += 1;
    } else if (token?.type === closeType) {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
    index += 1;
  }

  return {
    inner: tokens.slice(openIndex + 1, index),
    nextIndex: index,
  };
}

function getAttr(token: MarkdownItToken | undefined, name: string): string | null {
  if (!token) return null;
  if (typeof token.attrGet === "function") {
    return token.attrGet(name);
  }
  for (const [key, value] of token.attrs ?? []) {
    if (key === name) return value;
  }
  return null;
}

function normalizeLanguage(info: string): string {
  const language = info.trim().split(/\s+/)[0] ?? "";
  return language.replace(/[^a-zA-Z0-9_+.-]/g, "");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function sanitizeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const value = href.trim();
  if (!value) return null;
  if (/^(https?:|tg:|mailto:|tel:)/i.test(value)) {
    return value;
  }
  return null;
}

function sanitizeTelegramRawTag(raw: string): string {
  const text = raw.trim();
  if (!text) return "";

  const closeMatch = text.match(/^<\s*\/\s*([a-zA-Z0-9-]+)\s*>$/);
  if (closeMatch) {
    const closing = mapTelegramTagName(closeMatch[1] ?? "");
    return closing ? `</${closing}>` : "";
  }

  const openMatch = text.match(/^<\s*([a-zA-Z0-9-]+)([^>]*)>$/);
  if (!openMatch) {
    return escapeHtml(text);
  }

  const tagName = normalizeTagName(openMatch[1] ?? "");
  const attrsText = openMatch[2] ?? "";
  if (tagName === "br") {
    return "\n";
  }
  if (tagName === "span" && normalizeClass(extractQuotedAttr(attrsText, "class") ?? undefined) === "tg-spoiler") {
    return "<tg-spoiler>";
  }

  const mappedTag = mapTelegramTagName(tagName);
  if (!mappedTag) {
    return "";
  }

  switch (mappedTag) {
    case "a": {
      const href = sanitizeHref(extractQuotedAttr(attrsText, "href"));
      return href ? `<a href="${escapeHtmlAttr(href)}">` : "";
    }
    case "blockquote": {
      const expandable = /(^|\s)expandable(?=\s|$)/i.test(attrsText) ? " expandable" : "";
      return `<blockquote${expandable}>`;
    }
    case "tg-emoji": {
      const emojiId = (extractQuotedAttr(attrsText, "emoji-id") ?? "").trim();
      return /^\d+$/.test(emojiId) ? `<tg-emoji emoji-id="${emojiId}">` : "";
    }
    default:
      return `<${mappedTag}>`;
  }
}

function sanitizeTelegramHtmlFragment(fragment: string): string {
  if (!fragment.trim()) return "";

  const root = parse(`<root>${fragment}</root>`, {
    comment: false,
    blockTextElements: {
      script: true,
      style: true,
      pre: true,
      noscript: true,
    },
  });

  const wrapper = root.querySelector("root");
  if (!wrapper) return escapeHtml(fragment);

  return wrapper.childNodes.map((node) => sanitizeTelegramHtmlNode(node as unknown as ParsedNode)).join("");
}

function mapTelegramTagName(tagName: string): string | null {
  switch (normalizeTagName(tagName)) {
    case "b":
    case "strong":
      return "b";
    case "i":
    case "em":
      return "i";
    case "u":
    case "ins":
      return "u";
    case "s":
    case "strike":
    case "del":
      return "s";
    case "code":
      return "code";
    case "pre":
      return "pre";
    case "a":
      return "a";
    case "blockquote":
      return "blockquote";
    case "tg-spoiler":
      return "tg-spoiler";
    case "tg-emoji":
      return "tg-emoji";
    case "br":
      return "br";
    default:
      return null;
  }
}

function extractQuotedAttr(attrsText: string, name: string): string | null {
  const match = attrsText.match(new RegExp(`${name}\\s*=\\s*([\"'])(.*?)\\1`, "i"));
  return match?.[2] ?? null;
}

type ParsedNode = {
  nodeType: number;
  rawText?: string;
  tagName?: string;
  childNodes?: ParsedNode[];
  getAttribute?: (name: string) => string | undefined;
  hasAttribute?: (name: string) => boolean;
};

function sanitizeTelegramHtmlNode(node: ParsedNode): string {
  if (node.nodeType === 3) {
    return escapeHtml(node.rawText ?? "");
  }

  const tagName = normalizeTagName(node.tagName ?? "");
  const children = (node.childNodes ?? []).map((child) => sanitizeTelegramHtmlNode(child)).join("");

  if (tagName === "span" && normalizeClass(node.getAttribute?.("class")) === "tg-spoiler") {
    return `<tg-spoiler>${children}</tg-spoiler>`;
  }

  if (tagName === "strong") return `<b>${children}</b>`;
  if (tagName === "em") return `<i>${children}</i>`;
  if (tagName === "ins") return `<u>${children}</u>`;
  if (tagName === "strike" || tagName === "del") return `<s>${children}</s>`;

  switch (tagName) {
    case "b":
    case "i":
    case "u":
    case "s":
    case "code":
    case "pre":
    case "tg-spoiler":
      return `<${tagName}>${children}</${tagName}>`;
    case "blockquote": {
      const expandable = node.hasAttribute?.("expandable") ? " expandable" : "";
      return `<blockquote${expandable}>${children}</blockquote>`;
    }
    case "a": {
      const href = sanitizeHref(node.getAttribute?.("href"));
      return href ? `<a href="${escapeHtmlAttr(href)}">${children}</a>` : children;
    }
    case "tg-emoji": {
      const emojiId = (node.getAttribute?.("emoji-id") ?? "").trim();
      return /^\d+$/.test(emojiId)
        ? `<tg-emoji emoji-id="${emojiId}">${children}</tg-emoji>`
        : children;
    }
    case "br":
      return "\n";
    default:
      return children;
  }
}

function normalizeClass(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeTagName(value: string): string {
  return value.trim().toLowerCase();
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function findSafeHtmlSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) return text.length;

  const limit = Math.max(1, Math.floor(maxLength));
  const newline = text.lastIndexOf("\n", limit - 1);
  if (newline >= Math.floor(limit / 2)) {
    return Math.min(limit, newline + 1);
  }

  const whitespace = text.lastIndexOf(" ", limit - 1);
  if (whitespace >= Math.floor(limit / 2)) {
    return Math.min(limit, whitespace + 1);
  }

  const lastAmpersand = text.lastIndexOf("&", limit - 1);
  if (lastAmpersand !== -1) {
    const semicolon = text.indexOf(";", lastAmpersand);
    if (semicolon >= limit) {
      return Math.max(1, lastAmpersand);
    }
  }

  return limit;
}

function popTag(stack: Array<{ name: string }>, tagName: string): void {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]?.name === tagName) {
      stack.splice(index, 1);
      return;
    }
  }
}
