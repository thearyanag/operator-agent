import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OperatorStateDb } from "../src/state/operator-db";
import { BusinessConnectionStore, canReplyAsBusinessAccount } from "../src/telegram/business";
import { isBusinessMessageFromOwner } from "../src/telegram/handlers";

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

test("persists Telegram Business connection state in SQLite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "operator-agent-business-"));
  const stateDb = new OperatorStateDb(join(dir, "operator.sqlite"));
  const store = new BusinessConnectionStore(stateDb);

  store.set(makeConnection());

  const reloadedStore = new BusinessConnectionStore(stateDb);
  expect(reloadedStore.get("biz-1")).toMatchObject({
    id: "biz-1",
    ownerTelegramUserId: 123,
    ownerPrivateChatId: 456,
    isEnabled: true,
  });

  stateDb.close();
});

test("detects owner-authored Telegram Business messages", () => {
  const ownerConnection = {
    ownerTelegramUserId: 123,
  };

  expect(isBusinessMessageFromOwner({ from: { id: 123 } } as any, ownerConnection)).toBe(true);
  expect(isBusinessMessageFromOwner({ from: { id: 456 } } as any, ownerConnection)).toBe(false);
  expect(isBusinessMessageFromOwner({} as any, ownerConnection)).toBe(false);
});
