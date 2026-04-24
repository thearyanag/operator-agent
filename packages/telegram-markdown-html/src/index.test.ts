import { describe, expect, test } from "bun:test";
import { renderTelegramHtml, renderTelegramMessageChunks, splitTelegramHtml } from "./index";

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

describe("renderTelegramHtml", () => {
  test("renders spoilers and underline", () => {
    const html = renderTelegramHtml("This is ||secret|| and ++underlined++.");
    expect(html).toContain("<tg-spoiler>secret</tg-spoiler>");
    expect(html).toContain("<u>underlined</u>");
  });

  test("renders expandable blockquotes", () => {
    const html = renderTelegramHtml(":::expandable\nHidden details\n:::");
    expect(html).toContain("<blockquote expandable>");
    expect(html).toContain("Hidden details");
  });

  test("renders fenced code blocks with language", () => {
    const html = renderTelegramHtml("```ts\nconst x = 1;\n```");
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain("const x = 1;");
  });

  test("sanitizes allowed raw telegram html", () => {
    const html = renderTelegramHtml('<u>Hello</u> <tg-spoiler>secret</tg-spoiler>');
    expect(html).toContain("<u>Hello</u>");
    expect(html).toContain("<tg-spoiler>secret</tg-spoiler>");
  });

  test("strips unsupported raw html tags but keeps text", () => {
    const html = renderTelegramHtml('<script>alert(1)</script><div>Hello</div>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("Hello");
  });

  test("renders tables as wrapped monospace boxes", () => {
    const html = renderTelegramHtml(`| Feature | Notes |\n| --- | --- |\n| Tables | This note is long enough to wrap across multiple monospace lines in Telegram |`);
    expect(html).toContain("<pre><code>");
    expect(html).toContain("┌");
    expect(html).toContain("┬");
    expect(html).toContain("│ Tables");
  });
});

describe("splitTelegramHtml", () => {
  test("preserves text and valid html boundaries when splitting", () => {
    const html = "<b>Hello world</b>";
    const parts = splitTelegramHtml(html, 8);
    expect(parts.length).toBeGreaterThan(1);
    expect(stripTags(parts.join("")).replace(/\s+/g, "")).toBe("Helloworld");
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(8);
    }
  });

  test("renders and splits markdown end-to-end", () => {
    const parts = renderTelegramMessageChunks("**Hello** ||world||", 64);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.some((part) => part.includes("<b>Hello</b>"))).toBe(true);
    expect(parts.some((part) => part.includes("<tg-spoiler>world</tg-spoiler>"))).toBe(true);
  });
});
