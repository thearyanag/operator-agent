import type { Context } from "grammy";

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

  get(id: string): BusinessConnectionState | undefined {
    return this.connections.get(id);
  }

  set(connection: TelegramBusinessConnection): BusinessConnectionState {
    const state = normalizeBusinessConnection(connection);
    this.connections.set(state.id, state);
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
