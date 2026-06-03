import { Bot } from "grammy";
import { AuditLogger, serializeMessagesForAudit } from "./src/audit";
import { config, logStartupConfig } from "./src/config";
import { handleControlPanelRequest } from "./src/operator/control-panel";
import { createPostgresOperatorStore } from "./src/operator/postgres-store";
import type { OperatorStore } from "./src/operator/store";
import { createPiBridge } from "./src/pi/bridge";
import { prewarmMcpDirectToolCache } from "./src/pi/mcp-prewarm";
import { OperatorStateDb } from "./src/state/operator-db";
import { registerTelegramHandlers } from "./src/telegram/handlers";

const stateDb = new OperatorStateDb(config.operatorStateDbPath);
const operatorStore = await createOperatorStore();
const auditLogger = new AuditLogger(stateDb, operatorStore);

try {
  await prewarmMcpDirectToolCache(config);
} catch (error) {
  console.warn(`MCP cache prewarm failed before pi startup: ${error instanceof Error ? error.message : String(error)}`);
}

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
}, {
  operatorStore,
});

const bot = new Bot(config.telegramBotToken);

registerTelegramHandlers(bot, {
  appConfig: config,
  auditLogger,
  piBridge,
  stateDb,
  operatorStore,
});

logStartupConfig(config);
startHealthServer(operatorStore);

bot.start({
  drop_pending_updates: true,
  allowed_updates: config.telegramAllowedUpdates,
});

async function createOperatorStore(): Promise<OperatorStore | undefined> {
  if (!config.operatorDatabaseUrl) return undefined;

  return createPostgresOperatorStore(config.operatorDatabaseUrl, config.operatorOwnerId);
}

function startHealthServer(operatorStore?: OperatorStore): void {
  const portValue = Bun.env.PORT?.trim();
  if (!portValue) return;

  const port = Number(portValue);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    console.warn(`Skipping health server because PORT is invalid: ${portValue}`);
    return;
  }

  Bun.serve({
    port,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const controlPanelResponse = await handleControlPanelRequest(request, {
        appConfig: config,
        operatorStore,
      });
      if (controlPanelResponse) return controlPanelResponse;

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
