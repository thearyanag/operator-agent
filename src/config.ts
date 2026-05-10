import { join, resolve } from "node:path";
import type { AppConfig, OpenAICodexAuthConfig, PiProviderMode, ThinkingLevel } from "./types";

const TELEGRAM_TYPING_INTERVAL_MS = 4_000;
const TELEGRAM_MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const TELEGRAM_DRAFT_INTERVAL_MS = 650;
const DEFAULT_PI_MODEL = "anthropic/claude-sonnet-4-5";

export const config = loadConfig();

export function loadConfig(env: Record<string, string | undefined> = Bun.env, cwd = process.cwd()): AppConfig {
  const enableTelegramBusinessAutomation = parseBooleanEnv(env.ENABLE_TELEGRAM_BUSINESS_AUTOMATION, true);
  const piProviderMode = parsePiProviderMode(env.PI_PROVIDER);
  const piWorkdir = env.PI_WORKDIR?.trim() || cwd;
  const piSystemPromptPath = resolvePiPath(
    env.PI_SYSTEM_PROMPT_PATH?.trim() || join("prompts", "system-prompt.md"),
    piWorkdir,
  );

  return {
    telegramBotToken: requireEnv(env, "TELEGRAM_BOT_TOKEN"),
    allowedUserIds: parseTelegramIdSet(env.ALLOWED_USER_IDS, "ALLOWED_USER_IDS"),
    allowedGroupId: parseOptionalTelegramId(env.ALLOWED_GROUP_ID, "ALLOWED_GROUP_ID"),
    enableTelegramNativeStreaming: parseBooleanEnv(env.ENABLE_TELEGRAM_NATIVE_STREAMING, true),
    enableTelegramBusinessAutomation,
    telegramBusinessAllowedOwnerIds: parseTelegramIdSet(
      env.TELEGRAM_BUSINESS_ALLOWED_OWNER_IDS,
      "TELEGRAM_BUSINESS_ALLOWED_OWNER_IDS",
    ),
    telegramBusinessDryRun: parseBooleanEnv(env.TELEGRAM_BUSINESS_DRY_RUN, false),
    telegramAllowedUpdates: enableTelegramBusinessAutomation
      ? [
          "message",
          "business_connection",
          "business_message",
          "edited_business_message",
          "deleted_business_messages",
        ]
      : ["message"],
    piWorkdir,
    piProviderMode,
    piModel: resolvePiModel(env, piProviderMode),
    piOpenAICodexAuth: parseOpenAICodexAuth(env, piProviderMode),
    piThinkingLevel: parseOptionalThinkingLevel(env.PI_THINKING_LEVEL),
    piExtensionPaths: parseCsv(env.PI_EXTENSION_PATHS),
    piSystemPromptPath,
    piSessionDir: env.PI_SESSION_DIR?.trim() || join(cwd, ".pi", "telegram-sessions"),
    telegramAttachmentRoots: parseTelegramAttachmentRoots(env.TELEGRAM_ATTACHMENT_ROOTS, piWorkdir),
    operatorStateDbPath: env.OPERATOR_STATE_DB_PATH?.trim() || join(cwd, ".operator", "state", "operator.sqlite"),
    telegramTypingIntervalMs: TELEGRAM_TYPING_INTERVAL_MS,
    telegramMaxDocumentBytes: TELEGRAM_MAX_DOCUMENT_BYTES,
    telegramDraftIntervalMs: TELEGRAM_DRAFT_INTERVAL_MS,
  };
}

export function logStartupConfig(appConfig: AppConfig): void {
  console.log(`Starting Telegram bot in ${appConfig.piWorkdir}`);
  console.log(`Private DM access: ${describePrivateDmAccess(appConfig)}`);
  console.log(`pi provider: ${appConfig.piProviderMode}`);
  console.log(`pi model: ${appConfig.piModel ?? "default configured model"}`);
  console.log(`pi openai-codex auth: ${appConfig.piOpenAICodexAuth ? "configured" : "not provided"}`);
  console.log(`pi thinking level: ${appConfig.piThinkingLevel ?? "default"}`);
  console.log(
    `Additional pi extension paths: ${
      appConfig.piExtensionPaths.length > 0 ? appConfig.piExtensionPaths.join(", ") : "none"
    }`,
  );
  console.log(`pi system prompt: ${appConfig.piSystemPromptPath}`);
  console.log(`pi session dir: ${appConfig.piSessionDir}`);
  console.log(`Telegram attachment roots: ${appConfig.telegramAttachmentRoots.join(", ")}`);
  console.log(`Telegram native streaming: ${appConfig.enableTelegramNativeStreaming ? "enabled" : "disabled"}`);
  console.log(`Telegram Business automation: ${appConfig.enableTelegramBusinessAutomation ? "enabled" : "disabled"}`);

  if (appConfig.enableTelegramBusinessAutomation) {
    console.log(
      `Telegram Business owner allowlist: ${
        appConfig.telegramBusinessAllowedOwnerIds.size > 0
          ? [...appConfig.telegramBusinessAllowedOwnerIds].join(", ")
          : "all connected owners"
      }`,
    );
    console.log(`Telegram Business dry run: ${appConfig.telegramBusinessDryRun ? "enabled" : "disabled"}`);
  }

  console.log(`Operator state DB: ${appConfig.operatorStateDbPath}`);

  if (appConfig.allowedGroupId !== null) {
    console.log(`Allowed group ID: ${appConfig.allowedGroupId}`);
    console.log(
      "Users in the allowed group can message the bot in that group and in DMs, as long as the bot can read their membership.",
    );
  }
}

export function describePrivateDmAccess(appConfig: AppConfig): string {
  const parts: string[] = [];

  if (appConfig.allowedUserIds.size > 0) {
    parts.push(`whitelisted users (${[...appConfig.allowedUserIds].join(", ")})`);
  }

  if (appConfig.allowedGroupId !== null) {
    parts.push(`members of group ${appConfig.allowedGroupId}`);
  }

  return parts.length > 0 ? parts.join(" or ") : "all users";
}

function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parsePiProviderMode(rawValue: string | undefined): PiProviderMode {
  if (!rawValue?.trim()) return "default";

  const value = rawValue.trim();
  if (value === "openrouter" || value === "openai-codex") return value;

  throw new Error(`Invalid PI_PROVIDER: ${rawValue}. Allowed: openrouter, openai-codex`);
}

function resolvePiModel(env: Record<string, string | undefined>, providerMode: PiProviderMode): string | undefined {
  const explicitModel = env.PI_MODEL?.trim();

  if (providerMode === "openrouter") {
    requireEnv(env, "OPENROUTER_API_KEY");
    return normalizeProviderModel("openrouter", env.OPENROUTER_MODEL?.trim() || explicitModel || requireEnv(env, "OPENROUTER_MODEL"));
  }

  if (providerMode === "openai-codex") {
    return normalizeProviderModel(
      "openai-codex",
      explicitModel || env.OPENAI_CODEX_MODEL?.trim() || "gpt-5.3-codex",
    );
  }

  return explicitModel || DEFAULT_PI_MODEL;
}

function normalizeProviderModel(provider: "openrouter" | "openai-codex", model: string): string {
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    throw new Error(`Missing ${provider} model`);
  }

  return trimmedModel.startsWith(`${provider}/`) ? trimmedModel : `${provider}/${trimmedModel}`;
}

function parseOpenAICodexAuth(
  env: Record<string, string | undefined>,
  providerMode: PiProviderMode,
): OpenAICodexAuthConfig | undefined {
  const rawJson = env.OPENAI_CODEX_AUTH_JSON?.trim();
  if (rawJson) return parseOpenAICodexAuthJson(rawJson);

  const access = env.OPENAI_CODEX_ACCESS_TOKEN?.trim();
  const refresh = env.OPENAI_CODEX_REFRESH_TOKEN?.trim();
  const expiresAtMs = env.OPENAI_CODEX_EXPIRES_AT_MS?.trim();
  const legacyExpiresAt = env.OPENAI_CODEX_EXPIRES_AT?.trim();
  const accountId = env.OPENAI_CODEX_ACCOUNT_ID?.trim();
  const hasPartialAuth = Boolean(access || refresh || expiresAtMs || legacyExpiresAt || accountId);

  if (!hasPartialAuth) {
    if (providerMode === "openai-codex") {
      throw new Error(
        "Missing OpenAI Codex auth. Set OPENAI_CODEX_AUTH_JSON or OPENAI_CODEX_ACCESS_TOKEN, OPENAI_CODEX_REFRESH_TOKEN, OPENAI_CODEX_EXPIRES_AT_MS, and OPENAI_CODEX_ACCOUNT_ID.",
      );
    }

    return undefined;
  }

  return {
    type: "oauth",
    access: requireEnv(env, "OPENAI_CODEX_ACCESS_TOKEN"),
    refresh: requireEnv(env, "OPENAI_CODEX_REFRESH_TOKEN"),
    expires: parseEpochMs(
      requireEnv(env, expiresAtMs ? "OPENAI_CODEX_EXPIRES_AT_MS" : "OPENAI_CODEX_EXPIRES_AT"),
      expiresAtMs ? "OPENAI_CODEX_EXPIRES_AT_MS" : "OPENAI_CODEX_EXPIRES_AT",
    ),
    accountId: requireEnv(env, "OPENAI_CODEX_ACCOUNT_ID"),
  };
}

function parseOpenAICodexAuthJson(rawJson: string): OpenAICodexAuthConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`Invalid OPENAI_CODEX_AUTH_JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const credential = isRecord(parsed) && isRecord(parsed["openai-codex"]) ? parsed["openai-codex"] : parsed;

  if (!isRecord(credential)) {
    throw new Error("Invalid OPENAI_CODEX_AUTH_JSON: expected an openai-codex credential object");
  }

  const access = parseRequiredStringField(credential, "access", "OPENAI_CODEX_AUTH_JSON");
  const refresh = parseRequiredStringField(credential, "refresh", "OPENAI_CODEX_AUTH_JSON");
  const accountId = parseRequiredStringField(credential, "accountId", "OPENAI_CODEX_AUTH_JSON");

  return {
    type: "oauth",
    access,
    refresh,
    expires: parseEpochMs(credential.expires, "OPENAI_CODEX_AUTH_JSON.expires"),
    accountId,
  };
}

function parseRequiredStringField(record: Record<string, unknown>, field: string, sourceName: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${sourceName}: missing string field "${field}"`);
  }

  return value.trim();
}

function parseEpochMs(value: unknown, envName: string): number {
  const numericValue = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;

  if (!Number.isSafeInteger(numericValue) || numericValue <= 0) {
    throw new Error(`Invalid epoch milliseconds in ${envName}: ${String(value)}`);
  }

  return numericValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalTelegramId(rawValue: string | undefined, envName: string): number | null {
  if (!rawValue?.trim()) return null;
  return parseTelegramId(rawValue, envName);
}

function parseTelegramIdSet(rawValue: string | undefined, envName: string): Set<number> {
  if (!rawValue?.trim()) return new Set<number>();

  return new Set(
    rawValue
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => parseTelegramId(value, envName)),
  );
}

function parseTelegramId(rawValue: string, envName: string): number {
  const value = Number(rawValue.trim());

  if (!Number.isSafeInteger(value)) {
    throw new Error(`Invalid Telegram ID in ${envName}: ${rawValue}`);
  }

  return value;
}

function parseBooleanEnv(rawValue: string | undefined, defaultValue: boolean): boolean {
  if (!rawValue?.trim()) return defaultValue;

  const value = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(value)) return true;
  if (["0", "false", "no", "n", "off"].includes(value)) return false;

  throw new Error(`Invalid boolean environment value: ${rawValue}`);
}

function resolvePiPath(filePath: string, piWorkdir: string): string {
  return filePath.startsWith("/") ? filePath : join(piWorkdir, filePath);
}

function parseTelegramAttachmentRoots(rawValue: string | undefined, fallbackRoot: string): string[] {
  const configuredRoots = parseCsv(rawValue).map((root) => resolvePiPath(root, fallbackRoot));
  return configuredRoots.length > 0 ? configuredRoots : [resolve(fallbackRoot)];
}

function parseOptionalThinkingLevel(rawValue: string | undefined): ThinkingLevel | undefined {
  if (!rawValue?.trim()) return undefined;

  const value = rawValue.trim() as ThinkingLevel;
  const allowedLevels = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

  if (!allowedLevels.has(value)) {
    throw new Error(`Invalid PI_THINKING_LEVEL: ${rawValue}`);
  }

  return value;
}

function parseCsv(rawValue: string | undefined): string[] {
  if (!rawValue?.trim()) return [];

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
