import { Bot } from "grammy";
import { AuditLogger, serializeMessagesForAudit } from "./src/audit";
import { config, logStartupConfig } from "./src/config";
import { createPiBridge } from "./src/pi/bridge";
import { registerTelegramHandlers } from "./src/telegram/handlers";

const auditLogger = new AuditLogger(config.auditLogPath, config.auditLogMaxBytes);

const piBridge = await createPiBridge(config, {
  onEmptyResponse: async ({ sessionKey, prompt, newMessages, recentMessages, totalMessages, startMessageCount }) => {
    await auditLogger.log({
      event: "pi_empty_response",
      sessionKey,
      prompt,
      rawNewMessages: serializeMessagesForAudit(newMessages),
      rawRecentMessages: serializeMessagesForAudit(recentMessages),
      totalMessages,
      startMessageCount,
    });
  },
  onSessionLoaded: async ({ sessionKey, sessionFile, modelFallbackMessage }) => {
    await auditLogger.log({
      event: "pi_session_loaded",
      sessionKey,
      sessionFile,
      response: modelFallbackMessage,
    });
  },
});

const bot = new Bot(config.telegramBotToken);

registerTelegramHandlers(bot, {
  appConfig: config,
  auditLogger,
  piBridge,
});

logStartupConfig(config);

bot.start({
  drop_pending_updates: true,
  allowed_updates: config.telegramAllowedUpdates,
});
