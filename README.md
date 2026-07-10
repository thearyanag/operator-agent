# operator-agent

`operator-agent` is a self-hosted AI operator for Telegram.

It can sit inside team groups as a support/ops agent, and it can watch delegated personal Telegram conversations through Telegram Business / Chat Automation. The default product stance is conservative: it reads, records, summarizes, and drafts first; it only replies in team groups when explicitly tagged or replied to.

The first version is self-hosted:

- bring your own Telegram bot token
- bring your own Postgres
- bring your own auth / deployment boundary

## Product Modes

### Team Operator

Add the bot to a group. Operator observes messages, stores context, and stays quiet by default.

It invokes the agent only when:

- someone tags the bot, for example `@operator_bot can you check this?`
- someone replies directly to the bot
- someone uses an explicit command such as `/investigate`

This mode is for support groups, ops rooms, customer triage, and internal team workflows where a bot should not spam every thread.

### Personal Operator

Connect the bot through Telegram Business / Chat Automation. Operator watches allowed delegated conversations, identifies important messages, creates digest items, and drafts replies.

The MVP does not auto-send replies. It sends/stores draft text for the owner to review, edit, and send manually.

### Assistant Mode

Message the bot directly in a private DM. Operator answers immediately and keeps the existing per-chat pi session behavior.

## Who It Is For

- founders who want direct visibility into customer issues
- support teams answering harder account questions
- ops teams investigating incidents and user journeys
- product teams diagnosing onboarding, activation, and retention friction

This is an internal/self-hosted operator, not a hosted multi-tenant SaaS product yet.

## What It Does

- records conversations, observations, policy decisions, agent runs, outputs, summaries, memory, and audit events in an `operator` Postgres schema
- watches Telegram groups in read-only mode by default
- replies in groups only on mention/reply/explicit commands
- turns delegated personal messages into digest items or draft replies
- exposes a native Telegram Mini App control panel at `/app`
- streams private DM drafts while the answer is forming
- acknowledges group requests with a thumbs-up reaction, shows typing, and streams answer text by editing one group message
- exposes Operator context tools to pi dynamically: current-chat history in groups/business/current DMs, owner-wide history only in configured owner DMs
- sends useful files, screenshots, exports, or other artifacts back to Telegram
- supports `/investigate`, `/timeline`, `/handoff`, `/case-save`, `/case-open`, `/case-list`, and `/reset` workflows

## Data Sources

The default setup includes read-only connectors for:

- **Postgres** for account, user, and product state
- **Datadog** for logs and error investigation

You can add more pi/MCP tools over time, but the product works best when the connected tools are scoped to operator-safe investigation.

## Postgres State

Set `OPERATOR_DATABASE_URL` to enable the Operator system of record:

```bash
OPERATOR_DATABASE_URL=postgresql://operator:operator@localhost:5432/operator
OPERATOR_OWNER_ID=11111111-1111-4111-8111-111111111111
```

Operator creates an `operator` schema with tables for conversations, observations, policies, runs, outputs, Telegram sessions, summaries, memory, audit events, and Telegram Business connection state.

`DATABASE_URL` is still used by the optional Postgres MCP connector. In a simple self-hosted setup, it may point at the same Postgres database as `OPERATOR_DATABASE_URL`.

SQLite remains as a local compatibility store while the Postgres path replaces runtime state gradually.

## Context Artifacts

When Operator is tagged or commanded, it writes a run-scoped Telegram context file before calling pi.

The prompt includes:

- the most recent 5 observed messages as a preview
- a path to the full context file
- a note to read that file when the answer depends on recent group history

Default paths:

- native local runs: `./.operator/context/<run-id>/telegram-context.md`
- Docker/hosted runs: `/app/operator-context/<run-id>/telegram-context.md`
- physical Docker/hosted volume path: `/data/operator-context/<run-id>/telegram-context.md`

In Docker, `/app/operator-context` is a symlink to `/data/operator-context`, so pi sees a path inside its working tree while the file persists on the `/data` volume.

Postgres stores artifact metadata in `operator.operator_outputs`:

```sql
select payload
from operator.operator_outputs
where type = 'artifact'
order by created_at desc
limit 5;
```

## Mini App

If `PORT` is set, the app serves:

- `/healthz` for health checks
- `/app` for the native Telegram Mini App control panel
- `/api/conversations` for chat/group registry data
- `/api/outputs` for recent drafts, replies, and digest items
- `/api/install-link` for the group-add link

Set these values for the control panel:

```bash
TELEGRAM_BOT_USERNAME=operator_bot
OPERATOR_CONTROL_PANEL_TOKEN=change-me
```

The Mini App API accepts either Telegram Web App init data or the configured bearer/query token.

Set `ALLOWED_USER_IDS` when the Mini App should be limited to specific Telegram users. `OPERATOR_OWNER_ID` is the stable Postgres owner UUID, not a Telegram account ID.

Set `OPERATOR_OWNER_TELEGRAM_IDS` to the Telegram user IDs that may use owner-wide Operator tools from private DM. Without it, pi can still read the current chat context during a run, but it will not receive the cross-chat owner context tool.

```bash
OPERATOR_OWNER_TELEGRAM_IDS=123456789
```

## Telegram Guest Mode

Operator subscribes to Telegram Bot API `guest_message` updates by default. Guest mode lets the bot answer when it is summoned in a chat where it is not a member.

Guest callers use the same access boundary as private DMs: if no `ALLOWED_USER_IDS` or `ALLOWED_GROUP_ID` is configured, any Telegram user can summon the bot; otherwise the caller must be whitelisted or belong to the configured group.

Telegram must report `supports_guest_queries` for the bot. If it does not, Operator logs a startup warning and continues running.

Guest replies can render queued photos, videos, animations, audio, voice notes, and video notes inline when `OPERATOR_PUBLIC_URL` is configured. Operator copies each approved local attachment into its own temporary media spool, exposes it through an opaque URL on the existing HTTP server, and deletes it after 10 minutes. No external object-storage service is required. Documents and stickers still fall back to a note telling the caller to use a DM or add the bot to the chat.

## Telegram Rich Messages

Operator sends Telegram replies as Bot API 10.1 Rich Messages by default. Final replies use `sendRichMessage` or `editMessageText.rich_message`, private DM streaming uses `sendRichMessageDraft`, and guest replies use `answerGuestQuery` with `InputRichMessageContent` followed by rich inline edits.

If Telegram rejects a rich payload because the API/client does not support the new shape or the rich formatting is invalid, Operator falls back to the previous classic HTML renderer and then plain text.

## Telegram Business Automation

Telegram Business / Chat Automation is enabled by default and powers Personal Operator mode.

Users still control this from Telegram. A user must opt in by connecting the bot from Telegram Settings > Chat Automation, and Telegram decides which chats the bot can access. The MVP uses this for reading, digesting, and drafting; it does not auto-send delegated personal replies.

To disable Business automation entirely:

```bash
ENABLE_TELEGRAM_BUSINESS_AUTOMATION=false
```

To limit which connected Telegram users may use Business automation:

```bash
TELEGRAM_BUSINESS_ALLOWED_OWNER_IDS=123456789,987654321
```

## Deploy

| Step | Render | Railway | DigitalOcean |
| --- | --- | --- | --- |
| 1. Deploy | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/thearyanag/operator-agent) | [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/To01dE?referralCode=FKNyCM&utm_medium=integration&utm_source=template&utm_campaign=generic) | [![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/thearyanag/operator-agent/tree/main) |
| 2. Service type | Web service from the included `Dockerfile` if you want the Mini App. | Docker service from the included `Dockerfile` and `railway.json`. | Docker service from the included `.do/deploy.template.yaml`. |
| 3. Required secrets | `TELEGRAM_BOT_TOKEN`, `OPERATOR_DATABASE_URL`, plus one model provider credential. | `TELEGRAM_BOT_TOKEN`, `OPERATOR_DATABASE_URL`, plus one model provider credential. | `TELEGRAM_BOT_TOKEN`, `OPERATOR_DATABASE_URL`, plus one model provider credential. |
| 4. Safe defaults | `PI_MODEL=anthropic/claude-sonnet-4-5`, Telegram streaming and Business automation enabled, `DD_SITE=datadoghq.com`. Set `PORT` for `/app`. | Use the same environment values as Render if the template does not prefill them. | Uses the same defaults as Render. |
| 5. Persistent state | The Blueprint creates a 1 GB disk mounted at `/data`. | The template creates a volume mounted at `/data`. | App Platform local filesystem state is ephemeral. Use an external state backend or choose Render/Railway for durable `/data` state. |
| 6. Start chatting | After deploy succeeds, message your Telegram bot. | After deploy succeeds, message your Telegram bot. | After deploy succeeds and secrets are replaced, message your Telegram bot. |

Render storage is declared in `render.yaml`. Railway volumes are configured in the Railway template composer, not `railway.json`. DigitalOcean's deploy button uses `.do/deploy.template.yaml`; App Platform does not provide persistent volumes.

## Run Locally

### Docker Compose

The easiest local stack is Docker Compose. It starts Postgres and the app together.

Create local config:

```bash
cp .env.example .env
```

Set at least:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=your_bot_username_without_at
OPERATOR_CONTROL_PANEL_TOKEN=dev-token
```

Then configure one model provider, for example Anthropic:

```bash
ANTHROPIC_API_KEY=...
```

Or OpenRouter:

```bash
PI_PROVIDER=openrouter
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=google/gemini-3.1-flash-lite
```

Then run:

```bash
docker compose up --build
```

By default Compose exposes:

- app and Mini App: `http://localhost:3000`
- Postgres on the host: `postgresql://operator:operator@localhost:55432/operator`
- Postgres inside Compose: `postgresql://operator:operator@postgres:5432/operator`

Quick checks:

```bash
curl http://localhost:3000/healthz
curl 'http://localhost:3000/api/install-link?token=dev-token'
psql postgresql://operator:operator@localhost:55432/operator -c '\dt operator.*'
```

Open the control panel at:

```txt
http://localhost:3000/app?token=dev-token
```

To run only Postgres:

```bash
docker compose up postgres
```

### Native Bun

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
TELEGRAM_BOT_USERNAME=your_bot_username_without_at
OPERATOR_DATABASE_URL=postgresql://operator:operator@localhost:55432/operator
OPERATOR_CONTROL_PANEL_TOKEN=dev-token
PORT=3000
```

Then configure Anthropic, OpenRouter, or OpenAI Codex as shown below.

`DATABASE_URL` is only needed for the local Postgres MCP package. `DD_API_KEY`, `DD_APP_KEY`, and `DD_SITE` are only needed if the Datadog MCP package is enabled.

Runtime state is mirrored into Postgres when `OPERATOR_DATABASE_URL` is set. SQLite remains as a local compatibility store. By default local SQLite uses:

```bash
OPERATOR_STATE_DB_PATH=./.operator/state/operator.sqlite
```

To import an old `logs/audit-log.json` file into SQLite:

```bash
bun run migrate:audit
```

To check the local runtime database:

```bash
bun run doctor
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

## Investigation Commands

- `/investigate <id>` sets the active investigation subject for the chat and asks for a structured investigation.
- `/timeline` builds a timeline for the active investigation.
- `/handoff` produces a concise support/engineering handoff.
- `/case-save` saves the active investigation to SQLite.
- `/case-open <case-id>` restores a saved case into the current chat.
- `/case-list` shows recent saved cases for the chat.
- `/reset` clears the active investigation and in-memory agent session for the chat.

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
