import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { basename, join } from "node:path";
import { Type } from "typebox";
import type {
  AppConfig,
  EmptyPiResponseContext,
  PiProgressUpdate,
  PiPromptResult,
  SessionMessage,
  TelegramAttachmentKind,
  TelegramQueuedAttachment,
} from "../types";
import {
  normalizeTelegramAttachmentCaption,
  resolveAndValidateTelegramAttachmentPath,
  resolveTelegramAttachmentKind,
  sanitizeTelegramAttachmentFileName,
} from "../telegram/attachments";

export type PiBridgeHooks = {
  onEmptyResponse?: (context: EmptyPiResponseContext) => Promise<void> | void;
  onSessionLoaded?: (context: {
    sessionKey: string;
    modelFallbackMessage?: string;
  }) => Promise<void> | void;
};

export async function createPiBridge(appConfig: AppConfig, hooks: PiBridgeHooks = {}): Promise<PiBridge> {
  const authStorage = AuthStorage.create();
  seedOpenAICodexAuth(authStorage, appConfig);
  const modelRegistry = ModelRegistry.create(authStorage);
  const operatorSystemPrompt = await loadPiSystemPrompt(appConfig.piSystemPromptPath);
  const resourceLoader = new DefaultResourceLoader({
    cwd: appConfig.piWorkdir,
    agentDir: getAgentDir(),
    additionalExtensionPaths: appConfig.piExtensionPaths,
    systemPromptOverride: () => operatorSystemPrompt,
    appendSystemPromptOverride: () => [],
  });

  await resourceLoader.reload();

  const configuredModel = resolveConfiguredModel(modelRegistry, appConfig.piModel);

  return new PiBridge({
    cwd: appConfig.piWorkdir,
    sessionRootDir: appConfig.piSessionDir,
    attachmentRoots: appConfig.telegramAttachmentRoots,
    maxAttachmentBytes: appConfig.telegramMaxDocumentBytes,
    authStorage,
    modelRegistry,
    resourceLoader,
    configuredModel,
    thinkingLevel: appConfig.piThinkingLevel,
    onEmptyResponse: hooks.onEmptyResponse,
    onSessionLoaded: hooks.onSessionLoaded,
  });
}

function seedOpenAICodexAuth(authStorage: AuthStorage, appConfig: AppConfig): void {
  const credential = appConfig.piOpenAICodexAuth;
  if (!credential) return;

  const existing = authStorage.get("openai-codex");
  if (existing?.type === "oauth") {
    const existingAccountId = typeof existing.accountId === "string" ? existing.accountId : undefined;
    if (existingAccountId === credential.accountId && existing.expires >= credential.expires) {
      return;
    }
  }

  authStorage.set("openai-codex", credential);
}

export class PiBridge {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pendingAttachments = new Map<string, TelegramQueuedAttachment[]>();

  constructor(
    private readonly options: {
      cwd: string;
      sessionRootDir: string;
      attachmentRoots: string[];
      maxAttachmentBytes: number;
      authStorage: AuthStorage;
      modelRegistry: ModelRegistry;
      resourceLoader: DefaultResourceLoader;
      configuredModel?: ReturnType<ModelRegistry["find"]>;
      thinkingLevel?: AppConfig["piThinkingLevel"];
      onEmptyResponse?: (context: EmptyPiResponseContext) => Promise<void> | void;
      onSessionLoaded?: (context: {
        sessionKey: string;
        modelFallbackMessage?: string;
      }) => Promise<void> | void;
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
      let answerText = "";
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

          const answerFromPartial = extractAssistantTextFromMessageLike(assistantMessageEvent.partial);
          const answerFromMessage = extractAssistantTextFromMessageLike(event.message);
          const latestAnswer = answerFromPartial || answerFromMessage;

          if (assistantMessageEvent.type === "text_delta" && assistantMessageEvent.delta) {
            answerText += assistantMessageEvent.delta;
            options.onProgress({
              type: "answer",
              text: answerText,
            });
            return;
          }

          if (assistantMessageEvent.type === "text_end" && assistantMessageEvent.content) {
            answerText = assistantMessageEvent.content;
            options.onProgress({
              type: "answer",
              text: answerText,
            });
            return;
          }

          if (latestAnswer && latestAnswer !== answerText) {
            answerText = latestAnswer;
            options.onProgress({
              type: "answer",
              text: answerText,
            });
            return;
          }

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
      const response = getLatestAssistantText(newMessages);

      if (!response) {
        const assistantError = getLatestAssistantError(newMessages);
        if (assistantError) {
          throw new Error(`provider returned no assistant content: ${assistantError}`);
        }

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

  reset(sessionKey: string): void {
    this.sessions.delete(sessionKey);
    this.pendingAttachments.delete(sessionKey);
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

    await this.options.onSessionLoaded?.({
      sessionKey,
      modelFallbackMessage,
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
        `Prefer files inside these allowed roots: ${this.options.attachmentRoots.join(", ")}`,
      ],
      parameters: Type.Object({
        path: Type.String({ description: "Absolute or PI_WORKDIR-relative path to an existing local file." }),
        kind: Type.Optional(
          Type.Union(
            [
              Type.Literal("auto"),
              Type.Literal("document"),
              Type.Literal("photo"),
              Type.Literal("video"),
              Type.Literal("animation"),
              Type.Literal("audio"),
              Type.Literal("voice"),
              Type.Literal("video_note"),
              Type.Literal("sticker"),
            ],
            { description: "Telegram artifact type. Use auto to infer from file extension." },
          ),
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

    const resolvedPath = await resolveAndValidateTelegramAttachmentPath(filePath, {
      workdir: this.options.cwd,
      allowedRoots: this.options.attachmentRoots,
      maxDocumentBytes: this.options.maxAttachmentBytes,
    });
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

function resolveConfiguredModel(modelRegistry: ModelRegistry, modelRef: string | undefined) {
  if (!modelRef) return undefined;

  const normalizedRef = modelRef.trim().toLowerCase();
  const models = modelRegistry.getAll();
  const canonicalMatches = models.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedRef);
  const bareIdMatches = models.filter((candidate) => candidate.id.toLowerCase() === normalizedRef);
  const model =
    canonicalMatches.length === 1
      ? canonicalMatches.at(0)
      : bareIdMatches.length === 1
        ? bareIdMatches.at(0)
        : undefined;

  if (!model) {
    throw new Error(`Unable to find pi model: ${modelRef}`);
  }

  return model;
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

function getLatestAssistantError(messages: SessionMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as SessionMessage & { errorMessage?: unknown; stopReason?: unknown };
    if (message?.role !== "assistant") continue;
    if (typeof message.errorMessage !== "string" || !message.errorMessage.trim()) continue;
    return normalizeAssistantErrorMessage(message.errorMessage);
  }

  return undefined;
}

function normalizeAssistantErrorMessage(rawMessage: string): string {
  const trimmed = rawMessage.trim();
  const match = trimmed.match(/^(\d{3})\s+({.*})$/s);
  if (match) {
    try {
      const parsed = JSON.parse(match[2]!);
      const providerMessage = parsed?.error?.message;
      if (typeof providerMessage === "string" && providerMessage.trim()) {
        return `${match[1]} ${providerMessage.trim()}`;
      }
    } catch {
      return clipAssistantError(trimmed);
    }
  }

  return clipAssistantError(trimmed);
}

function clipAssistantError(message: string, maxLength = 1000): string {
  return message.length <= maxLength ? message : `${message.slice(0, maxLength)}...[truncated]`;
}

function extractAssistantTextFromMessageLike(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = "content" in message ? (message as { content?: unknown }).content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  let text = "";
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block?.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }

  return text.trim();
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

function getSessionDirForKey(rootDir: string, sessionKey: string): string {
  return join(rootDir, encodeSessionKeyForPath(sessionKey));
}

function encodeSessionKeyForPath(sessionKey: string): string {
  return Buffer.from(sessionKey, "utf8").toString("base64url");
}
