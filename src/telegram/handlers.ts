import { randomUUID } from "node:crypto";
import { Bot, type Context } from "grammy";
import type { AuditLogger } from "../audit";
import { serializeError } from "../audit";
import type { PiBridge } from "../pi/bridge";
import type { OperatorStateDb } from "../state/operator-db";
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
  stateDb: OperatorStateDb;
};

export function registerTelegramHandlers(bot: Bot, deps: TelegramHandlerDeps): void {
  const businessConnections = new BusinessConnectionStore(deps.stateDb);

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

    if (await handleOperatorCommand(ctx, runContext, text, deps)) {
      return;
    }

    await processTelegramRun(
      ctx,
      withActiveInvestigationPrompt(runContext, deps),
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
  const runId = randomUUID();
  const auditContext = { ...getAuditContextForRun(runContext), runId };
  const promptStartedAt = Date.now();

  try {
    upsertTelegramSessionFromContext(runContext, deps, promptStartedAt);
    deps.stateDb.startRun({
      id: runId,
      sessionKey: runContext.sessionKey,
      prompt: runContext.prompt,
      startedAt: promptStartedAt,
    });

    await deps.auditLogger.log({
      ...auditContext,
      event: "pi_prompt_started",
      prompt: runContext.prompt,
    });

    await sink.start();
    const result = await deps.piBridge.prompt(runContext.sessionKey, runContext.prompt, {
      onProgress: (update) => sink.handleProgress(update),
    });
    const promptCompletedAt = Date.now();
    const durationMs = promptCompletedAt - promptStartedAt;
    recordRunArtifacts(runId, runContext.sessionKey, result.attachments, deps, promptCompletedAt);
    deps.stateDb.completeRun({
      id: runId,
      response: result.text,
      completedAt: promptCompletedAt,
      durationMs,
      attachmentCount: result.attachments.length,
    });
    recordCaseRunEvent(runId, runContext, result.text, result.attachments.length, deps, promptCompletedAt);

    await deps.auditLogger.log({
      ...auditContext,
      event: "pi_prompt_completed",
      durationMs,
      response: result.text,
      attachmentCount: result.attachments.length,
    });

    await sink.stop();

    if (runContext.dryRun) {
      deps.stateDb.markRunArtifactsSuppressed(runId);
      await deps.auditLogger.log({
        ...auditContext,
        event: "telegram_reply_suppressed",
        response: result.text,
        attachmentCount: result.attachments.length,
        durationMs,
      });
      return;
    }

    const replyResult = await sink.sendFinal(result.text);

    let attachmentSendError: unknown;
    try {
      await sink.sendAttachments(result.attachments);
      deps.stateDb.markRunArtifactsSent(runId, Date.now());
    } catch (error) {
      attachmentSendError = error;
      deps.stateDb.markRunArtifactsFailed(runId, serializeError(error));
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
    const serializedError = serializeError(error);
    const failedAt = Date.now();
    console.error("Failed to process message with pi:", error);
    deps.stateDb.failRun({
      id: runId,
      error: serializedError,
      completedAt: failedAt,
      durationMs: failedAt - promptStartedAt,
    });
    await deps.auditLogger.log({
      ...auditContext,
      event: "pi_prompt_failed",
      durationMs: failedAt - promptStartedAt,
      error: serializedError,
    });

    await sink.stop();
    await sink.sendError(formatPiError(error));
  }
}

function recordRunArtifacts(
  runId: string,
  sessionKey: string,
  attachments: Array<{ path: string; fileName: string; kind: string }>,
  deps: TelegramHandlerDeps,
  createdAt: number,
): void {
  const active = deps.stateDb.getActiveInvestigation(sessionKey);
  attachments.forEach((attachment, index) => {
    deps.stateDb.insertArtifact({
      id: `${runId}:${index + 1}`,
      runId,
      caseId: active?.caseId ?? undefined,
      path: attachment.path,
      fileName: attachment.fileName,
      kind: attachment.kind,
      status: "queued",
      createdAt,
    });
  });
}

function recordCaseRunEvent(
  runId: string,
  runContext: TelegramRunContext,
  response: string,
  attachmentCount: number,
  deps: TelegramHandlerDeps,
  createdAt: number,
): void {
  const active = deps.stateDb.getActiveInvestigation(runContext.sessionKey);
  if (!active?.caseId) return;

  deps.stateDb.addCaseEvent({
    id: randomUUID(),
    caseId: active.caseId,
    runId,
    kind: "run_completed",
    text: response,
    metadataJson: JSON.stringify({
      prompt: runContext.prompt,
      attachmentCount,
    }),
    createdAt,
  });
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

async function handleOperatorCommand(
  ctx: Context,
  runContext: TelegramRunContext,
  text: string,
  deps: TelegramHandlerDeps,
): Promise<boolean> {
  const [commandWithSuffix = "", ...args] = text.trim().split(/\s+/);
  const command = commandWithSuffix.split("@")[0]?.toLowerCase();
  const rest = args.join(" ").trim();

  if (!command?.startsWith("/")) return false;
  upsertTelegramSessionFromContext(runContext, deps, Date.now());

  switch (command) {
    case "/reset":
      deps.piBridge.reset(runContext.sessionKey);
      deps.stateDb.clearActiveInvestigation(runContext.sessionKey);
      await ctx.reply("Reset this chat's active investigation and in-memory agent session.");
      return true;
    case "/investigate":
      if (!rest) {
        await ctx.reply("Usage: /investigate <user, account, workspace, or other subject>");
        return true;
      }
      deps.stateDb.setActiveInvestigation({
        sessionKey: runContext.sessionKey,
        subject: rest,
        updatedAt: Date.now(),
      });
      await processTelegramRun(
        ctx,
        {
          ...runContext,
          text: rest,
          prompt: buildInvestigationPrompt(rest),
        },
        createTelegramReplySink(ctx, runContext, deps.appConfig),
        deps,
      );
      return true;
    case "/timeline": {
      const active = deps.stateDb.getActiveInvestigation(runContext.sessionKey);
      if (!active) {
        await ctx.reply("No active investigation. Run /investigate <id> first.");
        return true;
      }
      await processTelegramRun(
        ctx,
        {
          ...runContext,
          prompt: buildTimelinePrompt(active.subject),
        },
        createTelegramReplySink(ctx, runContext, deps.appConfig),
        deps,
      );
      return true;
    }
    case "/handoff": {
      const active = deps.stateDb.getActiveInvestigation(runContext.sessionKey);
      if (!active) {
        await ctx.reply("No active investigation. Run /investigate <id> first.");
        return true;
      }
      await processTelegramRun(
        ctx,
        {
          ...runContext,
          prompt: buildHandoffPrompt(active.subject),
        },
        createTelegramReplySink(ctx, runContext, deps.appConfig),
        deps,
      );
      return true;
    }
    case "/case-save":
      await saveActiveCase(ctx, runContext, deps);
      return true;
    case "/case-open":
      await openCase(ctx, runContext, rest, deps);
      return true;
    case "/case-list":
      await listCases(ctx, runContext, deps);
      return true;
    default:
      return false;
  }
}

function upsertTelegramSessionFromContext(
  runContext: TelegramRunContext,
  deps: TelegramHandlerDeps,
  updatedAt: number,
): void {
  deps.stateDb.upsertTelegramSession({
    sessionKey: runContext.sessionKey,
    surface: runContext.surface,
    chatId: runContext.chatId,
    chatType: runContext.chatType,
    chatTitle: runContext.chatTitle,
    userId: runContext.userId,
    username: runContext.username,
    businessConnectionId: runContext.businessConnectionId,
    updatedAt,
  });
}

function withActiveInvestigationPrompt(runContext: TelegramRunContext, deps: TelegramHandlerDeps): TelegramRunContext {
  const active = deps.stateDb.getActiveInvestigation(runContext.sessionKey);
  if (!active) return runContext;

  return {
    ...runContext,
    prompt: [
      `Active investigation subject: ${active.subject}.`,
      active.caseId ? `Open case ID: ${active.caseId}.` : undefined,
      "Use this active subject as context for the user's follow-up unless they clearly ask about something else.",
      "",
      runContext.prompt,
    ].filter(Boolean).join("\n"),
  };
}

async function saveActiveCase(ctx: Context, runContext: TelegramRunContext, deps: TelegramHandlerDeps): Promise<void> {
  const active = deps.stateDb.getActiveInvestigation(runContext.sessionKey);
  if (!active) {
    await ctx.reply("No active investigation to save. Run /investigate <id> first.");
    return;
  }

  const now = Date.now();
  const latestRun = deps.stateDb.getLatestCompletedRunForSession(runContext.sessionKey);
  const caseId = `case_${new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
  deps.stateDb.createCase({
    id: caseId,
    subject: active.subject,
    sessionKey: runContext.sessionKey,
    status: "open",
    summary: latestRun?.response ?? undefined,
    createdAt: now,
    updatedAt: now,
  });
  deps.stateDb.setActiveInvestigation({
    sessionKey: runContext.sessionKey,
    subject: active.subject,
    caseId,
    updatedAt: now,
  });
  deps.stateDb.addCaseEvent({
    id: randomUUID(),
    caseId,
    runId: latestRun?.id,
    kind: "case_saved",
    text: latestRun?.response ?? `Saved active investigation for ${active.subject}.`,
    metadataJson: JSON.stringify({ sessionKey: runContext.sessionKey }),
    createdAt: now,
  });

  await ctx.reply(`Saved case ${caseId} for ${active.subject}.`);
}

async function openCase(
  ctx: Context,
  runContext: TelegramRunContext,
  caseId: string,
  deps: TelegramHandlerDeps,
): Promise<void> {
  if (!caseId) {
    await ctx.reply("Usage: /case-open <case-id>");
    return;
  }

  const caseRecord = deps.stateDb.getCase(caseId);
  if (!caseRecord) {
    await ctx.reply(`Case not found: ${caseId}`);
    return;
  }

  deps.stateDb.setActiveInvestigation({
    sessionKey: runContext.sessionKey,
    subject: caseRecord.subject,
    caseId: caseRecord.id,
    updatedAt: Date.now(),
  });
  await ctx.reply(`Opened case ${caseRecord.id} for ${caseRecord.subject}.`);
}

async function listCases(ctx: Context, runContext: TelegramRunContext, deps: TelegramHandlerDeps): Promise<void> {
  const cases = deps.stateDb.listCasesForSession(runContext.sessionKey);
  if (cases.length === 0) {
    await ctx.reply("No saved cases for this chat.");
    return;
  }

  await ctx.reply(
    cases
      .map((caseRecord) => {
        const updatedAt = new Date(caseRecord.updatedAt).toISOString();
        return `${caseRecord.id} — ${caseRecord.subject} (${caseRecord.status}, ${updatedAt})`;
      })
      .join("\n"),
  );
}

function buildInvestigationPrompt(subject: string): string {
  return [
    `Investigate this subject: ${subject}.`,
    "Return a structured operator investigation summary.",
    "",
    "Include:",
    "- Summary",
    "- What happened",
    "- Current state",
    "- Evidence",
    "- Likely cause",
    "- Recommended next checks",
  ].join("\n");
}

function buildTimelinePrompt(subject: string): string {
  return [
    `Build a cross-system timeline for the active investigation subject: ${subject}.`,
    "Use available evidence from connected tools. Separate verified events from inference.",
  ].join("\n");
}

function buildHandoffPrompt(subject: string): string {
  return [
    `Create a concise handoff for the active investigation subject: ${subject}.`,
    "Include issue summary, context, verified evidence, unknowns, and recommended next action.",
  ].join("\n");
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
