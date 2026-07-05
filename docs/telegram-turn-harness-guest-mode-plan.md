# Telegram Turn Harness and Guest Mode Plan

## Goal

Refactor Telegram handling around one turn harness, then add Telegram Bot API guest mode as another Telegram delivery mode. Guest mode must not be controlled by an `ENABLE_TELEGRAM_GUEST_MODE` flag.

Telegram Bot API guest mode was introduced in Bot API 10.0. It lets bots receive `guest_message` updates and respond in chats where the bot is not a member by calling `answerGuestQuery` with the message's `guest_query_id`.

## Why

The current Telegram entrypoint mixes update routing, access checks, prompt construction, Operator persistence, policy decisions, pi execution, and reply delivery inside `src/telegram/handlers.ts`. Guest mode has different delivery semantics from standard chat and group messages, so adding it directly there would make future Telegram extensions harder.

A turn harness gives us one normalized Telegram turn model and keeps surface-specific behavior behind small adapters.

## Target Shape

- `turn-envelope.ts`: extract Telegram updates into normalized envelopes.
- `turn-classifier.ts`: classify a turn as start, prompt run, unsupported, or ignored.
- `turn-harness.ts`: dispatch classified turns to handlers.
- Standard chat/group messages keep the current reply sink and policy behavior.
- Guest messages use a guest reply sink:
  - first response: `answerGuestQuery(guest_query_id, InlineQueryResultArticle)`
  - follow-up updates: edit the returned inline message if Telegram returns `inline_message_id`
  - fallback: answer once with the final/error text if editing is unavailable

Business automation can remain on the existing path for the first pass. It can move into the harness later once guest mode is stable.

## Implementation Steps

1. Add Bot API compatibility for guest mode.
   - Add `"guest_message"` to `TelegramAllowedUpdate`.
   - Include it unconditionally in startup allowed updates.
   - Add narrow local types for `guestMessage`, `guest_query_id`, `guest_bot_caller_user`, and `answerGuestQuery` if the installed grammY types do not expose them.

2. Add normalized turn modules.
   - `src/telegram/turn-envelope.ts`
   - `src/telegram/turn-classifier.ts`
   - `src/telegram/turn-harness.ts`

3. Migrate standard message handling.
   - Route `/start` and `message` updates through the turn harness.
   - Preserve current authorization, Operator observation recording, policy decisions, and pi execution behavior.

4. Add guest handling.
   - Extract guest message envelope.
   - Validate `guest_query_id` and caller identity.
   - Accept text/caption first.
   - Build `surface: "guest"` run context.
   - Use a guest sink with `answerGuestQuery`, not `sendMessage`.

5. Add startup verification.
   - After `getMe`, warn if `supports_guest_queries` is false.
   - Do not fail startup.

6. Add tests.
   - `telegramAllowedUpdates` includes `guest_message`.
   - Guest envelope rejects missing `guest_query_id`.
   - Guest sink answers once and edits after an inline message ID exists.
   - Guest prompt uses `answerGuestQuery`, not normal chat send APIs.
   - Existing private/group tests still pass.

## Non-Goals

- No Mini App guest mode changes.
- No public unauthenticated API access.
- No artifact delivery in guest mode v1 unless it falls out cheaply as text links.
- No broad Business automation rewrite in the first pass.

## Notes

Telegram guest mode is not equivalent to normal bot membership in a chat. Guest responses are query answers and inline-message edits, not ordinary `sendMessage` calls.
