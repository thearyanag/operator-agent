import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { OperatorStateDb } from "../src/state/operator-db";
import type { AuditLogEntry } from "../src/types";

const legacyAuditLogPath = Bun.argv[2] || Bun.env.AUDIT_LOG_PATH || join(process.cwd(), "logs", "audit-log.json");
const operatorStateDbPath =
  Bun.argv[3] || Bun.env.OPERATOR_STATE_DB_PATH || join(process.cwd(), ".operator", "state", "operator.sqlite");

const file = Bun.file(legacyAuditLogPath);
if (!(await file.exists())) {
  console.log(`Legacy audit log not found: ${legacyAuditLogPath}`);
  process.exit(0);
}

const parsed = JSON.parse(await file.text()) as unknown;
if (!Array.isArray(parsed)) {
  throw new Error(`Legacy audit log must contain an array: ${legacyAuditLogPath}`);
}

const stateDb = new OperatorStateDb(operatorStateDbPath);
let imported = 0;

try {
  for (const value of parsed) {
    const entry = normalizeLegacyAuditEntry(value);
    if (!entry) continue;

    stateDb.insertAuditEvent({
      id: entry.id,
      createdAt: Date.parse(entry.timestamp),
      event: entry.event,
      runId: entry.runId,
      sessionKey: entry.sessionKey,
      chatId: entry.chatId,
      userId: entry.userId,
      messageId: entry.messageId,
      surface: entry.surface,
      payloadJson: JSON.stringify(entry),
    });
    imported += 1;
  }
} finally {
  stateDb.close();
}

console.log(`Imported ${imported} audit events into ${operatorStateDbPath}`);

function normalizeLegacyAuditEntry(value: unknown): AuditLogEntry | undefined {
  if (!isRecord(value) || typeof value.event !== "string" || !value.event.trim()) {
    return undefined;
  }

  const timestamp = typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp))
    ? value.timestamp
    : new Date().toISOString();

  return {
    ...value,
    id: typeof value.id === "string" && value.id.trim() ? value.id : randomUUID(),
    timestamp,
    event: value.event.trim(),
  } as AuditLogEntry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
