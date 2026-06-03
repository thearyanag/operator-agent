import { expect, test } from "bun:test";
import { evaluateOperatorPolicy } from "../src/operator/policy";
import type {
  OperatorConversationMode,
  OperatorConversationPolicy,
  OperatorOwnerSettings,
} from "../src/operator/store";
import type { TelegramRunContext } from "../src/types";

function runContext(surface: TelegramRunContext["surface"] = "group"): TelegramRunContext {
  return {
    surface,
    sessionKey: `${surface}:1`,
    chatId: 1,
    chatType: surface === "group" ? "supergroup" : "private",
    chatTitle: surface === "group" ? "Team" : undefined,
    userId: 2,
    messageId: 3,
    text: "hello",
    prompt: "hello",
  };
}

function evaluate(mode: OperatorConversationMode, text: string, options: {
  status?: string;
  surface?: TelegramRunContext["surface"];
  botUsername?: string;
  botId?: number;
  ctx?: unknown;
  conversationPolicy?: OperatorConversationPolicy;
  ownerSettings?: OperatorOwnerSettings;
} = {}) {
  return evaluateOperatorPolicy({
    conversation: { mode, status: options.status },
    observationText: text,
    runContext: runContext(options.surface ?? (mode === "assistant" ? "private" : "group")),
    botUsername: options.botUsername,
    botId: options.botId,
    ctx: options.ctx as never,
    conversationPolicy: options.conversationPolicy,
    ownerSettings: options.ownerSettings,
  });
}

test("team conversations observe by default", () => {
  const policy = evaluate("team", "what is the current status?");

  expect(policy.action).toBe("observe");
  expect(policy.shouldInvokeAgent).toBe(false);
});

test("team conversations invoke only when Operator is tagged or replied to", () => {
  expect(evaluate("team", "@operator_bot please check this", { botUsername: "operator_bot" })).toMatchObject({
    action: "reply",
    shouldInvokeAgent: true,
  });

  const ctx = {
    message: {
      reply_to_message: {
        from: { id: 99 },
      },
    },
  };
  expect(evaluate("team", "please check this", { botId: 99, ctx })).toMatchObject({
    action: "reply",
    shouldInvokeAgent: true,
  });
});

test("assistant conversations reply immediately", () => {
  expect(evaluate("assistant", "investigate user 123", { surface: "private" })).toMatchObject({
    action: "reply",
    shouldInvokeAgent: true,
  });
});

test("personal conversations draft important messages and digest the rest", () => {
  expect(evaluate("personal", "Can you send this by EOD?")).toMatchObject({
    action: "draft",
    shouldInvokeAgent: true,
  });

  expect(evaluate("personal", "FYI I pushed the docs update")).toMatchObject({
    action: "summarize",
    shouldInvokeAgent: false,
  });
});

test("personal draft mode can draft every delegated message", () => {
  expect(evaluate("personal", "FYI I pushed the docs update", {
    ownerSettings: ownerSettings("draft_all"),
  })).toMatchObject({
    action: "draft",
    shouldInvokeAgent: true,
  });
});

test("personal draft mode can force digest only", () => {
  expect(evaluate("personal", "Can you send this by EOD?", {
    ownerSettings: ownerSettings("digest_only"),
  })).toMatchObject({
    action: "summarize",
    shouldInvokeAgent: false,
  });
});

test("conversation policy disables personal drafts and digests", () => {
  expect(evaluate("personal", "Can you send this by EOD?", {
    conversationPolicy: conversationPolicy({
      draftEnabled: false,
      summarizeEnabled: false,
    }),
  })).toMatchObject({
    action: "observe",
    shouldInvokeAgent: false,
  });
});

test("conversation policy can disable observation", () => {
  expect(evaluate("team", "@operator_bot check this", {
    botUsername: "operator_bot",
    conversationPolicy: conversationPolicy({
      observeEnabled: false,
    }),
  })).toMatchObject({
    action: "ignore",
    shouldInvokeAgent: false,
  });
});

test("paused conversations do not invoke the agent", () => {
  expect(evaluate("team", "@operator_bot check this", {
    botUsername: "operator_bot",
    status: "paused",
  })).toMatchObject({
    action: "ignore",
    shouldInvokeAgent: false,
  });
});

function conversationPolicy(update: Partial<OperatorConversationPolicy>): OperatorConversationPolicy {
  return {
    observeEnabled: true,
    autoReplyEnabled: false,
    draftEnabled: true,
    summarizeEnabled: true,
    escalationEnabled: true,
    triggerConfig: {},
    ...update,
  };
}

function ownerSettings(personalDraftMode: OperatorOwnerSettings["personalDraftMode"]): OperatorOwnerSettings {
  return {
    ownerUserId: "00000000-0000-4000-8000-000000000001",
    personalDraftMode,
    teamReplyMode: "mention_only",
    createdAt: new Date("2026-06-03T10:00:00.000Z"),
    updatedAt: new Date("2026-06-03T10:00:00.000Z"),
  };
}
