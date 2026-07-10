import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { Context } from "grammy";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type SessionMessage = AgentSession["messages"][number];
export type PiProviderMode = "default" | "openrouter" | "openai-codex";

export type OpenAICodexAuthConfig = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};

export type TelegramBusinessMessage = NonNullable<Context["businessMessage"]>;
export type TelegramEditedBusinessMessage = NonNullable<Context["editedBusinessMessage"]>;
export type TelegramDeletedBusinessMessages = NonNullable<Context["deletedBusinessMessages"]>;

export type TelegramUserLike = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export type ReplyRenderResult = {
  mode: "rich" | "html" | "plain";
  chunkCount: number;
};

export type TelegramSurface = "private" | "group" | "business" | "guest";

export type TelegramAllowedUpdate =
  | "message"
  | "guest_message"
  | "business_connection"
  | "business_message"
  | "edited_business_message"
  | "deleted_business_messages";

export type TelegramSendOptions = {
  businessConnectionId?: string;
};

export type TelegramRunContext = {
  surface: TelegramSurface;
  sessionKey: string;
  chatId: number;
  chatType?: string;
  chatTitle?: string;
  userId?: number;
  username?: string;
  sender?: string;
  messageId?: number;
  text: string;
  prompt: string;
  businessConnectionId?: string;
  businessOwnerUserId?: number;
  businessOwnerChatId?: number;
  businessCanReply?: boolean;
  businessIsEnabled?: boolean;
  dryRun?: boolean;
};

export type OperatorToolContext = {
  surface: TelegramSurface;
  sessionKey: string;
  runId: string;
  ownerUserId: string;
  ownerTelegramUserIds: Set<number>;
  requesterTelegramUserId?: number;
  currentConversationId?: string;
  currentConversationTitle?: string;
  currentTelegramChatId?: string;
};

export type TelegramAttachmentKind =
  | "auto"
  | "document"
  | "photo"
  | "video"
  | "animation"
  | "audio"
  | "voice"
  | "video_note"
  | "sticker";

export type TelegramQueuedAttachment = {
  path: string;
  fileName: string;
  caption?: string;
  kind: Exclude<TelegramAttachmentKind, "auto">;
};

export type PiPromptResult = {
  text: string;
  attachments: TelegramQueuedAttachment[];
};

export type PiProgressUpdate =
  | {
      type: "answer";
      text: string;
    }
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

export type AuditLogEntry = {
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
  runId?: string;
  chunkCount?: number;
  replyMode?: ReplyRenderResult["mode"];
  attachmentCount?: number;
  error?: string;
  rawNewMessages?: string;
  rawRecentMessages?: string;
  totalMessages?: number;
  startMessageCount?: number;
  surface?: TelegramSurface;
  businessConnectionId?: string;
  businessOwnerUserId?: number;
  businessOwnerChatId?: number;
  businessCanReply?: boolean;
  businessIsEnabled?: boolean;
  dryRun?: boolean;
};

export type EmptyPiResponseContext = {
  sessionKey: string;
  prompt: string;
  newMessages: SessionMessage[];
  recentMessages: SessionMessage[];
  totalMessages: number;
  startMessageCount: number;
};

export type AppConfig = {
  telegramBotToken: string;
  telegramBotUsername?: string;
  allowedUserIds: Set<number>;
  allowedGroupId: number | null;
  enableTelegramNativeStreaming: boolean;
  enableTelegramBusinessAutomation: boolean;
  telegramBusinessAllowedOwnerIds: Set<number>;
  telegramBusinessDryRun: boolean;
  telegramAllowedUpdates: readonly TelegramAllowedUpdate[];
  piWorkdir: string;
  piProviderMode: PiProviderMode;
  piModel?: string;
  piOpenAICodexAuth?: OpenAICodexAuthConfig;
  piThinkingLevel?: ThinkingLevel;
  piExtensionPaths: string[];
  piSystemPromptPath: string;
  piSessionDir: string;
  telegramAttachmentRoots: string[];
  operatorDatabaseUrl?: string;
  operatorOwnerId: string;
  operatorOwnerTelegramIds: Set<number>;
  operatorStateDbPath: string;
  operatorContextDir: string;
  operatorControlPanelToken?: string;
  operatorPublicUrl?: string;
  operatorGuestMediaDir: string;
  telegramTypingIntervalMs: number;
  telegramMaxDocumentBytes: number;
  telegramDraftIntervalMs: number;
};
