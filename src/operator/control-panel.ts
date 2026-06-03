import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../types";
import type {
  ConversationPolicyUpdate,
  OperatorOwnerSettingsUpdate,
  OperatorPersonalDraftMode,
  OperatorStore,
} from "./store";

export type ControlPanelDeps = {
  appConfig: AppConfig;
  operatorStore?: OperatorStore;
};

export async function handleControlPanelRequest(request: Request, deps: ControlPanelDeps): Promise<Response | undefined> {
  const url = new URL(request.url);

  if (url.pathname === "/app") {
    return htmlResponse(renderControlPanelHtml(deps.appConfig));
  }

  if (!url.pathname.startsWith("/api/")) {
    return undefined;
  }

  if (!isControlPanelAuthorized(request, deps.appConfig)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  if (request.method === "GET" && url.pathname === "/api/install-link") {
    if (!deps.appConfig.telegramBotUsername) {
      return jsonResponse({ error: "TELEGRAM_BOT_USERNAME is not configured" }, 400);
    }

    return jsonResponse({
      url: `https://t.me/${deps.appConfig.telegramBotUsername}?startgroup=operator`,
    });
  }

  if (!deps.operatorStore) {
    return jsonResponse({ error: "OPERATOR_DATABASE_URL is not configured" }, 503);
  }

  if (request.method === "GET" && url.pathname === "/api/conversations") {
    const conversations = await deps.operatorStore.listConversations(deps.appConfig.operatorOwnerId);
    return jsonResponse({ conversations });
  }

  if (request.method === "GET" && url.pathname === "/api/inbox") {
    const [items, outputs] = await Promise.all([
      deps.operatorStore.listConversationInbox(deps.appConfig.operatorOwnerId),
      deps.operatorStore.listRecentOutputs(deps.appConfig.operatorOwnerId, 50),
    ]);
    return jsonResponse({ items, outputs });
  }

  if (request.method === "GET" && url.pathname === "/api/settings") {
    const settings = await deps.operatorStore.getOwnerSettings(deps.appConfig.operatorOwnerId);
    return jsonResponse({
      settings,
      runtime: serializeRuntimeSettings(deps.appConfig),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/settings") {
    const update = await readJson<OperatorOwnerSettingsUpdate>(request);
    if (
      update.personalDraftMode !== undefined
      && !isOperatorPersonalDraftMode(update.personalDraftMode)
    ) {
      return jsonResponse({ error: "invalid personalDraftMode" }, 400);
    }

    const settings = await deps.operatorStore.updateOwnerSettings(deps.appConfig.operatorOwnerId, update);
    return jsonResponse({
      settings,
      runtime: serializeRuntimeSettings(deps.appConfig),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/outputs") {
    const outputs = await deps.operatorStore.listRecentOutputs(deps.appConfig.operatorOwnerId);
    return jsonResponse({ outputs });
  }

  const observationsMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/observations$/);
  if (request.method === "GET" && observationsMatch) {
    const observations = await deps.operatorStore.listConversationObservations({
      ownerUserId: deps.appConfig.operatorOwnerId,
      conversationId: observationsMatch[1]!,
      limit: parsePositiveInteger(url.searchParams.get("limit"), 80),
    });
    return jsonResponse({ observations });
  }

  const seenMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/seen$/);
  if (request.method === "POST" && seenMatch) {
    await deps.operatorStore.markConversationSeen({
      ownerUserId: deps.appConfig.operatorOwnerId,
      conversationId: seenMatch[1]!,
      seenAt: new Date(),
    });
    return jsonResponse({ ok: true });
  }

  const policyMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/policy$/);
  if (request.method === "POST" && policyMatch) {
    const update = await readJson<ConversationPolicyUpdate>(request);
    await deps.operatorStore.updateConversationPolicy(policyMatch[1]!, update);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "not found" }, 404);
}

function isControlPanelAuthorized(request: Request, appConfig: AppConfig): boolean {
  const url = new URL(request.url);
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = bearer || url.searchParams.get("token") || undefined;
  if (appConfig.operatorControlPanelToken && token === appConfig.operatorControlPanelToken) {
    return true;
  }

  const initData = request.headers.get("x-telegram-init-data") || url.searchParams.get("tgInitData") || "";
  if (!initData) return false;

  const verified = verifyTelegramWebAppInitData(initData, appConfig.telegramBotToken);
  if (!verified.ok || verified.userId === undefined) return false;

  const allowedTelegramUserIds = new Set([
    ...appConfig.allowedUserIds,
    ...appConfig.operatorOwnerTelegramIds,
  ]);
  if (allowedTelegramUserIds.size === 0) return false;
  return allowedTelegramUserIds.has(verified.userId);
}

function verifyTelegramWebAppInitData(initData: string, botToken: string): { ok: boolean; userId?: number } {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false };

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = createHmac("sha256", secret).update(dataCheckString).digest("hex");

  if (!safeEqualHex(hash, computed)) return { ok: false };

  const authDate = Number(params.get("auth_date"));
  if (Number.isFinite(authDate) && Date.now() / 1000 - authDate > 24 * 60 * 60) {
    return { ok: false };
  }

  const userRaw = params.get("user");
  if (!userRaw) return { ok: true };

  try {
    const user = JSON.parse(userRaw) as { id?: unknown };
    return { ok: true, userId: typeof user.id === "number" ? user.id : undefined };
  } catch {
    return { ok: true };
  }
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function parsePositiveInteger(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 500);
}

function isOperatorPersonalDraftMode(value: unknown): value is OperatorPersonalDraftMode {
  return value === "important_only" || value === "draft_all" || value === "digest_only";
}

function serializeRuntimeSettings(appConfig: AppConfig): Record<string, unknown> {
  return {
    botUsername: appConfig.telegramBotUsername ?? null,
    ownerUserId: appConfig.operatorOwnerId,
    ownerTelegramIds: [...appConfig.operatorOwnerTelegramIds],
    postgresConfigured: Boolean(appConfig.operatorDatabaseUrl),
    piProvider: appConfig.piProviderMode,
    piModel: appConfig.piModel ?? null,
    telegramBusinessAutomation: appConfig.enableTelegramBusinessAutomation,
    telegramBusinessDryRun: appConfig.telegramBusinessDryRun,
    telegramNativeStreaming: appConfig.enableTelegramNativeStreaming,
  };
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function renderControlPanelHtml(appConfig: AppConfig): string {
  const installLink = appConfig.telegramBotUsername
    ? `https://t.me/${appConfig.telegramBotUsername}?startgroup=operator`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Operator</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root {
      color-scheme: light dark;
      font-family: "Avenir Next", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      background: #101214;
      color: #f3f4ee;
      --bg: #101214;
      --panel: #171a1d;
      --panel-2: #1d2226;
      --line: #30383d;
      --muted: #98a29b;
      --text: #f3f4ee;
      --green: #77d17b;
      --amber: #d8a84f;
      --blue: #6fb7d8;
      --red: #e07979;
    }
    body {
      margin: 0;
      background:
        linear-gradient(180deg, rgba(111, 183, 216, 0.08), transparent 260px),
        var(--bg);
      color: var(--text);
    }
    .shell {
      max-width: 1160px;
      margin: 0 auto;
      padding: 16px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 12px 0 16px;
    }
    h1 {
      font-size: 22px;
      line-height: 1.2;
      margin: 0;
      letter-spacing: 0;
    }
    h2, h3 {
      margin: 0;
      letter-spacing: 0;
    }
    h2 {
      font-size: 15px;
    }
    h3 {
      font-size: 14px;
    }
    .muted {
      color: var(--muted);
      font-size: 12px;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    button, a.button {
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      padding: 8px 10px;
      border-radius: 6px;
      text-decoration: none;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      min-height: 34px;
    }
    button:hover, a.button:hover {
      border-color: #586269;
      background: #252c31;
    }
    button.primary {
      border-color: rgba(111, 183, 216, 0.55);
      background: rgba(111, 183, 216, 0.14);
      color: #d8f1fb;
    }
    button.danger {
      border-color: rgba(224, 121, 121, 0.45);
      color: #ffd5d5;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
    .stat {
      border: 1px solid var(--line);
      background: rgba(23, 26, 29, 0.88);
      border-radius: 8px;
      padding: 10px;
      min-width: 0;
    }
    .stat strong {
      display: block;
      font-size: 22px;
      line-height: 1.05;
    }
    .tabs {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
      margin-bottom: 12px;
    }
    .tab {
      background: transparent;
      border-color: var(--line);
      color: var(--muted);
    }
    .tab.active {
      background: #e5e1d2;
      color: #151719;
      border-color: #e5e1d2;
    }
    .workspace {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 390px;
      gap: 12px;
      align-items: start;
    }
    .panel {
      border: 1px solid var(--line);
      background: rgba(23, 26, 29, 0.92);
      border-radius: 8px;
      min-width: 0;
      overflow: hidden;
    }
    .panel-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 12px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.02);
    }
    .list {
      display: grid;
      gap: 0;
    }
    .row-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      padding: 12px;
      border-bottom: 1px solid rgba(48, 56, 61, 0.72);
      cursor: pointer;
    }
    .row-item:last-child {
      border-bottom: 0;
    }
    .row-item:hover, .row-item.selected {
      background: rgba(111, 183, 216, 0.08);
    }
    .title {
      font-weight: 680;
      overflow-wrap: anywhere;
      margin-bottom: 4px;
    }
    .preview {
      color: #c4c9c1;
      font-size: 13px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .pill-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
      align-content: start;
    }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 8px;
      color: #d7ddd5;
      font-size: 11px;
      white-space: nowrap;
      background: rgba(255, 255, 255, 0.03);
    }
    .pill.unread {
      border-color: rgba(216, 168, 79, 0.6);
      color: #f6d799;
    }
    .pill.personal {
      border-color: rgba(119, 209, 123, 0.48);
      color: #bdf2bf;
    }
    .pill.team {
      border-color: rgba(111, 183, 216, 0.48);
      color: #bae8fa;
    }
    .pill.assistant {
      border-color: rgba(229, 225, 210, 0.38);
      color: #e9e3d1;
    }
    .thread {
      max-height: calc(100vh - 226px);
      overflow: auto;
    }
    .message {
      padding: 11px 12px;
      border-bottom: 1px solid rgba(48, 56, 61, 0.55);
    }
    .message:last-child {
      border-bottom: 0;
    }
    .message-meta {
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 5px;
    }
    .message-text {
      font-size: 13px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .output {
      padding: 12px;
      border-bottom: 1px solid rgba(48, 56, 61, 0.72);
    }
    .output:last-child {
      border-bottom: 0;
    }
    .output pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 8px 0 0;
      color: #e2e7dd;
      font-family: inherit;
      font-size: 13px;
      line-height: 1.45;
    }
    .settings-panel {
      display: grid;
      gap: 0;
    }
    .setting-line {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(220px, auto);
      gap: 12px;
      align-items: center;
      padding: 12px;
      border-bottom: 1px solid rgba(48, 56, 61, 0.72);
    }
    .setting-line:last-child {
      border-bottom: 0;
    }
    .setting-value {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      flex-wrap: wrap;
      min-width: 0;
      overflow-wrap: anywhere;
      color: #dce3da;
      font-size: 13px;
    }
    .segmented {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .segmented button.active {
      background: #e5e1d2;
      color: #151719;
      border-color: #e5e1d2;
    }
    .empty {
      padding: 16px;
      color: var(--muted);
      font-size: 13px;
    }
    @media (max-width: 820px) {
      .stats {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .workspace {
        grid-template-columns: 1fr;
      }
      .setting-line {
        grid-template-columns: 1fr;
      }
      .setting-value, .segmented {
        justify-content: flex-start;
      }
      .thread {
        max-height: none;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>Operator</h1>
        <div class="muted">Inbox, drafts, and chat policy</div>
      </div>
      <div class="actions">
        <button class="primary" onclick="load()">Refresh</button>
        ${installLink ? `<a class="button" href="${installLink}">Add group</a>` : ""}
      </div>
    </header>

    <section class="stats">
      <div class="stat"><strong id="statUnread">0</strong><span class="muted">Unread</span></div>
      <div class="stat"><strong id="statDrafts">0</strong><span class="muted">Drafts</span></div>
      <div class="stat"><strong id="statDigests">0</strong><span class="muted">Digests</span></div>
      <div class="stat"><strong id="statChats">0</strong><span class="muted">Chats</span></div>
    </section>

    <nav class="tabs">
      <button id="tabInbox" class="tab active" onclick="setTab('inbox')">Inbox</button>
      <button id="tabDrafts" class="tab" onclick="setTab('drafts')">Drafts</button>
      <button id="tabChats" class="tab" onclick="setTab('chats')">Chats</button>
      <button id="tabSettings" class="tab" onclick="setTab('settings')">Settings</button>
    </nav>

    <section class="workspace">
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2 id="mainTitle">Inbox</h2>
            <div id="mainSubtitle" class="muted"></div>
          </div>
        </div>
        <div id="primaryList" class="list"></div>
      </div>

      <aside class="panel">
        <div class="panel-head">
          <div>
            <h2 id="threadTitle">Select chat</h2>
            <div id="threadSubtitle" class="muted"></div>
          </div>
          <div class="actions">
            <button id="markSeenButton" onclick="markSelectedSeen()">Seen</button>
          </div>
        </div>
        <div id="threadActions" class="actions" style="padding: 10px 12px; border-bottom: 1px solid var(--line);"></div>
        <div id="thread" class="thread"><div class="empty">No chat selected.</div></div>
      </aside>
    </section>
  </main>

  <script>
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
    }
    const initData = tg ? tg.initData : "";
    const browserToken = new URLSearchParams(window.location.search).get("token") || "";
    const ownerTelegramIds = new Set(${JSON.stringify([...appConfig.operatorOwnerTelegramIds])});
    const state = {
      tab: "inbox",
      items: [],
      outputs: [],
      settings: undefined,
      runtime: undefined,
      selectedId: undefined,
      observations: []
    };

    async function api(path, options = {}) {
      const url = new URL(path, window.location.origin);
      if (browserToken) {
        url.searchParams.set("token", browserToken);
      }
      const response = await fetch(url.toString(), {
        ...options,
        headers: {
          "content-type": "application/json",
          "x-telegram-init-data": initData,
          ...(options.headers || {})
        }
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }

    function clip(value, max = 180) {
      const text = String(value ?? "").replace(/\\s+/g, " ").trim();
      return text.length <= max ? text : text.slice(0, max - 13).trimEnd() + "...[truncated]";
    }

    function formatTime(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    }

    function conversationName(item) {
      const c = item.conversation || item;
      const last = item.lastObservation || {};
      if (c.title) return c.title;
      if (last.senderDisplayName && (c.mode !== "personal" || !isOwnerSender(last))) return last.senderDisplayName;
      if (c.mode === "assistant" && last.senderDisplayName) return last.senderDisplayName;
      if (c.mode === "personal") return "Personal chat";
      if (c.mode === "assistant") return "Assistant DM";
      return "Telegram chat";
    }

    function conversationMeta(item) {
      const c = item.conversation;
      const last = item.lastObservation || {};
      const parts = [c.telegramChatType || c.mode, formatTime(last.observedAt || c.updatedAt)].filter(Boolean);
      return parts.join(" / ");
    }

    function isOwnerSender(observation) {
      const senderId = Number(observation.senderPlatformId);
      return Number.isSafeInteger(senderId) && ownerTelegramIds.has(senderId);
    }

    function outputText(output) {
      const payload = output.payload || {};
      return payload.draft || payload.text || payload.summary || JSON.stringify(payload, null, 2);
    }

    function outputSource(output) {
      const payload = output.payload || {};
      return payload.sourceSender || payload.sourceConversationTitle || output.type;
    }

    function setTab(tab) {
      state.tab = tab;
      for (const name of ["inbox", "drafts", "chats", "settings"]) {
        document.getElementById("tab" + name[0].toUpperCase() + name.slice(1)).classList.toggle("active", name === tab);
      }
      render();
    }

    async function updateSettings(patch) {
      const data = await api("/api/settings", {
        method: "POST",
        body: JSON.stringify(patch)
      });
      state.settings = data.settings;
      state.runtime = data.runtime;
      render();
    }

    async function setStatus(id, status) {
      await api("/api/conversations/" + encodeURIComponent(id) + "/policy", {
        method: "POST",
        body: JSON.stringify({ status })
      });
      await load();
    }

    async function setPolicy(id, patch) {
      await api("/api/conversations/" + encodeURIComponent(id) + "/policy", {
        method: "POST",
        body: JSON.stringify(patch)
      });
      await load();
    }

    async function selectConversation(id) {
      state.selectedId = id;
      const data = await api("/api/conversations/" + encodeURIComponent(id) + "/observations?limit=80");
      state.observations = data.observations || [];
      render();
    }

    async function markSelectedSeen() {
      if (!state.selectedId) return;
      await api("/api/conversations/" + encodeURIComponent(state.selectedId) + "/seen", { method: "POST" });
      await load();
      await selectConversation(state.selectedId);
    }

    function renderConversationRow(item) {
      const c = item.conversation;
      const last = item.lastObservation || {};
      const selected = state.selectedId === c.id ? " selected" : "";
      const text = last.text || "No messages observed yet.";
      return '<div class="row-item' + selected + '" onclick="selectConversation(\\'' + c.id + '\\')">' +
        '<div><div class="title">' + escapeHtml(conversationName(item)) + '</div>' +
        '<div class="preview">' + escapeHtml(clip(text)) + '</div>' +
        '<div class="muted">' + escapeHtml(conversationMeta(item)) + '</div></div>' +
        '<div class="pill-row">' +
        (item.unreadCount > 0 ? '<span class="pill unread">' + item.unreadCount + ' unread</span>' : '') +
        '<span class="pill ' + escapeHtml(c.mode) + '">' + escapeHtml(c.mode) + '</span>' +
        '<span class="pill">' + escapeHtml(c.status) + '</span>' +
        '</div></div>';
    }

    function renderOutput(output) {
      const text = outputText(output);
      return '<div class="output">' +
        '<div class="pill-row" style="justify-content: space-between;"><div class="title">' + escapeHtml(output.type) + '</div><span class="pill">' + escapeHtml(output.status) + '</span></div>' +
        '<div class="muted">' + escapeHtml(outputSource(output)) + ' / ' + escapeHtml(formatTime(output.createdAt)) + '</div>' +
        '<pre>' + escapeHtml(text) + '</pre>' +
        (output.payload && output.payload.draft ? '<div class="actions" style="margin-top: 8px;"><button onclick="copyText(\\'' + escapeHtml(encodeURIComponent(output.payload.draft)) + '\\')">Copy</button></div>' : '') +
        '</div>';
    }

    async function copyText(encodedText) {
      const text = decodeURIComponent(encodedText);
      await navigator.clipboard.writeText(text);
    }

    function renderMessage(observation) {
      return '<div class="message">' +
        '<div class="message-meta">' + escapeHtml(observation.senderDisplayName || "Unknown sender") + ' / ' + escapeHtml(formatTime(observation.observedAt)) + '</div>' +
        '<div class="message-text">' + escapeHtml(observation.text || "[" + observation.messageType + "]") + '</div>' +
        '</div>';
    }

    function renderThread() {
      const item = state.items.find(entry => entry.conversation.id === state.selectedId);
      if (!item) {
        document.getElementById("threadTitle").textContent = "Select chat";
        document.getElementById("threadSubtitle").textContent = "";
        document.getElementById("threadActions").innerHTML = "";
        document.getElementById("thread").innerHTML = '<div class="empty">No chat selected.</div>';
        return;
      }

      const c = item.conversation;
      const policy = item.policy || {};
      document.getElementById("threadTitle").textContent = conversationName(item);
      document.getElementById("threadSubtitle").textContent = c.mode + " / " + c.status + " / " + (item.unreadCount || 0) + " unread";
      const nextStatus = c.status === "active" ? "paused" : "active";
      const draftLabel = policy.draftEnabled ? "Drafts on" : "Drafts off";
      const digestLabel = policy.summarizeEnabled ? "Digest on" : "Digest off";
      document.getElementById("threadActions").innerHTML =
        '<button onclick="setStatus(\\'' + c.id + '\\', \\'' + nextStatus + '\\')">' + nextStatus + '</button>' +
        '<button onclick="setPolicy(\\'' + c.id + '\\', { draftEnabled: ' + (!policy.draftEnabled) + ' })">' + draftLabel + '</button>' +
        '<button onclick="setPolicy(\\'' + c.id + '\\', { summarizeEnabled: ' + (!policy.summarizeEnabled) + ' })">' + digestLabel + '</button>' +
        '<button class="danger" onclick="setStatus(\\'' + c.id + '\\', \\'muted\\')">Mute</button>';
      document.getElementById("thread").innerHTML =
        state.observations.length ? state.observations.map(renderMessage).join("") : '<div class="empty">No observations yet.</div>';
    }

    function renderStats() {
      const unread = state.items.reduce((sum, item) => sum + (item.unreadCount || 0), 0);
      const drafts = state.outputs.filter(output => output.type === "draft").length;
      const digests = state.outputs.filter(output => output.type === "digest_item").length;
      document.getElementById("statUnread").textContent = String(unread);
      document.getElementById("statDrafts").textContent = String(drafts);
      document.getElementById("statDigests").textContent = String(digests);
      document.getElementById("statChats").textContent = String(state.items.length);
    }

    function renderSettings() {
      const settings = state.settings || {};
      const runtime = state.runtime || {};
      const personalDraftMode = settings.personalDraftMode || "important_only";
      const modes = [
        ["important_only", "Important only"],
        ["draft_all", "Draft all"],
        ["digest_only", "Digest only"]
      ];
      const modeButtons = modes.map(([value, label]) =>
        '<button class="' + (personalDraftMode === value ? "active" : "") + '" onclick="updateSettings({ personalDraftMode: \\'' + value + '\\' })">' +
          escapeHtml(label) +
        '</button>'
      ).join("");
      const ownerTelegramIds = Array.isArray(runtime.ownerTelegramIds) && runtime.ownerTelegramIds.length
        ? runtime.ownerTelegramIds.join(", ")
        : "not configured";
      const runtimeRows = [
        ["Bot", runtime.botUsername ? "@" + runtime.botUsername : "not configured"],
        ["Owner", ownerTelegramIds],
        ["Provider", [runtime.piProvider, runtime.piModel].filter(Boolean).join(" / ") || "default"],
        ["Postgres", runtime.postgresConfigured ? "configured" : "not configured"],
        ["Business", runtime.telegramBusinessAutomation ? (runtime.telegramBusinessDryRun ? "dry run" : "enabled") : "disabled"],
        ["Streaming", runtime.telegramNativeStreaming ? "enabled" : "disabled"]
      ];

      return '<div class="settings-panel">' +
        '<div class="setting-line">' +
          '<div><div class="title">Personal drafts</div><div class="muted">Business-account messages</div></div>' +
          '<div class="segmented">' + modeButtons + '</div>' +
        '</div>' +
        '<div class="setting-line">' +
          '<div><div class="title">Team replies</div><div class="muted">Group behavior</div></div>' +
          '<div class="setting-value"><span class="pill">Mention only</span></div>' +
        '</div>' +
        runtimeRows.map(([label, value]) =>
          '<div class="setting-line">' +
            '<div><div class="title">' + escapeHtml(label) + '</div></div>' +
            '<div class="setting-value">' + escapeHtml(value) + '</div>' +
          '</div>'
        ).join("") +
      '</div>';
    }

    function render() {
      renderStats();
      const primary = document.getElementById("primaryList");
      const title = document.getElementById("mainTitle");
      const subtitle = document.getElementById("mainSubtitle");

      if (state.tab === "drafts") {
        const outputs = state.outputs.filter(output => output.type === "draft" || output.type === "digest_item");
        title.textContent = "Drafts";
        subtitle.textContent = outputs.length + " recent outputs";
        primary.innerHTML = outputs.length ? outputs.map(renderOutput).join("") : '<div class="empty">No drafts or digest items yet.</div>';
      } else if (state.tab === "chats") {
        title.textContent = "Chats";
        subtitle.textContent = state.items.length + " monitored conversations";
        primary.innerHTML = state.items.length ? state.items.map(renderConversationRow).join("") : '<div class="empty">No conversations yet.</div>';
      } else if (state.tab === "settings") {
        title.textContent = "Settings";
        subtitle.textContent = "Owner preferences";
        primary.innerHTML = renderSettings();
      } else {
        const unreadItems = state.items.filter(item => item.unreadCount > 0);
        title.textContent = "Inbox";
        subtitle.textContent = unreadItems.length + " chats need review";
        primary.innerHTML = unreadItems.length ? unreadItems.map(renderConversationRow).join("") : '<div class="empty">Nothing unread.</div>';
      }

      renderThread();
    }

    async function load() {
      const [inboxData, settingsData] = await Promise.all([
        api("/api/inbox"),
        api("/api/settings")
      ]);
      state.items = inboxData.items || [];
      state.outputs = inboxData.outputs || [];
      state.settings = settingsData.settings;
      state.runtime = settingsData.runtime;
      if (!state.selectedId && state.items[0]) {
        state.selectedId = state.items[0].conversation.id;
        const details = await api("/api/conversations/" + encodeURIComponent(state.selectedId) + "/observations?limit=80");
        state.observations = details.observations || [];
      }
      render();
    }

    load().catch(error => {
      document.getElementById("primaryList").innerHTML = '<div class="empty">' + escapeHtml(error.message) + '</div>';
    });
  </script>
</body>
</html>`;
}
