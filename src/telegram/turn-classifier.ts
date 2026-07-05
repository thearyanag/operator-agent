import type { TelegramMessageTurnEnvelope, TelegramTurnEnvelope } from "./turn-envelope";

export type TelegramTurnAction =
  | { kind: "control.start" }
  | { kind: "control.unsupported"; reason: string }
  | { kind: "prompt.run" }
  | { kind: "ignore"; reason: string };

function isStartCommand(text: string): boolean {
  return /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text.trim());
}

function hasLeadingBotCommand(envelope: TelegramMessageTurnEnvelope): boolean {
  const text = envelope.text;
  if (!text) return false;
  const entities = "entities" in envelope.message && Array.isArray(envelope.message.entities)
    ? envelope.message.entities
    : [];
  const commandEntity = entities.find((entity) => entity?.type === "bot_command" && entity?.offset === 0);
  if (!commandEntity || typeof commandEntity.length !== "number" || commandEntity.length <= 0) {
    return false;
  }
  return text.slice(0, commandEntity.length).startsWith("/");
}

function classifyMessageTurn(envelope: TelegramMessageTurnEnvelope): TelegramTurnAction {
  const text = envelope.text?.trim() ?? "";

  if (envelope.mode === "chat" && isStartCommand(text)) {
    return { kind: "control.start" };
  }

  if (envelope.mode === "guest" && isStartCommand(text)) {
    return { kind: "control.unsupported", reason: "guest_start_command" };
  }

  if (envelope.mode === "guest" && hasLeadingBotCommand(envelope)) {
    return { kind: "control.unsupported", reason: "guest_command" };
  }

  return { kind: "prompt.run" };
}

export function classifyTelegramTurn(envelope: TelegramTurnEnvelope): TelegramTurnAction {
  if (envelope.kind === "message") {
    return classifyMessageTurn(envelope);
  }

  return { kind: "ignore", reason: "unknown_turn" };
}
