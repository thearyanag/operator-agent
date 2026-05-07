# operator-agent

`operator-agent` is a self-hosted Telegram copilot for understanding what happened to a user, an account, or a production issue.

Instead of opening the admin dashboard, logs, SQL, deploy history, and a support thread separately, you ask one question in chat. The agent checks the systems you connect, returns a grounded answer, and keeps the investigation in the same conversation.

## What You Ask

- What happened to this user?
- Where did they get stuck?
- What errors did they hit?
- Did a deploy or outage affect them?
- What is this account's current state?
- Which users were affected by this issue?
- Can you send me the relevant export or evidence?

The best use case is follow-up investigation:

> You: What happened to user 12345?
>
> Agent: They completed signup, hit a billing error during onboarding, retried twice, and never finished activation. I found the failure in Datadog and confirmed the account state in Postgres.
>
> You: Did the latest deploy cause it?
>
> Agent: Likely yes. The first matching error appears three minutes after the deploy and affects the same endpoint. I found 11 similar failures in the last hour.

## Who It Is For

- founders who want direct visibility into customer issues
- support teams answering harder account questions
- ops teams investigating incidents and user journeys
- product teams diagnosing onboarding, activation, and retention friction

This is an internal operator copilot, not a public support chatbot or a replacement for every dashboard.

## What It Does

- answers in Telegram, where the operator is already working
- keeps per-chat memory so follow-up questions stay in context
- streams private DM drafts while the answer is forming
- shows live progress during longer group and Business chats
- can run from a user's connected Telegram Business / Chat Automation profile
- sends useful files, screenshots, exports, or other artifacts back to Telegram
- records audit logs for prompts, failures, and reply delivery

## Data Sources

The default setup includes read-only connectors for:

- **Postgres** for account, user, and product state
- **Datadog** for logs and error investigation

You can add more pi/MCP tools over time, but the product works best when the connected tools are scoped to operator-safe investigation.

## Telegram Business Automation

Telegram Business / Chat Automation is enabled by default.

Users still control this from Telegram. A user must opt in by connecting the bot from Telegram Settings > Chat Automation, and Telegram decides which chats the bot can access and whether it can reply. The app mirrors the latest connection state for audit/debugging and only replies when Telegram grants `can_reply`.

To disable Business automation entirely:

```bash
ENABLE_TELEGRAM_BUSINESS_AUTOMATION=false
```

To limit which connected Telegram users may use Business automation:

```bash
TELEGRAM_BUSINESS_ALLOWED_OWNER_IDS=123456789,987654321
```

## Deploy

### Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/thearyanag/operator-agent)

Render deploys `operator-agent` as a background worker. The deploy form asks for secrets and prefills safe defaults.

Required:

- `TELEGRAM_BOT_TOKEN`
- `ANTHROPIC_API_KEY`
- `DATABASE_URL`
- `DD_API_KEY`
- `DD_APP_KEY`

Prefilled:

- `PI_MODEL=anthropic/claude-sonnet-4-5`
- `ENABLE_TELEGRAM_NATIVE_STREAMING=true`
- `ENABLE_TELEGRAM_BUSINESS_AUTOMATION=true`
- `TELEGRAM_BUSINESS_DRY_RUN=false`
- `DD_SITE=datadoghq.com`

### Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/To01dE?referralCode=FKNyCM&utm_medium=integration&utm_source=template&utm_campaign=generic)

Railway can deploy this repo from GitHub using the included `Dockerfile` and `railway.json`.

## Run Locally

Install dependencies:

```bash
bun install
```

Create local config:

```bash
cp .env.example .env
cp .mcp.json.example .mcp.json
```

Set at least:

```bash
TELEGRAM_BOT_TOKEN=...
ANTHROPIC_API_KEY=...
DATABASE_URL=...
DD_API_KEY=...
DD_APP_KEY=...
DD_SITE=datadoghq.com
```

Start the bot:

```bash
bun run start
```

For local iteration:

```bash
bun run dev
```

## Model Provider

The default model is Anthropic Claude Sonnet 4.5:

```bash
PI_MODEL=anthropic/claude-sonnet-4-5
ANTHROPIC_API_KEY=...
```

To use OpenRouter:

```bash
PI_PROVIDER=openrouter
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=google/gemini-3.1-flash-lite
```

To use OpenAI Codex:

```bash
PI_PROVIDER=openai-codex
OPENAI_CODEX_AUTH_JSON='{"openai-codex":{...}}'
```

You can also set `OPENAI_CODEX_ACCESS_TOKEN`, `OPENAI_CODEX_REFRESH_TOKEN`, `OPENAI_CODEX_EXPIRES_AT_MS`, and `OPENAI_CODEX_ACCOUNT_ID` instead of `OPENAI_CODEX_AUTH_JSON`.

## Access Control

By default, anyone who can message the bot can use it. For internal deployments, set one or both:

```bash
ALLOWED_USER_IDS=123456789,987654321
ALLOWED_GROUP_ID=-1001234567890
```

If `ALLOWED_GROUP_ID` is set, members of that group can use the bot in the group and in DMs, as long as the bot can verify membership.

## Files And Exports

The agent can send generated artifacts back to Telegram, such as CSV exports, logs, images, and documents.

For safety, files must already exist on disk and stay inside `TELEGRAM_ATTACHMENT_ROOTS`.

```bash
TELEGRAM_ATTACHMENT_ROOTS=/data/artifacts,/app/artifacts
```

## Boundaries

`operator-agent` is built for internal, self-hosted investigation. It is a strong fit for:

- support and ops workflows
- read-only production context
- account-level investigation
- incident triage and follow-up analysis

It is not meant to be:

- a consumer support bot
- a hosted multi-tenant SaaS product
- a system that automatically understands your business without connected tools
- a place to expose broad write access to production systems

## Maintainers

Implementation notes live in:

- `docs/architecture.md`
- `docs/investigation-workflows.md`
- `docs/positioning.md`

Validation:

```bash
bun run check
bun test tests
docker build -t operator-agent:local .
```
