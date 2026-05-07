import { realpath, stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { InputFile, type Context } from "grammy";
import type { TelegramAttachmentKind, TelegramQueuedAttachment, TelegramSendOptions } from "../types";
import { toTelegramMethodOptions } from "./api-options";

export type AttachmentValidationOptions = {
  workdir: string;
  allowedRoots: string[];
  maxDocumentBytes: number;
};

export async function resolveAndValidateTelegramAttachmentPath(
  filePath: string,
  options: AttachmentValidationOptions,
): Promise<string> {
  const absolutePath = filePath.startsWith("/") ? filePath : resolve(options.workdir, filePath);
  let canonicalPath: string;

  try {
    canonicalPath = await realpath(absolutePath);
  } catch {
    throw new Error(`Attachment file not found: ${filePath}`);
  }

  const fileStat = await stat(canonicalPath);
  if (!fileStat.isFile()) {
    throw new Error(`Attachment path is not a file: ${filePath}`);
  }

  if (fileStat.size > options.maxDocumentBytes) {
    throw new Error(
      `Attachment exceeds Telegram document size limit (${Math.round(options.maxDocumentBytes / 1024 / 1024)} MB): ${filePath}`,
    );
  }

  const isAllowed = options.allowedRoots.some((root) => isPathWithinRoot(canonicalPath, root));
  if (!isAllowed) {
    throw new Error(
      `Attachment path must stay inside an allowed root (${options.allowedRoots.join(", ")}): ${filePath}`,
    );
  }

  return canonicalPath;
}

export function sanitizeTelegramAttachmentFileName(fileName: string): string {
  return fileName.replace(/[\\/]+/g, "_").trim() || "attachment";
}

export function resolveTelegramAttachmentKind(
  filePath: string,
  requestedKind: TelegramAttachmentKind,
): Exclude<TelegramAttachmentKind, "auto"> {
  if (requestedKind !== "auto") {
    return requestedKind;
  }

  const lowerPath = filePath.toLowerCase();
  const lowerName = basename(lowerPath);

  if (matchesExtension(lowerPath, [".tgs"])) {
    return "sticker";
  }
  if (matchesExtension(lowerPath, [".webp", ".webm"]) && /sticker|emoji|tgsticker/.test(lowerName)) {
    return "sticker";
  }
  if (matchesExtension(lowerPath, [".mp4", ".mov", ".m4v"]) && /video[._-]?note|round[._-]?video/.test(lowerName)) {
    return "video_note";
  }
  if (matchesExtension(lowerPath, [".jpg", ".jpeg", ".png", ".webp"])) {
    return "photo";
  }
  if (matchesExtension(lowerPath, [".gif"])) {
    return "animation";
  }
  if (matchesExtension(lowerPath, [".mp4", ".mov", ".m4v", ".webm"])) {
    return "video";
  }
  if (matchesExtension(lowerPath, [".mp3", ".m4a", ".aac", ".flac", ".wav"])) {
    return "audio";
  }
  if (matchesExtension(lowerPath, [".ogg", ".oga", ".opus"])) {
    return "voice";
  }

  return "document";
}

export function normalizeTelegramAttachmentCaption(caption: string | undefined): string | undefined {
  if (!caption?.trim()) return undefined;
  return caption.trim().slice(0, 1024);
}

export async function sendQueuedTelegramAttachments(
  ctx: Context,
  attachments: TelegramQueuedAttachment[],
  options: TelegramSendOptions = {},
): Promise<void> {
  let index = 0;

  while (index < attachments.length) {
    const attachment = attachments[index]!;

    if (attachment.kind === "photo" || attachment.kind === "video") {
      const group = collectContiguousAttachments(attachments, index, new Set(["photo", "video"]));
      if (group.length > 1) {
        await sendTelegramMediaGroup(ctx, group, options);
        index += group.length;
        continue;
      }
    }

    if (attachment.kind === "document") {
      const group = collectContiguousAttachments(attachments, index, new Set(["document"]));
      if (group.length > 1) {
        await sendTelegramMediaGroup(ctx, group, options);
        index += group.length;
        continue;
      }
    }

    if (attachment.kind === "audio") {
      const group = collectContiguousAttachments(attachments, index, new Set(["audio"]));
      if (group.length > 1) {
        await sendTelegramMediaGroup(ctx, group, options);
        index += group.length;
        continue;
      }
    }

    await sendSingleTelegramAttachment(ctx, attachment, options);
    index += 1;
  }
}

function isPathWithinRoot(filePath: string, rootPath: string): boolean {
  const relativePath = relative(resolve(rootPath), filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function matchesExtension(filePath: string, extensions: string[]): boolean {
  return extensions.some((extension) => filePath.endsWith(extension));
}

function collectContiguousAttachments(
  attachments: TelegramQueuedAttachment[],
  startIndex: number,
  allowedKinds: Set<TelegramQueuedAttachment["kind"]>,
): TelegramQueuedAttachment[] {
  const group: TelegramQueuedAttachment[] = [];

  for (let index = startIndex; index < attachments.length; index += 1) {
    const attachment = attachments[index]!;
    if (!allowedKinds.has(attachment.kind)) {
      break;
    }
    group.push(attachment);
  }

  return group;
}

async function sendSingleTelegramAttachment(
  ctx: Context,
  attachment: TelegramQueuedAttachment,
  options: TelegramSendOptions = {},
): Promise<void> {
  const inputFile = new InputFile(attachment.path, attachment.fileName);
  const captionOptions = {
    ...(attachment.caption ? { caption: attachment.caption } : {}),
    ...toTelegramMethodOptions(options),
  };

  switch (attachment.kind) {
    case "photo":
      await ctx.replyWithPhoto(inputFile, captionOptions);
      break;
    case "video":
      await ctx.replyWithVideo(inputFile, captionOptions);
      break;
    case "animation":
      await ctx.replyWithAnimation(inputFile, captionOptions);
      break;
    case "audio":
      await ctx.replyWithAudio(inputFile, captionOptions);
      break;
    case "voice":
      await ctx.replyWithVoice(inputFile, captionOptions);
      break;
    case "video_note":
      await ctx.replyWithVideoNote(inputFile, toTelegramMethodOptions(options));
      break;
    case "sticker":
      await ctx.replyWithSticker(inputFile, toTelegramMethodOptions(options));
      break;
    case "document":
    default:
      await ctx.replyWithDocument(inputFile, captionOptions);
      break;
  }
}

async function sendTelegramMediaGroup(
  ctx: Context,
  attachments: TelegramQueuedAttachment[],
  options: TelegramSendOptions = {},
): Promise<void> {
  const media = attachments.map((attachment) => buildTelegramMediaGroupItem(attachment));
  await ctx.replyWithMediaGroup(media, toTelegramMethodOptions(options));
}

function buildTelegramMediaGroupItem(attachment: TelegramQueuedAttachment) {
  const media = new InputFile(attachment.path, attachment.fileName);

  switch (attachment.kind) {
    case "photo":
      return {
        type: "photo" as const,
        media,
        ...(attachment.caption ? { caption: attachment.caption } : {}),
      };
    case "video":
      return {
        type: "video" as const,
        media,
        ...(attachment.caption ? { caption: attachment.caption } : {}),
      };
    case "audio":
      return {
        type: "audio" as const,
        media,
        ...(attachment.caption ? { caption: attachment.caption } : {}),
      };
    case "document":
    default:
      return {
        type: "document" as const,
        media,
        ...(attachment.caption ? { caption: attachment.caption } : {}),
      };
  }
}
