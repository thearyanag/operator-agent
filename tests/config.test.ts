import { expect, test } from "bun:test";

Bun.env.TELEGRAM_BOT_TOKEN ||= "test-token";
delete Bun.env.PI_PROVIDER;
delete Bun.env.PI_MODEL;
delete Bun.env.ANTHROPIC_API_KEY;
delete Bun.env.OPENROUTER_API_KEY;
delete Bun.env.OPENROUTER_MODEL;
delete Bun.env.OPENAI_CODEX_AUTH_JSON;
delete Bun.env.OPENAI_CODEX_ACCESS_TOKEN;
delete Bun.env.OPENAI_CODEX_REFRESH_TOKEN;
delete Bun.env.OPENAI_CODEX_EXPIRES_AT_MS;
delete Bun.env.OPENAI_CODEX_EXPIRES_AT;
delete Bun.env.OPENAI_CODEX_ACCOUNT_ID;

const { loadConfig } = await import("../src/config");

const baseEnv = {
  TELEGRAM_BOT_TOKEN: "test-token",
};

test("defaults pi model to Anthropic Claude Sonnet 4.5", () => {
  const appConfig = loadConfig(baseEnv, "/tmp/operator-agent");

  expect(appConfig.piProviderMode).toBe("default");
  expect(appConfig.piModel).toBe("anthropic/claude-sonnet-4-5");
  expect(appConfig.operatorStateDbPath).toBe("/tmp/operator-agent/.operator/state/operator.sqlite");
});

test("enables Telegram guest message updates by default", () => {
  const appConfig = loadConfig(baseEnv, "/tmp/operator-agent");

  expect(appConfig.telegramAllowedUpdates).toContain("message");
  expect(appConfig.telegramAllowedUpdates).toContain("guest_message");
});

test("accepts a custom operator state database path", () => {
  const appConfig = loadConfig(
    {
      ...baseEnv,
      OPERATOR_STATE_DB_PATH: "/data/operator/operator.sqlite",
    },
    "/tmp/operator-agent",
  );

  expect(appConfig.operatorStateDbPath).toBe("/data/operator/operator.sqlite");
});

test("accepts Operator Postgres, owner, bot username, and control panel config", () => {
  const appConfig = loadConfig(
    {
      ...baseEnv,
      TELEGRAM_BOT_USERNAME: "operator_bot",
      OPERATOR_DATABASE_URL: "postgresql://operator:operator@localhost:5432/operator",
      OPERATOR_OWNER_ID: "11111111-1111-4111-8111-111111111111",
      OPERATOR_OWNER_TELEGRAM_IDS: "123456789,987654321",
      OPERATOR_CONTROL_PANEL_TOKEN: "panel-token",
      OPERATOR_CONTEXT_DIR: "/data/operator-context",
    },
    "/tmp/operator-agent",
  );

  expect(appConfig.telegramBotUsername).toBe("operator_bot");
  expect(appConfig.operatorDatabaseUrl).toBe("postgresql://operator:operator@localhost:5432/operator");
  expect(appConfig.operatorOwnerId).toBe("11111111-1111-4111-8111-111111111111");
  expect([...appConfig.operatorOwnerTelegramIds]).toEqual([123456789, 987654321]);
  expect(appConfig.operatorControlPanelToken).toBe("panel-token");
  expect(appConfig.operatorContextDir).toBe("/data/operator-context");
});

test("rejects invalid Operator owner IDs", () => {
  expect(() =>
    loadConfig(
      {
        ...baseEnv,
        OPERATOR_OWNER_ID: "not-a-uuid",
      },
      "/tmp/operator-agent",
    ),
  ).toThrow(/OPERATOR_OWNER_ID/);
});

test("rejects invalid Operator owner Telegram IDs", () => {
  expect(() =>
    loadConfig(
      {
        ...baseEnv,
        OPERATOR_OWNER_TELEGRAM_IDS: "abc",
      },
      "/tmp/operator-agent",
    ),
  ).toThrow(/OPERATOR_OWNER_TELEGRAM_IDS/);
});

test("maps OpenRouter provider inputs into a pi model ref", () => {
  const appConfig = loadConfig(
    {
      ...baseEnv,
      PI_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "sk-or-test",
      OPENROUTER_MODEL: "google/gemini-3.1-flash-lite-preview",
    },
    "/tmp/operator-agent",
  );

  expect(appConfig.piProviderMode).toBe("openrouter");
  expect(appConfig.piModel).toBe("openrouter/google/gemini-3.1-flash-lite-preview");
});

test("prefers OPENROUTER_MODEL over generic PI_MODEL in OpenRouter mode", () => {
  const appConfig = loadConfig(
    {
      ...baseEnv,
      PI_PROVIDER: "openrouter",
      PI_MODEL: "anthropic/claude-haiku-4-5",
      OPENROUTER_API_KEY: "sk-or-test",
      OPENROUTER_MODEL: "~anthropic/claude-haiku-latest",
    },
    "/tmp/operator-agent",
  );

  expect(appConfig.piProviderMode).toBe("openrouter");
  expect(appConfig.piModel).toBe("openrouter/~anthropic/claude-haiku-latest");
});

test("uses PI_MODEL as OpenRouter fallback when OPENROUTER_MODEL is absent", () => {
  const appConfig = loadConfig(
    {
      ...baseEnv,
      PI_PROVIDER: "openrouter",
      PI_MODEL: "openrouter/anthropic/claude-haiku-4.5",
      OPENROUTER_API_KEY: "sk-or-test",
    },
    "/tmp/operator-agent",
  );

  expect(appConfig.piModel).toBe("openrouter/anthropic/claude-haiku-4.5");
});

test("requires an OpenRouter API key in OpenRouter mode", () => {
  expect(() =>
    loadConfig(
      {
        ...baseEnv,
        PI_PROVIDER: "openrouter",
        PI_MODEL: "openrouter/google/gemini-3.1-flash-lite-preview",
        OPENROUTER_MODEL: "google/gemini-3.1-flash-lite-preview",
      },
      "/tmp/operator-agent",
    ),
  ).toThrow(/OPENROUTER_API_KEY/);
});

test("maps OpenAI Codex auth fields into pi auth config", () => {
  const appConfig = loadConfig(
    {
      ...baseEnv,
      PI_PROVIDER: "openai-codex",
      OPENAI_CODEX_ACCESS_TOKEN: "access-token",
      OPENAI_CODEX_REFRESH_TOKEN: "refresh-token",
      OPENAI_CODEX_EXPIRES_AT_MS: "1790000000000",
      OPENAI_CODEX_ACCOUNT_ID: "account-id",
    },
    "/tmp/operator-agent",
  );

  expect(appConfig.piProviderMode).toBe("openai-codex");
  expect(appConfig.piModel).toBe("openai-codex/gpt-5.3-codex");
  expect(appConfig.piOpenAICodexAuth).toEqual({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: 1790000000000,
    accountId: "account-id",
  });
});

test("accepts full auth.json shape for OpenAI Codex auth", () => {
  const appConfig = loadConfig(
    {
      ...baseEnv,
      PI_PROVIDER: "openai-codex",
      OPENAI_CODEX_AUTH_JSON: JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: 1790000000000,
          accountId: "account-id",
        },
      }),
    },
    "/tmp/operator-agent",
  );

  expect(appConfig.piOpenAICodexAuth?.accountId).toBe("account-id");
});
