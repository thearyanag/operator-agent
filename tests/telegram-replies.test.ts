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

test("guest reply sink answers guest query once and edits inline message", async () => {
  const answers: unknown[] = [];
  const edits: unknown[] = [];
  const ctx = {
    api: {
      answerGuestQuery: async (guestQueryId: string, result: unknown) => {
        answers.push({ guestQueryId, result });
        return { inline_message_id: "inline-1" };
      },
      editMessageTextInline: async (inlineMessageId: string, text: string, options: unknown) => {
        edits.push({ inlineMessageId, text, options });
        return true;
      },
    },
  };

  const sink = createTelegramGuestReplySink(ctx as never, "guest-query-1");
  await sink.start();
  sink.handleProgress({ type: "answer", text: "partial answer" });
  await sink.stop();
  const result = await sink.sendFinal("**final answer**");

  expect(result).toEqual({ mode: "html", chunkCount: 1 });
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({
    guestQueryId: "guest-query-1",
    result: {
      type: "article",
      input_message_content: {
        message_text: "Thinking...",
        parse_mode: "HTML",
      },
    },
  });
  expect(edits).toEqual([
    {
      inlineMessageId: "inline-1",
      text: "<b>final answer</b>",
      options: {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      },
    },
  ]);
});

test("guest reply sink retries rate-limited final inline edits without throwing", async () => {
  const edits: unknown[] = [];
  let editAttempts = 0;
  const ctx = {
    api: {
      answerGuestQuery: async () => ({ inline_message_id: "inline-1" }),
      editMessageTextInline: async (inlineMessageId: string, text: string, options: unknown) => {
        editAttempts += 1;
        edits.push({ inlineMessageId, text, options });
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
  };

  const sink = createTelegramGuestReplySink(ctx as never, "guest-query-1");
  await sink.start();
  await sink.stop();

  await expect(sink.sendFinal("final answer")).resolves.toEqual({ mode: "html", chunkCount: 1 });
  expect(editAttempts).toBe(2);
  expect(edits).toEqual([
    {
      inlineMessageId: "inline-1",
      text: "final answer",
      options: {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      },
    },
    {
      inlineMessageId: "inline-1",
      text: "final answer",
      options: {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      },
    },
  ]);
});
