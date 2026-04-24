import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { Bot, type Context } from "grammy";

const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const ALLOWED_USER_IDS = parseTelegramIdSet(Bun.env.ALLOWED_USER_IDS, "ALLOWED_USER_IDS");
const ALLOWED_GROUP_ID = parseOptionalTelegramId(Bun.env.ALLOWED_GROUP_ID, "ALLOWED_GROUP_ID");
const PI_WORKDIR = Bun.env.PI_WORKDIR?.trim() || process.cwd();
const PI_MODEL = Bun.env.PI_MODEL?.trim();
const PI_THINKING_LEVEL = parseOptionalThinkingLevel(Bun.env.PI_THINKING_LEVEL);
const PI_EXTENSION_PATHS = parseCsv(Bun.env.PI_EXTENSION_PATHS);

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type SessionMessage = AgentSession["messages"][number];

const bot = new Bot(TELEGRAM_BOT_TOKEN);
const piBridge = await createPiBridge();

bot.catch((error) => {
  console.error("Telegram bot error:", error.error);
});

bot.command("start", async (ctx) => {
  if (ctx.from?.is_bot) return;

  if (isAllowedGroupChat(ctx)) {
    await ctx.reply("Bot is ready. Send a message and I'll forward it to pi.");
    return;
  }

  if (ctx.chat?.type !== "private") return;

  if (!(await canUsePrivateDm(ctx))) {
    await replyUnauthorized(ctx);
    return;
  }

  await ctx.reply("Hi! Send me a message and I'll pass it to pi.");
});

bot.on("message", async (ctx) => {
  if (ctx.from?.is_bot) return;

  if (!isSupportedChat(ctx)) return;

  const text = ctx.message?.text ?? ctx.message?.caption;
  if (!text) {
    await ctx.reply("Send me a text message and I'll pass it to pi.");
    return;
  }

  const canUseBot = isAllowedGroupChat(ctx)
    ? true
    : ctx.chat?.type === "private" && (await canUsePrivateDm(ctx));

  if (!canUseBot) {
    await replyUnauthorized(ctx);
    return;
  }

  try {
    await ctx.api.sendChatAction(ctx.chat.id, "typing");
    const response = await piBridge.prompt(getSessionKey(ctx), buildPiPrompt(ctx, text));
    await replyInChunks(ctx, response);
  } catch (error) {
    console.error("Failed to process message with pi:", error);
    await ctx.reply(formatPiError(error));
  }
});

console.log(`Starting Telegram bot in ${PI_WORKDIR}`);
console.log(`Private DM access: ${describePrivateDmAccess()}`);
console.log(`pi model: ${PI_MODEL ?? "default configured model"}`);
console.log(`pi thinking level: ${PI_THINKING_LEVEL ?? "default"}`);
console.log(
  `Additional pi extension paths: ${PI_EXTENSION_PATHS.length > 0 ? PI_EXTENSION_PATHS.join(", ") : "none"}`,
);

if (ALLOWED_GROUP_ID !== null) {
  console.log(`Allowed group ID: ${ALLOWED_GROUP_ID}`);
  console.log(
    "Users in the allowed group can message the bot in that group and in DMs, as long as the bot can read their membership.",
  );
}

bot.start({ drop_pending_updates: true });

async function createPiBridge(): Promise<PiBridge> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const resourceLoader = new DefaultResourceLoader({
    cwd: PI_WORKDIR,
    agentDir: getAgentDir(),
    additionalExtensionPaths: PI_EXTENSION_PATHS,
  });

  await resourceLoader.reload();

  const configuredModel = resolveConfiguredModel(modelRegistry, PI_MODEL);

  return new PiBridge({
    cwd: PI_WORKDIR,
    authStorage,
    modelRegistry,
    resourceLoader,
    configuredModel,
    thinkingLevel: PI_THINKING_LEVEL,
  });
}

class PiBridge {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly options: {
      cwd: string;
      authStorage: AuthStorage;
      modelRegistry: ModelRegistry;
      resourceLoader: DefaultResourceLoader;
      configuredModel?: ReturnType<ModelRegistry["find"]>;
      thinkingLevel?: ThinkingLevel;
    },
  ) {}

  prompt(sessionKey: string, prompt: string): Promise<string> {
    return this.enqueue(sessionKey, async () => {
      const session = await this.getSession(sessionKey);
      const startMessageCount = session.messages.length;

      await session.prompt(prompt);

      const newMessages = session.messages.slice(startMessageCount);
      const response = getLatestAssistantText(newMessages) ?? getLatestAssistantText(session.messages);

      if (!response) {
        return "Pi completed the request but did not return any text.";
      }

      return response;
    });
  }

  private async getSession(sessionKey: string): Promise<AgentSession> {
    const existingSession = this.sessions.get(sessionKey);
    if (existingSession) return existingSession;

    const { session } = await createAgentSession({
      cwd: this.options.cwd,
      authStorage: this.options.authStorage,
      modelRegistry: this.options.modelRegistry,
      resourceLoader: this.options.resourceLoader,
      sessionManager: SessionManager.inMemory(),
      ...(this.options.configuredModel ? { model: this.options.configuredModel } : {}),
      ...(this.options.thinkingLevel ? { thinkingLevel: this.options.thinkingLevel } : {}),
    });

    this.sessions.set(sessionKey, session);
    return session;
  }

  private enqueue<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);

    this.queues.set(sessionKey, next);

    return next.finally(() => {
      if (this.queues.get(sessionKey) === next) {
        this.queues.delete(sessionKey);
      }
    });
  }
}

function requireEnv(name: string): string {
  const value = Bun.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
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

function resolveConfiguredModel(modelRegistry: ModelRegistry, modelRef: string | undefined) {
  if (!modelRef) return undefined;

  const [provider, modelId] = modelRef.split("/");
  if (!provider || !modelId) {
    throw new Error(`PI_MODEL must look like provider/model-id. Received: ${modelRef}`);
  }

  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`Unable to find pi model: ${modelRef}`);
  }

  return model;
}

function isSupportedChat(ctx: Context): boolean {
  return isAllowedGroupChat(ctx) || ctx.chat?.type === "private";
}

function isAllowedGroupChat(ctx: Context): boolean {
  return ALLOWED_GROUP_ID !== null && ctx.chat?.id === ALLOWED_GROUP_ID;
}

function describePrivateDmAccess(): string {
  const parts: string[] = [];

  if (ALLOWED_USER_IDS.size > 0) {
    parts.push(`whitelisted users (${[...ALLOWED_USER_IDS].join(", ")})`);
  }

  if (ALLOWED_GROUP_ID !== null) {
    parts.push(`members of group ${ALLOWED_GROUP_ID}`);
  }

  return parts.length > 0 ? parts.join(" or ") : "all users";
}

async function canUsePrivateDm(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;

  if (!userId) return false;

  if (ALLOWED_USER_IDS.size === 0 && ALLOWED_GROUP_ID === null) {
    return true;
  }

  if (ALLOWED_USER_IDS.has(userId)) {
    return true;
  }

  if (ALLOWED_GROUP_ID !== null) {
    try {
      const member = await ctx.api.getChatMember(ALLOWED_GROUP_ID, userId);
      return isActiveMemberStatus(member.status);
    } catch (error) {
      console.error(
        `Failed to verify whether user ${userId} belongs to group ${ALLOWED_GROUP_ID}:`,
        error,
      );
    }
  }

  return false;
}

function isActiveMemberStatus(status: string): boolean {
  return (
    status === "creator" ||
    status === "administrator" ||
    status === "member" ||
    status === "restricted"
  );
}

async function replyUnauthorized(ctx: Context): Promise<void> {
  const message = ALLOWED_GROUP_ID !== null
    ? "Sorry, you are not allowed to use this bot. You must be explicitly whitelisted or belong to the configured Telegram group."
    : "Sorry, you are not allowed to use this bot. You must be explicitly whitelisted.";

  await ctx.reply(message);
}

function getSessionKey(ctx: Context): string {
  return `${ctx.chat?.type ?? "unknown"}:${ctx.chat?.id ?? "unknown"}`;
}

function buildPiPrompt(ctx: Context, text: string): string {
  if (ctx.chat?.type === "private") {
    return text;
  }

  const chat = ctx.chat;
  if (!chat) {
    return text;
  }

  const senderName = formatSender(ctx);
  const chatTitle = "title" in chat && typeof chat.title === "string"
    ? chat.title
    : `chat ${chat.id}`;

  return [
    `Telegram group message in ${chatTitle}.`,
    `Sender: ${senderName}.`,
    "Reply as the bot to the message below.",
    "",
    text,
  ].join("\n");
}

function formatSender(ctx: Context): string {
  if (!ctx.from) return "unknown user";

  if (ctx.from.username) {
    return `@${ctx.from.username}`;
  }

  return [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || String(ctx.from.id);
}

function getLatestAssistantText(messages: SessionMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;

    const text = extractAssistantText(message).trim();
    if (text) return text;
  }

  return undefined;
}

function extractAssistantText(message: SessionMessage): string {
  if (message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  let text = "";
  for (const block of message.content as Array<{ type?: string; text?: string }>) {
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }

  return text;
}

async function replyInChunks(ctx: Context, text: string): Promise<void> {
  const chunks = chunkText(text, 4000);

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < Math.floor(maxLength / 2)) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt < Math.floor(maxLength / 2)) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks.filter(Boolean);
}

function formatPiError(error: unknown): string {
  if (error instanceof Error) {
    return `Pi failed: ${error.message}`;
  }

  return "Pi failed with an unknown error.";
}
