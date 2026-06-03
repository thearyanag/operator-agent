import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Type } from "typebox";
import type {
  ListObservationSliceInput,
  OperatorConversationMode,
  OperatorObservationSliceItem,
  OperatorStore,
} from "../operator/store";
import type {
  AppConfig,
  EmptyPiResponseContext,
  OperatorToolContext,
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

export type PiBridgeDependencies = {
  operatorStore?: OperatorStore;
};

export async function createPiBridge(
  appConfig: AppConfig,
  hooks: PiBridgeHooks = {},
  deps: PiBridgeDependencies = {},
): Promise<PiBridge> {
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
    operatorStore: deps.operatorStore,
    operatorContextDir: appConfig.operatorContextDir,
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
  private readonly activeOperatorToolContexts = new Map<string, OperatorToolContext>();

  constructor(
    private readonly options: {
      cwd: string;
      sessionRootDir: string;
      attachmentRoots: string[];
      maxAttachmentBytes: number;
      operatorStore?: OperatorStore;
      operatorContextDir?: string;
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
      operatorToolContext?: OperatorToolContext;
    } = {},
  ): Promise<PiPromptResult> {
    return this.enqueue(sessionKey, async () => {
      if (options.operatorToolContext) {
        this.activeOperatorToolContexts.set(sessionKey, options.operatorToolContext);
      }
      const session = await this.getSession(sessionKey).catch((error) => {
        this.activeOperatorToolContexts.delete(sessionKey);
        throw error;
      });
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
        this.activeOperatorToolContexts.delete(sessionKey);
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
    this.activeOperatorToolContexts.delete(sessionKey);
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
      customTools: this.createCustomTools(sessionKey),
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

  private createCustomTools(sessionKey: string) {
    const tools: ToolDefinition[] = [this.createTelegramAttachmentTool(sessionKey)];
    const context = this.activeOperatorToolContexts.get(sessionKey);
    if (!context || !this.options.operatorStore) return tools;

    tools.push(this.createOperatorCurrentConversationContextTool(sessionKey));
    if (isOwnerOperatorToolContext(context)) {
      tools.push(this.createOperatorOwnerContextTool(sessionKey));
    }

    return tools;
  }

  private createOperatorCurrentConversationContextTool(sessionKey: string) {
    return defineTool({
      name: "operator_context_slice_current",
      label: "Operator Current Chat Context",
      description:
        "Fetch observed Telegram messages from the current Operator conversation. Use this for current group/chat history questions.",
      promptSnippet: "Fetch observed messages from the current Telegram chat/group.",
      promptGuidelines: [
        "Use operator_context_slice_current when the answer depends on messages observed in this exact chat.",
        "Use since/until for time windows and limit for the number of messages.",
        "The tool may return a Markdown artifact path when the slice is large; read it before answering if needed.",
      ],
      parameters: Type.Object({
        since: Type.Optional(Type.String({ description: "ISO timestamp lower bound, inclusive." })),
        until: Type.Optional(Type.String({ description: "ISO timestamp upper bound, inclusive." })),
        limit: Type.Optional(Type.Integer({ description: "Maximum messages to fetch. Defaults to 100, max 500." })),
        sinceOwnerLastSeen: Type.Optional(
          Type.Boolean({ description: "Only include messages after the owner's read checkpoint when available." }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const context = this.requireOperatorToolContext(sessionKey);
        if (!context.currentConversationId) {
          throw new Error("operator_context_slice_current requires an active Operator conversation.");
        }

        const filters = normalizeOperatorSliceParams(params);
        const items = await this.requireOperatorStore().listObservationSlice({
          ownerUserId: context.ownerUserId,
          conversationId: context.currentConversationId,
          since: filters.since,
          until: filters.until,
          sinceOwnerLastSeen: filters.sinceOwnerLastSeen,
          limit: filters.limit,
        });
        const artifactPath = await this.writeAndRecordOperatorContextSliceArtifact({
          context,
          scope: "current_conversation",
          items,
          filters,
        });

        return buildOperatorSliceToolResult({
          scopeLabel: "current conversation",
          items,
          artifactPath,
          filters,
        });
      },
    });
  }

  private createOperatorOwnerContextTool(sessionKey: string) {
    return defineTool({
      name: "operator_context_slice_owner",
      label: "Operator Owner Context",
      description:
        "Fetch observed Telegram messages across the owner's Operator conversations. Only available in authorized owner DMs.",
      promptSnippet: "Fetch owner-wide observed Telegram context with optional chat, mode, and time filters.",
      promptGuidelines: [
        "Use operator_context_slice_owner for owner DM questions like what did I miss, summarize my groups, or find important messages across chats.",
        "Filter by mode, conversationTitle, telegramChatId, since, and until when the owner asks for a narrower slice.",
        "Do not use this tool in group answers; it is only exposed in owner private DMs.",
      ],
      parameters: Type.Object({
        since: Type.Optional(Type.String({ description: "ISO timestamp lower bound, inclusive." })),
        until: Type.Optional(Type.String({ description: "ISO timestamp upper bound, inclusive." })),
        limit: Type.Optional(Type.Integer({ description: "Maximum messages to fetch. Defaults to 100, max 500." })),
        modes: Type.Optional(
          Type.Array(
            Type.Union([Type.Literal("team"), Type.Literal("personal"), Type.Literal("assistant")]),
            { description: "Conversation modes to include." },
          ),
        ),
        conversationTitle: Type.Optional(Type.String({ description: "Case-insensitive substring match on chat title." })),
        telegramChatId: Type.Optional(Type.String({ description: "Exact Telegram chat ID as stored by Operator." })),
        sinceOwnerLastSeen: Type.Optional(
          Type.Boolean({ description: "Only include messages after the owner's read checkpoint when available." }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const context = this.requireOperatorToolContext(sessionKey);
        if (!isOwnerOperatorToolContext(context)) {
          throw new Error("operator_context_slice_owner is only available to the configured owner in a private DM.");
        }

        const filters = normalizeOperatorSliceParams(params);
        const items = await this.requireOperatorStore().listObservationSlice({
          ownerUserId: context.ownerUserId,
          modes: filters.modes,
          conversationTitle: filters.conversationTitle,
          telegramChatId: filters.telegramChatId,
          since: filters.since,
          until: filters.until,
          sinceOwnerLastSeen: filters.sinceOwnerLastSeen,
          limit: filters.limit,
        });
        const artifactPath = await this.writeAndRecordOperatorContextSliceArtifact({
          context,
          scope: "owner",
          items,
          filters,
        });

        return buildOperatorSliceToolResult({
          scopeLabel: "owner conversations",
          items,
          artifactPath,
          filters,
        });
      },
    });
  }

  private requireOperatorToolContext(sessionKey: string): OperatorToolContext {
    const context = this.activeOperatorToolContexts.get(sessionKey);
    if (!context) {
      throw new Error("Operator context tools can only be used during an active Telegram Operator prompt.");
    }
    return context;
  }

  private requireOperatorStore(): OperatorStore {
    if (!this.options.operatorStore) {
      throw new Error("Operator context tools require OPERATOR_DATABASE_URL.");
    }
    return this.options.operatorStore;
  }

  private async writeAndRecordOperatorContextSliceArtifact(input: {
    context: OperatorToolContext;
    scope: "current_conversation" | "owner";
    items: OperatorObservationSliceItem[];
    filters: NormalizedOperatorSliceParams;
  }): Promise<string> {
    const rootDir = this.options.operatorContextDir ?? join(this.options.cwd, ".operator", "context");
    const runDir = join(rootDir, sanitizePathSegment(input.context.runId));
    await mkdir(runDir, { recursive: true });

    const fileName = [
      "operator-context-slice",
      input.scope,
      new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14),
      randomUUID().slice(0, 8),
    ].join("-");
    const artifactPath = join(runDir, `${fileName}.md`);
    await writeFile(
      artifactPath,
      formatOperatorSliceArtifact({
        scope: input.scope,
        items: input.items,
        filters: input.filters,
        generatedAt: new Date(),
      }),
      "utf8",
    );

    if (input.context.currentConversationId) {
      await this.options.operatorStore?.insertOutput({
        conversationId: input.context.currentConversationId,
        agentRunId: input.context.runId,
        type: "artifact",
        status: "pending",
        payload: {
          kind: "operator_context_slice",
          scope: input.scope,
          path: artifactPath,
          messageCount: input.items.length,
          filters: serializeOperatorSliceFilters(input.filters),
        },
      }).catch((error) => {
        console.warn("Failed to insert Operator context slice artifact output:", error);
      });
    }

    return artifactPath;
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

type NormalizedOperatorSliceParams = {
  since?: Date;
  until?: Date;
  limit: number;
  modes?: OperatorConversationMode[];
  conversationTitle?: string;
  telegramChatId?: string;
  sinceOwnerLastSeen: boolean;
};

function normalizeOperatorSliceParams(params: unknown): NormalizedOperatorSliceParams {
  const record = isRecord(params) ? params : {};
  const modes = normalizeOperatorModes(record.modes);
  const conversationTitle = normalizeOptionalString(record.conversationTitle);
  const telegramChatId = normalizeOptionalString(record.telegramChatId);

  return {
    since: parseOptionalDate(record.since, "since"),
    until: parseOptionalDate(record.until, "until"),
    limit: clampToolLimit(record.limit),
    ...(modes ? { modes } : {}),
    ...(conversationTitle ? { conversationTitle } : {}),
    ...(telegramChatId ? { telegramChatId } : {}),
    sinceOwnerLastSeen: record.sinceOwnerLastSeen === true,
  };
}

function normalizeOperatorModes(value: unknown): OperatorConversationMode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const validModes = new Set<OperatorConversationMode>(["team", "personal", "assistant"]);
  const modes = value.filter((mode): mode is OperatorConversationMode => {
    return typeof mode === "string" && validModes.has(mode as OperatorConversationMode);
  });
  return modes.length > 0 ? [...new Set(modes)] : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalDate(value: unknown, fieldName: string): Date | undefined {
  const text = normalizeOptionalString(value);
  if (!text) return undefined;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${fieldName} timestamp: ${text}`);
  }
  return date;
}

function clampToolLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(Math.trunc(value), 500));
}

function isOwnerOperatorToolContext(context: OperatorToolContext): boolean {
  return (
    context.surface === "private" &&
    context.requesterTelegramUserId !== undefined &&
    context.ownerTelegramUserIds.has(context.requesterTelegramUserId)
  );
}

function buildOperatorSliceToolResult(input: {
  scopeLabel: string;
  items: OperatorObservationSliceItem[];
  artifactPath: string;
  filters: NormalizedOperatorSliceParams;
}) {
  const previewItems = input.items.slice(0, 12);
  const preview = previewItems.length > 0
    ? previewItems.map(formatOperatorSlicePreviewLine).join("\n")
    : "No observed messages matched the requested filters.";
  const checkpointNote = input.filters.sinceOwnerLastSeen && !input.items.some((item) => item.ownerLastSeenAt)
    ? "\nOwner last-seen checkpoints are not recorded for the matched messages yet; results may include older observed messages."
    : "";

  return {
    content: [
      {
        type: "text" as const,
        text: [
          `Operator context slice for ${input.scopeLabel}: ${input.items.length} observed message(s).`,
          `Full Markdown artifact: ${input.artifactPath}`,
          checkpointNote.trim() ? checkpointNote.trim() : undefined,
          "",
          "Recent preview:",
          preview,
        ].filter(Boolean).join("\n"),
      },
    ],
    details: {
      messageCount: input.items.length,
      artifactPath: input.artifactPath,
      filters: serializeOperatorSliceFilters(input.filters),
    },
  };
}

function formatOperatorSliceArtifact(input: {
  scope: "current_conversation" | "owner";
  items: OperatorObservationSliceItem[];
  filters: NormalizedOperatorSliceParams;
  generatedAt: Date;
}): string {
  const lines = [
    "# Operator Context Slice",
    "",
    `Scope: ${input.scope}`,
    `Generated at: ${input.generatedAt.toISOString()}`,
    `Message count: ${input.items.length}`,
    "",
    "## Filters",
    "",
    ...Object.entries(serializeOperatorSliceFilters(input.filters)).map(([key, value]) => `- ${key}: ${String(value)}`),
    "",
    "## Messages",
    "",
  ];

  const chronologicalItems = [...input.items].reverse();
  if (chronologicalItems.length === 0) {
    lines.push("No observed messages matched this slice.");
  } else {
    for (const item of chronologicalItems) {
      lines.push(formatOperatorSliceArtifactMessage(item), "");
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

function formatOperatorSliceArtifactMessage(item: OperatorObservationSliceItem): string {
  const title = item.conversation.title || item.conversation.telegramChatId;
  const sender = item.observation.senderDisplayName || item.observation.senderPlatformId || "unknown sender";
  const text = item.observation.text?.trim() || "[non-text message]";
  const ownerLastSeen = item.ownerLastSeenAt ? `\nOwner last seen at: ${item.ownerLastSeenAt.toISOString()}` : "";

  return [
    `### ${item.observation.observedAt.toISOString()} - ${title}`,
    "",
    `Conversation ID: ${item.conversation.id}`,
    `Telegram chat ID: ${item.conversation.telegramChatId}`,
    `Mode: ${item.conversation.mode}`,
    `Sender: ${sender}${ownerLastSeen}`,
    "",
    text,
  ].join("\n");
}

function formatOperatorSlicePreviewLine(item: OperatorObservationSliceItem): string {
  const title = item.conversation.title || item.conversation.telegramChatId;
  const sender = item.observation.senderDisplayName || item.observation.senderPlatformId || "unknown";
  const text = clipText(item.observation.text?.replace(/\s+/g, " ").trim() || "[non-text message]", 180);
  return `- ${item.observation.observedAt.toISOString()} | ${title} | ${sender}: ${text}`;
}

function serializeOperatorSliceFilters(filters: NormalizedOperatorSliceParams): Record<string, unknown> {
  return {
    since: filters.since?.toISOString() ?? null,
    until: filters.until?.toISOString() ?? null,
    limit: filters.limit,
    modes: filters.modes ?? null,
    conversationTitle: filters.conversationTitle ?? null,
    telegramChatId: filters.telegramChatId ?? null,
    sinceOwnerLastSeen: filters.sinceOwnerLastSeen,
  };
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "operator-run";
}

function clipText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 14)}...[truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
