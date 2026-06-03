export type OperatorConversationMode = "team" | "personal" | "assistant";
export type OperatorConversationStatus = "active" | "paused" | "muted" | "archived";
export type OperatorPolicyAction = "ignore" | "observe" | "summarize" | "draft" | "reply" | "escalate" | "save";
export type OperatorOutputType =
  | "reply"
  | "draft"
  | "digest_item"
  | "summary"
  | "support_issue"
  | "handoff"
  | "escalation"
  | "artifact";

export type OperatorConversation = {
  id: string;
  ownerUserId: string;
  platform: "telegram";
  mode: OperatorConversationMode;
  telegramChatId: string;
  telegramChatType: string;
  telegramBusinessConnectionId: string | null;
  title: string | null;
  status: OperatorConversationStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type OperatorObservation = {
  id: string;
  conversationId: string;
  platform: "telegram";
  platformMessageId: string;
  senderPlatformId: string | null;
  senderDisplayName: string | null;
  messageType: string;
  text: string | null;
  rawPayload: unknown;
  observedAt: Date;
  createdAt: Date;
};

export type OperatorPolicyDecision = {
  id: string;
  conversationId: string;
  observationId: string | null;
  action: OperatorPolicyAction;
  reason: string;
  confidence: number | null;
  shouldInvokeAgent: boolean;
  createdAt: Date;
};

export type OperatorAgentRun = {
  id: string;
  conversationId: string;
  observationId: string | null;
  mode: OperatorConversationMode;
  status: "running" | "completed" | "failed";
  prompt: string | null;
  response: string | null;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
};

export type OperatorOutput = {
  id: string;
  conversationId: string;
  observationId: string | null;
  agentRunId: string | null;
  type: OperatorOutputType;
  status: "pending" | "delivered" | "suppressed" | "failed";
  payload: Record<string, unknown>;
  createdAt: Date;
  deliveredAt: Date | null;
};

export type OperatorConversationPolicy = {
  observeEnabled: boolean;
  autoReplyEnabled: boolean;
  draftEnabled: boolean;
  summarizeEnabled: boolean;
  escalationEnabled: boolean;
  triggerConfig: Record<string, unknown>;
};

export type OperatorPersonalDraftMode = "important_only" | "draft_all" | "digest_only";

export type OperatorOwnerSettings = {
  ownerUserId: string;
  personalDraftMode: OperatorPersonalDraftMode;
  teamReplyMode: "mention_only";
  createdAt: Date;
  updatedAt: Date;
};

export type OperatorConversationInboxItem = {
  conversation: OperatorConversation;
  policy: OperatorConversationPolicy;
  lastObservation: OperatorObservation | null;
  unreadCount: number;
  lastSeenAt: Date | null;
};

export type UpsertConversationInput = {
  ownerUserId: string;
  mode: OperatorConversationMode;
  telegramChatId: string;
  telegramChatType: string;
  telegramBusinessConnectionId?: string | null;
  title?: string | null;
  status?: OperatorConversationStatus;
};

export type InsertObservationInput = {
  conversationId: string;
  platformMessageId: string;
  senderPlatformId?: string | null;
  senderDisplayName?: string | null;
  messageType: string;
  text?: string | null;
  rawPayload?: unknown;
  observedAt: Date;
};

export type InsertPolicyDecisionInput = {
  conversationId: string;
  observationId?: string | null;
  action: OperatorPolicyAction;
  reason: string;
  confidence?: number | null;
  shouldInvokeAgent: boolean;
};

export type StartAgentRunInput = {
  id: string;
  conversationId: string;
  observationId?: string | null;
  mode: OperatorConversationMode;
  prompt?: string | null;
};

export type InsertOutputInput = {
  conversationId: string;
  observationId?: string | null;
  agentRunId?: string | null;
  type: OperatorOutputType;
  status?: OperatorOutput["status"];
  payload: Record<string, unknown>;
};

export type InsertAuditEventInput = {
  id: string;
  createdAt: Date;
  event: string;
  runId?: string | null;
  conversationId?: string | null;
  observationId?: string | null;
  sessionKey?: string | null;
  chatId?: number | null;
  userId?: number | null;
  messageId?: number | null;
  surface?: string | null;
  payload: Record<string, unknown>;
};

export type UpsertTelegramSessionInput = {
  ownerUserId: string;
  sessionKey: string;
  surface: string;
  chatId: number;
  chatType?: string | null;
  chatTitle?: string | null;
  userId?: number | null;
  username?: string | null;
  businessConnectionId?: string | null;
  lastRunId?: string | null;
  updatedAt: Date;
};

export type ListObservationsSinceInput = {
  conversationId: string;
  since: Date;
  limit?: number;
};

export type ListObservationSliceInput = {
  ownerUserId: string;
  conversationId?: string;
  modes?: OperatorConversationMode[];
  conversationTitle?: string;
  telegramChatId?: string;
  since?: Date;
  until?: Date;
  sinceOwnerLastSeen?: boolean;
  limit?: number;
};

export type OperatorObservationSliceItem = {
  conversation: OperatorConversation;
  observation: OperatorObservation;
  ownerLastSeenAt: Date | null;
};

export type ConversationPolicyUpdate = {
  status?: OperatorConversationStatus;
  observeEnabled?: boolean;
  autoReplyEnabled?: boolean;
  draftEnabled?: boolean;
  summarizeEnabled?: boolean;
  escalationEnabled?: boolean;
  triggerConfig?: Record<string, unknown>;
};

export type OperatorOwnerSettingsUpdate = {
  personalDraftMode?: OperatorPersonalDraftMode;
};

export interface OperatorStore {
  upsertConversation(input: UpsertConversationInput): Promise<OperatorConversation>;
  insertObservation(input: InsertObservationInput): Promise<OperatorObservation>;
  insertPolicyDecision(input: InsertPolicyDecisionInput): Promise<OperatorPolicyDecision>;
  startAgentRun(input: StartAgentRunInput): Promise<OperatorAgentRun>;
  completeAgentRun(id: string, response: string, completedAt?: Date): Promise<void>;
  failAgentRun(id: string, error: string, completedAt?: Date): Promise<void>;
  insertOutput(input: InsertOutputInput): Promise<OperatorOutput>;
  markOutputDelivered(id: string, deliveredAt?: Date): Promise<void>;
  markOutputFailed(id: string, error: string): Promise<void>;
  insertAuditEvent(input: InsertAuditEventInput): Promise<void>;
  upsertTelegramSession(input: UpsertTelegramSessionInput): Promise<void>;
  upsertTelegramBusinessConnection(input: {
    id: string;
    ownerTelegramUserId: number;
    ownerPrivateChatId: number;
    isEnabled: boolean;
    canReply: boolean;
    rights: unknown;
    updatedAt: Date;
    lastCheckedAt?: Date;
  }): Promise<void>;
  getLatestAgentRunForConversation(conversationId: string): Promise<OperatorAgentRun | undefined>;
  listRecentObservations(conversationId: string, limit?: number): Promise<OperatorObservation[]>;
  listObservationsSince(input: ListObservationsSinceInput): Promise<OperatorObservation[]>;
  listObservationSlice(input: ListObservationSliceInput): Promise<OperatorObservationSliceItem[]>;
  listConversations(ownerUserId: string, limit?: number): Promise<OperatorConversation[]>;
  listConversationInbox(ownerUserId: string, limit?: number): Promise<OperatorConversationInboxItem[]>;
  listConversationObservations(input: {
    ownerUserId: string;
    conversationId: string;
    limit?: number;
  }): Promise<OperatorObservation[]>;
  listRecentOutputs(ownerUserId: string, limit?: number): Promise<OperatorOutput[]>;
  getConversationPolicy(conversationId: string): Promise<OperatorConversationPolicy>;
  getOwnerSettings(ownerUserId: string): Promise<OperatorOwnerSettings>;
  updateOwnerSettings(ownerUserId: string, update: OperatorOwnerSettingsUpdate): Promise<OperatorOwnerSettings>;
  markConversationSeen(input: {
    ownerUserId: string;
    conversationId: string;
    seenAt?: Date;
  }): Promise<void>;
  updateConversationPolicy(conversationId: string, update: ConversationPolicyUpdate): Promise<void>;
  close(): Promise<void>;
}

export type OperatorEnvelope = {
  conversation: OperatorConversation;
  observation: OperatorObservation;
  policyDecision: OperatorPolicyDecision;
};
