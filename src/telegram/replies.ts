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

const GROUP_STREAM_INTERVAL_MS = 500;

export interface TelegramReplySink {
  start(): Promise<void>;
  handleProgress(update: PiProgressUpdate): void;
  stop(): Promise<void>;
  sendFinal(text: string): Promise<ReplyRenderResult>;
  sendAttachments(attachments: TelegramQueuedAttachment[]): Promise<void>;
  sendError(text: string): Promise<void>;
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
    return replyRenderedResponse(this.ctx, text, {
      replaceMessageId: this.progress.messageId,
      businessConnectionId: this.options.businessConnectionId,
    });
  }

  async sendAttachments(attachments: TelegramQueuedAttachment[]): Promise<void> {
    await sendQueuedTelegramAttachments(this.ctx, attachments, this.options);
  }

  async sendError(text: string): Promise<void> {
    if (this.progress.messageId !== undefined) {
      await replyRenderedResponse(this.ctx, text, {
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
    this.latestAnswerText = clipGroupStreamingText(update.text);
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
    return replyRenderedResponse(this.ctx, text, {
      replaceMessageId: this.streamMessageId,
    });
  }

  async sendAttachments(attachments: TelegramQueuedAttachment[]): Promise<void> {
    await sendQueuedTelegramAttachments(this.ctx, attachments);
  }

  async sendError(text: string): Promise<void> {
    if (this.streamMessageId !== undefined) {
      await replyRenderedResponse(this.ctx, text, {
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
            const message = await this.ctx.reply(text, {
              link_preview_options: { is_disabled: true },
            });
            this.streamMessageId = message.message_id;
          } else {
            const chatId = this.ctx.chat?.id;
            if (chatId === undefined) return;

            await this.ctx.api.editMessageText(chatId, this.streamMessageId, text, {
              link_preview_options: { is_disabled: true },
            });
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
    this.latestDraftText = clipTelegramDraftText(update.text);
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
    return replyRenderedResponse(this.ctx, text);
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
          await this.ctx.api.sendMessageDraft(this.chatId, this.draftId, text);
        } catch (error) {
          console.warn("Failed to send Telegram draft update:", error);
        }
      });

    await this.draftChain;
  }
}

class LiveTelegramProgressMessage {
  private progressMessageId: number | undefined;
  private thinkingText = "";
  private latestStatus = "Thinking...";
  private lastRenderedHtml = "";
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
    const html = buildLiveProgressHtml(this.latestStatus, this.thinkingText);
    if (html === this.lastRenderedHtml) {
      return;
    }

    this.lastRenderedHtml = html;
    this.renderChain = this.renderChain
      .catch(() => undefined)
      .then(async () => {
        try {
          if (this.progressMessageId === undefined) {
            const message = await this.ctx.reply(html, {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              ...toTelegramMethodOptions(this.options),
            });
            this.progressMessageId = message.message_id;
            return;
          }

          const chatId = this.ctx.chat?.id;
          if (chatId === undefined) return;

          await this.ctx.api.editMessageText(chatId, this.progressMessageId, html, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            ...toTelegramMethodOptions(this.options),
          });
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

function clipTelegramDraftText(text: string, maxLength = 4000): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxLength) return trimmed;
  return `...\n${trimmed.slice(-(maxLength - 4))}`;
}

function clipGroupStreamingText(text: string, maxLength = 3500): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxLength) return trimmed;
  return `...\n${trimmed.slice(-(maxLength - 4))}`;
}

async function sendPlainTelegramMessage(
  ctx: Context,
  text: string,
  options: TelegramSendOptions = {},
): Promise<void> {
  for (const chunk of chunkText(text, 4000)) {
    await ctx.reply(chunk, {
      link_preview_options: { is_disabled: true },
      ...toTelegramMethodOptions(options),
    });
  }
}

async function replyRenderedResponse(
  ctx: Context,
  text: string,
  options: {
    replaceMessageId?: number;
    businessConnectionId?: string;
  } = {},
): Promise<ReplyRenderResult> {
  const htmlChunks = renderTelegramMessageChunks(text, 3500);

  try {
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
    if (!isTelegramParseError(error)) {
      throw error;
    }

    console.warn("Telegram HTML rendering failed, falling back to plain text:", error);

    const plainChunks = chunkText(text, 4000);
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

function buildLiveProgressHtml(status: string, thinkingText: string): string {
  const body = thinkingText.trim().length > 0 ? `${status}\n\n${thinkingText}` : status;
  return `<blockquote expandable>${escapeTelegramHtml(body)}</blockquote>`;
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

function escapeTelegramHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
