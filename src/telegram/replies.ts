import { GrammyError, type Context } from "grammy";
import { renderTelegramMessageChunks } from "../../packages/telegram-markdown-html/src/index";
import type {
  AppConfig,
  PiProgressUpdate,
  ReplyRenderResult,
  TelegramQueuedAttachment,
  TelegramRunContext,
  TelegramSendOptions,
} from "../types";
import { sendQueuedTelegramAttachments } from "./attachments";
import { toTelegramMethodOptions } from "./api-options";
import {
  isTelegramGuestRichMediaAttachment,
  type PublishedTelegramGuestMedia,
  type TelegramGuestMediaPublisher,
} from "./guest-media";

const GROUP_STREAM_INTERVAL_MS = 500;
const GUEST_STREAM_INTERVAL_MS = 2_000;
const RICH_MARKDOWN_LIMIT = 32_000;
const CLASSIC_HTML_LIMIT = 3_500;
const CLASSIC_TEXT_LIMIT = 4_000;
const GUEST_RICH_MEDIA_LIMIT = 50;

export interface TelegramReplySink {
  start(): Promise<void>;
  handleProgress(update: PiProgressUpdate): void;
  stop(): Promise<void>;
  sendFinal(text: string): Promise<ReplyRenderResult>;
  sendAttachments(attachments: TelegramQueuedAttachment[]): Promise<void>;
  sendError(text: string): Promise<void>;
}

export class TelegramGuestAttachmentUnsupportedError extends Error {
  constructor(readonly attachmentCount: number) {
    super(
      `Telegram guest mode cannot upload ${attachmentCount === 1 ? "this attachment" : `${attachmentCount} attachments`}. Use a DM or add the bot to the chat to receive local media files.`,
    );
    this.name = "TelegramGuestAttachmentUnsupportedError";
  }
}

export function createTelegramReplySink(
  ctx: Context,
  runContext: TelegramRunContext,
  appConfig: AppConfig,
): TelegramReplySink {
  if (
    runContext.surface === "private" &&
    appConfig.enableTelegramNativeStreaming &&
    Number.isSafeInteger(runContext.chatId)
  ) {
    return new PrivateDraftReplySink(ctx, runContext.chatId, buildDraftId(ctx.update.update_id), appConfig);
  }

  if (runContext.surface === "group") {
    return new GroupStreamingReplySink(ctx, appConfig);
  }

  return new EditableProgressReplySink(ctx, appConfig);
}

export function createTelegramGuestReplySink(
  ctx: Context,
  guestQueryId: string,
  mediaPublisher?: TelegramGuestMediaPublisher,
): TelegramReplySink {
  return new GuestInlineReplySink(ctx, guestQueryId, mediaPublisher);
}

export function formatTelegramDeliveryError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Telegram delivery failed with an unknown error.";
}

export class EditableProgressReplySink implements TelegramReplySink {
  private readonly progress: LiveTelegramProgressMessage;
  private stopTyping: (() => void) | undefined;

  constructor(
    private readonly ctx: Context,
    private readonly appConfig: AppConfig,
    private readonly options: TelegramSendOptions = {},
  ) {
    this.progress = new LiveTelegramProgressMessage(ctx, options);
  }

  async start(): Promise<void> {
    this.stopTyping = startTypingLoop(this.ctx, this.appConfig, this.options);
    await this.progress.start();
  }

  handleProgress(update: PiProgressUpdate): void {
    this.progress.handle(update);
  }

  async stop(): Promise<void> {
    this.stopTyping?.();
    this.stopTyping = undefined;
    await this.progress.stop();
  }

  async sendFinal(text: string): Promise<ReplyRenderResult> {
    return replyRichMarkdownResponse(this.ctx, text, {
      replaceMessageId: this.progress.messageId,
      businessConnectionId: this.options.businessConnectionId,
    });
  }

  async sendAttachments(attachments: TelegramQueuedAttachment[]): Promise<void> {
    await sendQueuedTelegramAttachments(this.ctx, attachments, this.options);
  }

  async sendError(text: string): Promise<void> {
    if (this.progress.messageId !== undefined) {
      await replyRichMarkdownResponse(this.ctx, text, {
        replaceMessageId: this.progress.messageId,
        businessConnectionId: this.options.businessConnectionId,
      });
      return;
    }

    await sendPlainTelegramMessage(this.ctx, text, this.options);
  }
}

export class BusinessReplySink extends EditableProgressReplySink {
  constructor(ctx: Context, businessConnectionId: string, appConfig: AppConfig) {
    super(ctx, appConfig, { businessConnectionId });
  }
}

export class GroupStreamingReplySink implements TelegramReplySink {
  private stopTyping: (() => void) | undefined;
  private streamMessageId: number | undefined;
  private latestAnswerText = "";
  private renderedAnswerText = "";
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private renderChain = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly ctx: Context,
    private readonly appConfig: AppConfig,
  ) {}

  async start(): Promise<void> {
    this.stopTyping = startTypingLoop(this.ctx, this.appConfig);
    try {
      await this.ctx.react("👍");
    } catch (error) {
      console.warn("Failed to acknowledge Telegram group message with reaction:", error);
    }
  }

  handleProgress(update: PiProgressUpdate): void {
    if (this.stopped || update.type !== "answer") return;
    this.latestAnswerText = clipRichMarkdownText(update.text);
    this.scheduleRender();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopTyping?.();
    this.stopTyping = undefined;
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    await this.renderChain.catch(() => undefined);
  }

  async sendFinal(text: string): Promise<ReplyRenderResult> {
    return replyRichMarkdownResponse(this.ctx, text, {
      replaceMessageId: this.streamMessageId,
    });
  }

  async sendAttachments(attachments: TelegramQueuedAttachment[]): Promise<void> {
    await sendQueuedTelegramAttachments(this.ctx, attachments);
  }

  async sendError(text: string): Promise<void> {
    if (this.streamMessageId !== undefined) {
      await replyRichMarkdownResponse(this.ctx, text, {
        replaceMessageId: this.streamMessageId,
      });
      return;
    }

    await sendPlainTelegramMessage(this.ctx, text);
  }

  private scheduleRender(): void {
    if (this.renderTimer || this.stopped || this.latestAnswerText === this.renderedAnswerText) return;

    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      void this.renderNow();
    }, GROUP_STREAM_INTERVAL_MS);
  }

  private async renderNow(): Promise<void> {
    const text = this.latestAnswerText;
    if (!text || text === this.renderedAnswerText) return;

    this.renderChain = this.renderChain
      .catch(() => undefined)
      .then(async () => {
        try {
          if (this.streamMessageId === undefined) {
            const message = await sendTelegramRichMessage(this.ctx, text);
            this.streamMessageId = message.message_id;
          } else {
            await editTelegramMessageRich(this.ctx, this.streamMessageId, text);
          }
          this.renderedAnswerText = text;
        } catch (error) {
          console.warn("Failed to stream Telegram group answer update:", error);
        }
      });

    await this.renderChain;
  }
}

export class NoopReplySink implements TelegramReplySink {
  async start(): Promise<void> {}
  handleProgress(_update: PiProgressUpdate): void {}
  async stop(): Promise<void> {}
  async sendFinal(_text: string): Promise<ReplyRenderResult> {
    return { mode: "plain", chunkCount: 0 };
  }
  async sendAttachments(_attachments: TelegramQueuedAttachment[]): Promise<void> {}
  async sendError(_text: string): Promise<void> {}
}

type TelegramGuestInlineResult = {
  type: "article";
  id: string;
  title: string;
  description?: string;
  input_message_content:
    | {
        rich_message: InputRichMessage;
      }
    | {
        message_text: string;
        parse_mode?: "HTML";
        link_preview_options?: { is_disabled: boolean };
      };
};

type RenderedRichMarkdown = {
  markdown: string;
  chunkCount: number;
};

type InputRichMessage = {
  markdown: string;
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
};

type TelegramMessageLike = {
  message_id: number;
};

type TelegramSentGuestMessage = {
  inline_message_id?: string;
};

type TelegramRawApi = Context["api"] & {
  answerGuestQuery?: (guestQueryId: string, result: TelegramGuestInlineResult) => Promise<TelegramSentGuestMessage>;
  raw?: {
    answerGuestQuery?: (payload: {
      guest_query_id: string;
      result: TelegramGuestInlineResult;
    }) => Promise<TelegramSentGuestMessage>;
    editMessageText?: (payload: {
      chat_id?: number | string;
      message_id?: number;
      inline_message_id?: string;
      text?: string;
      parse_mode?: "HTML";
      link_preview_options?: { is_disabled: boolean };
      rich_message?: InputRichMessage;
      business_connection_id?: string;
    }) => Promise<unknown>;
    sendRichMessage?: (payload: {
      chat_id: number | string;
      rich_message: InputRichMessage;
      business_connection_id?: string;
      disable_notification?: boolean;
      protect_content?: boolean;
      allow_paid_broadcast?: boolean;
    }) => Promise<TelegramMessageLike>;
    sendRichMessageDraft?: (payload: {
      chat_id: number;
      draft_id: number;
      rich_message: InputRichMessage;
      message_thread_id?: number;
    }) => Promise<true>;
  };
};

export class GuestInlineReplySink implements TelegramReplySink {
  private readonly api: TelegramRawApi;
  private inlineMessageId: string | undefined;
  private answerChain: Promise<void> | undefined;
  private editChain = Promise.resolve();
  private lastDeliveredText = "";
  private pendingEditText = "";
  private editTimer: ReturnType<typeof setTimeout> | undefined;
  private retryUntil = 0;
  private stopped = false;

  constructor(
    private readonly ctx: Context,
    private readonly guestQueryId: string,
    private readonly mediaPublisher?: TelegramGuestMediaPublisher,
  ) {
    this.api = ctx.api as TelegramRawApi;
  }

  async start(): Promise<void> {
    await this.answerOnce("Thinking...");
  }

  handleProgress(update: PiProgressUpdate): void {
    if (update.type !== "answer") return;
    this.pendingEditText = update.text;
    this.scheduleEdit();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearEditTimer();
    await this.answerChain?.catch(() => undefined);
    await this.editChain.catch(() => undefined);
  }

  async sendFinal(text: string): Promise<ReplyRenderResult> {
    return this.deliver(text);
  }

  async sendAttachments(attachments: TelegramQueuedAttachment[]): Promise<void> {
    if (attachments.length === 0) return;

    if (
      !this.mediaPublisher?.enabled
      || attachments.length > GUEST_RICH_MEDIA_LIMIT
      || attachments.some((attachment) => !isTelegramGuestRichMediaAttachment(attachment))
    ) {
      await this.deliver(buildGuestAttachmentUnsupportedMessage(this.lastDeliveredText, attachments));
      throw new TelegramGuestAttachmentUnsupportedError(attachments.length);
    }

    const published = await Promise.all(attachments.map((attachment) => this.mediaPublisher!.publish(attachment)));
    await this.deliver(buildGuestMediaMessage(this.lastDeliveredText, attachments, published));
  }

  async sendError(text: string): Promise<void> {
    await this.deliver(text);
  }

  private async deliver(text: string): Promise<ReplyRenderResult> {
    this.clearEditTimer();
    this.pendingEditText = "";
    await this.answerChain?.catch(() => undefined);
    if (this.inlineMessageId) {
      await this.editIfPossible(text, { force: true });
      return buildGuestReplyResult(text);
    }

    await this.answerOnce(text);
    return buildGuestReplyResult(text);
  }

  private async answerOnce(text: string): Promise<void> {
    if (this.inlineMessageId) return;
    if (this.answerChain) {
      await this.answerChain;
      return;
    }

    const rendered = buildGuestRenderedMessage(text);
    this.answerChain = this.callAnswerGuestQuery(buildGuestInlineResult(rendered))
      .catch((error) => {
        if (!isTelegramRichFallbackError(error)) {
          throw error;
        }
        console.warn("Telegram guest Rich Message answer failed, falling back to classic HTML:", error);
        return this.callAnswerGuestQuery(buildGuestClassicInlineResult(text));
      })
      .then((sent) => {
        this.inlineMessageId = sent.inline_message_id;
        this.lastDeliveredText = rendered.markdown;
      })
      .finally(() => {
        this.answerChain = undefined;
      });
    await this.answerChain;
  }

  private scheduleEdit(): void {
    if (this.stopped || this.editTimer || !this.inlineMessageId) return;

    const delay = Math.max(GUEST_STREAM_INTERVAL_MS, this.retryUntil - Date.now());
    this.editTimer = setTimeout(() => {
      this.editTimer = undefined;
      const text = this.pendingEditText;
      this.pendingEditText = "";
      if (!text) return;

      void this.editIfPossible(text).catch((error) => {
        console.warn("Failed to stream Telegram guest inline edit:", error);
      });
    }, delay);
  }

  private clearEditTimer(): void {
    if (!this.editTimer) return;
    clearTimeout(this.editTimer);
    this.editTimer = undefined;
  }

  private async editIfPossible(text: string, options: { force?: boolean } = {}): Promise<void> {
    await this.answerChain?.catch(() => undefined);
    const inlineMessageId = this.inlineMessageId;
    if (!inlineMessageId) return;

    const rendered = buildGuestRenderedMessage(text);
    if (!rendered.markdown || rendered.markdown === this.lastDeliveredText) return;

    const waitMs = this.retryUntil - Date.now();
    if (waitMs > 0) {
      if (!options.force) {
        this.pendingEditText = text;
        this.scheduleEdit();
        return;
      }
      await delay(waitMs);
    }

    this.editChain = this.editChain
      .catch(() => undefined)
      .then(async () => {
        let waitedForRateLimit = false;

        while (true) {
          try {
            await editTelegramInlineRichMessage(this.ctx, inlineMessageId, rendered.markdown);
            this.lastDeliveredText = rendered.markdown;
            return;
          } catch (error) {
            const retryAfter = getTelegramRetryAfterMs(error);
            if (retryAfter !== undefined) {
              this.retryUntil = Date.now() + retryAfter;
              this.pendingEditText = text;
              console.warn(`Telegram guest inline edit rate-limited; retrying after ${Math.ceil(retryAfter / 1000)}s.`);

              if (options.force && !waitedForRateLimit) {
                waitedForRateLimit = true;
                await delay(retryAfter);
                continue;
              }

              this.scheduleEdit();
              return;
            }

            if (isTelegramRichFallbackError(error)) {
              const fallback = buildGuestClassicMessage(text);
              await this.api.editMessageTextInline(inlineMessageId, fallback.text, {
                ...(fallback.parseMode ? { parse_mode: fallback.parseMode } : {}),
                link_preview_options: { is_disabled: true },
              });
              this.lastDeliveredText = fallback.text;
              return;
            }

            throw error;
          }
        }
      });
    await this.editChain;
  }

  private async callAnswerGuestQuery(result: TelegramGuestInlineResult): Promise<TelegramSentGuestMessage> {
    if (this.api.answerGuestQuery) {
      return this.api.answerGuestQuery(this.guestQueryId, result);
    }

    if (this.api.raw?.answerGuestQuery) {
      return this.api.raw.answerGuestQuery({
        guest_query_id: this.guestQueryId,
        result,
      });
    }

    throw new Error("Telegram API client does not support answerGuestQuery.");
  }
}

class PrivateDraftReplySink implements TelegramReplySink {
  private latestDraftText = "";
  private sentDraftText = "";
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private draftChain = Promise.resolve();
  private stopTyping: (() => void) | undefined;
  private stopped = false;

  constructor(
    private readonly ctx: Context,
    private readonly chatId: number,
    private readonly draftId: number,
    private readonly appConfig: AppConfig,
  ) {}

  async start(): Promise<void> {
    this.stopTyping = startTypingLoop(this.ctx, this.appConfig);
  }

  handleProgress(update: PiProgressUpdate): void {
    if (this.stopped || update.type !== "answer") return;
    this.latestDraftText = clipRichMarkdownText(update.text);
    this.scheduleDraft();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopTyping?.();
    this.stopTyping = undefined;
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = undefined;
    }
    await this.draftChain.catch(() => undefined);
  }

  async sendFinal(text: string): Promise<ReplyRenderResult> {
    return replyRichMarkdownResponse(this.ctx, text);
  }

  async sendAttachments(attachments: TelegramQueuedAttachment[]): Promise<void> {
    await sendQueuedTelegramAttachments(this.ctx, attachments);
  }

  async sendError(text: string): Promise<void> {
    await sendPlainTelegramMessage(this.ctx, text);
  }

  private scheduleDraft(): void {
    if (this.draftTimer || this.latestDraftText === this.sentDraftText) return;

    this.draftTimer = setTimeout(() => {
      this.draftTimer = undefined;
      void this.sendDraftNow();
    }, this.appConfig.telegramDraftIntervalMs);
  }

  private async sendDraftNow(): Promise<void> {
    const text = this.latestDraftText;
    if (!text || text === this.sentDraftText) return;

    this.sentDraftText = text;
    this.draftChain = this.draftChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await sendTelegramRichMessageDraft(this.ctx, this.chatId, this.draftId, text);
        } catch (error) {
          if (!isTelegramRichFallbackError(error)) {
            console.warn("Failed to send Telegram rich draft update:", error);
            return;
          }

          try {
            await this.ctx.api.sendMessageDraft(this.chatId, this.draftId, clipClassicText(text));
          } catch (fallbackError) {
            console.warn("Failed to send Telegram draft update:", fallbackError);
          }
        }
      });

    await this.draftChain;
  }
}

class LiveTelegramProgressMessage {
  private progressMessageId: number | undefined;
  private thinkingText = "";
  private latestStatus = "Thinking...";
  private lastRenderedMarkdown = "";
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private renderChain = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly ctx: Context,
    private readonly options: TelegramSendOptions = {},
  ) {}

  get messageId(): number | undefined {
    return this.progressMessageId;
  }

  async start(): Promise<void> {
    await this.renderNow();
  }

  handle(update: PiProgressUpdate): void {
    if (this.stopped || update.type === "answer") return;

    if (update.type === "thinking") {
      this.thinkingText = trimProgressThinking(update.text);
    } else if (update.type === "tool_start") {
      this.latestStatus = describeToolProgress(update.toolName, update.args);
    } else if (update.type === "tool_end" && update.isError) {
      this.latestStatus = `${describeToolLabel(update.toolName)} failed, trying to recover...`;
    } else if (update.type === "retry") {
      this.latestStatus = `Retrying (${update.attempt}/${update.maxAttempts})... ${update.errorMessage}`;
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
    const markdown = buildLiveProgressMarkdown(this.latestStatus, this.thinkingText);
    if (markdown === this.lastRenderedMarkdown) {
      return;
    }

    this.lastRenderedMarkdown = markdown;
    this.renderChain = this.renderChain
      .catch(() => undefined)
      .then(async () => {
        try {
          if (this.progressMessageId === undefined) {
            const message = await sendTelegramRichMessage(this.ctx, markdown, this.options);
            this.progressMessageId = message.message_id;
            return;
          }

          await editTelegramMessageRich(this.ctx, this.progressMessageId, markdown, this.options);
        } catch (error) {
          console.warn("Failed to render live Telegram progress message:", error);
        }
      });

    await this.renderChain;
  }
}

export function formatPiError(error: unknown): string {
  if (error instanceof Error) {
    return `Pi failed: ${error.message}`;
  }

  return "Pi failed with an unknown error.";
}

function startTypingLoop(
  ctx: Context,
  appConfig: AppConfig,
  options: TelegramSendOptions = {},
): () => void {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    return () => {};
  }

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const sendTyping = () => {
    if (stopped) return;

    void ctx.api.sendChatAction(chatId, "typing", toTelegramMethodOptions(options)).catch((error) => {
      console.warn("Failed to send Telegram typing action:", error);
    });
  };

  sendTyping();
  timer = setInterval(sendTyping, appConfig.telegramTypingIntervalMs);

  return () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
    }
  };
}

function buildDraftId(updateId: number): number {
  const normalized = Math.abs(updateId) % 2_147_483_647;
  return normalized === 0 ? 1 : normalized;
}

function clipRichMarkdownText(text: string, maxLength = RICH_MARKDOWN_LIMIT): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxLength) return trimmed;
  return `...\n${trimmed.slice(-(maxLength - 4))}`;
}

function clipClassicText(text: string, maxLength = CLASSIC_TEXT_LIMIT): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxLength) return trimmed;
  return `...\n${trimmed.slice(-(maxLength - 4))}`;
}

function buildGuestInlineResult(message: RenderedRichMarkdown): TelegramGuestInlineResult {
  return {
    type: "article",
    id: "operator-response",
    title: "Operator",
    description: buildRichDescription(message.markdown),
    input_message_content: {
      rich_message: { markdown: message.markdown },
    },
  };
}

function buildGuestClassicInlineResult(text: string): TelegramGuestInlineResult {
  const fallback = buildGuestClassicMessage(text);
  return {
    type: "article",
    id: "operator-response",
    title: "Operator",
    description: buildRichDescription(fallback.text),
    input_message_content: {
      message_text: fallback.text,
      ...(fallback.parseMode ? { parse_mode: fallback.parseMode } : {}),
      link_preview_options: { is_disabled: true },
    },
  };
}

function buildGuestClassicMessage(text: string): { text: string; parseMode?: "HTML" } {
  try {
    const chunks = renderTelegramMessageChunks(buildGuestPlainMessageText(text), CLASSIC_HTML_LIMIT);
    if (chunks.length > 0) {
      return {
        text: chunks[0]!,
        parseMode: "HTML",
      };
    }
  } catch (error) {
    console.warn("Telegram guest classic HTML rendering failed, falling back to plain text:", error);
  }

  return { text: buildGuestPlainMessageText(text) };
}

function buildGuestRenderedMessage(text: string): RenderedRichMarkdown {
  return buildRichMarkdown(text, { truncate: true });
}

function buildGuestReplyResult(text: string): ReplyRenderResult {
  const rendered = buildRichMarkdown(text, { truncate: true });
  return {
    mode: "rich",
    chunkCount: rendered.chunkCount,
  };
}

function buildGuestPlainMessageText(text: string): string {
  const chunks = chunkText(text.trim() || "Done.", CLASSIC_TEXT_LIMIT);
  if (chunks.length <= 1) return chunks[0] ?? "Done.";
  return `${chunks[0]}\n\n[Response truncated for Telegram guest mode.]`;
}

function buildGuestAttachmentUnsupportedMessage(
  deliveredText: string,
  attachments: TelegramQueuedAttachment[],
): string {
  const baseText = deliveredText.trim() || "Done.";
  const preview = attachments
    .slice(0, 5)
    .map((attachment) => `- ${attachment.fileName} (${attachment.kind})`)
    .join("\n");
  const remaining = attachments.length > 5 ? `\n- ...and ${attachments.length - 5} more` : "";

  return [
    baseText,
    "",
    "---",
    "",
    "**Media not delivered in guest mode.**",
    "Telegram guest replies cannot upload local files. Use a DM or add the bot to this chat to receive generated media.",
    "",
    preview + remaining,
  ].join("\n");
}

function buildGuestMediaMessage(
  deliveredText: string,
  attachments: TelegramQueuedAttachment[],
  published: PublishedTelegramGuestMedia[],
): string {
  const mediaMarkdown = attachments
    .map((attachment, index) => {
      const caption = escapeGuestMediaCaption(attachment.caption || attachment.fileName);
      return `![](${published[index]!.url} "${caption}")`;
    })
    .join("\n\n");
  const separator = "\n\n";
  const baseText = deliveredText.trim() || "Done.";
  const availableBaseLength = RICH_MARKDOWN_LIMIT - separator.length - mediaMarkdown.length;

  if (availableBaseLength <= 0) {
    throw new Error("Telegram guest media URLs exceed the Rich Message size limit.");
  }
  if (baseText.length <= availableBaseLength) {
    return `${baseText}${separator}${mediaMarkdown}`;
  }

  const suffix = "\n\n_Response truncated for Telegram guest media._";
  const baseLimit = Math.max(1, availableBaseLength - suffix.length);
  const clippedBase = chunkText(baseText, baseLimit)[0] ?? "Done.";
  return `${clippedBase}${suffix}${separator}${mediaMarkdown}`;
}

function escapeGuestMediaCaption(caption: string): string {
  return caption
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\s+/g, " ")
    .trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTelegramRetryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof GrammyError)) return undefined;
  const typedError = error as GrammyError & {
    parameters?: { retry_after?: unknown };
    error?: { parameters?: { retry_after?: unknown } };
  };
  const retryAfter = typedError.parameters?.retry_after ?? typedError.error?.parameters?.retry_after;
  return typeof retryAfter === "number" && Number.isFinite(retryAfter)
    ? Math.max(0, retryAfter * 1000)
    : undefined;
}

async function sendPlainTelegramMessage(
  ctx: Context,
  text: string,
  options: TelegramSendOptions = {},
): Promise<void> {
  for (const chunk of chunkText(text, CLASSIC_TEXT_LIMIT)) {
    await ctx.reply(chunk, {
      link_preview_options: { is_disabled: true },
      ...toTelegramMethodOptions(options),
    });
  }
}

async function replyRichMarkdownResponse(
  ctx: Context,
  text: string,
  options: {
    replaceMessageId?: number;
    businessConnectionId?: string;
  } = {},
): Promise<ReplyRenderResult> {
  const chunks = buildRichMarkdownChunks(text);

  try {
    if (chunks.length === 0) {
      throw new Error("Rendered Telegram rich message was empty.");
    }

    if (options.replaceMessageId !== undefined) {
      await editTelegramMessageRich(ctx, options.replaceMessageId, chunks[0]!, {
        businessConnectionId: options.businessConnectionId,
      });
      for (const chunk of chunks.slice(1)) {
        await sendTelegramRichMessage(ctx, chunk, {
          businessConnectionId: options.businessConnectionId,
        });
      }
    } else {
      for (const chunk of chunks) {
        await sendTelegramRichMessage(ctx, chunk, {
          businessConnectionId: options.businessConnectionId,
        });
      }
    }

    return { mode: "rich", chunkCount: chunks.length };
  } catch (error) {
    if (!isTelegramRichFallbackError(error)) {
      throw error;
    }

    console.warn("Telegram Rich Message delivery failed, falling back to classic HTML:", error);
    return replyClassicRenderedResponse(ctx, text, options);
  }
}

async function sendTelegramRichMessage(
  ctx: Context,
  markdown: string,
  options: TelegramSendOptions = {},
): Promise<TelegramMessageLike> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    throw new Error("Cannot send Telegram rich message without a chat id.");
  }

  const raw = (ctx.api as TelegramRawApi).raw;
  if (!raw?.sendRichMessage) {
    throw new Error("Telegram API client does not support sendRichMessage.");
  }

  return raw.sendRichMessage({
    chat_id: chatId,
    rich_message: { markdown },
    ...toTelegramMethodOptions(options),
  });
}

async function editTelegramMessageRich(
  ctx: Context,
  messageId: number,
  markdown: string,
  options: TelegramSendOptions = {},
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    throw new Error("Cannot edit Telegram rich message without a chat id.");
  }

  const raw = (ctx.api as TelegramRawApi).raw;
  if (!raw?.editMessageText) {
    throw new Error("Telegram API client does not support editMessageText.rich_message.");
  }

  await raw.editMessageText({
    chat_id: chatId,
    message_id: messageId,
    rich_message: { markdown },
    ...toTelegramMethodOptions(options),
  });
}

async function editTelegramInlineRichMessage(ctx: Context, inlineMessageId: string, markdown: string): Promise<void> {
  const raw = (ctx.api as TelegramRawApi).raw;
  if (!raw?.editMessageText) {
    throw new Error("Telegram API client does not support editMessageText.rich_message.");
  }

  await raw.editMessageText({
    inline_message_id: inlineMessageId,
    rich_message: { markdown },
  });
}

async function sendTelegramRichMessageDraft(
  ctx: Context,
  chatId: number,
  draftId: number,
  markdown: string,
): Promise<void> {
  const raw = (ctx.api as TelegramRawApi).raw;
  if (!raw?.sendRichMessageDraft) {
    throw new Error("Telegram API client does not support sendRichMessageDraft.");
  }

  await raw.sendRichMessageDraft({
    chat_id: chatId,
    draft_id: draftId,
    rich_message: { markdown },
  });
}

function buildRichMarkdownChunks(text: string): string[] {
  return chunkText(text.trim() || "Done.", RICH_MARKDOWN_LIMIT);
}

function buildRichMarkdown(text: string, options: { truncate?: boolean } = {}): RenderedRichMarkdown {
  const source = text.trim() || "Done.";
  const chunks = chunkText(source, RICH_MARKDOWN_LIMIT);

  if (!options.truncate || chunks.length <= 1) {
    return {
      markdown: chunks[0] ?? "Done.",
      chunkCount: chunks.length,
    };
  }

  const suffix = "\n\n_Response truncated for Telegram guest mode._";
  const truncatedChunks = chunkText(source, RICH_MARKDOWN_LIMIT - suffix.length);
  return {
    markdown: `${truncatedChunks[0] ?? "Done."}${suffix}`,
    chunkCount: chunks.length,
  };
}

function buildRichDescription(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~|#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function replyClassicRenderedResponse(
  ctx: Context,
  text: string,
  options: {
    replaceMessageId?: number;
    businessConnectionId?: string;
  } = {},
): Promise<ReplyRenderResult> {
  try {
    const htmlChunks = renderTelegramMessageChunks(text, CLASSIC_HTML_LIMIT);
    if (htmlChunks.length === 0) {
      throw new Error("Rendered Telegram HTML was empty.");
    }

    if (options.replaceMessageId !== undefined) {
      await replaceTelegramMessage(ctx, options.replaceMessageId, htmlChunks[0]!, {
        parse_mode: "HTML",
        businessConnectionId: options.businessConnectionId,
      });
      for (const chunk of htmlChunks.slice(1)) {
        await ctx.reply(chunk, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...toTelegramMethodOptions(options),
        });
      }
    } else {
      for (const chunk of htmlChunks) {
        await ctx.reply(chunk, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...toTelegramMethodOptions(options),
        });
      }
    }

    return { mode: "html", chunkCount: htmlChunks.length };
  } catch (error) {
    if (getTelegramRetryAfterMs(error) !== undefined) {
      throw error;
    }
    if (error instanceof GrammyError && !isTelegramParseError(error)) {
      throw error;
    }
    if (!(error instanceof Error) && !isTelegramParseError(error)) {
      throw error;
    }

    console.warn("Telegram HTML rendering failed, falling back to plain text:", error);

    const plainChunks = chunkText(text, CLASSIC_TEXT_LIMIT);
    if (plainChunks.length === 0) {
      throw new Error("Plain text reply was empty.");
    }

    if (options.replaceMessageId !== undefined) {
      await replaceTelegramMessage(ctx, options.replaceMessageId, plainChunks[0]!, {
        businessConnectionId: options.businessConnectionId,
      });
      for (const chunk of plainChunks.slice(1)) {
        await ctx.reply(chunk, {
          link_preview_options: { is_disabled: true },
          ...toTelegramMethodOptions(options),
        });
      }
    } else {
      for (const chunk of plainChunks) {
        await ctx.reply(chunk, {
          link_preview_options: { is_disabled: true },
          ...toTelegramMethodOptions(options),
        });
      }
    }

    return { mode: "plain", chunkCount: plainChunks.length };
  }
}

function buildLiveProgressMarkdown(status: string, thinkingText: string): string {
  const body = thinkingText.trim().length > 0 ? `${status}\n\n${thinkingText}` : status;
  return body
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

async function replaceTelegramMessage(
  ctx: Context,
  messageId: number,
  text: string,
  options: {
    parse_mode?: "HTML";
    businessConnectionId?: string;
  } = {},
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    throw new Error("Cannot replace Telegram message without a chat id.");
  }

  await ctx.api.editMessageText(chatId, messageId, text, {
    ...(options.parse_mode ? { parse_mode: options.parse_mode } : {}),
    link_preview_options: { is_disabled: true },
    ...toTelegramMethodOptions(options),
  });
}

function describeToolProgress(toolName: string, args: unknown): string {
  if (/datadog/i.test(toolName)) {
    return "Querying Datadog logs...";
  }
  if (/postgres|sql|database/i.test(toolName)) {
    return "Querying Postgres...";
  }
  if (toolName === "bash") {
    return "Running shell investigation...";
  }
  if (toolName === "read") {
    return "Reading files and docs...";
  }
  if (toolName === "write" || toolName === "edit") {
    return "Preparing an update...";
  }
  if (toolName === "mcp") {
    return "Checking MCP tools...";
  }

  if (args && typeof args === "object" && "path" in args && typeof args.path === "string") {
    return `${describeToolLabel(toolName)} ${args.path}...`;
  }

  return `${describeToolLabel(toolName)}...`;
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

  return `...\n${normalized.slice(-maxLength)}`;
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

function isTelegramRichFallbackError(error: unknown): boolean {
  if (getTelegramRetryAfterMs(error) !== undefined) return false;

  if (error instanceof GrammyError) {
    const errorCode = (error as GrammyError & { error_code?: unknown }).error_code;
    return errorCode === 400 || /rich|parse|can't parse|message text is empty/i.test(error.description);
  }

  return error instanceof Error && /does not support .*rich|sendRichMessage|rich_message/i.test(error.message);
}
