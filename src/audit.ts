import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditLogEntry, SessionMessage } from "./types";

export class AuditLogger {
  private queue = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxBytes: number,
  ) {}

  log(entry: Omit<AuditLogEntry, "id" | "timestamp">): Promise<void> {
    const normalizedEntry: AuditLogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
      text: truncateAuditText(entry.text),
      prompt: truncateAuditText(entry.prompt),
      response: truncateAuditText(entry.response),
      error: truncateAuditText(entry.error, 20_000),
      rawNewMessages: truncateAuditText(entry.rawNewMessages),
      rawRecentMessages: truncateAuditText(entry.rawRecentMessages),
    };

    const writeOperation = this.queue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });

      const entries = await this.readEntries();
      entries.push(normalizedEntry);

      let serialized = JSON.stringify(entries, null, 2) + "\n";
      while (Buffer.byteLength(serialized, "utf8") > this.maxBytes && entries.length > 1) {
        entries.shift();
        serialized = JSON.stringify(entries, null, 2) + "\n";
      }

      await writeFile(this.filePath, serialized, "utf8");
    });

    this.queue = writeOperation.catch((error) => {
      console.error("Failed to write audit log:", error);
    });

    return writeOperation;
  }

  private async readEntries(): Promise<AuditLogEntry[]> {
    try {
      const content = await readFile(this.filePath, "utf8");
      if (!content.trim()) {
        return [];
      }

      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? (parsed as AuditLogEntry[]) : [];
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return [];
      }

      console.error("Failed to read audit log, recreating it:", error);
      return [];
    }
  }
}

export function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function serializeMessagesForAudit(messages: SessionMessage[]): string {
  try {
    return JSON.stringify(messages, null, 2);
  } catch (error) {
    return `Failed to serialize messages: ${serializeError(error)}`;
  }
}

function truncateAuditText(value: string | undefined, maxLength = 100_000): string | undefined {
  if (!value || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function isFileNotFoundError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
