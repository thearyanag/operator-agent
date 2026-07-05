import type { Context } from "grammy";
import type { Chat, Message, User } from "grammy/types";

export type TelegramTurnMode = "chat" | "guest";

export type TelegramGuestMessage = Message & {
  guest_query_id?: string;
  guest_bot_caller_user?: User;
  guest_bot_caller_chat?: Chat;
};

export type TelegramGuestContext = Context & {
  guestMessage?: TelegramGuestMessage;
  update: Context["update"] & {
    guest_message?: TelegramGuestMessage;
  };
};

export type TelegramMessageTurnEnvelope = {
  kind: "message";
  mode: TelegramTurnMode;
  ctx: Context;
  message: Message;
  chatId: number;
  chatType?: string;
  chatTitle?: string;
  senderTelegramId?: number;
  senderUsername?: string;
  senderDisplayName?: string;
  text?: string;
  guestQueryId?: string;
  guestCallerSource?: "guest_bot_caller_user" | "from";
};

export type TelegramTurnEnvelope = TelegramMessageTurnEnvelope;

export type TelegramEnvelopeExtractionResult<TEnvelope extends TelegramTurnEnvelope> =
  | { ok: true; envelope: TEnvelope }
  | { ok: false; reason: string; details?: Record<string, unknown> };

export function getTelegramGuestMessage(ctx: Context): TelegramGuestMessage | undefined {
  const guestContext = ctx as TelegramGuestContext;
  return guestContext.guestMessage ?? guestContext.update.guest_message;
}

export function extractStandardMessageTurnEnvelope(
  ctx: Context,
): TelegramEnvelopeExtractionResult<TelegramMessageTurnEnvelope> {
  const message = ctx.message;
  const chat = ctx.chat;
  if (!message || !chat) {
    return { ok: false, reason: "missing_message" };
  }

  return {
    ok: true,
    envelope: {
      kind: "message",
      mode: "chat",
      ctx,
      message,
      chatId: chat.id,
      chatType: chat.type,
      chatTitle: getChatTitle(chat),
      senderTelegramId: ctx.from?.id,
      senderUsername: ctx.from?.username,
      senderDisplayName: formatTelegramUser(ctx.from),
      text: getMessageText(message),
    },
  };
}

export function extractGuestMessageTurnEnvelope(
  ctx: Context,
): TelegramEnvelopeExtractionResult<TelegramMessageTurnEnvelope> {
  const message = getTelegramGuestMessage(ctx);
  if (!message) {
    return { ok: false, reason: "missing_guest_message" };
  }

  const guestQueryId = typeof message.guest_query_id === "string"
    ? message.guest_query_id.trim()
    : "";
  if (!guestQueryId) {
    return {
      ok: false,
      reason: "missing_guest_query_id",
      details: { chatId: message.chat.id },
    };
  }

  const guestCallerUserId = message.guest_bot_caller_user?.id;
  const fromUserId = message.from?.id;
  const senderTelegramId = typeof guestCallerUserId === "number" ? guestCallerUserId : fromUserId;
  if (typeof senderTelegramId !== "number") {
    return {
      ok: false,
      reason: "missing_guest_caller_id",
      details: {
        chatId: message.chat.id,
        hasGuestCallerUserId: typeof guestCallerUserId === "number",
        hasFromId: typeof fromUserId === "number",
        hasGuestCallerChatId: typeof message.guest_bot_caller_chat?.id === "number",
        guestCallerChatType: message.guest_bot_caller_chat?.type,
      },
    };
  }

  const caller = message.guest_bot_caller_user ?? message.from;
  return {
    ok: true,
    envelope: {
      kind: "message",
      mode: "guest",
      ctx,
      message,
      chatId: message.chat.id,
      chatType: message.chat.type,
      chatTitle: getChatTitle(message.chat),
      senderTelegramId,
      senderUsername: caller?.username,
      senderDisplayName: formatTelegramUser(caller),
      text: getMessageText(message),
      guestQueryId,
      guestCallerSource: message.guest_bot_caller_user ? "guest_bot_caller_user" : "from",
    },
  };
}

export function getMessageText(message: Message): string | undefined {
  if ("text" in message && typeof message.text === "string") return message.text;
  if ("caption" in message && typeof message.caption === "string") return message.caption;
  return undefined;
}

function getChatTitle(chat: Chat): string | undefined {
  return "title" in chat && typeof chat.title === "string" ? chat.title : undefined;
}

function formatTelegramUser(user: User | undefined): string | undefined {
  if (!user) return undefined;
  if (user.username) return `@${user.username}`;
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || String(user.id);
}
