import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { loadConfig } from "../src/config";
import { handleControlPanelRequest } from "../src/operator/control-panel";

const baseEnv = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_BOT_USERNAME: "operator_bot",
  OPERATOR_CONTROL_PANEL_TOKEN: "panel-token",
};

test("serves Telegram group install link without requiring Postgres", async () => {
  const appConfig = loadConfig(baseEnv, "/tmp/operator-agent");
  const response = await handleControlPanelRequest(
    new Request("http://localhost/api/install-link?token=panel-token"),
    { appConfig },
  );

  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    url: "https://t.me/operator_bot?startgroup=operator",
  });
});

test("protects control panel APIs with the configured token", async () => {
  const appConfig = loadConfig(baseEnv, "/tmp/operator-agent");
  const response = await handleControlPanelRequest(
    new Request("http://localhost/api/install-link?token=wrong"),
    { appConfig },
  );

  expect(response?.status).toBe(401);
});

test("control panel APIs fail closed without token or allowed Telegram init data", async () => {
  const appConfig = loadConfig({
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_BOT_USERNAME: "operator_bot",
  }, "/tmp/operator-agent");
  const initData = buildTelegramInitData("test-token", 123);

  const noAuthResponse = await handleControlPanelRequest(
    new Request("http://localhost/api/install-link"),
    { appConfig },
  );
  const unallowedTelegramResponse = await handleControlPanelRequest(
    new Request("http://localhost/api/install-link", {
      headers: {
        "x-telegram-init-data": initData,
      },
    }),
    { appConfig },
  );

  expect(noAuthResponse?.status).toBe(401);
  expect(unallowedTelegramResponse?.status).toBe(401);
});

test("control panel accepts Telegram init data from owner Telegram IDs", async () => {
  const appConfig = loadConfig({
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_BOT_USERNAME: "operator_bot",
    OPERATOR_OWNER_TELEGRAM_IDS: "123",
  }, "/tmp/operator-agent");
  const response = await handleControlPanelRequest(
    new Request("http://localhost/api/install-link", {
      headers: {
        "x-telegram-init-data": buildTelegramInitData("test-token", 123),
      },
    }),
    { appConfig },
  );

  expect(response?.status).toBe(200);
});

test("browser control panel forwards query token to API calls", async () => {
  const appConfig = loadConfig(baseEnv, "/tmp/operator-agent");
  const response = await handleControlPanelRequest(new Request("http://localhost/app?token=panel-token"), {
    appConfig,
  });
  const html = await response?.text();

  expect(response?.status).toBe(200);
  expect(html).toContain("browserToken");
  expect(html).toContain('url.searchParams.set("token", browserToken)');
});

test("serves Mini App inbox data from Operator store", async () => {
  const appConfig = loadConfig(baseEnv, "/tmp/operator-agent");
  const store = {
    listConversationInbox: async (ownerUserId: string) => [
      {
        conversation: {
          id: "conversation-1",
          ownerUserId,
          platform: "telegram",
          mode: "personal",
          telegramChatId: "123",
          telegramChatType: "private",
          telegramBusinessConnectionId: "biz-1",
          title: null,
          status: "active",
          createdAt: new Date("2026-06-03T10:00:00.000Z"),
          updatedAt: new Date("2026-06-03T10:00:00.000Z"),
        },
        policy: {
          observeEnabled: true,
          autoReplyEnabled: false,
          draftEnabled: true,
          summarizeEnabled: true,
          escalationEnabled: true,
          triggerConfig: {},
        },
        lastObservation: null,
        unreadCount: 2,
        lastSeenAt: null,
      },
    ],
    listRecentOutputs: async () => [],
  };

  const response = await handleControlPanelRequest(new Request("http://localhost/api/inbox?token=panel-token"), {
    appConfig,
    operatorStore: store as any,
  });
  const body = (await response?.json()) as { items: Array<{ unreadCount: number }> };

  expect(response?.status).toBe(200);
  expect(body.items).toHaveLength(1);
  expect(body.items[0]?.unreadCount).toBe(2);
});

test("serves and updates owner settings", async () => {
  const appConfig = loadConfig(baseEnv, "/tmp/operator-agent");
  let personalDraftMode = "important_only";
  const store = {
    getOwnerSettings: async (ownerUserId: string) => ({
      ownerUserId,
      personalDraftMode,
      teamReplyMode: "mention_only",
      createdAt: new Date("2026-06-03T10:00:00.000Z"),
      updatedAt: new Date("2026-06-03T10:00:00.000Z"),
    }),
    updateOwnerSettings: async (ownerUserId: string, update: { personalDraftMode?: string }) => {
      personalDraftMode = update.personalDraftMode ?? personalDraftMode;
      return {
        ownerUserId,
        personalDraftMode,
        teamReplyMode: "mention_only",
        createdAt: new Date("2026-06-03T10:00:00.000Z"),
        updatedAt: new Date("2026-06-03T10:01:00.000Z"),
      };
    },
  };

  const getResponse = await handleControlPanelRequest(
    new Request("http://localhost/api/settings?token=panel-token"),
    {
      appConfig,
      operatorStore: store as any,
    },
  );
  const postResponse = await handleControlPanelRequest(
    new Request("http://localhost/api/settings?token=panel-token", {
      method: "POST",
      body: JSON.stringify({ personalDraftMode: "draft_all" }),
    }),
    {
      appConfig,
      operatorStore: store as any,
    },
  );
  const invalidResponse = await handleControlPanelRequest(
    new Request("http://localhost/api/settings?token=panel-token", {
      method: "POST",
      body: JSON.stringify({ personalDraftMode: "auto_send" }),
    }),
    {
      appConfig,
      operatorStore: store as any,
    },
  );

  expect(getResponse?.status).toBe(200);
  const getBody = await getResponse?.json() as { settings: { personalDraftMode: string } };
  expect(getBody.settings.personalDraftMode).toBe("important_only");
  expect(postResponse?.status).toBe(200);
  const postBody = await postResponse?.json() as { settings: { personalDraftMode: string } };
  expect(postBody.settings.personalDraftMode).toBe("draft_all");
  expect(invalidResponse?.status).toBe(400);
});

test("serves observations and marks conversations seen", async () => {
  const appConfig = loadConfig(baseEnv, "/tmp/operator-agent");
  const calls: string[] = [];
  const store = {
    listConversationObservations: async (input: { conversationId: string; limit?: number }) => {
      calls.push(`observations:${input.conversationId}:${input.limit}`);
      return [];
    },
    markConversationSeen: async (input: { conversationId: string }) => {
      calls.push(`seen:${input.conversationId}`);
    },
  };

  const observationsResponse = await handleControlPanelRequest(
    new Request("http://localhost/api/conversations/conversation-1/observations?limit=15&token=panel-token"),
    {
      appConfig,
      operatorStore: store as any,
    },
  );
  const seenResponse = await handleControlPanelRequest(
    new Request("http://localhost/api/conversations/conversation-1/seen?token=panel-token", { method: "POST" }),
    {
      appConfig,
      operatorStore: store as any,
    },
  );

  expect(observationsResponse?.status).toBe(200);
  expect(seenResponse?.status).toBe(200);
  expect(calls).toEqual(["observations:conversation-1:15", "seen:conversation-1"]);
});

function buildTelegramInitData(botToken: string, userId: number): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "test-query",
    user: JSON.stringify({
      id: userId,
      first_name: "Test",
    }),
  });
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}
