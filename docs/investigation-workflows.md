# Investigation Workflows Draft

Status: baseline implemented for the operator investigation command surface.

## Goal

Turn the bot from a generic chat interface over tools into a focused internal operator console for investigations.

Core idea:
- investigate a specific user/account/workspace
- keep follow-up context across turns
- produce structured, evidence-backed answers
- generate handoff artifacts for support or engineering

## Proposed Command Surface

### Phase 1

- `/reset`
- `/investigate <id>`
- `/timeline`
- `/handoff`

### Phase 2

- `/case-save`
- `/case-open <id>`
- `/case-list` (optional)

## Command Definitions

### `/reset`

Clears the current chat's active investigation state and pi session.

Use cases:
- start over from a clean slate
- recover from bad context
- refresh after config or tool changes

Expected behavior:
- delete the in-memory pi session for the current chat
- clear active investigation subject/context for the current chat
- confirm reset in chat

### `/investigate <id>`

Starts or refreshes an investigation for a subject.

Accepted inputs can include:
- email
- user id
- account id
- workspace id

Expected behavior:
- store the subject as the active investigation target for this chat
- ask pi for a structured investigation summary
- future follow-up questions in the same chat implicitly refer to this subject until changed or reset

Expected output shape:
- Summary
- What happened
- Current state
- Evidence
- Likely cause
- Recommended next checks

### `/timeline`

Produces a normalized timeline for the current investigation target.

Expected behavior:
- require an active investigation target
- if none exists, instruct the user to run `/investigate <id>` first
- ask pi to synthesize a cross-system timeline

Desired sources over time:
- product/app events
- database state changes
- Datadog logs and errors
- billing/subscription events
- deploy/release events

Expected output shape:
- timestamped event sequence
- grouped by most relevant milestones
- short note on likely stall/failure point

### `/handoff`

Generates a concise handoff summary for the current investigation.

V1 behavior:
- produce a generic handoff summary

Possible future variants:
- `/handoff support`
- `/handoff eng`
- `/handoff founder`

Expected output shape:
- Issue summary
- User/account context
- What was verified
- Evidence
- What remains unknown
- Recommended next action

### `/case-save`

Persists the current investigation as a saved case.

Expected behavior:
- require active investigation context
- save current case data to the operator state database
- return generated case id

Example saved data:
- case id
- subject
- resolved identifiers
- created at / updated at
- last summary
- last response
- optional evidence/timeline snapshot

### `/case-open <id>`

Loads a saved case into the current chat.

Expected behavior:
- load the saved case from the operator state database
- restore active investigation subject/context for this chat
- optionally restore a compact case summary into the next pi prompt
- confirm the case is active

### `/case-list` (optional)

Lists saved cases so users can reopen old investigations.

Expected behavior:
- show recent saved cases
- include id, subject, and updated time

## Why This Command Surface

This command set is intentionally opinionated.

It moves the product from:
- "Telegram bot with access to tools"

to:
- "operator investigation console in chat"

This aligns with the positioning:
- stop dashboard hopping
- investigate what happened to a user
- keep asking why
- follow up across systems in one conversational loop

## Proposed Output Standard

Investigation-oriented responses should trend toward a consistent structure:

1. Summary
2. What happened
3. Evidence
4. Likely cause
5. Open questions
6. Recommended next action

Not every response has to rigidly follow this format, but the product should generally bias toward structured, operationally useful answers.

## Lightweight Data Model

### Active in-memory investigation state

```ts
type ActiveInvestigation = {
  subject: string;
  openedCaseId?: string;
};
```

Tracked per chat/session.

### Persisted case shape

```ts
type InvestigationCase = {
  id: string;
  subject: string;
  createdAt: string;
  updatedAt: string;
  chatId: number | string;
  sessionKey: string;
  summary?: string;
  lastResponse?: string;
};
```

This can stay minimal in v1 and expand later with:
- identifiers
- evidence
- timeline
- source metadata
- notes

## Recommended Build Order

### First

1. `/reset`
2. `/investigate <id>`
3. `/timeline`
4. `/handoff`

These are the highest-leverage UX improvements and do not require much persistence complexity.

### Second

5. `/case-save`
6. `/case-open <id>`

These require persistence and case lifecycle decisions.

### Later

- `/case-list`
- role-specific handoffs
- saved evidence/timeline artifacts
- deploy correlation mode
- investigation playbooks by issue type

## Product Principle

The product should expose a small number of repeatable operator workflows rather than forcing users to understand the underlying MCP tools or connectors.

The user experience goal is:
- ask about a user/account
- get a structured answer
- keep drilling with follow-ups
- save or hand off the investigation when needed
