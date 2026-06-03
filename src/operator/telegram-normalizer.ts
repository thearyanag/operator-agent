import type { Context } from "grammy";
import type { AppConfig, TelegramBusinessMessage, TelegramRunContext } from "../types";
import type { BusinessConnectionState } from "../telegram/business";
import type { OperatorStore } from "./store";

export async function recordStandardTelegramObservation(input: {
  store: OperatorStore;
  appConfig: AppConfig;
  ctx: Context;
  runContext: TelegramRunContext;
  text: string;
}) {
  const conversation = await input.store.upsertConversation({
    ownerUserId: input.appConfig.operatorOwnerId,
    mode: input.runContext.surface === "private" ? "assistant" : "team",
    telegramChatId: String(input.runContext.chatId),
    telegramChatType: input.runContext.chatType ?? input.runContext.surface,
    title: input.runContext.chatTitle ?? null,
  });

  const observation = await input.store.insertObservation({
    conversationId: conversation.id,
    platformMessageId: String(input.runContext.messageId ?? input.ctx.update.update_id),
    senderPlatformId: input.runContext.userId === undefined ? null : String(input.runContext.userId),
    senderDisplayName: input.runContext.sender ?? input.runContext.username ?? null,
    messageType: getStandardMessageType(input.ctx),
    text: input.text,
    rawPayload: buildStandardRawPayload(input.ctx),
    observedAt: getStandardObservedAt(input.ctx),
  });

  return { conversation, observation };
}

export async function recordBusinessTelegramObservation(input: {
  store: OperatorStore;
  appConfig: AppConfig;
  message: TelegramBusinessMessage;
  connection: BusinessConnectionState;
  text: string;
}) {
  const chatTitle = "title" in input.message.chat && typeof input.message.chat.title === "string"
    ? input.message.chat.title
    : null;
  const senderTitle = input.message.from?.id === input.connection.ownerTelegramUserId
    ? null
    : formatBusinessSender(input.message);
  const conversation = await input.store.upsertConversation({
    ownerUserId: input.appConfig.operatorOwnerId,
    mode: "personal",
    telegramChatId: String(input.message.chat.id),
    telegramChatType: input.message.chat.type,
    telegramBusinessConnectionId: input.connection.id,
    title: chatTitle ?? senderTitle,
  });

  const observation = await input.store.insertObservation({
    conversationId: conversation.id,
    platformMessageId: String(input.message.message_id),
    senderPlatformId: input.message.from?.id === undefined ? null : String(input.message.from.id),
    senderDisplayName: formatBusinessSender(input.message),
    messageType: getBusinessMessageType(input.message),
    text: input.text,
    rawPayload: buildBusinessRawPayload(input.message),
    observedAt: new Date(input.message.date * 1000),
  });

  return { conversation, observation };
}

function getStandardMessageType(ctx: Context): string {
  const message = ctx.message;
  if (!message) return "other";
  if (message.text !== undefined) return "text";
  if (message.caption !== undefined) return "caption";
  if (message.photo !== undefined) return "photo";
  if (message.document !== undefined) return "document";
  if (message.voice !== undefined) return "voice";
  if (message.video !== undefined) return "video";
  return "other";
}

function getBusinessMessageType(message: TelegramBusinessMessage): string {
  if (message.text !== undefined) return "text";
  if (message.caption !== undefined) return "caption";
  if (message.photo !== undefined) return "photo";
  if (message.document !== undefined) return "document";
  if (message.voice !== undefined) return "voice";
  if (message.video !== undefined) return "video";
  return "other";
}

function getStandardObservedAt(ctx: Context): Date {
  const date = ctx.message?.date;
  return typeof date === "number" ? new Date(date * 1000) : new Date();
}

function buildStandardRawPayload(ctx: Context): Record<string, unknown> {
  const message = ctx.message;
  return {
    updateId: ctx.update.update_id,
    messageId: message?.message_id,
    chat: message?.chat
      ? {
          id: message.chat.id,
          type: message.chat.type,
          title: "title" in message.chat ? message.chat.title : undefined,
        }
      : undefined,
    from: message?.from
      ? {
          id: message.from.id,
          username: message.from.username,
          firstName: message.from.first_name,
          lastName: message.from.last_name,
        }
      : undefined,
    hasText: message?.text !== undefined,
    hasCaption: message?.caption !== undefined,
  };
}

function buildBusinessRawPayload(message: TelegramBusinessMessage): Record<string, unknown> {
  return {
    messageId: message.message_id,
    businessConnectionId: message.business_connection_id,
    chat: {
      id: message.chat.id,
      type: message.chat.type,
      title: "title" in message.chat ? message.chat.title : undefined,
    },
    from: message.from
      ? {
          id: message.from.id,
          username: message.from.username,
          firstName: message.from.first_name,
          lastName: message.from.last_name,
        }
      : undefined,
    hasText: message.text !== undefined,
    hasCaption: message.caption !== undefined,
  };
}

function formatBusinessSender(message: TelegramBusinessMessage): string | null {
  const from = message.from;
  if (!from) return null;
  if (from.username) return `@${from.username}`;
  return [from.first_name, from.last_name].filter(Boolean).join(" ") || String(from.id);
}
