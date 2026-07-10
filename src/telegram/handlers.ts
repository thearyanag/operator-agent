import { randomUUID } from "node:crypto";
import { Bot, type Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { AuditLogger } from "../audit";
import { serializeError } from "../audit";
import {
  createTelegramContextArtifact,
  withTelegramContextPrompt,
  type TelegramContextArtifact,
} from "../operator/context-artifact";
import {
  buildPersonalDigestOutput,
  buildPersonalDraftPrompt,
  evaluateOperatorPolicy,
} from "../operator/policy";
import type { OperatorEnvelope, OperatorStore } from "../operator/store";
import {
  recordBusinessTelegramObservation,
  recordStandardTelegramObservation,
} from "../operator/telegram-normalizer";
import type { PiBridge } from "../pi/bridge";
import type { OperatorStateDb } from "../state/operator-db";
import type {
  AppConfig,
  OperatorToolContext,
  TelegramBusinessMessage,
  TelegramDeletedBusinessMessages,
  TelegramEditedBusinessMessage,
  TelegramRunContext,
} from "../types";
import {
  canUsePrivateDm,
  canUseTelegramUser,
  getUnauthorizedMessage,
  isSupportedChat,
  isTeamGroupChat,
  replyUnauthorized,
} from "./access";
import {
  BusinessConnectionStore,
  canReplyAsBusinessAccount,
  type BusinessConnectionState,
} from "./business";
import {
  buildBusinessRunContext,
  buildGuestRunContext,
  buildStandardRunContext,
  getAuditContextForRun,
  getBusinessAuditContext,
} from "./context";
import type { TelegramGuestMediaPublisher } from "./guest-media";
import {
  createTelegramGuestReplySink,
  createTelegramReplySink,
  formatPiError,
  formatTelegramDeliveryError,
  TelegramGuestAttachmentUnsupportedError,
  type TelegramReplySink,
} from "./replies";
import { TelegramTurnHarness } from "./turn-harness";
import {
  extractGuestMessageTurnEnvelope,
  extractStandardMessageTurnEnvelope,
  getTelegramGuestMessage,
  type TelegramMessageTurnEnvelope,
} from "./turn-envelope";

type TelegramHandlerDeps = {
  appConfig: AppConfig;
  auditLogger: AuditLogger;
  piBridge: PiBridge;
  stateDb: OperatorStateDb;
  operatorStore?: OperatorStore;
  guestMediaStore?: TelegramGuestMediaPublisher;
};

export function registerTelegramHandlers(bot: Bot, deps: TelegramHandlerDeps): void {
  const businessConnections = new BusinessConnectionStore(deps.stateDb, deps.operatorStore);
  const turnHarness = createTelegramTurnHarness(deps);

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

  bot.use(async (ctx, next) => {
    if (!getTelegramGuestMessage(ctx)) {
      await next();
      return;
    }

    const extracted = extractGuestMessageTurnEnvelope(ctx);
    if (!extracted.ok) {
      await handleInvalidGuestEnvelope(ctx, extracted.reason, deps);
      return;
    }

    await turnHarness.handle(extracted.envelope);
  });

  bot.command("start", async (ctx) => {
    const extracted = extractStandardMessageTurnEnvelope(ctx);
    if (!extracted.ok) return;
    await turnHarness.handle(extracted.envelope);
  });

  bot.on("message", async (ctx) => {
    const extracted = extractStandardMessageTurnEnvelope(ctx);
    if (!extracted.ok) return;
    await turnHarness.handle(extracted.envelope);
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

function createTelegramTurnHarness(deps: TelegramHandlerDeps): TelegramTurnHarness {
  return new TelegramTurnHarness({
    handlers: {
      handleStart: async (envelope) => {
        if (envelope.kind !== "message" || envelope.mode !== "chat") return;
        await handleStandardStartTurn(envelope, deps);
      },
      handleUnsupported: async (envelope) => {
        if (envelope.kind !== "message") return;
        await handleUnsupportedTelegramTurn(envelope);
      },
      handlePromptRun: async (envelope) => {
        if (envelope.kind !== "message") return;
        if (envelope.mode === "guest") {
          await handleGuestPromptTurn(envelope, deps);
          return;
        }
        await handleStandardPromptTurn(envelope, deps);
      },
    },
  });
}

async function handleStandardStartTurn(
  envelope: TelegramMessageTurnEnvelope,
  deps: TelegramHandlerDeps,
): Promise<void> {
  const ctx = envelope.ctx;
  if (ctx.from?.is_bot) return;

  if (isTeamGroupChat(ctx, deps.appConfig)) {
    await ctx.reply("Operator is watching this group. Tag me when you want a reply.");
    return;
  }

  if (ctx.chat?.type !== "private") return;

  if (!(await canUsePrivateDm(ctx, deps.appConfig))) {
    await replyUnauthorized(ctx, deps.appConfig);
    return;
  }

  await ctx.reply("Hi! Send me a message and I'll pass it to pi.");
}

async function handleUnsupportedTelegramTurn(envelope: TelegramMessageTurnEnvelope): Promise<void> {
  if (envelope.mode === "guest" && envelope.guestQueryId) {
    await createTelegramGuestReplySink(envelope.ctx, envelope.guestQueryId).sendFinal(
      "Telegram guest mode supports questions and replies, but not bot setup commands.",
    );
  }
}

async function handleStandardPromptTurn(
  envelope: TelegramMessageTurnEnvelope,
  deps: TelegramHandlerDeps,
): Promise<void> {
  const ctx = envelope.ctx;
  if (ctx.from?.is_bot) return;
  if (!isSupportedChat(ctx, deps.appConfig)) return;

  const text = envelope.text;
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

  const canUseBot = isTeamGroupChat(ctx, deps.appConfig)
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

  const operatorEnvelope = await recordOperatorEnvelopeForStandardMessage(ctx, runContext, text, deps);

  if (await handleOperatorCommand(ctx, runContext, text, deps, operatorEnvelope)) {
    return;
  }

  const runtimePolicy = operatorEnvelope?.policyDecision ?? evaluateOperatorPolicy({
    conversation: {
      mode: runContext.surface === "private" ? "assistant" : "team",
      status: "active",
    },
    observationText: text,
    runContext,
    ctx,
    botUsername: deps.appConfig.telegramBotUsername,
  });

  if (!runtimePolicy.shouldInvokeAgent) {
    if (operatorEnvelope) {
      await maybeRecordObservedOutput(operatorEnvelope, text, deps);
    }
    return;
  }

  await processTelegramRun(
    ctx,
    withActiveInvestigationPrompt(runContext, deps),
    createTelegramReplySink(ctx, runContext, deps.appConfig),
    deps,
    operatorEnvelope,
  );
}

async function handleGuestPromptTurn(
  envelope: TelegramMessageTurnEnvelope,
  deps: TelegramHandlerDeps,
): Promise<void> {
  const guestQueryId = envelope.guestQueryId;
  if (!guestQueryId) return;

  const sink = createTelegramGuestReplySink(envelope.ctx, guestQueryId, deps.guestMediaStore);
  const text = envelope.text;
  if (!text) {
    await sink.sendFinal("Send a text message or caption when summoning Operator.");
    return;
  }

  const callerId = envelope.senderTelegramId;
  if (callerId === undefined) {
    await sink.sendFinal("Could not identify the Telegram caller. Try summoning Operator from your Telegram account.");
    return;
  }

  const runContext = buildGuestRunContext(envelope, text);
  const auditContext = getAuditContextForRun(runContext);

  await deps.auditLogger.log({
    ...auditContext,
    event: "guest_message_received",
    text,
  });

  if (!(await canUseTelegramUser(callerId, envelope.ctx.api, deps.appConfig))) {
    await deps.auditLogger.log({
      ...auditContext,
      event: "guest_message_rejected",
      error: "unauthorized",
    });
    await sink.sendFinal(getUnauthorizedMessage(deps.appConfig));
    return;
  }

  await processTelegramRun(
    envelope.ctx,
    withActiveInvestigationPrompt(runContext, deps),
    sink,
    deps,
  );
}

async function handleInvalidGuestEnvelope(
  ctx: Context,
  reason: string,
  deps: TelegramHandlerDeps,
): Promise<void> {
  const message = getTelegramGuestMessage(ctx);
  await deps.auditLogger.log({
    event: "guest_message_rejected",
    chatId: message?.chat.id,
    chatType: message?.chat.type,
    messageId: message?.message_id,
    error: reason,
    surface: "guest",
  });

  const guestQueryId = typeof message?.guest_query_id === "string" ? message.guest_query_id.trim() : "";
  if (!guestQueryId) return;

  await createTelegramGuestReplySink(ctx, guestQueryId).sendFinal(
    "Could not process this Telegram guest message. Try summoning Operator again.",
  );
}

async function recordOperatorEnvelopeForStandardMessage(
  ctx: Context,
  runContext: TelegramRunContext,
  text: string,
  deps: TelegramHandlerDeps,
): Promise<OperatorEnvelope | undefined> {
  if (!deps.operatorStore) return undefined;

  try {
    const { conversation, observation } = await recordStandardTelegramObservation({
      store: deps.operatorStore,
      appConfig: deps.appConfig,
      ctx,
      runContext,
      text,
    });
    const policyContext = await loadOperatorPolicyContext(deps, conversation.id);
    const policy = evaluateOperatorPolicy({
      conversation,
      observationText: text,
      runContext,
      ctx,
      botUsername: deps.appConfig.telegramBotUsername,
      ...policyContext,
    });
    const policyDecision = await deps.operatorStore.insertPolicyDecision({
      conversationId: conversation.id,
      observationId: observation.id,
      action: policy.action,
      reason: policy.reason,
      confidence: policy.confidence,
      shouldInvokeAgent: policy.shouldInvokeAgent,
    });
    return { conversation, observation, policyDecision };
  } catch (error) {
    console.warn("Failed to record Operator conversation observation:", error);
    return undefined;
  }
}

async function maybeRecordObservedOutput(
  envelope: OperatorEnvelope,
  text: string,
  deps: TelegramHandlerDeps,
): Promise<void> {
  if (!deps.operatorStore) return;

  if (envelope.policyDecision.action === "observe") {
    return;
  }

  if (envelope.policyDecision.action === "summarize") {
    await deps.operatorStore.insertOutput({
      conversationId: envelope.conversation.id,
      observationId: envelope.observation.id,
      type: "digest_item",
      status: "pending",
      payload: {
        title: envelope.conversation.title ?? "Telegram update",
        summary: text.slice(0, 500),
        priority: "normal",
      },
    }).catch((error) => {
      console.warn("Failed to insert digest output:", error);
    });
  }
}

async function recordOperatorEnvelopeForBusinessMessage(
  message: TelegramBusinessMessage,
  connection: BusinessConnectionState,
  runContext: TelegramRunContext,
  text: string,
  deps: TelegramHandlerDeps,
  policyOverride?: ReturnType<typeof evaluateOperatorPolicy>,
): Promise<OperatorEnvelope | undefined> {
  if (!deps.operatorStore) return undefined;

  try {
    const { conversation, observation } = await recordBusinessTelegramObservation({
      store: deps.operatorStore,
      appConfig: deps.appConfig,
      message,
      connection,
      text,
    });
    const policyContext = policyOverride
      ? {}
      : await loadOperatorPolicyContext(deps, conversation.id);
    const policy = policyOverride ?? evaluateOperatorPolicy({
      conversation,
      observationText: text,
      runContext,
      ...policyContext,
    });
    const policyDecision = await deps.operatorStore.insertPolicyDecision({
      conversationId: conversation.id,
      observationId: observation.id,
      action: policy.action,
      reason: policy.reason,
      confidence: policy.confidence,
      shouldInvokeAgent: policy.shouldInvokeAgent,
    });
    return { conversation, observation, policyDecision };
  } catch (error) {
    console.warn("Failed to record Operator business observation:", error);
    return undefined;
  }
}

async function processPersonalDraft(
  ctx: Context,
  runContext: TelegramRunContext,
  envelope: OperatorEnvelope,
  connection: BusinessConnectionState,
  deps: TelegramHandlerDeps,
): Promise<void> {
  if (!deps.operatorStore) return;

  const runId = randomUUID();
  const prompt = buildPersonalDraftPrompt({
    observation: envelope.observation,
    runContext,
  });
  await deps.operatorStore.startAgentRun({
    id: runId,
    conversationId: envelope.conversation.id,
    observationId: envelope.observation.id,
    mode: "personal",
    prompt,
  });

  let draftText: string;
  try {
    const result = await deps.piBridge.prompt(runContext.sessionKey, prompt, {
      operatorToolContext: buildOperatorToolContext(runId, runContext, deps, envelope),
    });
    draftText = result.text;
    await deps.operatorStore.completeAgentRun(runId, draftText);
  } catch (error) {
    const serialized = serializeError(error);
    await deps.operatorStore.failAgentRun(runId, serialized);
    await deps.auditLogger.log({
      ...getAuditContextForRun(runContext),
      runId,
      event: "personal_draft_failed",
      error: serialized,
    });
    return;
  }

  const output = await deps.operatorStore.insertOutput({
    conversationId: envelope.conversation.id,
    observationId: envelope.observation.id,
    agentRunId: runId,
    type: "draft",
    status: "pending",
    payload: {
      draft: draftText,
      sourceText: envelope.observation.text,
      sourceConversationTitle: envelope.conversation.title,
      sourceSender: envelope.observation.senderDisplayName,
    },
  });

  await deps.operatorStore.insertOutput({
    conversationId: envelope.conversation.id,
    observationId: envelope.observation.id,
    type: "digest_item",
    status: "pending",
    payload: buildPersonalDigestOutput({
      observation: envelope.observation,
      runContext,
    }),
  });

  if (deps.appConfig.telegramBusinessDryRun) {
    return;
  }

  try {
    await ctx.api.sendMessage(
      connection.ownerPrivateChatId,
      [
        "Draft reply",
        envelope.conversation.title ? `Chat: ${envelope.conversation.title}` : undefined,
        envelope.observation.senderDisplayName ? `From: ${envelope.observation.senderDisplayName}` : undefined,
        "",
        draftText,
      ].filter(Boolean).join("\n"),
      {
        link_preview_options: { is_disabled: true },
        reply_markup: buildPersonalDraftReplyMarkup(envelope, draftText),
      },
    );
    await deps.operatorStore.markOutputDelivered(output.id);
  } catch (error) {
    const serialized = serializeError(error);
    await deps.operatorStore.markOutputFailed(output.id, serialized);
    console.warn("Failed to deliver personal draft to owner DM:", error);
  }
}

async function loadOperatorPolicyContext(
  deps: TelegramHandlerDeps,
  conversationId: string,
) {
  if (!deps.operatorStore) return {};

  const [conversationPolicy, ownerSettings] = await Promise.all([
    deps.operatorStore.getConversationPolicy(conversationId).catch((error) => {
      console.warn("Failed to load Operator conversation policy:", error);
      return undefined;
    }),
    deps.operatorStore.getOwnerSettings(deps.appConfig.operatorOwnerId).catch((error) => {
      console.warn("Failed to load Operator owner settings:", error);
      return undefined;
    }),
  ]);

  return { conversationPolicy, ownerSettings };
}

function buildPersonalDraftReplyMarkup(
  envelope: OperatorEnvelope,
  draftText: string,
): InlineKeyboardMarkup {
  const inlineKeyboard: InlineKeyboardMarkup["inline_keyboard"] = [];
  const draftLink = buildTelegramDraftDeepLink(envelope, draftText);

  if (draftLink) {
    inlineKeyboard.push([
      {
        text: "Open chat with draft",
        url: draftLink,
      },
    ]);
  }

  inlineKeyboard.push([
    {
      text: "Copy draft",
      copy_text: {
        text: draftText,
      },
    },
  ]);

  return { inline_keyboard: inlineKeyboard };
}

function buildTelegramDraftDeepLink(envelope: OperatorEnvelope, draftText: string): string | undefined {
  const username = getBusinessSenderUsername(envelope.observation.rawPayload);
  if (!username) return undefined;

  const text = normalizeTelegramDeepLinkDraftText(draftText);
  if (!text) return undefined;

  return `https://t.me/${username}?text=${encodeURIComponent(text)}`;
}

function getBusinessSenderUsername(rawPayload: unknown): string | undefined {
  if (!isRecord(rawPayload)) return undefined;
  const from = rawPayload.from;
  if (!isRecord(from)) return undefined;
  const username = typeof from.username === "string" ? from.username.trim().replace(/^@/, "") : "";
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return undefined;
  return username;
}

function normalizeTelegramDeepLinkDraftText(text: string, maxLength = 900): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const safeText = trimmed.startsWith("@") ? ` ${trimmed}` : trimmed;
  return safeText.length <= maxLength ? safeText : safeText.slice(0, maxLength).trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function maybeCreateTelegramContextArtifact(
  runId: string,
  runContext: TelegramRunContext,
  deps: TelegramHandlerDeps,
  operatorEnvelope?: OperatorEnvelope,
): Promise<TelegramContextArtifact | undefined> {
  if (!deps.operatorStore || !operatorEnvelope) return undefined;

  try {
    return await createTelegramContextArtifact({
      appConfig: deps.appConfig,
      store: deps.operatorStore,
      envelope: operatorEnvelope,
      runContext,
      runId,
    });
  } catch (error) {
    console.warn("Failed to create Operator Telegram context artifact:", error);
    return undefined;
  }
}

function buildOperatorToolContext(
  runId: string,
  runContext: TelegramRunContext,
  deps: TelegramHandlerDeps,
  operatorEnvelope?: OperatorEnvelope,
): OperatorToolContext {
  return {
    surface: runContext.surface,
    sessionKey: runContext.sessionKey,
    runId,
    ownerUserId: deps.appConfig.operatorOwnerId,
    ownerTelegramUserIds: deps.appConfig.operatorOwnerTelegramIds,
    requesterTelegramUserId: runContext.surface === "business"
      ? runContext.businessOwnerUserId
      : runContext.userId,
    currentConversationId: operatorEnvelope?.conversation.id,
    currentConversationTitle: operatorEnvelope?.conversation.title ?? runContext.chatTitle,
    currentTelegramChatId: operatorEnvelope?.conversation.telegramChatId ?? String(runContext.chatId),
  };
}

async function processTelegramRun(
  ctx: Context,
  runContext: TelegramRunContext,
  sink: TelegramReplySink,
  deps: TelegramHandlerDeps,
  operatorEnvelope?: OperatorEnvelope,
): Promise<void> {
  const runId = randomUUID();
  const auditContext = { ...getAuditContextForRun(runContext), runId };
  const promptStartedAt = Date.now();

  try {
    const contextArtifact = await maybeCreateTelegramContextArtifact(runId, runContext, deps, operatorEnvelope);
    const effectivePrompt = contextArtifact
      ? withTelegramContextPrompt(runContext.prompt, contextArtifact)
      : runContext.prompt;

    upsertTelegramSessionFromContext(runContext, deps, promptStartedAt, runId);
    deps.stateDb.startRun({
      id: runId,
      sessionKey: runContext.sessionKey,
      prompt: effectivePrompt,
      startedAt: promptStartedAt,
    });
    if (deps.operatorStore && operatorEnvelope) {
      await deps.operatorStore.startAgentRun({
        id: runId,
        conversationId: operatorEnvelope.conversation.id,
        observationId: operatorEnvelope.observation.id,
        mode: operatorEnvelope.conversation.mode,
        prompt: effectivePrompt,
      }).catch((error) => {
        console.warn("Failed to start Operator Postgres agent run:", error);
      });
      if (contextArtifact) {
        await deps.operatorStore.insertOutput({
          conversationId: operatorEnvelope.conversation.id,
          observationId: operatorEnvelope.observation.id,
          agentRunId: runId,
          type: "artifact",
          status: "pending",
          payload: {
            kind: "telegram_context",
            path: contextArtifact.path,
            messageCount: contextArtifact.messageCount,
            previewCount: contextArtifact.previewCount,
            window: contextArtifact.window,
            windowStartAt: contextArtifact.windowStartAt?.toISOString() ?? null,
            windowEndAt: contextArtifact.windowEndAt?.toISOString() ?? null,
          },
        }).catch((error) => {
          console.warn("Failed to insert Operator context artifact output:", error);
        });
      }
    }

    await deps.auditLogger.log({
      ...auditContext,
      event: "pi_prompt_started",
      prompt: effectivePrompt,
    });

    await sink.start();
    const result = await deps.piBridge.prompt(runContext.sessionKey, effectivePrompt, {
      onProgress: (update) => sink.handleProgress(update),
      operatorToolContext: buildOperatorToolContext(runId, runContext, deps, operatorEnvelope),
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
    await deps.operatorStore?.completeAgentRun(runId, result.text, new Date(promptCompletedAt)).catch((error) => {
      console.warn("Failed to complete Operator Postgres agent run:", error);
    });
    const replyOutput = deps.operatorStore && operatorEnvelope
      ? await deps.operatorStore.insertOutput({
          conversationId: operatorEnvelope.conversation.id,
          observationId: operatorEnvelope.observation.id,
          agentRunId: runId,
          type: "reply",
          status: runContext.dryRun ? "suppressed" : "pending",
          payload: {
            text: result.text,
            attachmentCount: result.attachments.length,
            surface: runContext.surface,
          },
        }).catch((error) => {
          console.warn("Failed to insert Operator reply output:", error);
          return undefined;
        })
      : undefined;
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
    if (replyOutput) {
      await deps.operatorStore?.markOutputDelivered(replyOutput.id).catch((error) => {
        console.warn("Failed to mark Operator reply output delivered:", error);
      });
    }

    let attachmentSendError: unknown;
    try {
      await sink.sendAttachments(result.attachments);
      deps.stateDb.markRunArtifactsSent(runId, Date.now());
    } catch (error) {
      attachmentSendError = error;
      deps.stateDb.markRunArtifactsFailed(runId, serializeError(error));
      console.error("Failed to send Telegram attachment:", error);
      if (!(error instanceof TelegramGuestAttachmentUnsupportedError)) {
        await sink.sendError(`Failed to send attachment: ${formatTelegramDeliveryError(error)}`);
      }
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
    await deps.operatorStore?.failAgentRun(runId, serializedError, new Date(failedAt)).catch((storeError) => {
      console.warn("Failed to fail Operator Postgres agent run:", storeError);
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

  if (!canReplyAsBusinessAccount(connection)) {
    await deps.auditLogger.log({
      ...auditContext,
      event: "business_message_rejected",
      error: "business connection disabled or missing can_reply",
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

  const runContext = buildBusinessRunContext(message, text, connection, {
    dryRun: deps.appConfig.telegramBusinessDryRun,
  });
  const isOwnerAuthored = isBusinessMessageFromOwner(message, connection);
  const operatorEnvelope = await recordOperatorEnvelopeForBusinessMessage(
    message,
    connection,
    runContext,
    text,
    deps,
    isOwnerAuthored
      ? {
          action: "observe",
          reason: "owner-authored business message",
          confidence: 1,
          shouldInvokeAgent: false,
        }
      : undefined,
  );
  if (!operatorEnvelope) {
    await deps.auditLogger.log({
      ...auditContext,
      event: "business_message_rejected",
      error: "operator observation unavailable",
    });
    return;
  }

  if (isOwnerAuthored) {
    await deps.auditLogger.log({
      ...auditContext,
      event: "business_message_observed",
      response: "owner-authored business message",
    });
    return;
  }

  if (!operatorEnvelope.policyDecision.shouldInvokeAgent) {
    await maybeRecordObservedOutput(operatorEnvelope, text, deps);
    return;
  }

  await processPersonalDraft(ctx, runContext, operatorEnvelope, connection, deps);
}

async function handleOperatorCommand(
  ctx: Context,
  runContext: TelegramRunContext,
  text: string,
  deps: TelegramHandlerDeps,
  operatorEnvelope?: OperatorEnvelope,
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
        operatorEnvelope,
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
        operatorEnvelope,
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
        operatorEnvelope,
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
  lastRunId?: string,
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
  void deps.operatorStore?.upsertTelegramSession({
    ownerUserId: deps.appConfig.operatorOwnerId,
    sessionKey: runContext.sessionKey,
    surface: runContext.surface,
    chatId: runContext.chatId,
    chatType: runContext.chatType,
    chatTitle: runContext.chatTitle,
    userId: runContext.userId,
    username: runContext.username,
    businessConnectionId: runContext.businessConnectionId,
    lastRunId,
    updatedAt: new Date(updatedAt),
  }).catch((error) => {
    console.warn(`Failed to persist Telegram session ${runContext.sessionKey} to Operator Postgres:`, error);
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

export function isBusinessMessageFromOwner(
  message: Pick<TelegramBusinessMessage, "from">,
  connection: Pick<BusinessConnectionState, "ownerTelegramUserId">,
): boolean {
  return message.from?.id === connection.ownerTelegramUserId;
}
