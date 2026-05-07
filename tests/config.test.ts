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
