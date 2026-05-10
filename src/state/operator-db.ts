import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AuditEventRecord = {
  id: string;
  createdAt: number;
  event: string;
  runId: string | null;
  sessionKey: string | null;
  chatId: number | null;
  userId: number | null;
  messageId: number | null;
  surface: string | null;
  payloadJson: string;
};

export type AuditEventInsert = {
  id: string;
  createdAt: number;
  event: string;
  runId?: string;
  sessionKey?: string;
  chatId?: number;
  userId?: number;
  messageId?: number;
  surface?: string;
  payloadJson: string;
};

export type TelegramSessionRecord = {
  sessionKey: string;
  surface: string;
  chatId: number;
  chatType: string | null;
  chatTitle: string | null;
  userId: number | null;
  username: string | null;
  businessConnectionId: string | null;
  createdAt: number;
  updatedAt: number;
  lastRunId: string | null;
};

export type TelegramSessionUpsert = {
  sessionKey: string;
  surface: string;
  chatId: number;
  chatType?: string;
  chatTitle?: string;
  userId?: number;
  username?: string;
  businessConnectionId?: string;
  updatedAt: number;
};

export type RunStatus = "running" | "completed" | "failed";

export type RunRecord = {
  id: string;
  sessionKey: string;
  status: RunStatus;
  prompt: string;
  response: string | null;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  attachmentCount: number;
};

export type RunStartInsert = {
  id: string;
  sessionKey: string;
  prompt: string;
  startedAt: number;
};

export type BusinessConnectionRecord = {
  id: string;
  ownerTelegramUserId: number;
  ownerPrivateChatId: number;
  isEnabled: number;
  canReply: number;
  rightsJson: string;
  updatedAt: number;
  lastCheckedAt: number | null;
};

export type BusinessConnectionUpsert = {
  id: string;
  ownerTelegramUserId: number;
  ownerPrivateChatId: number;
  isEnabled: boolean;
  canReply: boolean;
  rightsJson: string;
  updatedAt: number;
  lastCheckedAt?: number;
};

export type ArtifactStatus = "queued" | "sent" | "failed" | "suppressed";

export type ArtifactRecord = {
  id: string;
  runId: string;
  caseId: string | null;
  path: string;
  fileName: string;
  kind: string;
  status: ArtifactStatus;
  sizeBytes: number | null;
  sha256: string | null;
  createdAt: number;
  sentAt: number | null;
  error: string | null;
};

export type ArtifactInsert = {
  id: string;
  runId: string;
  caseId?: string;
  path: string;
  fileName: string;
  kind: string;
  status: ArtifactStatus;
  sizeBytes?: number;
  sha256?: string;
  createdAt: number;
};

export type ActiveInvestigationRecord = {
  sessionKey: string;
  subject: string;
  caseId: string | null;
  updatedAt: number;
};

export type CaseRecord = {
  id: string;
  subject: string;
  sessionKey: string;
  status: string;
  summary: string | null;
  createdAt: number;
  updatedAt: number;
};

export type CaseInsert = {
  id: string;
  subject: string;
  sessionKey: string;
  status: string;
  summary?: string;
  createdAt: number;
  updatedAt: number;
};

export type CaseEventInsert = {
  id: string;
  caseId: string;
  runId?: string;
  kind: string;
  text: string;
  metadataJson: string;
  createdAt: number;
};

export type EvidenceItemInsert = {
  id: string;
  caseId?: string;
  runId: string;
  source: string;
  queryHash?: string;
  querySummary: string;
  resultSummary?: string;
  externalRef?: string;
  payloadJson?: string;
  createdAt: number;
};

export class OperatorStateDb {
  private readonly db: Database;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.applySchema();
  }

  insertAuditEvent(event: AuditEventInsert): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO audit_events (
          id,
          created_at,
          event,
          run_id,
          session_key,
          chat_id,
          user_id,
          message_id,
          surface,
          payload_json
        ) VALUES (
          $id,
          $createdAt,
          $event,
          $runId,
          $sessionKey,
          $chatId,
          $userId,
          $messageId,
          $surface,
          $payloadJson
        )`,
      )
      .run({
        $id: event.id,
        $createdAt: event.createdAt,
        $event: event.event,
        $runId: event.runId ?? null,
        $sessionKey: event.sessionKey ?? null,
        $chatId: event.chatId ?? null,
        $userId: event.userId ?? null,
        $messageId: event.messageId ?? null,
        $surface: event.surface ?? null,
        $payloadJson: event.payloadJson,
      });
  }

  listAuditEvents(limit = 100): AuditEventRecord[] {
    return this.db
      .query(
        `SELECT
          id,
          created_at AS createdAt,
          event,
          run_id AS runId,
          session_key AS sessionKey,
          chat_id AS chatId,
          user_id AS userId,
          message_id AS messageId,
          surface,
          payload_json AS payloadJson
        FROM audit_events
        ORDER BY created_at DESC, id DESC
        LIMIT $limit`,
      )
      .all({ $limit: limit }) as AuditEventRecord[];
  }

  upsertTelegramSession(session: TelegramSessionUpsert): void {
    this.db
      .query(
        `INSERT INTO telegram_sessions (
          session_key,
          surface,
          chat_id,
          chat_type,
          chat_title,
          user_id,
          username,
          business_connection_id,
          created_at,
          updated_at
        ) VALUES (
          $sessionKey,
          $surface,
          $chatId,
          $chatType,
          $chatTitle,
          $userId,
          $username,
          $businessConnectionId,
          $updatedAt,
          $updatedAt
        )
        ON CONFLICT(session_key) DO UPDATE SET
          surface = excluded.surface,
          chat_id = excluded.chat_id,
          chat_type = excluded.chat_type,
          chat_title = excluded.chat_title,
          user_id = excluded.user_id,
          username = excluded.username,
          business_connection_id = excluded.business_connection_id,
          updated_at = excluded.updated_at`,
      )
      .run({
        $sessionKey: session.sessionKey,
        $surface: session.surface,
        $chatId: session.chatId,
        $chatType: session.chatType ?? null,
        $chatTitle: session.chatTitle ?? null,
        $userId: session.userId ?? null,
        $username: session.username ?? null,
        $businessConnectionId: session.businessConnectionId ?? null,
        $updatedAt: session.updatedAt,
      });
  }

  startRun(run: RunStartInsert): void {
    this.db
      .query(
        `INSERT INTO runs (
          id,
          session_key,
          status,
          prompt,
          started_at,
          attachment_count
        ) VALUES (
          $id,
          $sessionKey,
          'running',
          $prompt,
          $startedAt,
          0
        )`,
      )
      .run({
        $id: run.id,
        $sessionKey: run.sessionKey,
        $prompt: run.prompt,
        $startedAt: run.startedAt,
      });

    this.db
      .query(
        `UPDATE telegram_sessions
        SET last_run_id = $runId, updated_at = $updatedAt
        WHERE session_key = $sessionKey`,
      )
      .run({
        $runId: run.id,
        $updatedAt: run.startedAt,
        $sessionKey: run.sessionKey,
      });
  }

  completeRun(run: {
    id: string;
    response: string;
    completedAt: number;
    durationMs: number;
    attachmentCount: number;
  }): void {
    this.db
      .query(
        `UPDATE runs
        SET
          status = 'completed',
          response = $response,
          error = NULL,
          completed_at = $completedAt,
          duration_ms = $durationMs,
          attachment_count = $attachmentCount
        WHERE id = $id`,
      )
      .run({
        $id: run.id,
        $response: run.response,
        $completedAt: run.completedAt,
        $durationMs: run.durationMs,
        $attachmentCount: run.attachmentCount,
      });
  }

  failRun(run: {
    id: string;
    error: string;
    completedAt: number;
    durationMs: number;
  }): void {
    this.db
      .query(
        `UPDATE runs
        SET
          status = 'failed',
          error = $error,
          completed_at = $completedAt,
          duration_ms = $durationMs
        WHERE id = $id`,
      )
      .run({
        $id: run.id,
        $error: run.error,
        $completedAt: run.completedAt,
        $durationMs: run.durationMs,
      });
  }

  getTelegramSession(sessionKey: string): TelegramSessionRecord | undefined {
    return this.db
      .query(
        `SELECT
          session_key AS sessionKey,
          surface,
          chat_id AS chatId,
          chat_type AS chatType,
          chat_title AS chatTitle,
          user_id AS userId,
          username,
          business_connection_id AS businessConnectionId,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_run_id AS lastRunId
        FROM telegram_sessions
        WHERE session_key = $sessionKey`,
      )
      .get({ $sessionKey: sessionKey }) as TelegramSessionRecord | undefined;
  }

  getRun(id: string): RunRecord | undefined {
    return this.db
      .query(
        `SELECT
          id,
          session_key AS sessionKey,
          status,
          prompt,
          response,
          error,
          started_at AS startedAt,
          completed_at AS completedAt,
          duration_ms AS durationMs,
          attachment_count AS attachmentCount
        FROM runs
        WHERE id = $id`,
      )
      .get({ $id: id }) as RunRecord | undefined;
  }

  getLatestCompletedRunForSession(sessionKey: string): RunRecord | undefined {
    return this.db
      .query(
        `SELECT
          id,
          session_key AS sessionKey,
          status,
          prompt,
          response,
          error,
          started_at AS startedAt,
          completed_at AS completedAt,
          duration_ms AS durationMs,
          attachment_count AS attachmentCount
        FROM runs
        WHERE session_key = $sessionKey AND status = 'completed'
        ORDER BY completed_at DESC, started_at DESC
        LIMIT 1`,
      )
      .get({ $sessionKey: sessionKey }) as RunRecord | undefined;
  }

  upsertBusinessConnection(connection: BusinessConnectionUpsert): void {
    this.db
      .query(
        `INSERT INTO business_connections (
          id,
          owner_telegram_user_id,
          owner_private_chat_id,
          is_enabled,
          can_reply,
          rights_json,
          updated_at,
          last_checked_at
        ) VALUES (
          $id,
          $ownerTelegramUserId,
          $ownerPrivateChatId,
          $isEnabled,
          $canReply,
          $rightsJson,
          $updatedAt,
          $lastCheckedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          owner_telegram_user_id = excluded.owner_telegram_user_id,
          owner_private_chat_id = excluded.owner_private_chat_id,
          is_enabled = excluded.is_enabled,
          can_reply = excluded.can_reply,
          rights_json = excluded.rights_json,
          updated_at = excluded.updated_at,
          last_checked_at = excluded.last_checked_at`,
      )
      .run({
        $id: connection.id,
        $ownerTelegramUserId: connection.ownerTelegramUserId,
        $ownerPrivateChatId: connection.ownerPrivateChatId,
        $isEnabled: connection.isEnabled ? 1 : 0,
        $canReply: connection.canReply ? 1 : 0,
        $rightsJson: connection.rightsJson,
        $updatedAt: connection.updatedAt,
        $lastCheckedAt: connection.lastCheckedAt ?? null,
      });
  }

  getBusinessConnection(id: string): BusinessConnectionRecord | undefined {
    return this.db
      .query(
        `SELECT
          id,
          owner_telegram_user_id AS ownerTelegramUserId,
          owner_private_chat_id AS ownerPrivateChatId,
          is_enabled AS isEnabled,
          can_reply AS canReply,
          rights_json AS rightsJson,
          updated_at AS updatedAt,
          last_checked_at AS lastCheckedAt
        FROM business_connections
        WHERE id = $id`,
      )
      .get({ $id: id }) as BusinessConnectionRecord | undefined;
  }

  insertArtifact(artifact: ArtifactInsert): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO artifacts (
          id,
          run_id,
          case_id,
          path,
          file_name,
          kind,
          status,
          size_bytes,
          sha256,
          created_at,
          sent_at,
          error
        ) VALUES (
          $id,
          $runId,
          $caseId,
          $path,
          $fileName,
          $kind,
          $status,
          $sizeBytes,
          $sha256,
          $createdAt,
          NULL,
          NULL
        )`,
      )
      .run({
        $id: artifact.id,
        $runId: artifact.runId,
        $caseId: artifact.caseId ?? null,
        $path: artifact.path,
        $fileName: artifact.fileName,
        $kind: artifact.kind,
        $status: artifact.status,
        $sizeBytes: artifact.sizeBytes ?? null,
        $sha256: artifact.sha256 ?? null,
        $createdAt: artifact.createdAt,
      });
  }

  markRunArtifactsSent(runId: string, sentAt: number): void {
    this.db
      .query(
        `UPDATE artifacts
        SET status = 'sent', sent_at = $sentAt, error = NULL
        WHERE run_id = $runId`,
      )
      .run({ $runId: runId, $sentAt: sentAt });
  }

  markRunArtifactsFailed(runId: string, error: string): void {
    this.db
      .query(
        `UPDATE artifacts
        SET status = 'failed', error = $error
        WHERE run_id = $runId`,
      )
      .run({ $runId: runId, $error: error });
  }

  markRunArtifactsSuppressed(runId: string): void {
    this.db
      .query(
        `UPDATE artifacts
        SET status = 'suppressed'
        WHERE run_id = $runId`,
      )
      .run({ $runId: runId });
  }

  listArtifactsForRun(runId: string): ArtifactRecord[] {
    return this.db
      .query(
        `SELECT
          id,
          run_id AS runId,
          case_id AS caseId,
          path,
          file_name AS fileName,
          kind,
          status,
          size_bytes AS sizeBytes,
          sha256,
          created_at AS createdAt,
          sent_at AS sentAt,
          error
        FROM artifacts
        WHERE run_id = $runId
        ORDER BY created_at ASC, id ASC`,
      )
      .all({ $runId: runId }) as ArtifactRecord[];
  }

  setActiveInvestigation(investigation: {
    sessionKey: string;
    subject: string;
    caseId?: string;
    updatedAt: number;
  }): void {
    this.db
      .query(
        `INSERT INTO active_investigations (
          session_key,
          subject,
          case_id,
          updated_at
        ) VALUES (
          $sessionKey,
          $subject,
          $caseId,
          $updatedAt
        )
        ON CONFLICT(session_key) DO UPDATE SET
          subject = excluded.subject,
          case_id = excluded.case_id,
          updated_at = excluded.updated_at`,
      )
      .run({
        $sessionKey: investigation.sessionKey,
        $subject: investigation.subject,
        $caseId: investigation.caseId ?? null,
        $updatedAt: investigation.updatedAt,
      });
  }

  getActiveInvestigation(sessionKey: string): ActiveInvestigationRecord | undefined {
    return this.db
      .query(
        `SELECT
          session_key AS sessionKey,
          subject,
          case_id AS caseId,
          updated_at AS updatedAt
        FROM active_investigations
        WHERE session_key = $sessionKey`,
      )
      .get({ $sessionKey: sessionKey }) as ActiveInvestigationRecord | undefined;
  }

  clearActiveInvestigation(sessionKey: string): void {
    this.db.query("DELETE FROM active_investigations WHERE session_key = $sessionKey").run({
      $sessionKey: sessionKey,
    });
  }

  createCase(caseRecord: CaseInsert): void {
    this.db
      .query(
        `INSERT INTO cases (
          id,
          subject,
          session_key,
          status,
          summary,
          created_at,
          updated_at
        ) VALUES (
          $id,
          $subject,
          $sessionKey,
          $status,
          $summary,
          $createdAt,
          $updatedAt
        )`,
      )
      .run({
        $id: caseRecord.id,
        $subject: caseRecord.subject,
        $sessionKey: caseRecord.sessionKey,
        $status: caseRecord.status,
        $summary: caseRecord.summary ?? null,
        $createdAt: caseRecord.createdAt,
        $updatedAt: caseRecord.updatedAt,
      });
  }

  getCase(id: string): CaseRecord | undefined {
    return this.db
      .query(
        `SELECT
          id,
          subject,
          session_key AS sessionKey,
          status,
          summary,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM cases
        WHERE id = $id`,
      )
      .get({ $id: id }) as CaseRecord | undefined;
  }

  listCasesForSession(sessionKey: string, limit = 10): CaseRecord[] {
    return this.db
      .query(
        `SELECT
          id,
          subject,
          session_key AS sessionKey,
          status,
          summary,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM cases
        WHERE session_key = $sessionKey
        ORDER BY updated_at DESC, created_at DESC
        LIMIT $limit`,
      )
      .all({ $sessionKey: sessionKey, $limit: limit }) as CaseRecord[];
  }

  addCaseEvent(event: CaseEventInsert): void {
    this.db
      .query(
        `INSERT INTO case_events (
          id,
          case_id,
          run_id,
          kind,
          text,
          metadata_json,
          created_at
        ) VALUES (
          $id,
          $caseId,
          $runId,
          $kind,
          $text,
          $metadataJson,
          $createdAt
        )`,
      )
      .run({
        $id: event.id,
        $caseId: event.caseId,
        $runId: event.runId ?? null,
        $kind: event.kind,
        $text: event.text,
        $metadataJson: event.metadataJson,
        $createdAt: event.createdAt,
      });
  }

  addEvidenceItem(item: EvidenceItemInsert): void {
    this.db
      .query(
        `INSERT INTO evidence_items (
          id,
          case_id,
          run_id,
          source,
          query_hash,
          query_summary,
          result_summary,
          external_ref,
          payload_json,
          created_at
        ) VALUES (
          $id,
          $caseId,
          $runId,
          $source,
          $queryHash,
          $querySummary,
          $resultSummary,
          $externalRef,
          $payloadJson,
          $createdAt
        )`,
      )
      .run({
        $id: item.id,
        $caseId: item.caseId ?? null,
        $runId: item.runId,
        $source: item.source,
        $queryHash: item.queryHash ?? null,
        $querySummary: item.querySummary,
        $resultSummary: item.resultSummary ?? null,
        $externalRef: item.externalRef ?? null,
        $payloadJson: item.payloadJson ?? null,
        $createdAt: item.createdAt,
      });
  }

  checkIntegrity(): string[] {
    const rows = this.db.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    return rows.map((row) => row.integrity_check);
  }

  countRunningRuns(): number {
    const row = this.db.query("SELECT COUNT(*) AS count FROM runs WHERE status = 'running'").get() as {
      count: number;
    };
    return row.count;
  }

  close(): void {
    this.db.close();
  }

  private applySchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 30000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        event TEXT NOT NULL,
        run_id TEXT,
        session_key TEXT,
        chat_id INTEGER,
        user_id INTEGER,
        message_id INTEGER,
        surface TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS audit_events_created_idx
        ON audit_events(created_at DESC);

      CREATE INDEX IF NOT EXISTS audit_events_session_idx
        ON audit_events(session_key, created_at DESC)
        WHERE session_key IS NOT NULL;

      CREATE INDEX IF NOT EXISTS audit_events_event_idx
        ON audit_events(event, created_at DESC);

      CREATE TABLE IF NOT EXISTS telegram_sessions (
        session_key TEXT PRIMARY KEY,
        surface TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        chat_type TEXT,
        chat_title TEXT,
        user_id INTEGER,
        username TEXT,
        business_connection_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_run_id TEXT
      );

      CREATE INDEX IF NOT EXISTS telegram_sessions_updated_idx
        ON telegram_sessions(updated_at DESC);

      CREATE INDEX IF NOT EXISTS telegram_sessions_chat_idx
        ON telegram_sessions(chat_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        duration_ms INTEGER,
        attachment_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (session_key) REFERENCES telegram_sessions(session_key) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS runs_session_idx
        ON runs(session_key, started_at DESC);

      CREATE INDEX IF NOT EXISTS runs_status_idx
        ON runs(status, started_at DESC);

      CREATE TABLE IF NOT EXISTS business_connections (
        id TEXT PRIMARY KEY,
        owner_telegram_user_id INTEGER NOT NULL,
        owner_private_chat_id INTEGER NOT NULL,
        is_enabled INTEGER NOT NULL,
        can_reply INTEGER NOT NULL,
        rights_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        last_checked_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS business_connections_owner_idx
        ON business_connections(owner_telegram_user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        session_key TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_key) REFERENCES telegram_sessions(session_key) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS cases_session_idx
        ON cases(session_key, updated_at DESC);

      CREATE TABLE IF NOT EXISTS active_investigations (
        session_key TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        case_id TEXT,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_key) REFERENCES telegram_sessions(session_key) ON DELETE CASCADE,
        FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS case_events (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        run_id TEXT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS case_events_case_idx
        ON case_events(case_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        case_id TEXT,
        path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        size_bytes INTEGER,
        sha256 TEXT,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        error TEXT,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
        FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS artifacts_run_idx
        ON artifacts(run_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS artifacts_status_idx
        ON artifacts(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS evidence_items (
        id TEXT PRIMARY KEY,
        case_id TEXT,
        run_id TEXT NOT NULL,
        source TEXT NOT NULL,
        query_hash TEXT,
        query_summary TEXT NOT NULL,
        result_summary TEXT,
        external_ref TEXT,
        payload_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE SET NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS evidence_items_case_idx
        ON evidence_items(case_id, created_at DESC)
        WHERE case_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS evidence_items_run_idx
        ON evidence_items(run_id, created_at DESC);
    `);
    this.ensureAuditRunIdColumn();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS audit_events_run_idx
        ON audit_events(run_id, created_at DESC)
        WHERE run_id IS NOT NULL;
    `);
  }

  private ensureAuditRunIdColumn(): void {
    const columns = this.db.query("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "run_id")) return;
    this.db.exec("ALTER TABLE audit_events ADD COLUMN run_id TEXT");
  }
}
