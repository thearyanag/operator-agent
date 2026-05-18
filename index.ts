import { Bot } from "grammy";
import { AuditLogger, serializeMessagesForAudit } from "./src/audit";
import { config, logStartupConfig } from "./src/config";
import { createPiBridge } from "./src/pi/bridge";
import { OperatorStateDb } from "./src/state/operator-db";
import { registerTelegramHandlers } from "./src/telegram/handlers";

const stateDb = new OperatorStateDb(config.operatorStateDbPath);
const auditLogger = new AuditLogger(stateDb);

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
  onSessionLoaded: async ({ sessionKey, modelFallbackMessage }) => {
    await auditLogger.log({
      event: "pi_session_loaded",
      sessionKey,
      response: modelFallbackMessage,
    });
  },
});

const bot = new Bot(config.telegramBotToken);

registerTelegramHandlers(bot, {
  appConfig: config,
  auditLogger,
  piBridge,
  stateDb,
});

logStartupConfig(config);
startHealthServer();

bot.start({
  drop_pending_updates: true,
  allowed_updates: config.telegramAllowedUpdates,
});

function startHealthServer(): void {
  const portValue = Bun.env.PORT?.trim();
  if (!portValue) return;

  const port = Number(portValue);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    console.warn(`Skipping health server because PORT is invalid: ${portValue}`);
    return;
  }

  Bun.serve({
    port,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/healthz" || pathname === "/") {
        return new Response("ok\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      return new Response("not found\n", { status: 404 });
    },
  });

  console.log(`Health server listening on port ${port}`);
}
