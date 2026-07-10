import { Bot } from "grammy";
import { AuditLogger, serializeMessagesForAudit } from "./src/audit";
import { config, logStartupConfig } from "./src/config";
import { handleControlPanelRequest } from "./src/operator/control-panel";
import { createPostgresOperatorStore } from "./src/operator/postgres-store";
import type { OperatorStore } from "./src/operator/store";
import { createPiBridge } from "./src/pi/bridge";
import { prewarmMcpDirectToolCache } from "./src/pi/mcp-prewarm";
import { OperatorStateDb } from "./src/state/operator-db";
import { TelegramGuestMediaStore } from "./src/telegram/guest-media";
import { registerTelegramHandlers } from "./src/telegram/handlers";

const stateDb = new OperatorStateDb(config.operatorStateDbPath);
const guestMediaStore = new TelegramGuestMediaStore({
  publicUrl: config.operatorPublicUrl,
  spoolDir: config.operatorGuestMediaDir,
  attachmentValidation: {
    workdir: config.piWorkdir,
    allowedRoots: config.telegramAttachmentRoots,
    maxDocumentBytes: config.telegramMaxDocumentBytes,
  },
});
let operatorStore: OperatorStore | undefined;
startHealthServer(() => operatorStore, guestMediaStore);
void guestMediaStore.pruneExpired().catch((error) => {
  console.warn(`Failed to prune expired Telegram guest media: ${error instanceof Error ? error.message : String(error)}`);
});

console.log("Initializing Operator store");
operatorStore = await createOperatorStore();
const auditLogger = new AuditLogger(stateDb, operatorStore);

try {
  console.log("Prewarming MCP direct tool cache");
  await prewarmMcpDirectToolCache(config);
} catch (error) {
  console.warn(`MCP cache prewarm failed before pi startup: ${error instanceof Error ? error.message : String(error)}`);
}

console.log("Initializing pi bridge");
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
  guestMediaStore,
});

logStartupConfig(config);
await verifyTelegramGuestModeSupport(bot);

bot.start({
  drop_pending_updates: true,
  allowed_updates: config.telegramAllowedUpdates as never,
});

async function createOperatorStore(): Promise<OperatorStore | undefined> {
  if (!config.operatorDatabaseUrl) return undefined;

  return createPostgresOperatorStore(config.operatorDatabaseUrl, config.operatorOwnerId);
}

function startHealthServer(
  getOperatorStore: () => OperatorStore | undefined,
  mediaStore: TelegramGuestMediaStore,
): void {
  const portValue = Bun.env.PORT?.trim();
  if (!portValue) {
    if (mediaStore.enabled) {
      console.warn("OPERATOR_PUBLIC_URL is configured, but PORT is not set; Telegram guest media URLs will not be served.");
    }
    return;
  }

  const port = Number(portValue);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    console.warn(`Skipping health server because PORT is invalid: ${portValue}`);
    return;
  }

  Bun.serve({
    port,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const guestMediaResponse = await mediaStore.handleRequest(request);
      if (guestMediaResponse) return guestMediaResponse;

      const controlPanelResponse = await handleControlPanelRequest(request, {
        appConfig: config,
        operatorStore: getOperatorStore(),
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

async function verifyTelegramGuestModeSupport(bot: Bot): Promise<void> {
  try {
    const me = await bot.api.getMe();
    if (!(me as { supports_guest_queries?: boolean }).supports_guest_queries) {
      console.warn("Telegram bot does not report supports_guest_queries. Enable Guest Mode in BotFather before rollout.");
    }
  } catch (error) {
    console.warn(`Could not verify Telegram guest mode support: ${error instanceof Error ? error.message : String(error)}`);
  }
}
