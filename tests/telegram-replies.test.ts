import { expect, test } from "bun:test";
import {
  createTelegramReplySink,
  GroupStreamingReplySink,
} from "../src/telegram/replies";
import type { AppConfig, TelegramRunContext } from "../src/types";

test("group reply sink reacts, types, and streams answer text through one edited message", async () => {
  const reactions: unknown[] = [];
  const chatActions: unknown[] = [];
  const replies: string[] = [];
  const edits: string[] = [];
  const ctx = {
    update: { update_id: 1 },
    chat: { id: -1001 },
    api: {
      sendChatAction: async (_chatId: number, action: string) => {
        chatActions.push(action);
        return true;
      },
      editMessageText: async (_chatId: number, _messageId: number, text: string) => {
        edits.push(text);
        return true;
      },
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 10 };
    },
    react: async (reaction: unknown) => {
      reactions.push(reaction);
      return true;
    },
  };

  const sink = createTelegramReplySink(
    ctx as never,
    {
      surface: "group",
      sessionKey: "group:-1001",
      chatId: -1001,
      chatType: "supergroup",
      text: "@bot check",
      prompt: "@bot check",
    } as TelegramRunContext,
    {
      enableTelegramNativeStreaming: true,
      telegramDraftIntervalMs: 650,
      telegramTypingIntervalMs: 4000,
    } as AppConfig,
  );

  expect(sink).toBeInstanceOf(GroupStreamingReplySink);
  await sink.start();
  sink.handleProgress({ type: "thinking", text: "internal thinking" });
  sink.handleProgress({ type: "answer", text: "partial answer" });
  await new Promise((resolve) => setTimeout(resolve, 550));
  sink.handleProgress({ type: "answer", text: "partial answer continued" });
  await new Promise((resolve) => setTimeout(resolve, 550));
  expect(reactions).toEqual(["👍"]);
  expect(chatActions).toEqual(["typing"]);
  expect(replies).toEqual(["partial answer"]);
  expect(edits).toEqual(["partial answer continued"]);
  await sink.stop();
});
