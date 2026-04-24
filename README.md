# operator-agent

Minimal Telegram bot scaffolded with Bun + grammY, now wired to the **pi SDK**.

## Install

```bash
bun install
```

## Configure

Copy the example env file and fill in your bot token:

```bash
cp .env.example .env
```

Telegram env vars:

- `TELEGRAM_BOT_TOKEN` — required bot token from BotFather
- `ALLOWED_USER_IDS` — optional comma-separated user IDs allowed to DM the bot
- `ALLOWED_GROUP_ID` — optional group/supergroup ID; users in this group can use the bot, and messages in that group are forwarded to pi too

pi env vars:

- `PI_WORKDIR` — optional working directory for pi
- `PI_MODEL` — optional `provider/model-id`, for example `anthropic/claude-sonnet-4-5`
- `PI_THINKING_LEVEL` — optional thinking level
- `PI_EXTENSION_PATHS` — optional extra comma-separated extension paths

pi auth/model setup uses the normal pi mechanisms:

- `~/.pi/agent/auth.json`, if you already use pi
- provider API keys in env, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.
- standard pi extension discovery from `~/.pi/agent/extensions/` and `.pi/extensions/`

If `ALLOWED_GROUP_ID` is set, make sure the bot is added to that group so it can verify membership.

## Run

```bash
bun run start
```

For local development with auto-reload:

```bash
bun run dev
```

## Behavior

- Private chats: the bot forwards the message to a per-chat pi SDK session and returns pi's response
- Allowed group chat: if `ALLOWED_GROUP_ID` is set, messages sent in that group are forwarded to pi too
- Access control:
  - if no allow rules are set, anyone can DM the bot
  - if `ALLOWED_USER_IDS` is set, only those users can DM it
  - if `ALLOWED_GROUP_ID` is set, members of that group can also DM it
- Sessions are currently kept in memory per Telegram chat
