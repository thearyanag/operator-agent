# telegram-markdown-html

Render Markdown into Telegram-safe HTML.

## Features

- Standard Markdown: headings, bold, italic, strike, links, lists, blockquotes, code, fenced code, tables
- Telegram-specific features:
  - spoilers via `||spoiler||`
  - underline via `++underline++`
  - expandable blockquotes via `:::expandable ... :::`
- Safe passthrough for Telegram HTML fragments such as `<u>`, `<tg-spoiler>`, `<blockquote expandable>`, `<tg-emoji emoji-id="...">`
- Chunking that preserves valid Telegram HTML tags across message splits

## Install

```bash
npm install telegram-markdown-html
```

## Usage

```ts
import { renderTelegramHtml, renderTelegramHtmlChunks } from "telegram-markdown-html";

const html = renderTelegramHtml(`
# Hello

> quote

:::expandable
Hidden details
:::

This is ||spoiler|| and ++underline++.
`);

const chunks = renderTelegramHtmlChunks(html, 4000);
```

## Notes

- Telegram does not support HTML list tags or heading tags, so these are rendered as formatted plain text.
- Tables are rendered as monospaced `<pre><code>` blocks.
- Raw HTML is sanitized to Telegram-supported tags only.
