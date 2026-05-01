# operator-agent

A self-hosted operator copilot for investigating what happened to a user, an account, or a production issue — from chat.

Founders, ops teams, support teams, and product teams should not need to open five tools just to answer a routine question. Most of the time, the workflow looks like this:

- open the admin dashboard
- open logs
- open SQL
- check a deploy
- ask engineering for help
- lose the thread halfway through

**operator-agent is the alternative.**

Ask a question in chat. The agent checks the systems it has access to, returns a grounded answer, and lets you keep drilling with follow-up questions until you understand what actually happened.

## Who this is for

- founders who want direct visibility into customer issues
- ops teams investigating account state and user journeys
- support teams trying to answer harder customer questions
- product teams diagnosing friction in onboarding, activation, and retention

## What it helps answer

- What happened to this user?
- Where did they get stuck?
- What errors did they hit?
- Did the latest deploy affect them?
- What is the state of this account across systems?
- Why is this customer having a bad experience right now?

## Why this is useful

Dashboards are great when the question is already known.

Operator work is different.

The question is usually ad hoc. The answer usually spans multiple systems. And the first answer usually creates the next question.

That is where `operator-agent` is strongest.

It is built for:

- conversational investigation instead of dashboard hopping
- read-only access to production context
- user-level answers instead of only aggregate metrics
- follow-up questions in the same thread of investigation

This repo is best thought of as an **internal operator copilot**, not a general-purpose chatbot.

## See the workflow

A typical loop looks like this:

> You: What happened to user 12345?
>
> Agent: They completed signup, hit an error during onboarding, retried twice, and never finished activation. I found the failure in logs and confirmed the account state in Postgres.
>
> You: What error did they hit?
>
> Agent: A 500 from the billing service starting at 14:03 UTC. It affected 11 requests in that window.
>
> You: Did the latest deploy cause it?
>
> Agent: Likely yes. The errors begin three minutes after the deploy and cluster around one service. Want me to summarize the affected users?

That is the product: ask what happened, then keep asking why.

## Current capabilities

Today, `operator-agent` supports:

- read-only investigation through Postgres and Datadog
- persisted per-chat sessions for follow-up questions
- live progress updates during long investigations
- Telegram-friendly rich response formatting
- explicit delivery of exports, images, and other artifacts back into chat
- audit logging for prompts, failures, and reply delivery

## Product boundaries

`operator-agent` is a strong fit for:

- internal support and ops investigations
- self-hosted operator workflows
- teams that want a trusted read-only assistant over production context
- MCP-connected internal tools and data sources

It is not currently positioned as:

- a consumer support bot
- a public multi-tenant SaaS product
- a replacement for every dashboard
- a zero-setup system that automatically understands your business

---

## Quick start

### 1. Install

```bash
bun install
```

### 2. Configure environment

```bash
cp .env.example .env
```

At minimum, set:

- `TELEGRAM_BOT_TOKEN`

If you want the default investigation sources, also configure:

- `DATABASE_URL`
- `DD_API_KEY`
- `DD_APP_KEY`
- `DD_SITE` optional

### 3. Configure MCP sources

```bash
cp .mcp.json.example .mcp.json
```

This repo already includes project-local MCP servers for:

- `packages/postgres-mcp`
- `packages/datadog-mcp`

### 4. Run

```bash
bun run start
```

For development:

```bash
bun run dev
```

## Configuration

### Telegram access control

- `ALLOWED_USER_IDS` — optional comma-separated Telegram user IDs allowed to DM the bot
- `ALLOWED_GROUP_ID` — optional Telegram group or supergroup ID; members of this group can use the bot, and the group itself can chat with it

### Agent runtime

- `PI_WORKDIR` — optional working directory for pi
- `PI_MODEL` — optional explicit `provider/model-id`
- `PI_THINKING_LEVEL` — optional thinking level
- `PI_EXTENSION_PATHS` — optional extra extension paths
- `PI_SYSTEM_PROMPT_PATH` — optional path to the operator system prompt file
- `PI_SESSION_DIR` — optional directory for persisted per-chat pi sessions

Default operator prompt:

- `prompts/system-prompt.md`

## File and media delivery

The bot exposes a custom pi tool:

- `telegram_queue_attachment`

This lets the agent send useful investigation artifacts back into Telegram after the final reply.

Supported attachment kinds:

- `document`
- `photo`
- `video`
- `animation`
- `audio`
- `voice`
- `video_note`
- `sticker`
- `auto`

For safety:

- files must already exist on disk
- files must stay inside `TELEGRAM_ATTACHMENT_ROOTS`
- relative paths are resolved from `PI_WORKDIR`
- files are validated before send

When compatible items are queued consecutively, the bot groups them more cleanly where Telegram allows it.

## Runtime behavior

By default, the bot:

- persists per-chat sessions across restarts
- keeps Telegram typing alive during long investigations
- edits a live progress message during longer runs
- renders final answers with Telegram HTML formatting
- falls back to plain text if Telegram rejects formatted output
- writes audit logs to `logs/audit-log.json`

## Included sources

This repo currently includes local MCP servers for:

- **Postgres** — read-only database inspection
- **Datadog** — logs and error investigation

The MCP adapter is configured so these sources appear to pi as direct tools.

## Stack

For teams evaluating or extending the implementation:

- runtime: **Bun**
- Telegram bot: **grammY**
- agent runtime: **pi SDK** via `@mariozechner/pi-coding-agent`
- MCP bridge: project-local **`pi-mcp-adapter`** config via `.mcp.json`
- local connectors:
  - `packages/postgres-mcp`
  - `packages/datadog-mcp`
- Telegram rendering package:
  - `packages/telegram-markdown-html`

pi auth follows standard pi conventions, including:

- `~/.pi/agent/auth.json`
- provider API keys in env such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
- extension discovery from `~/.pi/agent/extensions/` and `.pi/extensions/`
- project-local pi packages from `.pi/settings.json`

## Repo guide

- `index.ts` — main Telegram bot
- `prompts/system-prompt.md` — operator behavior prompt
- `.mcp.json` — MCP adapter configuration
- `packages/postgres-mcp` — local Postgres MCP server
- `packages/datadog-mcp` — local Datadog MCP server
- `packages/telegram-markdown-html` — Telegram HTML renderer
- `docs/investigation-workflows.md` — workflow notes
- `docs/positioning.md` — internal positioning notes
