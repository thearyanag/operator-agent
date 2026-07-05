import {
  classifyTelegramTurn,
  type TelegramTurnAction,
} from "./turn-classifier";
import type { TelegramTurnEnvelope } from "./turn-envelope";

export type TelegramTurnHarnessResult =
  | { kind: "handled"; action: TelegramTurnAction["kind"] }
  | { kind: "ignored"; reason: string };

export type TelegramTurnHarnessHandlers = {
  handleStart(
    envelope: TelegramTurnEnvelope,
    action: Extract<TelegramTurnAction, { kind: "control.start" }>,
  ): Promise<void>;
  handleUnsupported(
    envelope: TelegramTurnEnvelope,
    action: Extract<TelegramTurnAction, { kind: "control.unsupported" }>,
  ): Promise<void>;
  handlePromptRun(
    envelope: TelegramTurnEnvelope,
    action: Extract<TelegramTurnAction, { kind: "prompt.run" }>,
  ): Promise<void>;
  handleIgnored?(
    envelope: TelegramTurnEnvelope,
    action: Extract<TelegramTurnAction, { kind: "ignore" }>,
  ): Promise<void>;
};

export type TelegramTurnHarnessOptions = {
  classify?: (envelope: TelegramTurnEnvelope) => TelegramTurnAction;
  handlers: TelegramTurnHarnessHandlers;
};

export class TelegramTurnHarness {
  private readonly classify: (envelope: TelegramTurnEnvelope) => TelegramTurnAction;
  private readonly handlers: TelegramTurnHarnessHandlers;

  constructor(options: TelegramTurnHarnessOptions) {
    this.classify = options.classify ?? classifyTelegramTurn;
    this.handlers = options.handlers;
  }

  async handle(envelope: TelegramTurnEnvelope): Promise<TelegramTurnHarnessResult> {
    const action = this.classify(envelope);

    switch (action.kind) {
      case "control.start":
        await this.handlers.handleStart(envelope, action);
        return { kind: "handled", action: action.kind };
      case "control.unsupported":
        await this.handlers.handleUnsupported(envelope, action);
        return { kind: "handled", action: action.kind };
      case "prompt.run":
        await this.handlers.handlePromptRun(envelope, action);
        return { kind: "handled", action: action.kind };
      case "ignore":
        await this.handlers.handleIgnored?.(envelope, action);
        return { kind: "ignored", reason: action.reason };
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }
}
