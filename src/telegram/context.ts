import type { Context } from "grammy";
import type { AuditLogEntry, TelegramBusinessMessage, TelegramEditedBusinessMessage, TelegramRunContext, TelegramUserLike } from "../types";
import { canReplyAsBusinessAccount, type BusinessConnectionState } from "./business";
import type { TelegramMessageTurnEnvelope } from "./turn-envelope";

export function buildStandardRunContext(ctx: Context, text: string): TelegramRunContext {
  const chat = ctx.chat;
  const chatId = chat?.id;
  if (chatId === undefined) {
    throw new Error("Cannot build Telegram run context without a chat id.");
  }

  const chatTitle = chat && "title" in chat && typeof chat.title === "string" ? chat.title : undefined;
  const surface = ctx.chat?.type === "private" ? "private" : "group";

  return {
    surface,
    sessionKey: getSessionKey(ctx),
    chatId,
    chatType: chat?.type,
    chatTitle,
    userId: ctx.from?.id,
    username: ctx.from?.username,
    sender: formatSender(ctx),
    messageId: ctx.message?.message_id,
    text,
    prompt: buildPiPrompt(ctx, text),
  };
}

export function buildBusinessRunContext(
  message: TelegramBusinessMessage,
  text: string,
  connection: BusinessConnectionState,
  options: { dryRun: boolean },
): TelegramRunContext {
  const chatTitle = "title" in message.chat && typeof message.chat.title === "string"
    ? message.chat.title
    : undefined;
  const sender = formatTelegramUser(message.from);

  return {
    surface: "business",
    sessionKey: `business:${connection.id}:${message.chat.id}`,
    chatId: message.chat.id,
    chatType: message.chat.type,
    chatTitle,
    userId: message.from?.id,
    username: message.from?.username,
    sender,
    messageId: message.message_id,
    text,
    prompt: buildBusinessPiPrompt(message, text, connection),
    businessConnectionId: connection.id,
    businessOwnerUserId: connection.ownerTelegramUserId,
    businessOwnerChatId: connection.ownerPrivateChatId,
    businessCanReply: canReplyAsBusinessAccount(connection),
    businessIsEnabled: connection.isEnabled,
    dryRun: options.dryRun,
  };
}

export function buildGuestRunContext(envelope: TelegramMessageTurnEnvelope, text: string): TelegramRunContext {
  if (envelope.mode !== "guest") {
    throw new Error("Cannot build guest run context from a non-guest Telegram envelope.");
  }
  if (envelope.senderTelegramId === undefined) {
    throw new Error("Cannot build guest run context without a caller Telegram user ID.");
  }

  return {
    surface: "guest",
    sessionKey: `guest:${envelope.senderTelegramId}:${envelope.chatId}`,
    chatId: envelope.chatId,
    chatType: envelope.chatType,
    chatTitle: envelope.chatTitle,
    userId: envelope.senderTelegramId,
    username: envelope.senderUsername,
    sender: envelope.senderDisplayName,
    messageId: envelope.message.message_id,
    text,
    prompt: buildGuestPiPrompt(envelope, text),
  };
}

export function getAuditContextForRun(runContext: TelegramRunContext): Omit<AuditLogEntry, "id" | "timestamp" | "event"> {
  return {
    surface: runContext.surface,
    sessionKey: runContext.sessionKey,
    chatId: runContext.chatId,
    chatType: runContext.chatType,
    chatTitle: runContext.chatTitle,
    userId: runContext.userId,
    username: runContext.username,
    sender: runContext.sender,
    messageId: runContext.messageId,
    businessConnectionId: runContext.businessConnectionId,
    businessOwnerUserId: runContext.businessOwnerUserId,
    businessOwnerChatId: runContext.businessOwnerChatId,
    businessCanReply: runContext.businessCanReply,
    businessIsEnabled: runContext.businessIsEnabled,
    dryRun: runContext.dryRun,
  };
}

export function getBusinessAuditContext(
  message: TelegramBusinessMessage | TelegramEditedBusinessMessage,
  businessConnectionId: string | undefined,
): Omit<AuditLogEntry, "id" | "timestamp" | "event"> {
  const chatTitle = "title" in message.chat && typeof message.chat.title === "string"
    ? message.chat.title
    : undefined;

  return {
    surface: "business",
    sessionKey: businessConnectionId ? `business:${businessConnectionId}:${message.chat.id}` : undefined,
    chatId: message.chat.id,
    chatType: message.chat.type,
    chatTitle,
    userId: message.from?.id,
    username: message.from?.username,
    sender: formatTelegramUser(message.from),
    messageId: message.message_id,
    businessConnectionId,
  };
}

export function getSessionKey(ctx: Context): string {
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

function buildBusinessPiPrompt(
  message: TelegramBusinessMessage,
  text: string,
  connection: BusinessConnectionState,
): string {
  const sender = formatTelegramUser(message.from);
  const owner = connection.ownerTelegramUserId;

  return [
    "Telegram Chat Automation message.",
    `Connected account owner Telegram user ID: ${owner}.`,
    `Incoming chat ID: ${message.chat.id}.`,
    `Sender: ${sender}.`,
    "Reply on behalf of the connected Telegram account owner to the message below.",
    "",
    text,
  ].join("\n");
}

function buildGuestPiPrompt(envelope: TelegramMessageTurnEnvelope, text: string): string {
  const chatTitle = envelope.chatTitle ?? `chat ${envelope.chatId}`;
  const sender = envelope.senderDisplayName ?? envelope.senderUsername ?? String(envelope.senderTelegramId ?? "unknown user");

  return [
    `Telegram guest message in ${chatTitle}.`,
    `Sender: ${sender}.`,
    "Reply as a guest bot response to the message below. The bot may not be installed in this chat, so keep the response self-contained and appropriate for the current chat.",
    "",
    text,
  ].join("\n");
}

function formatSender(ctx: Context): string {
  return formatTelegramUser(ctx.from);
}

export function formatTelegramUser(user: TelegramUserLike | undefined): string {
  if (!user) return "unknown user";
  if (user.username) return `@${user.username}`;
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || String(user.id);
}
