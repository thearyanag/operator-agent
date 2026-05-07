import { Bot, type Context } from "grammy";
import type { AuditLogger } from "../audit";
import { serializeError } from "../audit";
import type { PiBridge } from "../pi/bridge";
import type {
  AppConfig,
  TelegramBusinessMessage,
  TelegramDeletedBusinessMessages,
  TelegramEditedBusinessMessage,
  TelegramRunContext,
} from "../types";
import { canUsePrivateDm, isAllowedGroupChat, isSupportedChat, replyUnauthorized } from "./access";
import {
  BusinessConnectionStore,
  canReplyAsBusinessAccount,
  type BusinessConnectionState,
} from "./business";
import {
  buildBusinessRunContext,
  buildStandardRunContext,
  getAuditContextForRun,
  getBusinessAuditContext,
} from "./context";
import {
  BusinessReplySink,
  createTelegramReplySink,
  formatPiError,
  NoopReplySink,
  type TelegramReplySink,
} from "./replies";

type TelegramHandlerDeps = {
  appConfig: AppConfig;
  auditLogger: AuditLogger;
  piBridge: PiBridge;
};

export function registerTelegramHandlers(bot: Bot, deps: TelegramHandlerDeps): void {
  const businessConnections = new BusinessConnectionStore();

  bot.catch((error) => {
    console.error("Telegram bot error:", error.error);
    void deps.auditLogger.log({
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

    if (isAllowedGroupChat(ctx, deps.appConfig)) {
      await ctx.reply("Bot is ready. Send a message and I'll forward it to pi.");
      return;
    }

    if (ctx.chat?.type !== "private") return;

    if (!(await canUsePrivateDm(ctx, deps.appConfig))) {
      await replyUnauthorized(ctx, deps.appConfig);
      return;
    }

    await ctx.reply("Hi! Send me a message and I'll pass it to pi.");
  });

  bot.on("message", async (ctx) => {
    if (ctx.from?.is_bot) return;
    if (!isSupportedChat(ctx, deps.appConfig)) return;

    const text = ctx.message?.text ?? ctx.message?.caption;
    if (!text) {
      await ctx.reply("Send me a text message and I'll pass it to pi.");
      return;
    }

    const runContext = buildStandardRunContext(ctx, text);
    const auditContext = getAuditContextForRun(runContext);

    await deps.auditLogger.log({
      ...auditContext,
      event: "incoming_message",
      text,
    });

    const canUseBot = isAllowedGroupChat(ctx, deps.appConfig)
      ? true
      : ctx.chat?.type === "private" && (await canUsePrivateDm(ctx, deps.appConfig));

    if (!canUseBot) {
      await deps.auditLogger.log({
        ...auditContext,
        event: "message_rejected",
        error: "unauthorized",
      });
      await replyUnauthorized(ctx, deps.appConfig);
      return;
    }

    await processTelegramRun(
      ctx,
      runContext,
      createTelegramReplySink(ctx, runContext, deps.appConfig),
      deps,
    );
  });

  bot.on("business_connection", async (ctx) => {
    const connection = ctx.businessConnection;
    if (!connection) return;

    const state = businessConnections.set(connection);
    await deps.auditLogger.log({
      event: "business_connection_updated",
      surface: "business",
      businessConnectionId: state.id,
      businessOwnerUserId: state.ownerTelegramUserId,
      businessOwnerChatId: state.ownerPrivateChatId,
      businessIsEnabled: state.isEnabled,
      businessCanReply: canReplyAsBusinessAccount(state),
    });
  });

  bot.on("business_message", async (ctx) => {
    const message = ctx.businessMessage;
    if (!message) return;
    await handleBusinessMessage(ctx, message, businessConnections, deps);
  });

  bot.on("edited_business_message", async (ctx) => {
    const message = ctx.editedBusinessMessage;
    if (!message) return;
    await handleEditedBusinessMessage(message, deps);
  });

  bot.on("deleted_business_messages", async (ctx) => {
    const deleted = ctx.deletedBusinessMessages;
    if (!deleted) return;
    await handleDeletedBusinessMessages(deleted, deps);
  });
}

async function processTelegramRun(
  ctx: Context,
  runContext: TelegramRunContext,
  sink: TelegramReplySink,
  deps: TelegramHandlerDeps,
): Promise<void> {
  const auditContext = getAuditContextForRun(runContext);
  const promptStartedAt = Date.now();

  try {
    await deps.auditLogger.log({
      ...auditContext,
      event: "pi_prompt_started",
      prompt: runContext.prompt,
    });

    await sink.start();
    const result = await deps.piBridge.prompt(runContext.sessionKey, runContext.prompt, {
      onProgress: (update) => sink.handleProgress(update),
    });

    await deps.auditLogger.log({
      ...auditContext,
      event: "pi_prompt_completed",
      durationMs: Date.now() - promptStartedAt,
      response: result.text,
      attachmentCount: result.attachments.length,
    });

    await sink.stop();

    if (runContext.dryRun) {
      await deps.auditLogger.log({
        ...auditContext,
        event: "telegram_reply_suppressed",
        response: result.text,
        attachmentCount: result.attachments.length,
        durationMs: Date.now() - promptStartedAt,
      });
      return;
    }

    const replyResult = await sink.sendFinal(result.text);

    let attachmentSendError: unknown;
    try {
      await sink.sendAttachments(result.attachments);
    } catch (error) {
      attachmentSendError = error;
      console.error("Failed to send Telegram attachment:", error);
      await sink.sendError(`Failed to send attachment: ${formatPiError(error)}`);
    }

    await deps.auditLogger.log({
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
    await deps.auditLogger.log({
      ...auditContext,
      event: "pi_prompt_failed",
      durationMs: Date.now() - promptStartedAt,
      error: serializeError(error),
    });

    await sink.stop();
    await sink.sendError(formatPiError(error));
  }
}

async function handleBusinessMessage(
  ctx: Context,
  message: TelegramBusinessMessage,
  businessConnections: BusinessConnectionStore,
  deps: TelegramHandlerDeps,
): Promise<void> {
  if (message.from?.is_bot) return;

  const text = message.text ?? message.caption;
  const businessConnectionId = message.business_connection_id;
  const baseAuditContext = getBusinessAuditContext(message, businessConnectionId);

  await deps.auditLogger.log({
    ...baseAuditContext,
    event: "business_message_received",
    text,
  });

  if (!deps.appConfig.enableTelegramBusinessAutomation) {
    await deps.auditLogger.log({
      ...baseAuditContext,
      event: "business_message_rejected",
      error: "business automation disabled",
    });
    return;
  }

  if (!text) {
    await deps.auditLogger.log({
      ...baseAuditContext,
      event: "business_message_rejected",
      error: "unsupported non-text business message",
    });
    return;
  }

  if (!businessConnectionId) {
    await deps.auditLogger.log({
      ...baseAuditContext,
      event: "business_message_rejected",
      error: "missing business_connection_id",
    });
    return;
  }

  const connection = await getBusinessConnectionState(ctx, businessConnections, businessConnectionId, {
    refresh: true,
  });
  const auditContext = {
    ...baseAuditContext,
    businessOwnerUserId: connection?.ownerTelegramUserId,
    businessOwnerChatId: connection?.ownerPrivateChatId,
    businessIsEnabled: connection?.isEnabled,
    businessCanReply: connection ? canReplyAsBusinessAccount(connection) : false,
  };

  if (!connection) {
    await deps.auditLogger.log({
      ...auditContext,
      event: "business_message_rejected",
      error: "business connection state unavailable",
    });
    return;
  }

  if (!canBusinessOwnerUseAutomation(connection.ownerTelegramUserId, deps.appConfig)) {
    await deps.auditLogger.log({
      ...auditContext,
      event: "business_message_rejected",
      error: "business owner not allowed by server config",
    });
    return;
  }

  if (!canReplyAsBusinessAccount(connection)) {
    await deps.auditLogger.log({
      ...auditContext,
      event: "business_message_rejected",
      error: "business connection disabled or missing can_reply",
    });
    return;
  }

  const runContext = buildBusinessRunContext(message, text, connection, {
    dryRun: deps.appConfig.telegramBusinessDryRun,
  });
  await processTelegramRun(
    ctx,
    runContext,
    deps.appConfig.telegramBusinessDryRun
      ? new NoopReplySink()
      : new BusinessReplySink(ctx, businessConnectionId, deps.appConfig),
    deps,
  );
}

async function handleEditedBusinessMessage(
  message: TelegramEditedBusinessMessage,
  deps: TelegramHandlerDeps,
): Promise<void> {
  await deps.auditLogger.log({
    ...getBusinessAuditContext(message, message.business_connection_id),
    event: "business_message_edited",
    text: message.text ?? message.caption,
  });
}

async function handleDeletedBusinessMessages(
  deleted: TelegramDeletedBusinessMessages,
  deps: TelegramHandlerDeps,
): Promise<void> {
  await deps.auditLogger.log({
    event: "business_messages_deleted",
    surface: "business",
    businessConnectionId: deleted.business_connection_id,
    chatId: deleted.chat.id,
    chatType: deleted.chat.type,
    response: JSON.stringify({ messageIds: deleted.message_ids }),
  });
}

async function getBusinessConnectionState(
  ctx: Context,
  businessConnections: BusinessConnectionStore,
  businessConnectionId: string,
  options: { refresh?: boolean } = {},
): Promise<BusinessConnectionState | undefined> {
  const cached = businessConnections.get(businessConnectionId);
  if (cached && !options.refresh) return cached;

  try {
    return businessConnections.set(await ctx.api.getBusinessConnection(businessConnectionId));
  } catch (error) {
    console.warn(`Failed to fetch Telegram business connection ${businessConnectionId}:`, error);
    return options.refresh ? undefined : cached;
  }
}

function canBusinessOwnerUseAutomation(ownerTelegramUserId: number, appConfig: AppConfig): boolean {
  return (
    appConfig.telegramBusinessAllowedOwnerIds.size === 0 ||
    appConfig.telegramBusinessAllowedOwnerIds.has(ownerTelegramUserId)
  );
}
