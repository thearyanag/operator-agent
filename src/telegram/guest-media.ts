import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { TelegramQueuedAttachment } from "../types";
import {
  resolveAndValidateTelegramAttachmentPath,
  sanitizeTelegramAttachmentFileName,
  type AttachmentValidationOptions,
} from "./attachments";

export const TELEGRAM_GUEST_MEDIA_TTL_MS = 10 * 60 * 1_000;
export const TELEGRAM_GUEST_MEDIA_PATH_PREFIX = "/guest-media/";

const GUEST_RICH_MEDIA_KINDS = new Set<TelegramQueuedAttachment["kind"]>([
  "photo",
  "video",
  "animation",
  "audio",
  "voice",
  "video_note",
]);

export type PublishedTelegramGuestMedia = {
  url: string;
  expiresAt: number;
};

export interface TelegramGuestMediaPublisher {
  readonly enabled: boolean;
  publish(attachment: TelegramQueuedAttachment): Promise<PublishedTelegramGuestMedia>;
}

export type TelegramGuestMediaStoreOptions = {
  publicUrl?: string;
  spoolDir: string;
  attachmentValidation: AttachmentValidationOptions;
  ttlMs?: number;
};

export class TelegramGuestMediaStore implements TelegramGuestMediaPublisher {
  readonly enabled: boolean;
  private readonly spoolDir: string;
  private readonly ttlMs: number;

  constructor(private readonly options: TelegramGuestMediaStoreOptions) {
    this.enabled = Boolean(options.publicUrl);
    this.spoolDir = resolve(options.spoolDir);
    this.ttlMs = options.ttlMs ?? TELEGRAM_GUEST_MEDIA_TTL_MS;
  }

  async publish(attachment: TelegramQueuedAttachment): Promise<PublishedTelegramGuestMedia> {
    if (!this.options.publicUrl) {
      throw new Error("OPERATOR_PUBLIC_URL is required to send inline media in Telegram guest mode.");
    }
    if (!isTelegramGuestRichMediaAttachment(attachment)) {
      throw new Error(`Telegram Rich Markdown does not support queued ${attachment.kind} attachments.`);
    }

    const sourcePath = await resolveAndValidateTelegramAttachmentPath(
      attachment.path,
      this.options.attachmentValidation,
    );
    const fileName = sanitizeGuestMediaFileName(attachment.fileName);
    const expiresAt = Date.now() + this.ttlMs;
    const token = buildGuestMediaToken(expiresAt);
    const mediaDir = resolve(this.spoolDir, token);
    const mediaPath = resolve(mediaDir, fileName);

    await mkdir(mediaDir, { recursive: true });
    await copyFile(sourcePath, mediaPath);
    this.scheduleDeletion(mediaDir, this.ttlMs);

    return {
      url: `${this.options.publicUrl}${TELEGRAM_GUEST_MEDIA_PATH_PREFIX}${token}/${encodeURIComponent(fileName)}`,
      expiresAt,
    };
  }

  async handleRequest(request: Request, now = Date.now()): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(TELEGRAM_GUEST_MEDIA_PATH_PREFIX)) {
      return undefined;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\n", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    const route = parseGuestMediaRoute(url.pathname);
    if (!route || route.expiresAt <= now) {
      if (route) {
        await rm(resolve(this.spoolDir, route.token), { recursive: true, force: true }).catch(() => undefined);
      }
      return notFoundResponse();
    }

    const mediaDir = resolve(this.spoolDir, route.token);
    const mediaPath = resolve(mediaDir, route.fileName);
    if (!isPathWithinRoot(mediaPath, mediaDir)) {
      return notFoundResponse();
    }

    let fileStat;
    try {
      fileStat = await stat(mediaPath);
    } catch {
      return notFoundResponse();
    }
    if (!fileStat.isFile()) {
      return notFoundResponse();
    }

    const range = parseByteRange(request.headers.get("range"), fileStat.size);
    if (range === "invalid") {
      return new Response(null, {
        status: 416,
        headers: {
          "accept-ranges": "bytes",
          "content-range": `bytes */${fileStat.size}`,
        },
      });
    }

    const file = Bun.file(mediaPath);
    const headers = new Headers({
      "accept-ranges": "bytes",
      "cache-control": `private, max-age=${Math.floor(this.ttlMs / 1_000)}`,
      "content-disposition": buildInlineContentDisposition(route.fileName),
      "content-type": file.type || "application/octet-stream",
      "x-content-type-options": "nosniff",
    });

    if (range) {
      const contentLength = range.end - range.start + 1;
      headers.set("content-length", String(contentLength));
      headers.set("content-range", `bytes ${range.start}-${range.end}/${fileStat.size}`);
      return new Response(request.method === "HEAD" ? null : file.slice(range.start, range.end + 1), {
        status: 206,
        headers,
      });
    }

    headers.set("content-length", String(fileStat.size));
    return new Response(request.method === "HEAD" ? null : file, { headers });
  }

  async pruneExpired(now = Date.now()): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.spoolDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const expiresAt = parseGuestMediaToken(entry.name);
          if (expiresAt === undefined) return;
          const mediaDir = resolve(this.spoolDir, entry.name);
          if (expiresAt > now) {
            this.scheduleDeletion(mediaDir, expiresAt - now);
            return;
          }
          await rm(mediaDir, { recursive: true, force: true });
        }),
    );
  }

  private scheduleDeletion(mediaDir: string, delayMs: number): void {
    const timer = setTimeout(() => {
      void rm(mediaDir, { recursive: true, force: true }).catch((error) => {
        console.warn(`Failed to delete expired Telegram guest media: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, delayMs);
    timer.unref?.();
  }
}

export function isTelegramGuestRichMediaAttachment(attachment: TelegramQueuedAttachment): boolean {
  return GUEST_RICH_MEDIA_KINDS.has(attachment.kind);
}

function sanitizeGuestMediaFileName(fileName: string): string {
  const sanitized = sanitizeTelegramAttachmentFileName(fileName)
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .slice(0, 180);
  return sanitized === "." || sanitized === ".." ? "attachment" : sanitized;
}

function buildGuestMediaToken(expiresAt: number): string {
  return `${expiresAt.toString(36)}-${randomBytes(18).toString("base64url")}`;
}

function parseGuestMediaRoute(pathname: string): { token: string; fileName: string; expiresAt: number } | undefined {
  const suffix = pathname.slice(TELEGRAM_GUEST_MEDIA_PATH_PREFIX.length);
  const segments = suffix.split("/");
  if (segments.length !== 2 || !segments[0] || !segments[1]) return undefined;

  let fileName: string;
  try {
    fileName = decodeURIComponent(segments[1]);
  } catch {
    return undefined;
  }
  if (fileName !== sanitizeGuestMediaFileName(fileName)) return undefined;

  const expiresAt = parseGuestMediaToken(segments[0]);
  if (expiresAt === undefined) return undefined;

  return { token: segments[0], fileName, expiresAt };
}

function parseGuestMediaToken(token: string): number | undefined {
  const match = token.match(/^([a-z0-9]+)-([A-Za-z0-9_-]{24})$/);
  if (!match) return undefined;
  const expiresAt = Number.parseInt(match[1]!, 36);
  return Number.isSafeInteger(expiresAt) && expiresAt > 0 ? expiresAt : undefined;
}

function isPathWithinRoot(filePath: string, root: string): boolean {
  return filePath === root || filePath.startsWith(`${root}/`);
}

function parseByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "invalid" | undefined {
  if (!header) return undefined;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size <= 0) return "invalid";

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || start >= size
    || requestedEnd < start
  ) {
    return "invalid";
  }

  return { start, end: Math.min(requestedEnd, size - 1) };
}

function buildInlineContentDisposition(fileName: string): string {
  const asciiName = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function notFoundResponse(): Response {
  return new Response("not found\n", { status: 404 });
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
