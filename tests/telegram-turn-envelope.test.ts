import { expect, test } from "bun:test";
import {
  extractGuestMessageTurnEnvelope,
  extractStandardMessageTurnEnvelope,
} from "../src/telegram/turn-envelope";

test("extracts standard Telegram message turn envelope", () => {
  const ctx = {
    message: {
      message_id: 10,
      chat: { id: 123, type: "private" },
      text: "hello",
      from: { id: 456, first_name: "Ada", username: "ada" },
    },
    chat: { id: 123, type: "private" },
    from: { id: 456, first_name: "Ada", username: "ada" },
  };

  const result = extractStandardMessageTurnEnvelope(ctx as never);

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.envelope.mode).toBe("chat");
    expect(result.envelope.chatId).toBe(123);
    expect(result.envelope.senderTelegramId).toBe(456);
    expect(result.envelope.text).toBe("hello");
  }
});

test("rejects guest Telegram message without guest query id", () => {
  const ctx = {
    guestMessage: {
      message_id: 10,
      chat: { id: -1001, type: "supergroup", title: "Ops" },
      text: "@operator help",
      from: { id: 456, first_name: "Ada", username: "ada" },
    },
  };

  const result = extractGuestMessageTurnEnvelope(ctx as never);

  expect(result).toMatchObject({
    ok: false,
    reason: "missing_guest_query_id",
  });
});

test("extracts guest Telegram message caller identity", () => {
  const ctx = {
    guestMessage: {
      message_id: 10,
      guest_query_id: "guest-query-1",
      chat: { id: -1001, type: "supergroup", title: "Ops" },
      text: "@operator help",
      from: { id: 111, first_name: "Forwarder" },
      guest_bot_caller_user: { id: 456, first_name: "Ada", username: "ada" },
    },
  };

  const result = extractGuestMessageTurnEnvelope(ctx as never);

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.envelope.mode).toBe("guest");
    expect(result.envelope.guestQueryId).toBe("guest-query-1");
    expect(result.envelope.senderTelegramId).toBe(456);
    expect(result.envelope.guestCallerSource).toBe("guest_bot_caller_user");
  }
});
