import { expect, test } from "bun:test";
import { GrammyError } from "grammy";
import {
  createTelegramGuestReplySink,
  createTelegramReplySink,
  GroupStreamingReplySink,
} from "../src/telegram/replies";
import type { AppConfig, TelegramRunContext } from "../src/types";

test("group reply sink reacts, types, and streams answer text through one edited message", async () => {
  const reactions: unknown[] = [];
  const chatActions: unknown[] = [];
  const richMessages: unknown[] = [];
  const richEdits: unknown[] = [];
  const ctx = {
    update: { update_id: 1 },
    chat: { id: -1001 },
    api: {
      sendChatAction: async (_chatId: number, action: string) => {
        chatActions.push(action);
        return true;
      },
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richMessages.push(payload);
          return { message_id: 10 };
        },
        editMessageText: async (payload: unknown) => {
          richEdits.push(payload);
          return true;
        },
      },
    },
    reply: async (text: string) => {
      richMessages.push({ fallback: text });
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
  expect(richMessages).toEqual([
    {
      chat_id: -1001,
      rich_message: { markdown: "partial answer" },
    },
  ]);
  expect(richEdits).toEqual([
    {
      chat_id: -1001,
      message_id: 10,
      rich_message: { markdown: "partial answer continued" },
    },
  ]);
  await sink.stop();
});

test("private reply sink streams rich message drafts and sends rich final replies", async () => {
  const chatActions: unknown[] = [];
  const drafts: unknown[] = [];
  const richMessages: unknown[] = [];
  const ctx = {
    update: { update_id: 42 },
    chat: { id: 1234 },
    api: {
      sendChatAction: async (_chatId: number, action: string) => {
        chatActions.push(action);
        return true;
      },
      raw: {
        sendRichMessageDraft: async (payload: unknown) => {
          drafts.push(payload);
          return true;
        },
        sendRichMessage: async (payload: unknown) => {
          richMessages.push(payload);
          return { message_id: 20 };
        },
      },
    },
  };

  const sink = createTelegramReplySink(
    ctx as never,
    {
      surface: "private",
      sessionKey: "private:1234",
      chatId: 1234,
      chatType: "private",
      text: "check",
      prompt: "check",
    } as TelegramRunContext,
    {
      enableTelegramNativeStreaming: true,
      telegramDraftIntervalMs: 10,
      telegramTypingIntervalMs: 4000,
    } as AppConfig,
  );

  await sink.start();
  sink.handleProgress({ type: "answer", text: "**partial answer**" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await sink.sendFinal("**final answer**");
  await sink.stop();

  expect(result).toEqual({ mode: "rich", chunkCount: 1 });
  expect(chatActions).toEqual(["typing"]);
  expect(drafts).toEqual([
    {
      chat_id: 1234,
      draft_id: 42,
      rich_message: { markdown: "**partial answer**" },
    },
  ]);
  expect(richMessages).toEqual([
    {
      chat_id: 1234,
      rich_message: { markdown: "**final answer**" },
    },
  ]);
});

test("guest reply sink answers guest query once and edits inline message", async () => {
  const answers: unknown[] = [];
  const edits: unknown[] = [];
  const ctx = {
    api: {
      answerGuestQuery: async (guestQueryId: string, result: unknown) => {
        answers.push({ guestQueryId, result });
        return { inline_message_id: "inline-1" };
      },
      raw: {
        editMessageText: async (payload: unknown) => {
          edits.push(payload);
          return true;
        },
      },
    },
  };

  const sink = createTelegramGuestReplySink(ctx as never, "guest-query-1");
  await sink.start();
  sink.handleProgress({ type: "answer", text: "partial answer" });
  await sink.stop();
  const result = await sink.sendFinal("**final answer**");

  expect(result).toEqual({ mode: "rich", chunkCount: 1 });
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({
    guestQueryId: "guest-query-1",
    result: {
      type: "article",
      input_message_content: {
        rich_message: { markdown: "Thinking..." },
      },
    },
  });
  expect(edits).toEqual([
    {
      inline_message_id: "inline-1",
      rich_message: { markdown: "**final answer**" },
    },
  ]);
});

test("guest reply sink retries rate-limited final inline edits without throwing", async () => {
  const edits: unknown[] = [];
  let editAttempts = 0;
  const ctx = {
    api: {
      answerGuestQuery: async () => ({ inline_message_id: "inline-1" }),
      raw: {
        editMessageText: async (payload: unknown) => {
          editAttempts += 1;
          edits.push(payload);
          if (editAttempts === 1) {
            throw new GrammyError(
              "Call to 'editMessageText' failed!",
              {
                ok: false,
                error_code: 429,
                description: "Too Many Requests: retry after 0",
                parameters: { retry_after: 0 },
              },
              "editMessageText",
              {},
            );
          }
          return true;
        },
      },
    },
  };

  const sink = createTelegramGuestReplySink(ctx as never, "guest-query-1");
  await sink.start();
  await sink.stop();

  await expect(sink.sendFinal("final answer")).resolves.toEqual({ mode: "rich", chunkCount: 1 });
  expect(editAttempts).toBe(2);
  expect(edits).toEqual([
    {
      inline_message_id: "inline-1",
      rich_message: { markdown: "final answer" },
    },
    {
      inline_message_id: "inline-1",
      rich_message: { markdown: "final answer" },
    },
  ]);
});
