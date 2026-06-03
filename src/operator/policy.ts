import type { Context } from "grammy";
import type { TelegramRunContext } from "../types";
import type {
  OperatorConversation,
  OperatorConversationMode,
  OperatorConversationPolicy,
  OperatorObservation,
  OperatorOwnerSettings,
  OperatorPolicyAction,
} from "./store";

export type PolicyEvaluation = {
  action: OperatorPolicyAction;
  reason: string;
  confidence: number;
  shouldInvokeAgent: boolean;
};

export function evaluateOperatorPolicy(input: {
  conversation: OperatorConversation | { mode: OperatorConversationMode; status?: string };
  observationText: string;
  runContext: TelegramRunContext;
  ctx?: Context;
  botUsername?: string;
  botId?: number;
  conversationPolicy?: OperatorConversationPolicy;
  ownerSettings?: OperatorOwnerSettings;
}): PolicyEvaluation {
  const status = input.conversation.status ?? "active";
  if (status === "paused" || status === "muted" || status === "archived") {
    return {
      action: "ignore",
      reason: `conversation status is ${status}`,
      confidence: 1,
      shouldInvokeAgent: false,
    };
  }

  if (input.conversationPolicy?.observeEnabled === false) {
    return {
      action: "ignore",
      reason: "conversation observation is disabled",
      confidence: 1,
      shouldInvokeAgent: false,
    };
  }

  if (input.conversation.mode === "assistant") {
    return {
      action: "reply",
      reason: "direct assistant conversation",
      confidence: 1,
      shouldInvokeAgent: true,
    };
  }

  if (input.conversation.mode === "team") {
    if (isBotTaggedOrRepliedTo({
      ctx: input.ctx,
      text: input.observationText,
      botUsername: input.botUsername,
      botId: input.botId,
    })) {
      return {
        action: "reply",
        reason: "team message tagged or replied to Operator",
        confidence: 0.95,
        shouldInvokeAgent: true,
      };
    }

    return {
      action: "observe",
      reason: "team conversation is read-only unless Operator is tagged or replied to",
      confidence: 1,
      shouldInvokeAgent: false,
    };
  }

  if (input.conversation.mode === "personal") {
    const draftEnabled = input.conversationPolicy?.draftEnabled ?? true;
    const summarizeEnabled = input.conversationPolicy?.summarizeEnabled ?? true;
    const personalDraftMode = input.ownerSettings?.personalDraftMode ?? "important_only";

    if (!draftEnabled) {
      return summarizeOrObserve({
        summarizeEnabled,
        reason: summarizeEnabled
          ? "personal drafts disabled for this chat; saved for digest"
          : "personal drafts and digest are disabled for this chat",
      });
    }

    if (personalDraftMode === "draft_all") {
      return {
        action: "draft",
        reason: "owner setting drafts all personal delegated messages",
        confidence: 0.8,
        shouldInvokeAgent: true,
      };
    }

    if (personalDraftMode === "digest_only") {
      return summarizeOrObserve({
        summarizeEnabled,
        reason: summarizeEnabled
          ? "owner setting saves personal delegated messages for digest only"
          : "personal digest is disabled for this chat",
      });
    }

    if (looksImportantForPersonalOperator(input.observationText)) {
      return {
        action: "draft",
        reason: "personal delegated message appears important or reply-worthy",
        confidence: 0.75,
        shouldInvokeAgent: true,
      };
    }

    return summarizeOrObserve({
      summarizeEnabled,
      reason: summarizeEnabled
        ? "personal delegated message saved for digest"
        : "personal digest is disabled for this chat",
    });
  }

  return {
    action: "observe",
    reason: "default observe policy",
    confidence: 0.5,
    shouldInvokeAgent: false,
  };
}

function summarizeOrObserve(input: {
  summarizeEnabled: boolean;
  reason: string;
}): PolicyEvaluation {
  if (input.summarizeEnabled) {
    return {
      action: "summarize",
      reason: input.reason,
      confidence: 0.7,
      shouldInvokeAgent: false,
    };
  }

  return {
    action: "observe",
    reason: input.reason,
    confidence: 0.8,
    shouldInvokeAgent: false,
  };
}

export function buildPersonalDraftPrompt(input: {
  observation: OperatorObservation;
  runContext: TelegramRunContext;
}): string {
  return [
    "You are Personal Operator drafting a Telegram reply for the account owner.",
    "The owner will review and edit this before sending. Do not send it yourself.",
    "Return only the draft reply text. Keep it concise and natural.",
    "",
    `Conversation: ${input.runContext.chatTitle ?? `chat ${input.runContext.chatId}`}`,
    `Sender: ${input.runContext.sender ?? input.observation.senderDisplayName ?? "unknown"}`,
    "",
    "Incoming message:",
    input.observation.text ?? input.runContext.text,
  ].join("\n");
}

export function buildPersonalDigestOutput(input: {
  observation: OperatorObservation;
  runContext: TelegramRunContext;
}): Record<string, unknown> {
  const text = input.observation.text ?? input.runContext.text;
  return {
    title: input.runContext.chatTitle ?? input.runContext.sender ?? "Telegram update",
    summary: clip(text, 500),
    priority: "normal",
    sourceObservationId: input.observation.id,
  };
}

function isBotTaggedOrRepliedTo(input: {
  ctx?: Context;
  text: string;
  botUsername?: string;
  botId?: number;
}): boolean {
  const maybeMe = input.ctx
    ? (input.ctx as Context & { me?: { id?: number; username?: string } }).me
    : undefined;
  const botUsername = input.botUsername ?? maybeMe?.username;
  const botId = input.botId ?? maybeMe?.id;

  if (botUsername && new RegExp(`(^|\\s)@${escapeRegExp(botUsername)}\\b`, "i").test(input.text)) {
    return true;
  }

  const replyTo = input.ctx?.message?.reply_to_message;
  if (botId !== undefined && replyTo?.from?.id === botId) {
    return true;
  }

  return false;
}

function looksImportantForPersonalOperator(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  if (/[?؟]$/.test(normalized)) return true;

  return [
    "urgent",
    "asap",
    "important",
    "can you",
    "could you",
    "please",
    "need your",
    "need you",
    "waiting",
    "follow up",
    "remind",
    "deadline",
    "issue",
    "blocked",
    "stuck",
    "not working",
  ].some((signal) => normalized.includes(signal));
}

function clip(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 14).trimEnd()}...[truncated]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
