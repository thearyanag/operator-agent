import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelegramContextArtifact } from "../src/operator/context-artifact";
import type {
  OperatorAgentRun,
  OperatorEnvelope,
  OperatorObservation,
  OperatorStore,
} from "../src/operator/store";
import type { AppConfig, TelegramRunContext } from "../src/types";

test("writes a run-scoped Telegram context file and prompt pointer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "operator-context-"));
  const observations: OperatorObservation[] = [
    observation("obs-1", "2026-06-03T14:53:09.000Z", "Aryan", "oh"),
    observation("obs-2", "2026-06-03T14:53:10.000Z", "Aryan", "ok"),
    observation("obs-3", "2026-06-03T14:53:12.000Z", "Aryan", "what the heck"),
  ];
  const latestRun: OperatorAgentRun = {
    id: "11111111-1111-4111-8111-111111111111",
    conversationId: "conversation-1",
    observationId: null,
    mode: "team",
    status: "completed",
    prompt: "previous prompt",
    response: "previous response",
    error: null,
    startedAt: new Date("2026-06-03T14:53:00.000Z"),
    completedAt: new Date("2026-06-03T14:53:01.000Z"),
  };
  const store = {
    getLatestAgentRunForConversation: async () => latestRun,
    listObservationsSince: async () => observations,
    listRecentObservations: async () => observations.slice(-2).reverse(),
  } as unknown as OperatorStore;

  const artifact = await createTelegramContextArtifact({
    appConfig: { operatorContextDir: dir } as AppConfig,
    store,
    envelope: makeEnvelope(),
    runContext: makeRunContext(),
    runId: "run-1",
  });

  expect(artifact.path).toBe(join(dir, "run-1", "telegram-context.md"));
  expect(artifact.messageCount).toBe(3);
  expect(artifact.previewCount).toBe(2);
  expect(artifact.window).toBe("since_last_agent_run");
  expect(artifact.promptBlock).toContain("Full observed context file:");
  expect(artifact.promptBlock).toContain("what the heck");

  const file = await readFile(artifact.path, "utf8");
  expect(file).toContain("# Telegram Context");
  expect(file).toContain("Window: since_last_agent_run");
  expect(file).toContain("Aryan");
  expect(file).toContain("what the heck");
});

function makeEnvelope(): OperatorEnvelope {
  return {
    conversation: {
      id: "conversation-1",
      ownerUserId: "owner-1",
      platform: "telegram",
      mode: "team",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramBusinessConnectionId: null,
      title: "Test Group",
      status: "active",
      createdAt: new Date("2026-06-03T14:00:00.000Z"),
      updatedAt: new Date("2026-06-03T14:53:12.000Z"),
    },
    observation: observation("obs-3", "2026-06-03T14:53:12.000Z", "Aryan", "what the heck"),
    policyDecision: {
      id: "policy-1",
      conversationId: "conversation-1",
      observationId: "obs-3",
      action: "reply",
      reason: "tagged",
      confidence: 1,
      shouldInvokeAgent: true,
      createdAt: new Date("2026-06-03T14:53:12.000Z"),
    },
  };
}

function makeRunContext(): TelegramRunContext {
  return {
    surface: "group",
    sessionKey: "group:-1001",
    chatId: -1001,
    chatType: "supergroup",
    chatTitle: "Test Group",
    userId: 123,
    username: "aryan",
    sender: "Aryan",
    messageId: 3,
    text: "@bot last 3 messages?",
    prompt: "@bot last 3 messages?",
  };
}

function observation(id: string, observedAt: string, sender: string, text: string): OperatorObservation {
  return {
    id,
    conversationId: "conversation-1",
    platform: "telegram",
    platformMessageId: id,
    senderPlatformId: "123",
    senderDisplayName: sender,
    messageType: "text",
    text,
    rawPayload: {},
    observedAt: new Date(observedAt),
    createdAt: new Date(observedAt),
  };
}
