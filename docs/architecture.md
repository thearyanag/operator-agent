# Architecture

`operator-agent` is organized around one runtime loop: receive a Telegram message, turn it into a pi prompt, stream progress back to Telegram, send the final answer and queued artifacts, then write an audit trail.

## Runtime Flow

1. `index.ts` loads configuration, creates the audit logger, creates the pi bridge, registers Telegram handlers, and starts grammY polling.
2. `src/telegram/handlers.ts` owns Telegram update routing and authorization decisions.
3. `src/telegram/context.ts` converts Telegram messages into stable run contexts and pi prompts.
4. `src/pi/bridge.ts` owns pi sessions, per-chat prompt queues, pi event normalization, and the `telegram_queue_attachment` tool.
5. `src/telegram/replies.ts` owns typing indicators, progress messages, private-DM draft streaming, final reply rendering, and error delivery.
6. `src/telegram/attachments.ts` validates queued files and sends them through the correct Telegram media APIs.
7. `src/state/operator-db.ts` owns the local SQLite runtime database for Telegram sessions, runs, Business connections, artifacts, cases, evidence, and audit events.

## Module Boundaries

- `src/config.ts` is the only place that should read `Bun.env`.
- `src/pi/bridge.ts` should not know about Telegram routing or authorization.
- `src/telegram/handlers.ts` should stay HTTP/chat focused: route updates, reject unsafe requests, and call the pi bridge.
- `src/telegram/replies.ts` should own Telegram delivery mechanics, including fallbacks when Telegram rejects formatted HTML.
- `src/telegram/business.ts` should stay limited to Business connection normalization and reply eligibility.
- `src/state/operator-db.ts` should own canonical operator runtime tables; config, prompts, MCP config, PI-owned session files, and explicit user artifacts stay file-backed.
- `packages/*` are reusable local packages or MCP servers. Keep product runtime code in `src/` unless it is intentionally reusable.

## Extension Guidelines

- Add new environment variables in `src/config.ts`, then document them in `.env.example` and `README.md`.
- Add new Telegram update types in `src/telegram/handlers.ts`; keep prompt construction in `src/telegram/context.ts`.
- Add new pi-facing tools in `src/pi/bridge.ts` only when the tool needs active session context.
- Add reusable source integrations as local MCP packages under `packages/*`.
- Keep audit entries structured and bounded; large raw payloads should be truncated through `AuditLogger` before they are inserted into SQLite.

## Safety Defaults

- Telegram DM access is allowlist/group-gated when configured.
- Telegram Business automation is disabled unless explicitly enabled.
- Business replies require Telegram's current `can_reply` permission.
- Attachments must already exist, must be files, must stay inside configured roots, and must fit Telegram's document size limit.
- pi prompts are queued per Telegram session key so overlapping messages in the same chat do not race the same session.
