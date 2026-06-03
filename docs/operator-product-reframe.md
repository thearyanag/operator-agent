# Operator Product Reframe

Status: working product direction.

## Core Thesis

Operator is an AI operations layer for Telegram.

It watches the conversations a user or team chooses, separates signal from noise, and helps people act: summarize, triage, investigate, draft, escalate, and follow up.

The product is not primarily a generic Telegram chatbot. It is a conversation monitoring and action system for personal and professional workflows.

## Product Promise

Operator helps you understand what matters across Telegram and respond with less manual scanning.

For teams, it becomes a support and operations agent inside groups.

For individuals, it becomes a personal scanner for their Telegram account, surfacing important messages, summaries, missed asks, and suggested replies.

## Product Modes

### Team Operator

Team Operator is used in groups, communities, support rooms, company chats, and operational channels.

The user adds the bot to a Telegram group. Operator can then act as a support or operations agent for that group.

Expected jobs:

- Answer common support questions.
- Detect unresolved asks.
- Summarize active issues.
- Triage bugs, complaints, leads, requests, and escalations.
- Route issues to humans when confidence is low.
- Investigate production, customer, or account state when connected to tools.
- Produce concise handoffs for support, founders, or engineering.
- Keep group context across follow-up questions.

The professional pitch:

> Add Operator to a Telegram group and it becomes your support and ops copilot.

### Personal Operator

Personal Operator is used through Telegram Business / Chat Automation or equivalent delegated account access.

The user delegates their own Telegram account to Operator. Operator can then watch the chats the user allows and act as a personal scanner.

Expected jobs:

- Summarize what happened while the user was away.
- Identify messages that need attention.
- Detect missed asks and follow-ups.
- Prioritize important people, groups, threads, and opportunities.
- Draft replies in the user's voice.
- Create daily or real-time briefs.
- Flag urgent issues, risks, customer complaints, or high-value messages.
- Optionally auto-reply in narrowly approved contexts.

The personal pitch:

> Delegate your Telegram to Operator and get a prioritized brief of what matters.

## Product Primitive

The core primitive is a monitored conversation.

A monitored conversation can be:

- A Telegram group where the bot is present.
- A private chat with the bot.
- A Business / Chat Automation conversation connected through a user's delegated account.

Each monitored conversation should have:

- Scope: what Operator can read and reply to.
- Mode: team, personal, or direct assistant.
- Policy: when Operator should observe, summarize, draft, reply, or stay silent.
- Memory: recent context, active topics, open questions, and saved cases.
- Tools: optional external systems such as Postgres, Datadog, CRM, docs, or ticketing.

## Default Behavior

Operator should default to quiet, useful behavior.

For teams:

- Reply when mentioned or when a configured support trigger is detected.
- Summarize unresolved issues.
- Escalate when it cannot answer with confidence.
- Avoid pretending to know facts it has not verified.

For individuals:

- Watch and summarize.
- Prioritize attention.
- Draft before sending.
- Auto-reply only when explicitly enabled for a chat, topic, or rule.

## Safety Boundaries

Operator should be permissioned and transparent.

Important boundaries:

- Users choose which groups or chats are monitored.
- Personal delegated access should start in read/summarize/draft mode.
- Auto-reply should be opt-in and narrowly scoped.
- Support answers should distinguish verified facts from guesses.
- Tool access should be read-only by default.
- Audit logs should record prompts, replies, tool use, and suppression decisions.
- Internal account, database, and telemetry details should not leak into user-facing replies unless intended.

## Current Repo Fit

The existing repo already supports several pieces of this direction:

- Telegram bot surface for private and group chats.
- Telegram Business / Chat Automation support for delegated account flows.
- Per-chat session keys and pi sessions.
- Progress messages and private draft streaming.
- SQLite-backed sessions, runs, audit events, artifacts, cases, and active investigations.
- `/investigate`, `/timeline`, `/handoff`, `/case-save`, `/case-open`, `/case-list`, and `/reset`.
- Postgres and Datadog MCP connectors.
- Telegram attachment delivery for generated artifacts.

The current repo is closest to Team Operator for investigation and support workflows.

The newer product direction adds Personal Operator as a first-class mode and reframes the whole product around monitored conversations instead of one-off prompts.

## Main Enablement Gaps

To enable this product direction, the repo needs product primitives beyond the current prompt loop:

- Conversation registry: which chats are monitored and in what mode.
- Policy engine: when to observe, summarize, draft, reply, escalate, or ignore.
- Inbox / digest model: important items, summaries, missed asks, and follow-ups.
- Personal scanner flow: delegated Telegram account summaries and drafts.
- Team support flow: group trigger detection, support responses, and escalation.
- Safer tool boundary: read-only connectors and explicit action permissions.
- Better state model: conversations, observations, tasks, summaries, drafts, and cases.
- UX commands for configuration, such as enable, disable, digest, watch, mute, and policy settings.

## Reframe Summary

Old framing:

> A Telegram copilot for investigating users, accounts, and production issues.

New framing:

> Operator is an AI operations layer for Telegram. It watches selected conversations, identifies what matters, and helps you summarize, triage, investigate, draft, reply, and follow up.

Two product modes:

- Team Operator: support and ops agent for Telegram groups.
- Personal Operator: personal scanner and assistant for delegated Telegram conversations.
