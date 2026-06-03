import { randomUUID } from "node:crypto";
import type { OperatorStore } from "./operator/store";
import type { OperatorStateDb } from "./state/operator-db";
import type { AuditLogEntry, SessionMessage } from "./types";

export class AuditLogger {
  private queue = Promise.resolve();

  constructor(
    private readonly stateDb: OperatorStateDb,
    private readonly operatorStore?: OperatorStore,
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
      this.stateDb.insertAuditEvent({
        id: normalizedEntry.id,
        createdAt: Date.parse(normalizedEntry.timestamp),
        event: normalizedEntry.event,
        runId: normalizedEntry.runId,
        sessionKey: normalizedEntry.sessionKey,
        chatId: normalizedEntry.chatId,
        userId: normalizedEntry.userId,
        messageId: normalizedEntry.messageId,
        surface: normalizedEntry.surface,
        payloadJson: JSON.stringify(normalizedEntry),
      });
      await this.operatorStore?.insertAuditEvent({
        id: normalizedEntry.id,
        createdAt: new Date(normalizedEntry.timestamp),
        event: normalizedEntry.event,
        runId: normalizedEntry.runId,
        sessionKey: normalizedEntry.sessionKey,
        chatId: normalizedEntry.chatId,
        userId: normalizedEntry.userId,
        messageId: normalizedEntry.messageId,
        surface: normalizedEntry.surface,
        payload: normalizedEntry as unknown as Record<string, unknown>,
      });
    });

    this.queue = writeOperation.catch((error) => {
      console.error("Failed to write audit log:", error);
    });

    return writeOperation;
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
