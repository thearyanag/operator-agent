import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Bot, GrammyError, InputFile, type Context } from "grammy";
import { Type } from "typebox";
import { renderTelegramMessageChunks } from "./packages/telegram-markdown-html/src/index";

const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const ALLOWED_USER_IDS = parseTelegramIdSet(Bun.env.ALLOWED_USER_IDS, "ALLOWED_USER_IDS");
const ALLOWED_GROUP_ID = parseOptionalTelegramId(Bun.env.ALLOWED_GROUP_ID, "ALLOWED_GROUP_ID");
const PI_WORKDIR = Bun.env.PI_WORKDIR?.trim() || process.cwd();
const PI_MODEL = Bun.env.PI_MODEL?.trim();
const PI_THINKING_LEVEL = parseOptionalThinkingLevel(Bun.env.PI_THINKING_LEVEL);
const PI_EXTENSION_PATHS = parseCsv(Bun.env.PI_EXTENSION_PATHS);
const PI_SYSTEM_PROMPT_PATH = resolvePiPath(
  Bun.env.PI_SYSTEM_PROMPT_PATH?.trim() || join("prompts", "system-prompt.md"),
);
const PI_SESSION_DIR = Bun.env.PI_SESSION_DIR?.trim() || join(process.cwd(), ".pi", "telegram-sessions");
const TELEGRAM_ATTACHMENT_ROOTS = parseTelegramAttachmentRoots(Bun.env.TELEGRAM_ATTACHMENT_ROOTS, PI_WORKDIR);
const AUDIT_LOG_PATH = Bun.env.AUDIT_LOG_PATH?.trim() || join(process.cwd(), "logs", "audit-log.json");
const AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const TELEGRAM_TYPING_INTERVAL_MS = 4_000;
const TELEGRAM_MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type SessionMessage = AgentSession["messages"][number];
type ReplyRenderResult = {
  mode: "html" | "plain";
  chunkCount: number;
};
type TelegramAttachmentKind =
  | "auto"
  | "document"
  | "photo"
  | "video"
  | "animation"
  | "audio"
  | "voice"
  | "video_note"
  | "sticker";

type TelegramQueuedAttachment = {
  path: string;
  fileName: string;
  caption?: string;
  kind: Exclude<TelegramAttachmentKind, "auto">;
};
type PiPromptResult = {
  text: string;
  attachments: TelegramQueuedAttachment[];
};
type PiProgressUpdate =
  | {
      type: "thinking";
      text: string;
    }
  | {
      type: "tool_start";
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_end";
      toolName: string;
      isError: boolean;
    }
  | {
      type: "retry";
      attempt: number;
      maxAttempts: number;
      errorMessage: string;
    };
type AuditLogEntry = {
  id: string;
  timestamp: string;
  event: string;
  sessionKey?: string;
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  userId?: number;
  username?: string;
  sender?: string;
  messageId?: number;
  text?: string;
  prompt?: string;
  response?: string;
  durationMs?: number;
  chunkCount?: number;
  replyMode?: ReplyRenderResult["mode"];
  attachmentCount?: number;
  error?: string;
  rawNewMessages?: string;
  rawRecentMessages?: string;
  totalMessages?: number;
  startMessageCount?: number;
  sessionFile?: string;
};

type EmptyPiResponseContext = {
  sessionKey: string;
  prompt: string;
  newMessages: SessionMessage[];
  recentMessages: SessionMessage[];
  totalMessages: number;
  startMessageCount: number;
};

const bot = new Bot(TELEGRAM_BOT_TOKEN);
let auditLogger: AuditLogger;
const piBridge = await createPiBridge();

bot.catch((error) => {
  console.error("Telegram bot error:", error.error);
  void auditLogger.log({
    event: "telegram_bot_error",
    error: serializeError(error.error),
    chatId: error.ctx.chat?.id,
    chatType: error.ctx.chat?.type,
    userId: error.ctx.from?.id,
    username: error.ctx.from?.username,
    messageId: error.ctx.message?.message_id,
  });
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

  const sessionKey = getSessionKey(ctx);
  const auditContext = getAuditContext(ctx, sessionKey);
  const piPrompt = buildPiPrompt(ctx, text);

  await auditLogger.log({
    ...auditContext,
    event: "incoming_message",
    text,
  });

  const canUseBot = isAllowedGroupChat(ctx)
    ? true
    : ctx.chat?.type === "private" && (await canUsePrivateDm(ctx));

  if (!canUseBot) {
    await auditLogger.log({
      ...auditContext,
      event: "message_rejected",
      error: "unauthorized",
    });
    await replyUnauthorized(ctx);
    return;
  }

  const promptStartedAt = Date.now();

  const stopTyping = startTypingLoop(ctx);
  const liveProgress = new LiveTelegramProgressMessage(ctx);

  try {
    await auditLogger.log({
      ...auditContext,
      event: "pi_prompt_started",
      prompt: piPrompt,
    });

    await liveProgress.start();
    const result = await piBridge.prompt(sessionKey, piPrompt, {
      onProgress: (update) => liveProgress.handle(update),
    });

    await auditLogger.log({
      ...auditContext,
      event: "pi_prompt_completed",
      durationMs: Date.now() - promptStartedAt,
      response: result.text,
      attachmentCount: result.attachments.length,
    });

    await liveProgress.stop();
    const replyResult = await replyRenderedResponse(ctx, result.text, {
      replaceMessageId: liveProgress.messageId,
    });

    let attachmentSendError: unknown;
    try {
      await sendQueuedTelegramAttachments(ctx, result.attachments);
    } catch (error) {
      attachmentSendError = error;
      console.error("Failed to send Telegram attachment:", error);
      await ctx.reply(`Failed to send attachment: ${formatPiError(error)}`);
    }

    await auditLogger.log({
      ...auditContext,
      event: "telegram_reply_sent",
      replyMode: replyResult.mode,
      chunkCount: replyResult.chunkCount,
      attachmentCount: result.attachments.length,
      durationMs: Date.now() - promptStartedAt,
      ...(attachmentSendError ? { error: serializeError(attachmentSendError) } : {}),
    });
  } catch (error) {
    console.error("Failed to process message with pi:", error);
    await auditLogger.log({
      ...auditContext,
      event: "pi_prompt_failed",
      durationMs: Date.now() - promptStartedAt,
      error: serializeError(error),
    });

    await liveProgress.stop();
    const errorText = formatPiError(error);
    if (liveProgress.messageId !== undefined) {
      await replyRenderedResponse(ctx, errorText, {
        replaceMessageId: liveProgress.messageId,
      });
    } else {
      await ctx.reply(errorText);
    }
  } finally {
    stopTyping();
  }
});

console.log(`Starting Telegram bot in ${PI_WORKDIR}`);
console.log(`Private DM access: ${describePrivateDmAccess()}`);
console.log(`pi model: ${PI_MODEL ?? "default configured model"}`);
console.log(`pi thinking level: ${PI_THINKING_LEVEL ?? "default"}`);
console.log(
  `Additional pi extension paths: ${PI_EXTENSION_PATHS.length > 0 ? PI_EXTENSION_PATHS.join(", ") : "none"}`,
);
console.log(`pi system prompt: ${PI_SYSTEM_PROMPT_PATH}`);
console.log(`pi session dir: ${PI_SESSION_DIR}`);
console.log(`Telegram attachment roots: ${TELEGRAM_ATTACHMENT_ROOTS.join(", ")}`);
console.log(`Audit log: ${AUDIT_LOG_PATH} (max ${Math.round(AUDIT_LOG_MAX_BYTES / 1024 / 1024)} MB)`);

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
  const operatorSystemPrompt = await loadPiSystemPrompt(PI_SYSTEM_PROMPT_PATH);
  const resourceLoader = new DefaultResourceLoader({
    cwd: PI_WORKDIR,
    agentDir: getAgentDir(),
    additionalExtensionPaths: PI_EXTENSION_PATHS,
    systemPromptOverride: () => operatorSystemPrompt,
    appendSystemPromptOverride: () => [],
  });

  await resourceLoader.reload();

  const configuredModel = resolveConfiguredModel(modelRegistry, PI_MODEL);

  return new PiBridge({
    cwd: PI_WORKDIR,
    sessionRootDir: PI_SESSION_DIR,
    authStorage,
    modelRegistry,
    resourceLoader,
    configuredModel,
    thinkingLevel: PI_THINKING_LEVEL,
    onEmptyResponse: async ({ sessionKey, prompt, newMessages, recentMessages, totalMessages, startMessageCount }) => {
      await auditLogger.log({
        event: "pi_empty_response",
        sessionKey,
        prompt,
        rawNewMessages: serializeMessagesForAudit(newMessages),
        rawRecentMessages: serializeMessagesForAudit(recentMessages),
        totalMessages,
        startMessageCount,
      });
    },
  });
}

class PiBridge {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pendingAttachments = new Map<string, TelegramQueuedAttachment[]>();

  constructor(
    private readonly options: {
      cwd: string;
      sessionRootDir: string;
      authStorage: AuthStorage;
      modelRegistry: ModelRegistry;
      resourceLoader: DefaultResourceLoader;
      configuredModel?: ReturnType<ModelRegistry["find"]>;
      thinkingLevel?: ThinkingLevel;
      onEmptyResponse?: (context: EmptyPiResponseContext) => Promise<void> | void;
    },
  ) {}

  prompt(
    sessionKey: string,
    prompt: string,
    options: {
      onProgress?: (update: PiProgressUpdate) => void;
    } = {},
  ): Promise<PiPromptResult> {
    return this.enqueue(sessionKey, async () => {
      const session = await this.getSession(sessionKey);
      const startMessageCount = session.messages.length;
      let thinkingText = "";
      const attachments: TelegramQueuedAttachment[] = [];

      this.pendingAttachments.set(sessionKey, attachments);

      const unsubscribe = session.subscribe((event) => {
        if (!options.onProgress) return;

        if (event.type === "message_update") {
          const assistantMessageEvent = event.assistantMessageEvent as {
            type?: string;
            delta?: string;
            content?: string;
            partial?: unknown;
          };

          const thinkingFromPartial = extractThinkingTextFromMessageLike(assistantMessageEvent.partial);
          const thinkingFromMessage = extractThinkingTextFromMessageLike(event.message);
          const latestThinking = thinkingFromPartial || thinkingFromMessage;

          if (latestThinking) {
            thinkingText = latestThinking;
            options.onProgress({
              type: "thinking",
              text: thinkingText,
            });
            return;
          }

          if (assistantMessageEvent.type === "thinking_delta" && assistantMessageEvent.delta) {
            thinkingText += assistantMessageEvent.delta;
            options.onProgress({
              type: "thinking",
              text: thinkingText,
            });
            return;
          }

          if (assistantMessageEvent.type === "thinking_end" && assistantMessageEvent.content) {
            thinkingText = assistantMessageEvent.content;
            options.onProgress({
              type: "thinking",
              text: thinkingText,
            });
          }
          return;
        }

        if (event.type === "tool_execution_start") {
          options.onProgress({
            type: "tool_start",
            toolName: event.toolName,
            args: event.args,
          });
          return;
        }

        if (event.type === "tool_execution_end") {
          options.onProgress({
            type: "tool_end",
            toolName: event.toolName,
            isError: event.isError,
          });
          return;
        }

        if (event.type === "auto_retry_start") {
          options.onProgress({
            type: "retry",
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            errorMessage: event.errorMessage,
          });
        }
      });

      try {
        await session.prompt(prompt);
      } finally {
        unsubscribe();
        this.pendingAttachments.delete(sessionKey);
      }

      const newMessages = session.messages.slice(startMessageCount);
      const response = getLatestAssistantText(newMessages) ?? getLatestAssistantText(session.messages);

      if (!response) {
        await this.options.onEmptyResponse?.({
          sessionKey,
          prompt,
          newMessages,
          recentMessages: session.messages.slice(Math.max(0, session.messages.length - 10)),
          totalMessages: session.messages.length,
          startMessageCount,
        });
        return {
          text: "Pi completed the request but did not return any text.",
          attachments,
        };
      }

      return {
        text: response,
        attachments,
      };
    });
  }

  private async getSession(sessionKey: string): Promise<AgentSession> {
    const existingSession = this.sessions.get(sessionKey);
    if (existingSession) return existingSession;

    const sessionDir = getSessionDirForKey(this.options.sessionRootDir, sessionKey);
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: this.options.cwd,
      authStorage: this.options.authStorage,
      modelRegistry: this.options.modelRegistry,
      resourceLoader: this.options.resourceLoader,
      sessionManager: SessionManager.continueRecent(this.options.cwd, sessionDir),
      customTools: [this.createTelegramAttachmentTool(sessionKey)],
      ...(this.options.configuredModel ? { model: this.options.configuredModel } : {}),
      ...(this.options.thinkingLevel ? { thinkingLevel: this.options.thinkingLevel } : {}),
    });

    await session.bindExtensions({});

    if (modelFallbackMessage) {
      console.warn(`Pi model fallback for ${sessionKey}: ${modelFallbackMessage}`);
    }

    void auditLogger.log({
      event: "pi_session_loaded",
      sessionKey,
      sessionFile: session.sessionFile,
      response: modelFallbackMessage,
    });

    this.sessions.set(sessionKey, session);
    return session;
  }

  private createTelegramAttachmentTool(sessionKey: string) {
    return defineTool({
      name: "telegram_queue_attachment",
      label: "Telegram Queue Attachment",
      description:
        "Queue a local file for the Telegram bot to send after the final assistant reply. Use this only for files that should be delivered to the user.",
      promptSnippet: "Queue a local file to be sent to the Telegram user after the final reply.",
      promptGuidelines: [
        "Use telegram_queue_attachment when you intentionally want the Telegram bot to send a generated file to the user.",
        "Only pass files that already exist on disk and are safe to share.",
        `Prefer files inside these allowed roots: ${TELEGRAM_ATTACHMENT_ROOTS.join(", ")}`,
      ],
      parameters: Type.Object({
        path: Type.String({ description: "Absolute or PI_WORKDIR-relative path to an existing local file." }),
        kind: Type.Optional(
          Type.Union([
            Type.Literal("auto"),
            Type.Literal("document"),
            Type.Literal("photo"),
            Type.Literal("video"),
            Type.Literal("animation"),
            Type.Literal("audio"),
            Type.Literal("voice"),
            Type.Literal("video_note"),
            Type.Literal("sticker"),
          ], { description: "Telegram artifact type. Use auto to infer from file extension." }),
        ),
        caption: Type.Optional(Type.String({ description: "Optional short caption to send with the file." })),
        fileName: Type.Optional(Type.String({ description: "Optional filename override shown in Telegram." })),
      }),
      execute: async (_toolCallId, params) => {
        const attachment = await this.queueTelegramAttachment(
          sessionKey,
          params.path,
          params.caption,
          params.fileName,
          params.kind,
        );
        return {
          content: [
            {
              type: "text",
              text: `Queued Telegram attachment: ${attachment.fileName}`,
            },
          ],
          details: attachment,
        };
      },
    });
  }

  private async queueTelegramAttachment(
    sessionKey: string,
    filePath: string,
    caption?: string,
    fileName?: string,
    kind: TelegramAttachmentKind = "auto",
  ): Promise<TelegramQueuedAttachment> {
    const queue = this.pendingAttachments.get(sessionKey);
    if (!queue) {
      throw new Error("telegram_queue_attachment can only be used during an active Telegram prompt.");
    }

    const resolvedPath = await resolveAndValidateTelegramAttachmentPath(filePath);
    const attachment = {
      path: resolvedPath,
      fileName: sanitizeTelegramAttachmentFileName(fileName || basename(resolvedPath)),
      caption: normalizeTelegramAttachmentCaption(caption),
      kind: resolveTelegramAttachmentKind(resolvedPath, kind),
    } satisfies TelegramQueuedAttachment;

    queue.push(attachment);
    return attachment;
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

function resolvePiPath(filePath: string): string {
  return filePath.startsWith("/") ? filePath : join(PI_WORKDIR, filePath);
}

function parseTelegramAttachmentRoots(rawValue: string | undefined, fallbackRoot: string): string[] {
  const configuredRoots = parseCsv(rawValue).map(resolvePiPath);
  return configuredRoots.length > 0 ? configuredRoots : [resolve(fallbackRoot)];
}

async function resolveAndValidateTelegramAttachmentPath(filePath: string): Promise<string> {
  const absolutePath = filePath.startsWith("/") ? filePath : resolve(PI_WORKDIR, filePath);
  let canonicalPath: string;

  try {
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    throw new Error(`Attachment file not found: ${filePath}`);
  }

  const fileStat = await stat(canonicalPath);
  if (!fileStat.isFile()) {
    throw new Error(`Attachment path is not a file: ${filePath}`);
  }

  if (fileStat.size > TELEGRAM_MAX_DOCUMENT_BYTES) {
    throw new Error(
      `Attachment exceeds Telegram document size limit (${Math.round(TELEGRAM_MAX_DOCUMENT_BYTES / 1024 / 1024)} MB): ${filePath}`,
    );
  }

  const isAllowed = TELEGRAM_ATTACHMENT_ROOTS.some((root) => isPathWithinRoot(canonicalPath, root));
  if (!isAllowed) {
    throw new Error(
      `Attachment path must stay inside an allowed root (${TELEGRAM_ATTACHMENT_ROOTS.join(", ")}): ${filePath}`,
    );
  }

  return canonicalPath;
}

function isPathWithinRoot(filePath: string, rootPath: string): boolean {
  const relativePath = relative(resolve(rootPath), filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function sanitizeTelegramAttachmentFileName(fileName: string): string {
  return fileName.replace(/[\\/]+/g, "_").trim() || "attachment";
}

function resolveTelegramAttachmentKind(
  filePath: string,
  requestedKind: TelegramAttachmentKind,
): Exclude<TelegramAttachmentKind, "auto"> {
  if (requestedKind !== "auto") {
    return requestedKind;
  }

  const lowerPath = filePath.toLowerCase();
  const lowerName = basename(lowerPath);

  if (matchesExtension(lowerPath, [".tgs"])) {
    return "sticker";
  }
  if (matchesExtension(lowerPath, [".webp", ".webm"]) && /sticker|emoji|tgsticker/.test(lowerName)) {
    return "sticker";
  }
  if (matchesExtension(lowerPath, [".mp4", ".mov", ".m4v"]) && /video[._-]?note|round[._-]?video/.test(lowerName)) {
    return "video_note";
  }
  if (matchesExtension(lowerPath, [".jpg", ".jpeg", ".png", ".webp"])) {
    return "photo";
  }
  if (matchesExtension(lowerPath, [".gif"])) {
    return "animation";
  }
  if (matchesExtension(lowerPath, [".mp4", ".mov", ".m4v", ".webm"])) {
    return "video";
  }
  if (matchesExtension(lowerPath, [".mp3", ".m4a", ".aac", ".flac", ".wav"])) {
    return "audio";
  }
  if (matchesExtension(lowerPath, [".ogg", ".oga", ".opus"])) {
    return "voice";
  }

  return "document";
}

function matchesExtension(filePath: string, extensions: string[]): boolean {
  return extensions.some((extension) => filePath.endsWith(extension));
}

function normalizeTelegramAttachmentCaption(caption: string | undefined): string | undefined {
  if (!caption?.trim()) return undefined;
  return caption.trim().slice(0, 1024);
}

async function loadPiSystemPrompt(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`Missing pi system prompt file: ${filePath}`);
  }

  const content = (await file.text()).trim();
  if (!content) {
    throw new Error(`Pi system prompt file is empty: ${filePath}`);
  }

  return content;
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

function extractThinkingTextFromMessageLike(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = "content" in message ? (message as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return "";

  let text = "";
  for (const block of content as Array<{ type?: string; thinking?: string }>) {
    if (block?.type === "thinking" && typeof block.thinking === "string") {
      text += block.thinking;
    }
  }

  return text.trim();
}

function startTypingLoop(ctx: Context): () => void {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    return () => {};
  }

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const sendTyping = () => {
    if (stopped) return;

    void ctx.api.sendChatAction(chatId, "typing").catch((error) => {
      console.warn("Failed to send Telegram typing action:", error);
    });
  };

  sendTyping();
  timer = setInterval(sendTyping, TELEGRAM_TYPING_INTERVAL_MS);

  return () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
    }
  };
}

class LiveTelegramProgressMessage {
  private progressMessageId: number | undefined;
  private thinkingText = "";
  private latestStatus = "Thinking…";
  private lastRenderedHtml = "";
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private renderChain = Promise.resolve();
  private stopped = false;

  constructor(private readonly ctx: Context) {}

  get messageId(): number | undefined {
    return this.progressMessageId;
  }

  async start(): Promise<void> {
    await this.renderNow();
  }

  handle(update: PiProgressUpdate): void {
    if (this.stopped) return;

    if (update.type === "thinking") {
      this.thinkingText = trimProgressThinking(update.text);
    } else if (update.type === "tool_start") {
      this.latestStatus = describeToolProgress(update.toolName, update.args);
    } else if (update.type === "tool_end" && update.isError) {
      this.latestStatus = `${describeToolLabel(update.toolName)} failed, trying to recover…`;
    } else if (update.type === "retry") {
      this.latestStatus = `Retrying (${update.attempt}/${update.maxAttempts})… ${update.errorMessage}`;
    }

    this.scheduleRender();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    await this.renderChain.catch(() => undefined);
  }

  private scheduleRender(): void {
    if (this.renderTimer || this.stopped) return;

    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      void this.renderNow();
    }, 1_200);
  }

  private async renderNow(): Promise<void> {
    const html = buildLiveProgressHtml(this.latestStatus, this.thinkingText);
    if (html === this.lastRenderedHtml) {
      return;
    }

    this.lastRenderedHtml = html;
    this.renderChain = this.renderChain
      .catch(() => undefined)
      .then(async () => {
        try {
          if (this.progressMessageId === undefined) {
            const message = await this.ctx.reply(html, {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
            });
            this.progressMessageId = message.message_id;
            return;
          }

          const chatId = this.ctx.chat?.id;
          if (chatId === undefined) return;

          await this.ctx.api.editMessageText(chatId, this.progressMessageId, html, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          });
        } catch (error) {
          console.warn("Failed to render live Telegram progress message:", error);
        }
      });

    await this.renderChain;
  }
}

async function sendQueuedTelegramAttachments(ctx: Context, attachments: TelegramQueuedAttachment[]): Promise<void> {
  let index = 0;

  while (index < attachments.length) {
    const attachment = attachments[index]!;

    if (attachment.kind === "photo" || attachment.kind === "video") {
      const group = collectContiguousAttachments(attachments, index, new Set(["photo", "video"]));
      if (group.length > 1) {
        await sendTelegramMediaGroup(ctx, group);
        index += group.length;
        continue;
      }
    }

    if (attachment.kind === "document") {
      const group = collectContiguousAttachments(attachments, index, new Set(["document"]));
      if (group.length > 1) {
        await sendTelegramMediaGroup(ctx, group);
        index += group.length;
        continue;
      }
    }

    if (attachment.kind === "audio") {
      const group = collectContiguousAttachments(attachments, index, new Set(["audio"]));
      if (group.length > 1) {
        await sendTelegramMediaGroup(ctx, group);
        index += group.length;
        continue;
      }
    }

    await sendSingleTelegramAttachment(ctx, attachment);
    index += 1;
  }
}

function collectContiguousAttachments(
  attachments: TelegramQueuedAttachment[],
  startIndex: number,
  allowedKinds: Set<TelegramQueuedAttachment["kind"]>,
): TelegramQueuedAttachment[] {
  const group: TelegramQueuedAttachment[] = [];

  for (let index = startIndex; index < attachments.length; index += 1) {
    const attachment = attachments[index]!;
    if (!allowedKinds.has(attachment.kind)) {
      break;
    }
    group.push(attachment);
  }

  return group;
}

async function sendSingleTelegramAttachment(ctx: Context, attachment: TelegramQueuedAttachment): Promise<void> {
  const inputFile = new InputFile(attachment.path, attachment.fileName);
  const captionOptions = attachment.caption ? { caption: attachment.caption } : {};

  switch (attachment.kind) {
    case "photo":
      await ctx.replyWithPhoto(inputFile, captionOptions);
      break;
    case "video":
      await ctx.replyWithVideo(inputFile, captionOptions);
      break;
    case "animation":
      await ctx.replyWithAnimation(inputFile, captionOptions);
      break;
    case "audio":
      await ctx.replyWithAudio(inputFile, captionOptions);
      break;
    case "voice":
      await ctx.replyWithVoice(inputFile, captionOptions);
      break;
    case "video_note":
      await ctx.replyWithVideoNote(inputFile);
      break;
    case "sticker":
      await ctx.replyWithSticker(inputFile);
      break;
    case "document":
    default:
      await ctx.replyWithDocument(inputFile, captionOptions);
      break;
  }
}

async function sendTelegramMediaGroup(ctx: Context, attachments: TelegramQueuedAttachment[]): Promise<void> {
  const media = attachments.map((attachment) => buildTelegramMediaGroupItem(attachment));
  await ctx.replyWithMediaGroup(media);
}

function buildTelegramMediaGroupItem(attachment: TelegramQueuedAttachment) {
  const media = new InputFile(attachment.path, attachment.fileName);

  switch (attachment.kind) {
    case "photo":
      return {
        type: "photo" as const,
        media,
        ...(attachment.caption ? { caption: attachment.caption } : {}),
      };
    case "video":
      return {
        type: "video" as const,
        media,
        ...(attachment.caption ? { caption: attachment.caption } : {}),
      };
    case "audio":
      return {
        type: "audio" as const,
        media,
        ...(attachment.caption ? { caption: attachment.caption } : {}),
      };
    case "document":
    default:
      return {
        type: "document" as const,
        media,
        ...(attachment.caption ? { caption: attachment.caption } : {}),
      };
  }
}

async function replyRenderedResponse(
  ctx: Context,
  text: string,
  options: {
    replaceMessageId?: number;
  } = {},
): Promise<ReplyRenderResult> {
  const htmlChunks = renderTelegramMessageChunks(text, 3500);

  try {
    if (htmlChunks.length === 0) {
      throw new Error("Rendered Telegram HTML was empty.");
    }

    if (options.replaceMessageId !== undefined) {
      await replaceTelegramMessage(ctx, options.replaceMessageId, htmlChunks[0]!, { parse_mode: "HTML" });
      for (const chunk of htmlChunks.slice(1)) {
        await ctx.reply(chunk, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      }
    } else {
      for (const chunk of htmlChunks) {
        await ctx.reply(chunk, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      }
    }

    return { mode: "html", chunkCount: htmlChunks.length };
  } catch (error) {
    if (!isTelegramParseError(error)) {
      throw error;
    }

    console.warn("Telegram HTML rendering failed, falling back to plain text:", error);

    const plainChunks = chunkText(text, 4000);
    if (plainChunks.length === 0) {
      throw new Error("Plain text reply was empty.");
    }

    if (options.replaceMessageId !== undefined) {
      await replaceTelegramMessage(ctx, options.replaceMessageId, plainChunks[0]!);
      for (const chunk of plainChunks.slice(1)) {
        await ctx.reply(chunk, {
          link_preview_options: { is_disabled: true },
        });
      }
    } else {
      for (const chunk of plainChunks) {
        await ctx.reply(chunk, {
          link_preview_options: { is_disabled: true },
        });
      }
    }

    return { mode: "plain", chunkCount: plainChunks.length };
  }
}

function buildLiveProgressHtml(status: string, thinkingText: string): string {
  const body = thinkingText.trim().length > 0 ? `${status}\n\n${thinkingText}` : status;
  return `<blockquote expandable>${escapeTelegramHtml(body)}</blockquote>`;
}

async function replaceTelegramMessage(
  ctx: Context,
  messageId: number,
  text: string,
  options: {
    parse_mode?: "HTML";
  } = {},
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    throw new Error("Cannot replace Telegram message without a chat id.");
  }

  await ctx.api.editMessageText(chatId, messageId, text, {
    ...(options.parse_mode ? { parse_mode: options.parse_mode } : {}),
    link_preview_options: { is_disabled: true },
  });
}

function describeToolProgress(toolName: string, args: unknown): string {
  if (/datadog/i.test(toolName)) {
    return "Querying Datadog logs…";
  }
  if (/postgres|sql|database/i.test(toolName)) {
    return "Querying Postgres…";
  }
  if (toolName === "bash") {
    return "Running shell investigation…";
  }
  if (toolName === "read") {
    return "Reading files and docs…";
  }
  if (toolName === "write" || toolName === "edit") {
    return "Preparing an update…";
  }
  if (toolName === "mcp") {
    return "Checking MCP tools…";
  }

  if (args && typeof args === "object" && "path" in args && typeof args.path === "string") {
    return `${describeToolLabel(toolName)} ${args.path}…`;
  }

  return `${describeToolLabel(toolName)}…`;
}

function describeToolLabel(toolName: string): string {
  return toolName
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (character) => character.toUpperCase());
}

function trimProgressThinking(text: string, maxLength = 3_200): string {
  const normalized = text.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `…\n${normalized.slice(-maxLength)}`;
}

function escapeTelegramHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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

function isTelegramParseError(error: unknown): boolean {
  return error instanceof GrammyError && /parse entities|can't parse entities|message text is empty/i.test(error.description);
}

function formatPiError(error: unknown): string {
  if (error instanceof Error) {
    return `Pi failed: ${error.message}`;
  }

  return "Pi failed with an unknown error.";
}

function getAuditContext(ctx: Context, sessionKey: string): Omit<AuditLogEntry, "id" | "timestamp" | "event"> {
  const chat = ctx.chat;

  return {
    sessionKey,
    chatId: chat?.id,
    chatType: chat?.type,
    chatTitle: chat && "title" in chat && typeof chat.title === "string" ? chat.title : undefined,
    userId: ctx.from?.id,
    username: ctx.from?.username,
    sender: formatSender(ctx),
    messageId: ctx.message?.message_id,
  };
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function truncateAuditText(value: string | undefined, maxLength = 100_000): string | undefined {
  if (!value || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n…[truncated ${value.length - maxLength} chars]`;
}

function serializeMessagesForAudit(messages: SessionMessage[]): string {
  try {
    return JSON.stringify(messages, null, 2);
  } catch (error) {
    return `Failed to serialize messages: ${serializeError(error)}`;
  }
}

function getSessionDirForKey(rootDir: string, sessionKey: string): string {
  return join(rootDir, encodeSessionKeyForPath(sessionKey));
}

function encodeSessionKeyForPath(sessionKey: string): string {
  return Buffer.from(sessionKey, "utf8").toString("base64url");
}

class AuditLogger {
  private queue = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxBytes: number,
  ) {}

  log(entry: Omit<AuditLogEntry, "id" | "timestamp">): Promise<void> {
    const normalizedEntry: AuditLogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
      text: truncateAuditText(entry.text),
      prompt: truncateAuditText(entry.prompt),
      response: truncateAuditText(entry.response),
      error: truncateAuditText(entry.error, 20_000),
      rawNewMessages: truncateAuditText(entry.rawNewMessages),
      rawRecentMessages: truncateAuditText(entry.rawRecentMessages),
    };

    const writeOperation = this.queue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });

      const entries = await this.readEntries();
      entries.push(normalizedEntry);

      let serialized = JSON.stringify(entries, null, 2) + "\n";
      while (Buffer.byteLength(serialized, "utf8") > this.maxBytes && entries.length > 1) {
        entries.shift();
        serialized = JSON.stringify(entries, null, 2) + "\n";
      }

      await writeFile(this.filePath, serialized, "utf8");
    });

    this.queue = writeOperation.catch((error) => {
      console.error("Failed to write audit log:", error);
    });

    return writeOperation;
  }

  private async readEntries(): Promise<AuditLogEntry[]> {
    try {
      const content = await readFile(this.filePath, "utf8");
      if (!content.trim()) {
        return [];
      }

      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? (parsed as AuditLogEntry[]) : [];
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return [];
      }

      console.error("Failed to read audit log, recreating it:", error);
      return [];
    }
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

auditLogger = new AuditLogger(AUDIT_LOG_PATH, AUDIT_LOG_MAX_BYTES);
