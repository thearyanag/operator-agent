# Operator Enablement Plan

Status: final working plan for the product reframe.

Implementation status as of 2026-06-03: Milestones 1-7 now have an MVP implementation in the repo. Memory hardening and the optional GBrain adapter remain future work.

## Direction

Operator is an AI operator for Telegram.

It watches selected Telegram conversations, identifies what matters, and helps the owner summarize, triage, draft, reply, investigate, and follow up.

The product has two primary modes:

- Team Operator: a support and operations agent for groups.
- Personal Operator: a personal scanner for delegated Telegram conversations.

The first version is self-hosted:

- Bring your own Telegram bot token.
- Bring your own Postgres.
- Bring your own auth setup.
- No hosted multi-tenant assumptions yet.

## Product Defaults

### Team Operator

Team mode is for Telegram groups.

Default behavior:

- Read and observe messages in groups where the bot is present.
- Do not proactively reply by default.
- Reply only when tagged, mentioned, or directly replied to.
- Save observations, summaries, unresolved asks, and support context.
- Use external tools only when explicitly needed for a tagged request.

This keeps group behavior predictable and avoids spam.

### Personal Operator

Personal mode is for delegated Telegram conversations through Telegram Business / Chat Automation or an equivalent account-delegation flow.

Default behavior:

- Read allowed delegated conversations.
- Identify important messages.
- Build digests.
- Draft replies.
- Do not send replies automatically.

The user experience should be:

1. Operator detects something important.
2. Operator prepares a draft.
3. The user opens the DM or control panel.
4. The user edits the draft if needed.
5. The user presses send.

### Assistant Mode

Assistant mode is the direct bot DM experience.

Default behavior:

- User messages Operator directly.
- Operator answers immediately.
- Existing pi session behavior can continue while the new data model is introduced.

## Core Architecture

The core architecture is:

```txt
Telegram update
-> conversation registry
-> observation pipeline
-> policy decision
-> mode processor
-> operator output
-> optional Telegram delivery
```

The key change is that messages become product data before they become prompts.

## Postgres System Of Record

Each Operator owner has one Postgres database.

Operator should store its state in an `operator` schema.

Initial tables:

- `operator.users`
- `operator.conversations`
- `operator.conversation_members`
- `operator.conversation_policies`
- `operator.observations`
- `operator.policy_decisions`
- `operator.agent_runs`
- `operator.operator_outputs`
- `operator.telegram_sessions`
- `operator.summaries`
- `operator.memory_items`
- `operator.audit_events`
- `operator.telegram_business_connections`

The current SQLite state should be replaced gradually by Postgres.

## Conversation Registry

The conversation registry is the root product primitive.

A conversation can be:

- A Telegram group where the bot is present.
- A private DM with the bot.
- A delegated Telegram Business / Chat Automation conversation.

Suggested table:

```sql
create table operator.conversations (
  id uuid primary key,
  owner_user_id uuid not null,
  platform text not null default 'telegram',
  mode text not null check (mode in ('team', 'personal', 'assistant')),
  telegram_chat_id text not null,
  telegram_chat_type text not null,
  telegram_business_connection_id text,
  title text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, telegram_chat_id, coalesce(telegram_business_connection_id, ''))
);
```

Default mode mapping:

- Group or supergroup message: `team`
- Telegram Business / delegated conversation: `personal`
- Direct private bot chat: `assistant`

## Observation Pipeline

Every incoming Telegram message should be saved as an observation.

Suggested table:

```sql
create table operator.observations (
  id uuid primary key,
  conversation_id uuid not null references operator.conversations(id),
  platform text not null default 'telegram',
  platform_message_id text not null,
  sender_platform_id text,
  sender_display_name text,
  message_type text not null,
  text text,
  raw_payload jsonb,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (conversation_id, platform_message_id)
);

create index observations_conversation_time_idx
  on operator.observations(conversation_id, observed_at desc);
```

MVP should store:

- message id
- conversation id
- sender id/name
- text or caption
- message type
- Telegram timestamp
- minimal raw Telegram payload

Skip for MVP:

- full media ingestion
- embeddings
- vector search
- GBrain integration
- automatic long-term memory extraction for every message

## Policy Engine

The policy engine decides what to do with each observation.

Possible decisions:

- `ignore`
- `observe`
- `summarize`
- `draft`
- `reply`
- `escalate`
- `save`

Suggested table:

```sql
create table operator.policy_decisions (
  id uuid primary key,
  conversation_id uuid not null references operator.conversations(id),
  observation_id uuid references operator.observations(id),
  action text not null,
  reason text not null,
  confidence numeric,
  should_invoke_agent boolean not null,
  created_at timestamptz not null default now()
);
```

MVP policy:

- `assistant`: invoke agent for direct user messages.
- `team`: observe all messages, invoke agent only when the bot is tagged/replied to.
- `personal`: observe all allowed messages, create digest/draft outputs when important, never auto-send.

The policy engine should be deterministic first. Avoid using the LLM as the first policy gate.

## Mode Processors

After policy, route to a mode-specific processor.

### Team Processor

Inputs:

- observation
- recent group context
- conversation policy
- optional memory/summaries

Outputs:

- support reply
- clarifying question
- unresolved issue
- escalation
- summary
- handoff

MVP:

- Reply only on tag/reply.
- Use current pi bridge for the answer path.
- Save the output before delivery.

### Personal Processor

Inputs:

- observation
- recent personal conversation context
- known owner preferences
- conversation policy

Outputs:

- important item
- draft reply
- digest item
- follow-up

MVP:

- Generate digest items.
- Generate draft replies for important messages that need a response.
- Send drafts to the owner, not to the original chat.
- Do not auto-reply.

### Assistant Processor

Inputs:

- direct DM observation
- existing session context

Outputs:

- assistant reply
- artifact
- summary

MVP:

- Keep the current direct bot behavior.
- Back it with `conversation_id`, `observations`, `agent_runs`, and `operator_outputs`.

## Operator Outputs

All generated artifacts should be saved as outputs before delivery.

Suggested table:

```sql
create table operator.operator_outputs (
  id uuid primary key,
  conversation_id uuid not null references operator.conversations(id),
  observation_id uuid references operator.observations(id),
  agent_run_id uuid references operator.agent_runs(id),
  type text not null,
  status text not null default 'pending',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
```

Output types:

- `reply`
- `draft`
- `digest_item`
- `summary`
- `support_issue`
- `handoff`
- `escalation`
- `artifact`

Delivery is a separate step from generation.

## Mini App Control Panel

The Telegram Mini App is a native part of the product, not a later add-on.

MVP functions:

- Show monitored chats and groups.
- Show mode: team, personal, assistant.
- Show status: active, paused, muted.
- Show recent important items.
- Show drafts.
- Show digests.
- Let the user add a group.
- Let the user pause/resume a conversation.
- Let the user choose whether a group is read-only or tag-reply enabled.

Group onboarding flow:

```txt
Open Mini App
-> Add group
-> Telegram group picker / bot add flow
-> bot joins group
-> start payload links group to owner
-> conversation registered as team mode
```

Personal onboarding flow:

```txt
Open Mini App
-> Connect delegated Telegram access
-> user selects allowed chats where supported
-> conversations registered as personal mode
-> digest + draft behavior starts
```

The Mini App should make the product feel like a controllable operator, not a hidden automation.

## Memory

MVP memory stays Postgres-native.

Suggested table:

```sql
create table operator.memory_items (
  id uuid primary key,
  owner_user_id uuid not null,
  conversation_id uuid references operator.conversations(id),
  kind text not null,
  content text not null,
  metadata jsonb not null default '{}',
  importance numeric,
  source_observation_id uuid references operator.observations(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz
);
```

Memory kinds:

- `preference`
- `person`
- `project`
- `open_loop`
- `support_context`
- `recurring_topic`
- `relationship`
- `instruction`

MVP should write memory conservatively.

Do not turn every observation into memory.

## Summaries

Suggested table:

```sql
create table operator.summaries (
  id uuid primary key,
  owner_user_id uuid not null,
  conversation_id uuid references operator.conversations(id),
  type text not null,
  title text,
  content text not null,
  covers_start_at timestamptz,
  covers_end_at timestamptz,
  source_observation_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
```

Summary types:

- `conversation_digest`
- `personal_daily_digest`
- `team_issue_summary`
- `support_handoff`
- `thread_summary`

## GBrain Future Path

GBrain is intentionally skipped for MVP.

The code should still preserve a clean future integration path.

Add a memory provider interface:

```ts
interface MemoryProvider {
  search(input: {
    ownerId: string;
    conversationId?: string;
    query: string;
  }): Promise<MemoryHit[]>;

  write(input: {
    ownerId: string;
    conversationId?: string;
    kind: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}
```

MVP implementation:

- `PostgresMemoryProvider`

Future implementation:

- `GBrainMemoryProvider`

Processors should only depend on `MemoryProvider`, never directly on GBrain.

This keeps GBrain as an optional semantic memory upgrade rather than a core dependency.

## Implementation Milestones

### Milestone 1: Postgres State Foundation

Goal: replace SQLite as the product state foundation.

Status: MVP implemented.

Build:

- Postgres config: `OPERATOR_DATABASE_URL`
- schema creation / migrations
- `OperatorStore` interface
- `PostgresOperatorStore`
- initial tables: conversations, observations, policy decisions, agent runs, outputs, audit

Keep:

- existing Telegram bot behavior
- existing pi bridge

### Milestone 2: Conversation Registry And Observations

Goal: every Telegram update becomes durable product data.

Status: MVP implemented.

Build:

- Telegram normalizer
- conversation upsert
- observation insert
- dedupe by Telegram message id
- mode defaults: team, personal, assistant

### Milestone 3: Deterministic Policy Engine

Goal: decide what happens before invoking the agent.

Status: MVP implemented.

Build:

- policy engine module
- policy decisions table writes
- team tag/reply detection
- personal importance heuristic
- assistant direct-message behavior

### Milestone 4: Operator Outputs

Goal: save every reply/draft/summary before delivery.

Status: MVP implemented for replies, drafts, digest items, and delivery state. Artifact output records are still future work.

Build:

- output creation
- delivery status tracking
- map current Telegram replies to output records
- map current attachments/artifacts to output records

### Milestone 5: Team Operator MVP

Goal: groups are monitored by default and answered only on tag/reply.

Status: MVP implemented.

Build:

- group observation loop
- tag/reply agent invocation
- saved support replies
- saved unresolved issues when answer is low-confidence
- no keyword-triggered auto-replies yet

### Milestone 6: Personal Operator MVP

Goal: delegated conversations produce digests and drafts.

Status: MVP implemented with owner-DM draft delivery. Direct user-account draft insertion is not available in the current Telegram Bot API path.

Build:

- personal observation loop
- important item detection
- digest generation
- draft reply generation
- DM delivery of drafts to owner
- no auto-send

### Milestone 7: Mini App Control Panel

Goal: users control Operator inside Telegram.

Status: MVP implemented for chat list, output list, pause/resume, and add-group link. Read-only vs tag-reply policy editing is still future work.

Build:

- chat/group list
- conversation status/mode view
- important items
- drafts
- digests
- pause/resume
- add group flow
- read-only vs tag-reply setting

The Mini App should be part of the initial product architecture, but implementation can begin once the backend conversation and output tables exist.

### Milestone 8: Memory And Summary Hardening

Goal: make Operator useful over time without GBrain.

Status: future work.

Build:

- conservative `memory_items` writes
- digest summaries
- conversation summaries
- open-loop tracking
- personal preferences
- support context memory

### Milestone 9: Optional GBrain Adapter

Goal: add long-term semantic memory later without rewriting processors.

Status: future work.

Build:

- `GBrainMemoryProvider`
- allowlisted GBrain read/write operations
- memory extraction jobs
- retrieval before digest/draft/reply generation

This milestone is explicitly out of MVP.

## Non-Goals For MVP

- Hosted multi-tenant SaaS.
- Automatic personal auto-replies.
- Group keyword-triggered replies.
- Full media ingestion.
- Vector search.
- GBrain dependency.
- Complex ticketing/case management.
- Public customer support bot behavior.

## First Build Slice

The first build slice should be:

```txt
Postgres store
-> conversations
-> observations
-> policy decisions
-> current assistant/team reply path backed by outputs
```

Then add:

```txt
personal digest + draft
-> Mini App visibility/control
-> memory/summaries
```

This gives Operator the right product spine before adding intelligence polish.
