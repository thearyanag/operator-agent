import type { Context } from "grammy";
import type { OperatorStore } from "../operator/store";
import type { OperatorStateDb } from "../state/operator-db";

export type TelegramBusinessConnection = NonNullable<Context["businessConnection"]>;

export type BusinessConnectionState = {
  id: string;
  ownerTelegramUserId: number;
  ownerPrivateChatId: number;
  isEnabled: boolean;
  rights?: TelegramBusinessConnection["rights"];
  updatedAt: string;
};

/**
 * Telegram sends connection state separately from business messages.
 * Keep the latest state in memory so message handlers can cheaply verify
 * whether the connected account still allows replies.
 */
export class BusinessConnectionStore {
  private readonly connections = new Map<string, BusinessConnectionState>();

  constructor(
    private readonly stateDb?: OperatorStateDb,
    private readonly operatorStore?: OperatorStore,
  ) {}

  get(id: string): BusinessConnectionState | undefined {
    const cached = this.connections.get(id);
    if (cached) return cached;

    const stored = this.stateDb?.getBusinessConnection(id);
    if (!stored) return undefined;

    const state: BusinessConnectionState = {
      id: stored.id,
      ownerTelegramUserId: stored.ownerTelegramUserId,
      ownerPrivateChatId: stored.ownerPrivateChatId,
      isEnabled: stored.isEnabled === 1,
      rights: parseStoredRights(stored.rightsJson),
      updatedAt: new Date(stored.updatedAt).toISOString(),
    };
    this.connections.set(id, state);
    return state;
  }

  set(connection: TelegramBusinessConnection): BusinessConnectionState {
    const state = normalizeBusinessConnection(connection);
    this.connections.set(state.id, state);
    this.stateDb?.upsertBusinessConnection({
      id: state.id,
      ownerTelegramUserId: state.ownerTelegramUserId,
      ownerPrivateChatId: state.ownerPrivateChatId,
      isEnabled: state.isEnabled,
      canReply: canReplyAsBusinessAccount(state),
      rightsJson: JSON.stringify(state.rights ?? {}),
      updatedAt: Date.parse(state.updatedAt),
      lastCheckedAt: Date.now(),
    });
    void this.operatorStore?.upsertTelegramBusinessConnection({
      id: state.id,
      ownerTelegramUserId: state.ownerTelegramUserId,
      ownerPrivateChatId: state.ownerPrivateChatId,
      isEnabled: state.isEnabled,
      canReply: canReplyAsBusinessAccount(state),
      rights: state.rights ?? {},
      updatedAt: new Date(state.updatedAt),
      lastCheckedAt: new Date(),
    }).catch((error) => {
      console.warn(`Failed to persist Telegram Business connection ${state.id} to Operator Postgres:`, error);
    });
    return state;
  }
}

export function normalizeBusinessConnection(connection: TelegramBusinessConnection): BusinessConnectionState {
  return {
    id: connection.id,
    ownerTelegramUserId: connection.user.id,
    ownerPrivateChatId: connection.user_chat_id,
    isEnabled: connection.is_enabled,
    rights: connection.rights,
    updatedAt: new Date().toISOString(),
  };
}

export function canReplyAsBusinessAccount(connection: BusinessConnectionState): boolean {
  return connection.isEnabled && connection.rights?.can_reply === true;
}

function parseStoredRights(rightsJson: string): TelegramBusinessConnection["rights"] | undefined {
  try {
    const parsed = JSON.parse(rightsJson) as TelegramBusinessConnection["rights"];
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
