import { expect, test } from "bun:test";
import { BusinessConnectionStore, canReplyAsBusinessAccount } from "../src/telegram/business";

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "biz-1",
    user: {
      id: 123,
      is_bot: false,
      first_name: "Ari",
    },
    user_chat_id: 456,
    date: 1,
    is_enabled: true,
    rights: {
      can_reply: true,
    },
    ...overrides,
  } as any;
}

test("stores normalized Telegram Business connection state", () => {
  const store = new BusinessConnectionStore();
  const state = store.set(makeConnection());

  expect(state.id).toBe("biz-1");
  expect(state.ownerTelegramUserId).toBe(123);
  expect(state.ownerPrivateChatId).toBe(456);
  expect(state.isEnabled).toBe(true);
  expect(state.rights?.can_reply).toBe(true);
  expect(store.get("biz-1")).toEqual(state);
});

test("requires enabled connection and can_reply to reply as business account", () => {
  const store = new BusinessConnectionStore();

  expect(canReplyAsBusinessAccount(store.set(makeConnection()))).toBe(true);
  expect(canReplyAsBusinessAccount(store.set(makeConnection({ is_enabled: false })))).toBe(false);
  expect(canReplyAsBusinessAccount(store.set(makeConnection({ rights: {} })))).toBe(false);
});
