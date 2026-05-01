# Positioning Draft

Status: working notes captured from the internal launch discussion. This is intentionally a draft, not final copy.

## One-Liner

An internal operator copilot that lets founders and ops teams investigate user journeys, errors, and production state from chat instead of hopping between dashboards, logs, and SQL consoles.

## Core Thesis

Dashboards are good for predefined metrics. Day-to-day operator work is different:

- the question is usually ad hoc
- the answer often spans multiple systems
- the first answer creates follow-up questions

This product is strongest when it replaces dashboard hopping for routine investigations, not when it claims to replace every dashboard entirely.

## Product Framing

- internal operator copilot
- no-dashboard workflow for routine ops investigations
- read-only access to production context
- conversational investigation across Postgres, Datadog, and internal tools
- Telegram is the interface, not the product identity

## Who It Is For

- founders
- operations teams
- support teams
- product teams

These users should be able to answer routine operational questions without pulling an engineer into every thread.

## Problem It Solves

The recurring founder and operator questions are usually:

- What happened to this user?
- Where did they get stuck?
- What errors did they hit?
- Did the latest deploy affect them?
- What is the state of this account across systems?

Today, answering those questions usually means opening several tools:

- admin dashboards
- logs
- SQL consoles
- analytics dashboards

This product compresses that workflow into one conversational loop.

## Why It Works

- cross-system context instead of one dashboard at a time
- user-level investigation instead of only aggregate metrics
- follow-up questions instead of static predefined panels
- faster answers without spending engineering time on simple operational queries

The most important differentiator is not "natural language queries." The differentiator is the ability to keep drilling with follow-ups until the operator actually understands what happened.

## Internal Proof Point

The strongest internal story is:

- the team stopped living in dashboards for many day-to-day investigations
- instead of opening the admin dashboard, logs, and SQL manually, they asked the bot in the group
- the follow-up loop was more useful than a static dashboard because they could keep asking why

This supports a strong but credible claim:

- stop dashboard hopping for routine ops investigations

It does not support an inflated claim like:

- replace dashboards overall

## Positioning Language To Use

- stop dashboard hopping
- ask what happened to a user and keep asking why
- your internal operator console in chat
- natural-language access to customer journeys, logs, and database state
- read-only answers from Postgres and Datadog, in chat
- from static dashboards to conversational investigation

## Positioning Language To Avoid

- replace all dashboards
- no engineering needed
- ask anything about production
- plug it in and it understands your business automatically

Those claims are too broad and create trust problems.

## Strong Pitch Variants

### Short version

Founders and ops teams should not need to open dashboards, logs, and SQL consoles just to understand what happened to one user.

### Slightly longer version

Ask about a user, issue, or journey in chat. The agent checks Postgres, Datadog, and app context, returns a usable answer, and lets you keep drilling with follow-up questions.

### Contrast statement

- dashboards show what changed
- this product helps explain why it changed and what happened to a specific user

## Example Use Cases

- "How is user `X` doing in their journey?"
- "Where did this user get stuck during onboarding?"
- "Why did this account churn?"
- "Show me the errors this user hit in the last 7 days."
- "Summarize this customer's support and product friction."
- "Did the latest deploy affect activation?"

## Product Boundaries

This repo is best positioned as:

- a self-hosted internal operator tool
- a trusted read-only support and investigation agent
- a starter kit for MCP-connected ops assistants

This repo is not best positioned as:

- a consumer support bot
- a public multi-tenant product in its current architecture
- a general-purpose Telegram AI assistant

## Open Questions For Later

- whether Telegram remains the primary surface or just the first surface
- how opinionated the public version should be about Datadog and Postgres connectors
- whether the launch should target founders directly or broader ops/support teams
- what level of workflow memory and saved investigations should exist outside chat
