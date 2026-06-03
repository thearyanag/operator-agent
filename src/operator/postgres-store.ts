import pg from "pg";
import type {
  ConversationPolicyUpdate,
  InsertAuditEventInput,
  ListObservationSliceInput,
  ListObservationsSinceInput,
  InsertObservationInput,
  InsertOutputInput,
  InsertPolicyDecisionInput,
  OperatorAgentRun,
  OperatorConversation,
  OperatorConversationInboxItem,
  OperatorConversationPolicy,
  OperatorObservation,
  OperatorObservationSliceItem,
  OperatorOutput,
  OperatorOwnerSettings,
  OperatorOwnerSettingsUpdate,
  OperatorPolicyDecision,
  OperatorStore,
  StartAgentRunInput,
  UpsertConversationInput,
  UpsertTelegramSessionInput,
} from "./store";

const { Pool } = pg;

type PgRow = Record<string, unknown>;

export async function createPostgresOperatorStore(databaseUrl: string, ownerUserId: string): Promise<PostgresOperatorStore> {
  const store = new PostgresOperatorStore(databaseUrl);
  await store.applySchema(ownerUserId);
  return store;
}

export class PostgresOperatorStore implements OperatorStore {
  private readonly pool: InstanceType<typeof Pool>;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async applySchema(ownerUserId: string): Promise<void> {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS operator;

      CREATE TABLE IF NOT EXISTS operator.users (
        id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS operator.owner_settings (
        owner_user_id uuid PRIMARY KEY REFERENCES operator.users(id) ON DELETE CASCADE,
        personal_draft_mode text NOT NULL DEFAULT 'important_only'
          CHECK (personal_draft_mode IN ('important_only', 'draft_all', 'digest_only')),
        team_reply_mode text NOT NULL DEFAULT 'mention_only'
          CHECK (team_reply_mode IN ('mention_only')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS operator.conversations (
        id uuid PRIMARY KEY,
        owner_user_id uuid NOT NULL REFERENCES operator.users(id) ON DELETE CASCADE,
        platform text NOT NULL DEFAULT 'telegram',
        mode text NOT NULL CHECK (mode IN ('team', 'personal', 'assistant')),
        telegram_chat_id text NOT NULL,
        telegram_chat_type text NOT NULL,
        telegram_business_connection_id text NOT NULL DEFAULT '',
        title text,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'muted', 'archived')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS conversations_telegram_identity_idx
        ON operator.conversations(platform, telegram_chat_id, telegram_business_connection_id);

      CREATE INDEX IF NOT EXISTS conversations_owner_updated_idx
        ON operator.conversations(owner_user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS operator.conversation_members (
        id uuid PRIMARY KEY,
        conversation_id uuid NOT NULL REFERENCES operator.conversations(id) ON DELETE CASCADE,
        platform_user_id text NOT NULL,
        display_name text,
        role text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (conversation_id, platform_user_id)
      );

      CREATE TABLE IF NOT EXISTS operator.conversation_policies (
        conversation_id uuid PRIMARY KEY REFERENCES operator.conversations(id) ON DELETE CASCADE,
        observe_enabled boolean NOT NULL DEFAULT true,
        auto_reply_enabled boolean NOT NULL DEFAULT false,
        draft_enabled boolean NOT NULL DEFAULT true,
        summarize_enabled boolean NOT NULL DEFAULT true,
        escalation_enabled boolean NOT NULL DEFAULT true,
        trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS operator.observations (
        id uuid PRIMARY KEY,
        conversation_id uuid NOT NULL REFERENCES operator.conversations(id) ON DELETE CASCADE,
        platform text NOT NULL DEFAULT 'telegram',
        platform_message_id text NOT NULL,
        sender_platform_id text,
        sender_display_name text,
        message_type text NOT NULL,
        text text,
        raw_payload jsonb,
        observed_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (conversation_id, platform_message_id)
      );

      CREATE INDEX IF NOT EXISTS observations_conversation_time_idx
        ON operator.observations(conversation_id, observed_at DESC);

      CREATE TABLE IF NOT EXISTS operator.policy_decisions (
        id uuid PRIMARY KEY,
        conversation_id uuid NOT NULL REFERENCES operator.conversations(id) ON DELETE CASCADE,
        observation_id uuid REFERENCES operator.observations(id) ON DELETE SET NULL,
        action text NOT NULL,
        reason text NOT NULL,
        confidence numeric,
        should_invoke_agent boolean NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS policy_decisions_conversation_time_idx
        ON operator.policy_decisions(conversation_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS operator.agent_runs (
        id uuid PRIMARY KEY,
        conversation_id uuid NOT NULL REFERENCES operator.conversations(id) ON DELETE CASCADE,
        observation_id uuid REFERENCES operator.observations(id) ON DELETE SET NULL,
        mode text NOT NULL,
        status text NOT NULL,
        prompt text,
        response text,
        error text,
        started_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      );

      CREATE INDEX IF NOT EXISTS agent_runs_conversation_time_idx
        ON operator.agent_runs(conversation_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS operator.operator_outputs (
        id uuid PRIMARY KEY,
        conversation_id uuid NOT NULL REFERENCES operator.conversations(id) ON DELETE CASCADE,
        observation_id uuid REFERENCES operator.observations(id) ON DELETE SET NULL,
        agent_run_id uuid REFERENCES operator.agent_runs(id) ON DELETE SET NULL,
        type text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        delivered_at timestamptz
      );

      CREATE INDEX IF NOT EXISTS operator_outputs_conversation_time_idx
        ON operator.operator_outputs(conversation_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS operator_outputs_type_status_idx
        ON operator.operator_outputs(type, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS operator.telegram_sessions (
        session_key text PRIMARY KEY,
        owner_user_id uuid NOT NULL REFERENCES operator.users(id) ON DELETE CASCADE,
        surface text NOT NULL,
        chat_id bigint NOT NULL,
        chat_type text,
        chat_title text,
        user_id bigint,
        username text,
        business_connection_id text,
        last_run_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL
      );

      CREATE INDEX IF NOT EXISTS telegram_sessions_owner_updated_idx
        ON operator.telegram_sessions(owner_user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS operator.owner_read_checkpoints (
        owner_user_id uuid NOT NULL REFERENCES operator.users(id) ON DELETE CASCADE,
        conversation_id uuid NOT NULL REFERENCES operator.conversations(id) ON DELETE CASCADE,
        last_seen_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_user_id, conversation_id)
      );

      CREATE INDEX IF NOT EXISTS owner_read_checkpoints_owner_updated_idx
        ON operator.owner_read_checkpoints(owner_user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS operator.summaries (
        id uuid PRIMARY KEY,
        owner_user_id uuid NOT NULL REFERENCES operator.users(id) ON DELETE CASCADE,
        conversation_id uuid REFERENCES operator.conversations(id) ON DELETE CASCADE,
        type text NOT NULL,
        title text,
        content text NOT NULL,
        covers_start_at timestamptz,
        covers_end_at timestamptz,
        source_observation_ids uuid[] NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS operator.memory_items (
        id uuid PRIMARY KEY,
        owner_user_id uuid NOT NULL REFERENCES operator.users(id) ON DELETE CASCADE,
        conversation_id uuid REFERENCES operator.conversations(id) ON DELETE CASCADE,
        kind text NOT NULL,
        content text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        importance numeric,
        source_observation_id uuid REFERENCES operator.observations(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz
      );

      CREATE TABLE IF NOT EXISTS operator.audit_events (
        id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL,
        event text NOT NULL,
        run_id text,
        conversation_id text,
        observation_id text,
        session_key text,
        chat_id bigint,
        user_id bigint,
        message_id bigint,
        surface text,
        payload jsonb NOT NULL
      );

      CREATE INDEX IF NOT EXISTS audit_events_created_idx
        ON operator.audit_events(created_at DESC);

      CREATE TABLE IF NOT EXISTS operator.telegram_business_connections (
        id text PRIMARY KEY,
        owner_telegram_user_id bigint NOT NULL,
        owner_private_chat_id bigint NOT NULL,
        is_enabled boolean NOT NULL,
        can_reply boolean NOT NULL,
        rights jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL,
        last_checked_at timestamptz
      );
    `);

    await this.pool.query(
      `INSERT INTO operator.users (id)
      VALUES ($1)
      ON CONFLICT (id) DO NOTHING`,
      [ownerUserId],
    );

    await this.pool.query(
      `INSERT INTO operator.owner_settings (owner_user_id)
      VALUES ($1)
      ON CONFLICT (owner_user_id) DO NOTHING`,
      [ownerUserId],
    );
  }

  async upsertConversation(input: UpsertConversationInput): Promise<OperatorConversation> {
    const id = crypto.randomUUID();
    const row = await this.one(
      `INSERT INTO operator.conversations (
        id,
        owner_user_id,
        mode,
        telegram_chat_id,
        telegram_chat_type,
        telegram_business_connection_id,
        title,
        status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'active')
      )
      ON CONFLICT (platform, telegram_chat_id, telegram_business_connection_id) DO UPDATE SET
        mode = excluded.mode,
        telegram_chat_type = excluded.telegram_chat_type,
        title = COALESCE(excluded.title, operator.conversations.title),
        status = CASE
          WHEN operator.conversations.status = 'archived' THEN operator.conversations.status
          ELSE COALESCE(excluded.status, operator.conversations.status)
        END,
        updated_at = now()
      RETURNING *`,
      [
        id,
        input.ownerUserId,
        input.mode,
        input.telegramChatId,
        input.telegramChatType,
        input.telegramBusinessConnectionId ?? "",
        input.title ?? null,
        input.status ?? null,
      ],
    );

    await this.pool.query(
      `INSERT INTO operator.conversation_policies (conversation_id)
      VALUES ($1)
      ON CONFLICT (conversation_id) DO NOTHING`,
      [row.id],
    );

    return mapConversation(row);
  }

  async insertObservation(input: InsertObservationInput): Promise<OperatorObservation> {
    const row = await this.one(
      `INSERT INTO operator.observations (
        id,
        conversation_id,
        platform_message_id,
        sender_platform_id,
        sender_display_name,
        message_type,
        text,
        raw_payload,
        observed_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9
      )
      ON CONFLICT (conversation_id, platform_message_id) DO UPDATE SET
        sender_platform_id = excluded.sender_platform_id,
        sender_display_name = excluded.sender_display_name,
        message_type = excluded.message_type,
        text = excluded.text,
        raw_payload = excluded.raw_payload,
        observed_at = excluded.observed_at
      RETURNING *`,
      [
        crypto.randomUUID(),
        input.conversationId,
        input.platformMessageId,
        input.senderPlatformId ?? null,
        input.senderDisplayName ?? null,
        input.messageType,
        input.text ?? null,
        JSON.stringify(input.rawPayload ?? {}),
        input.observedAt,
      ],
    );
    return mapObservation(row);
  }

  async insertPolicyDecision(input: InsertPolicyDecisionInput): Promise<OperatorPolicyDecision> {
    const row = await this.one(
      `INSERT INTO operator.policy_decisions (
        id,
        conversation_id,
        observation_id,
        action,
        reason,
        confidence,
        should_invoke_agent
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7
      )
      RETURNING *`,
      [
        crypto.randomUUID(),
        input.conversationId,
        input.observationId ?? null,
        input.action,
        input.reason,
        input.confidence ?? null,
        input.shouldInvokeAgent,
      ],
    );
    return mapPolicyDecision(row);
  }

  async startAgentRun(input: StartAgentRunInput): Promise<OperatorAgentRun> {
    const row = await this.one(
      `INSERT INTO operator.agent_runs (
        id,
        conversation_id,
        observation_id,
        mode,
        status,
        prompt
      ) VALUES (
        $1, $2, $3, $4, 'running', $5
      )
      RETURNING *`,
      [input.id, input.conversationId, input.observationId ?? null, input.mode, input.prompt ?? null],
    );
    return mapAgentRun(row);
  }

  async completeAgentRun(id: string, response: string, completedAt = new Date()): Promise<void> {
    await this.pool.query(
      `UPDATE operator.agent_runs
      SET status = 'completed', response = $2, error = NULL, completed_at = $3
      WHERE id = $1`,
      [id, response, completedAt],
    );
  }

  async failAgentRun(id: string, error: string, completedAt = new Date()): Promise<void> {
    await this.pool.query(
      `UPDATE operator.agent_runs
      SET status = 'failed', error = $2, completed_at = $3
      WHERE id = $1`,
      [id, error, completedAt],
    );
  }

  async insertOutput(input: InsertOutputInput): Promise<OperatorOutput> {
    const row = await this.one(
      `INSERT INTO operator.operator_outputs (
        id,
        conversation_id,
        observation_id,
        agent_run_id,
        type,
        status,
        payload
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb
      )
      RETURNING *`,
      [
        crypto.randomUUID(),
        input.conversationId,
        input.observationId ?? null,
        input.agentRunId ?? null,
        input.type,
        input.status ?? "pending",
        JSON.stringify(input.payload),
      ],
    );
    return mapOutput(row);
  }

  async markOutputDelivered(id: string, deliveredAt = new Date()): Promise<void> {
    await this.pool.query(
      `UPDATE operator.operator_outputs
      SET status = 'delivered', delivered_at = $2
      WHERE id = $1`,
      [id, deliveredAt],
    );
  }

  async markOutputFailed(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE operator.operator_outputs
      SET status = 'failed', payload = payload || jsonb_build_object('error', $2)
      WHERE id = $1`,
      [id, error],
    );
  }

  async insertAuditEvent(input: InsertAuditEventInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO operator.audit_events (
        id,
        created_at,
        event,
        run_id,
        conversation_id,
        observation_id,
        session_key,
        chat_id,
        user_id,
        message_id,
        surface,
        payload
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
      )
      ON CONFLICT (id) DO NOTHING`,
      [
        input.id,
        input.createdAt,
        input.event,
        input.runId ?? null,
        input.conversationId ?? null,
        input.observationId ?? null,
        input.sessionKey ?? null,
        input.chatId ?? null,
        input.userId ?? null,
        input.messageId ?? null,
        input.surface ?? null,
        JSON.stringify(input.payload),
      ],
    );
  }

  async upsertTelegramSession(input: UpsertTelegramSessionInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO operator.telegram_sessions (
        session_key,
        owner_user_id,
        surface,
        chat_id,
        chat_type,
        chat_title,
        user_id,
        username,
        business_connection_id,
        last_run_id,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      )
      ON CONFLICT (session_key) DO UPDATE SET
        surface = excluded.surface,
        chat_id = excluded.chat_id,
        chat_type = excluded.chat_type,
        chat_title = excluded.chat_title,
        user_id = excluded.user_id,
        username = excluded.username,
        business_connection_id = excluded.business_connection_id,
        last_run_id = COALESCE(excluded.last_run_id, operator.telegram_sessions.last_run_id),
        updated_at = excluded.updated_at`,
      [
        input.sessionKey,
        input.ownerUserId,
        input.surface,
        input.chatId,
        input.chatType ?? null,
        input.chatTitle ?? null,
        input.userId ?? null,
        input.username ?? null,
        input.businessConnectionId ?? null,
        input.lastRunId ?? null,
        input.updatedAt,
      ],
    );
  }

  async upsertTelegramBusinessConnection(input: {
    id: string;
    ownerTelegramUserId: number;
    ownerPrivateChatId: number;
    isEnabled: boolean;
    canReply: boolean;
    rights: unknown;
    updatedAt: Date;
    lastCheckedAt?: Date;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO operator.telegram_business_connections (
        id,
        owner_telegram_user_id,
        owner_private_chat_id,
        is_enabled,
        can_reply,
        rights,
        updated_at,
        last_checked_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6::jsonb, $7, $8
      )
      ON CONFLICT (id) DO UPDATE SET
        owner_telegram_user_id = excluded.owner_telegram_user_id,
        owner_private_chat_id = excluded.owner_private_chat_id,
        is_enabled = excluded.is_enabled,
        can_reply = excluded.can_reply,
        rights = excluded.rights,
        updated_at = excluded.updated_at,
        last_checked_at = excluded.last_checked_at`,
      [
        input.id,
        input.ownerTelegramUserId,
        input.ownerPrivateChatId,
        input.isEnabled,
        input.canReply,
        JSON.stringify(input.rights ?? {}),
        input.updatedAt,
        input.lastCheckedAt ?? null,
      ],
    );
  }

  async listConversations(ownerUserId: string, limit = 100): Promise<OperatorConversation[]> {
    const result = await this.pool.query(
      `SELECT *
      FROM operator.conversations
      WHERE owner_user_id = $1
      ORDER BY updated_at DESC
      LIMIT $2`,
      [ownerUserId, limit],
    );
    return result.rows.map(mapConversation);
  }

  async listConversationInbox(ownerUserId: string, limit = 100): Promise<OperatorConversationInboxItem[]> {
    const result = await this.pool.query(
      `SELECT
        to_jsonb(conversations) AS conversation,
        CASE
          WHEN policies.conversation_id IS NULL THEN NULL
          ELSE to_jsonb(policies)
        END AS policy,
        to_jsonb(last_observation) AS last_observation,
        read_checkpoints.last_seen_at AS last_seen_at,
        COALESCE(unread.unread_count, 0)::int AS unread_count
      FROM operator.conversations conversations
      LEFT JOIN operator.conversation_policies policies
        ON policies.conversation_id = conversations.id
      LEFT JOIN operator.owner_read_checkpoints read_checkpoints
        ON read_checkpoints.owner_user_id = conversations.owner_user_id
        AND read_checkpoints.conversation_id = conversations.id
      LEFT JOIN LATERAL (
        SELECT *
        FROM operator.observations observations
        WHERE observations.conversation_id = conversations.id
        ORDER BY observations.observed_at DESC
        LIMIT 1
      ) last_observation ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS unread_count
        FROM operator.observations observations
        WHERE observations.conversation_id = conversations.id
          AND (
            read_checkpoints.last_seen_at IS NULL
            OR observations.observed_at > read_checkpoints.last_seen_at
          )
      ) unread ON true
      WHERE conversations.owner_user_id = $1
      ORDER BY
        COALESCE(last_observation.observed_at, conversations.updated_at) DESC,
        conversations.updated_at DESC
      LIMIT $2`,
      [ownerUserId, limit],
    );

    return result.rows.map((row) => ({
      conversation: mapConversation(row.conversation as PgRow),
      policy: mapConversationPolicy(row.policy),
      lastObservation: isRecord(row.last_observation) ? mapObservation(row.last_observation as PgRow) : null,
      unreadCount: Number(row.unread_count ?? 0),
      lastSeenAt: row.last_seen_at === null || row.last_seen_at === undefined ? null : toDate(row.last_seen_at),
    }));
  }

  async getLatestAgentRunForConversation(conversationId: string): Promise<OperatorAgentRun | undefined> {
    const result = await this.pool.query(
      `SELECT *
      FROM operator.agent_runs
      WHERE conversation_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
      [conversationId],
    );
    const row = result.rows[0];
    return row ? mapAgentRun(row) : undefined;
  }

  async listRecentObservations(conversationId: string, limit = 100): Promise<OperatorObservation[]> {
    const result = await this.pool.query(
      `SELECT *
      FROM operator.observations
      WHERE conversation_id = $1
      ORDER BY observed_at DESC
      LIMIT $2`,
      [conversationId, limit],
    );
    return result.rows.map(mapObservation);
  }

  async listObservationsSince(input: ListObservationsSinceInput): Promise<OperatorObservation[]> {
    const result = await this.pool.query(
      `SELECT *
      FROM operator.observations
      WHERE conversation_id = $1
        AND observed_at > $2
      ORDER BY observed_at ASC
      LIMIT $3`,
      [input.conversationId, input.since, input.limit ?? 200],
    );
    return result.rows.map(mapObservation);
  }

  async listConversationObservations(input: {
    ownerUserId: string;
    conversationId: string;
    limit?: number;
  }): Promise<OperatorObservation[]> {
    const result = await this.pool.query(
      `SELECT observations.*
      FROM operator.observations observations
      JOIN operator.conversations conversations
        ON conversations.id = observations.conversation_id
      WHERE conversations.owner_user_id = $1
        AND conversations.id = $2
      ORDER BY observations.observed_at DESC
      LIMIT $3`,
      [input.ownerUserId, input.conversationId, clampSliceLimit(input.limit)],
    );
    return result.rows.map(mapObservation);
  }

  async listObservationSlice(input: ListObservationSliceInput): Promise<OperatorObservationSliceItem[]> {
    const params: unknown[] = [input.ownerUserId];
    const clauses = ["conversations.owner_user_id = $1"];

    if (input.conversationId) {
      params.push(input.conversationId);
      clauses.push(`conversations.id = $${params.length}`);
    }

    if (input.modes && input.modes.length > 0) {
      params.push(input.modes);
      clauses.push(`conversations.mode = ANY($${params.length}::text[])`);
    }

    if (input.conversationTitle) {
      params.push(input.conversationTitle);
      clauses.push(`conversations.title ILIKE '%' || $${params.length} || '%'`);
    }

    if (input.telegramChatId) {
      params.push(input.telegramChatId);
      clauses.push(`conversations.telegram_chat_id = $${params.length}`);
    }

    if (input.since) {
      params.push(input.since);
      clauses.push(`observations.observed_at >= $${params.length}`);
    }

    if (input.until) {
      params.push(input.until);
      clauses.push(`observations.observed_at <= $${params.length}`);
    }

    if (input.sinceOwnerLastSeen) {
      clauses.push(
        "(read_checkpoints.last_seen_at IS NULL OR observations.observed_at > read_checkpoints.last_seen_at)",
      );
    }

    const limit = clampSliceLimit(input.limit);
    params.push(limit);

    const result = await this.pool.query(
      `SELECT
        to_jsonb(conversations) AS conversation,
        to_jsonb(observations) AS observation,
        read_checkpoints.last_seen_at AS owner_last_seen_at
      FROM operator.observations observations
      JOIN operator.conversations conversations
        ON conversations.id = observations.conversation_id
      LEFT JOIN operator.owner_read_checkpoints read_checkpoints
        ON read_checkpoints.owner_user_id = conversations.owner_user_id
        AND read_checkpoints.conversation_id = conversations.id
      WHERE ${clauses.join("\n        AND ")}
      ORDER BY observations.observed_at DESC
      LIMIT $${params.length}`,
      params,
    );

    return result.rows.map((row) => ({
      conversation: mapConversation(row.conversation as PgRow),
      observation: mapObservation(row.observation as PgRow),
      ownerLastSeenAt:
        row.owner_last_seen_at === null || row.owner_last_seen_at === undefined
          ? null
          : toDate(row.owner_last_seen_at),
    }));
  }

  async listRecentOutputs(ownerUserId: string, limit = 100): Promise<OperatorOutput[]> {
    const result = await this.pool.query(
      `SELECT outputs.*
      FROM operator.operator_outputs outputs
      JOIN operator.conversations conversations
        ON conversations.id = outputs.conversation_id
      WHERE conversations.owner_user_id = $1
      ORDER BY outputs.created_at DESC
      LIMIT $2`,
      [ownerUserId, limit],
    );
    return result.rows.map(mapOutput);
  }

  async getConversationPolicy(conversationId: string): Promise<OperatorConversationPolicy> {
    const row = await this.one(
      `INSERT INTO operator.conversation_policies (conversation_id)
      VALUES ($1)
      ON CONFLICT (conversation_id) DO UPDATE SET
        conversation_id = excluded.conversation_id
      RETURNING *`,
      [conversationId],
    );
    return mapConversationPolicy(row);
  }

  async getOwnerSettings(ownerUserId: string): Promise<OperatorOwnerSettings> {
    const row = await this.one(
      `INSERT INTO operator.owner_settings (owner_user_id)
      VALUES ($1)
      ON CONFLICT (owner_user_id) DO UPDATE SET
        owner_user_id = excluded.owner_user_id
      RETURNING *`,
      [ownerUserId],
    );
    return mapOwnerSettings(row);
  }

  async updateOwnerSettings(
    ownerUserId: string,
    update: OperatorOwnerSettingsUpdate,
  ): Promise<OperatorOwnerSettings> {
    const row = await this.one(
      `INSERT INTO operator.owner_settings (
        owner_user_id,
        personal_draft_mode,
        updated_at
      ) VALUES (
        $1,
        COALESCE($2, 'important_only'),
        now()
      )
      ON CONFLICT (owner_user_id) DO UPDATE SET
        personal_draft_mode = COALESCE($2, operator.owner_settings.personal_draft_mode),
        updated_at = now()
      RETURNING *`,
      [ownerUserId, update.personalDraftMode ?? null],
    );
    return mapOwnerSettings(row);
  }

  async markConversationSeen(input: {
    ownerUserId: string;
    conversationId: string;
    seenAt?: Date;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO operator.owner_read_checkpoints (
        owner_user_id,
        conversation_id,
        last_seen_at,
        updated_at
      ) VALUES (
        $1,
        $2,
        $3,
        now()
      )
      ON CONFLICT (owner_user_id, conversation_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        updated_at = now()`,
      [input.ownerUserId, input.conversationId, input.seenAt ?? new Date()],
    );
  }

  async updateConversationPolicy(conversationId: string, update: ConversationPolicyUpdate): Promise<void> {
    if (update.status) {
      await this.pool.query(
        `UPDATE operator.conversations
        SET status = $2, updated_at = now()
        WHERE id = $1`,
        [conversationId, update.status],
      );
    }

    await this.pool.query(
      `INSERT INTO operator.conversation_policies (
        conversation_id,
        observe_enabled,
        auto_reply_enabled,
        draft_enabled,
        summarize_enabled,
        escalation_enabled,
        trigger_config
      ) VALUES (
        $1,
        COALESCE($2, true),
        COALESCE($3, false),
        COALESCE($4, true),
        COALESCE($5, true),
        COALESCE($6, true),
        COALESCE($7::jsonb, '{}'::jsonb)
      )
      ON CONFLICT (conversation_id) DO UPDATE SET
        observe_enabled = COALESCE($2, operator.conversation_policies.observe_enabled),
        auto_reply_enabled = COALESCE($3, operator.conversation_policies.auto_reply_enabled),
        draft_enabled = COALESCE($4, operator.conversation_policies.draft_enabled),
        summarize_enabled = COALESCE($5, operator.conversation_policies.summarize_enabled),
        escalation_enabled = COALESCE($6, operator.conversation_policies.escalation_enabled),
        trigger_config = COALESCE($7::jsonb, operator.conversation_policies.trigger_config),
        updated_at = now()`,
      [
        conversationId,
        update.observeEnabled ?? null,
        update.autoReplyEnabled ?? null,
        update.draftEnabled ?? null,
        update.summarizeEnabled ?? null,
        update.escalationEnabled ?? null,
        update.triggerConfig ? JSON.stringify(update.triggerConfig) : null,
      ],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async one(sql: string, params: unknown[]): Promise<PgRow> {
    const result = await this.pool.query(sql, params);
    const row = result.rows[0];
    if (!row) {
      throw new Error("Postgres query returned no rows.");
    }
    return row as PgRow;
  }
}

function clampSliceLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 100;
  return Math.max(1, Math.min(Math.trunc(limit), 500));
}

function mapConversation(row: PgRow): OperatorConversation {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    platform: "telegram",
    mode: row.mode as OperatorConversation["mode"],
    telegramChatId: String(row.telegram_chat_id),
    telegramChatType: String(row.telegram_chat_type),
    telegramBusinessConnectionId: row.telegram_business_connection_id ? String(row.telegram_business_connection_id) : null,
    title: row.title === null || row.title === undefined ? null : String(row.title),
    status: row.status as OperatorConversation["status"],
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapObservation(row: PgRow): OperatorObservation {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    platform: "telegram",
    platformMessageId: String(row.platform_message_id),
    senderPlatformId: row.sender_platform_id === null || row.sender_platform_id === undefined ? null : String(row.sender_platform_id),
    senderDisplayName: row.sender_display_name === null || row.sender_display_name === undefined ? null : String(row.sender_display_name),
    messageType: String(row.message_type),
    text: row.text === null || row.text === undefined ? null : String(row.text),
    rawPayload: row.raw_payload,
    observedAt: toDate(row.observed_at),
    createdAt: toDate(row.created_at),
  };
}

function mapPolicyDecision(row: PgRow): OperatorPolicyDecision {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    observationId: row.observation_id === null || row.observation_id === undefined ? null : String(row.observation_id),
    action: row.action as OperatorPolicyDecision["action"],
    reason: String(row.reason),
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    shouldInvokeAgent: Boolean(row.should_invoke_agent),
    createdAt: toDate(row.created_at),
  };
}

function mapAgentRun(row: PgRow): OperatorAgentRun {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    observationId: row.observation_id === null || row.observation_id === undefined ? null : String(row.observation_id),
    mode: row.mode as OperatorAgentRun["mode"],
    status: row.status as OperatorAgentRun["status"],
    prompt: row.prompt === null || row.prompt === undefined ? null : String(row.prompt),
    response: row.response === null || row.response === undefined ? null : String(row.response),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    startedAt: toDate(row.started_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : toDate(row.completed_at),
  };
}

function mapOutput(row: PgRow): OperatorOutput {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    observationId: row.observation_id === null || row.observation_id === undefined ? null : String(row.observation_id),
    agentRunId: row.agent_run_id === null || row.agent_run_id === undefined ? null : String(row.agent_run_id),
    type: row.type as OperatorOutput["type"],
    status: row.status as OperatorOutput["status"],
    payload: isRecord(row.payload) ? row.payload : {},
    createdAt: toDate(row.created_at),
    deliveredAt: row.delivered_at === null || row.delivered_at === undefined ? null : toDate(row.delivered_at),
  };
}

function mapConversationPolicy(value: unknown): OperatorConversationPolicy {
  if (!isRecord(value)) return defaultConversationPolicy();

  return {
    observeEnabled: Boolean(value.observe_enabled ?? true),
    autoReplyEnabled: Boolean(value.auto_reply_enabled ?? false),
    draftEnabled: Boolean(value.draft_enabled ?? true),
    summarizeEnabled: Boolean(value.summarize_enabled ?? true),
    escalationEnabled: Boolean(value.escalation_enabled ?? true),
    triggerConfig: isRecord(value.trigger_config) ? value.trigger_config : {},
  };
}

function mapOwnerSettings(row: PgRow): OperatorOwnerSettings {
  return {
    ownerUserId: String(row.owner_user_id),
    personalDraftMode: row.personal_draft_mode as OperatorOwnerSettings["personalDraftMode"],
    teamReplyMode: row.team_reply_mode as OperatorOwnerSettings["teamReplyMode"],
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function defaultConversationPolicy(): OperatorConversationPolicy {
  return {
    observeEnabled: true,
    autoReplyEnabled: false,
    draftEnabled: true,
    summarizeEnabled: true,
    escalationEnabled: true,
    triggerConfig: {},
  };
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
