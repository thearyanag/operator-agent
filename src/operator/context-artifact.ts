import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig, TelegramRunContext } from "../types";
import type { OperatorEnvelope, OperatorObservation, OperatorStore } from "./store";

const MAX_CONTEXT_MESSAGES = 200;
const FALLBACK_CONTEXT_MESSAGES = 100;
const PREVIEW_MESSAGES = 5;
const MAX_MESSAGE_CHARS = 4_000;

export type TelegramContextArtifact = {
  path: string;
  messageCount: number;
  previewCount: number;
  window: "since_last_agent_run" | "recent_fallback";
  windowStartAt: Date | null;
  windowEndAt: Date | null;
  promptBlock: string;
};

export async function createTelegramContextArtifact(input: {
  appConfig: AppConfig;
  store: OperatorStore;
  envelope: OperatorEnvelope;
  runContext: TelegramRunContext;
  runId: string;
}): Promise<TelegramContextArtifact> {
  const latestRun = await input.store.getLatestAgentRunForConversation(input.envelope.conversation.id);
  const observations = latestRun
    ? await input.store.listObservationsSince({
        conversationId: input.envelope.conversation.id,
        since: latestRun.startedAt,
        limit: MAX_CONTEXT_MESSAGES,
      })
    : (await input.store.listRecentObservations(input.envelope.conversation.id, FALLBACK_CONTEXT_MESSAGES)).reverse();
  const recentPreview = (await input.store.listRecentObservations(
    input.envelope.conversation.id,
    PREVIEW_MESSAGES,
  )).reverse();

  const runDir = join(input.appConfig.operatorContextDir, input.runId);
  const artifactPath = join(runDir, "telegram-context.md");
  await mkdir(runDir, { recursive: true });

  const windowStartAt = observations[0]?.observedAt ?? latestRun?.startedAt ?? null;
  const windowEndAt = observations[observations.length - 1]?.observedAt ?? null;
  await writeFile(
    artifactPath,
    renderContextMarkdown({
      envelope: input.envelope,
      runContext: input.runContext,
      observations,
      latestRunStartedAt: latestRun?.startedAt ?? null,
      window: latestRun ? "since_last_agent_run" : "recent_fallback",
      windowStartAt,
      windowEndAt,
    }),
    "utf8",
  );

  return {
    path: artifactPath,
    messageCount: observations.length,
    previewCount: recentPreview.length,
    window: latestRun ? "since_last_agent_run" : "recent_fallback",
    windowStartAt,
    windowEndAt,
    promptBlock: renderPromptBlock({
      artifactPath,
      recentPreview,
      window: latestRun ? "since_last_agent_run" : "recent_fallback",
      messageCount: observations.length,
    }),
  };
}

export function withTelegramContextPrompt(prompt: string, artifact: TelegramContextArtifact): string {
  return [
    artifact.promptBlock,
    "",
    "Current request:",
    prompt,
  ].join("\n");
}

function renderContextMarkdown(input: {
  envelope: OperatorEnvelope;
  runContext: TelegramRunContext;
  observations: OperatorObservation[];
  latestRunStartedAt: Date | null;
  window: TelegramContextArtifact["window"];
  windowStartAt: Date | null;
  windowEndAt: Date | null;
}): string {
  return [
    "# Telegram Context",
    "",
    `Conversation: ${input.envelope.conversation.title ?? input.runContext.chatTitle ?? input.envelope.conversation.telegramChatId}`,
    `Conversation ID: ${input.envelope.conversation.id}`,
    `Mode: ${input.envelope.conversation.mode}`,
    `Window: ${input.window}`,
    `Previous agent run started at: ${input.latestRunStartedAt?.toISOString() ?? "none"}`,
    `Window start: ${input.windowStartAt?.toISOString() ?? "unknown"}`,
    `Window end: ${input.windowEndAt?.toISOString() ?? "unknown"}`,
    `Message count: ${input.observations.length}`,
    "",
    "## Messages",
    "",
    ...input.observations.flatMap((observation) => renderObservation(observation)),
  ].join("\n");
}

function renderPromptBlock(input: {
  artifactPath: string;
  recentPreview: OperatorObservation[];
  window: TelegramContextArtifact["window"];
  messageCount: number;
}): string {
  return [
    "You are Operator in a Telegram conversation.",
    "",
    "Recent observed message preview:",
    ...input.recentPreview.map((observation) => `- ${formatObservationInline(observation)}`),
    "",
    `Full observed context file: ${input.artifactPath}`,
    `Context window: ${input.window}`,
    `Context message count: ${input.messageCount}`,
    "",
    "Read the context file when the user asks about previous messages, recent group history, what happened earlier, or anything that may depend on observed Telegram context.",
  ].join("\n");
}

function renderObservation(observation: OperatorObservation): string[] {
  return [
    `### ${observation.observedAt.toISOString()} | ${formatSender(observation)}`,
    "",
    clipMessage(observation.text ?? `[${observation.messageType}]`),
    "",
  ];
}

function formatObservationInline(observation: OperatorObservation): string {
  return `${observation.observedAt.toISOString()} | ${formatSender(observation)} | ${clipMessage(
    observation.text ?? `[${observation.messageType}]`,
  ).replace(/\s+/g, " ")}`;
}

function formatSender(observation: OperatorObservation): string {
  return observation.senderDisplayName ?? observation.senderPlatformId ?? "unknown";
}

function clipMessage(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_MESSAGE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_MESSAGE_CHARS - 14).trimEnd()}...[truncated]`;
}
