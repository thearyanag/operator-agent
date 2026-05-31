import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppConfig } from "../types";

const MCP_CACHE_VERSION = 1;
const MCP_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SERVER_TIMEOUT_MS = 10_000;

type McpSettings = {
  directTools?: boolean | string[];
  toolPrefix?: "server" | "none" | "short";
  [key: string]: unknown;
};

type ServerEntry = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: string;
  bearerToken?: string;
  bearerTokenEnv?: string;
  exposeResources?: boolean;
  excludeTools?: string[];
  directTools?: boolean | string[];
  lifecycle?: "lazy" | "eager" | "keep-alive";
  idleTimeout?: number;
  debug?: boolean;
  [key: string]: unknown;
};

type McpConfig = {
  settings?: McpSettings;
  mcpServers: Record<string, ServerEntry>;
};

type CachedTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  uiResourceUri?: string;
  uiStreamMode?: "eager" | "stream-first";
};

type CachedResource = {
  uri: string;
  name: string;
  description?: string;
};

type ServerCacheEntry = {
  configHash: string;
  tools: CachedTool[];
  resources: CachedResource[];
  cachedAt: number;
};

type MetadataCache = {
  version: number;
  servers: Record<string, ServerCacheEntry>;
};

type PrewarmResult = {
  serverName: string;
  status: "cached" | "discovered" | "skipped" | "failed";
  toolCount?: number;
  resourceCount?: number;
  message?: string;
};

export async function prewarmMcpDirectToolCache(
  appConfig: Pick<AppConfig, "piWorkdir">,
  options: { serverTimeoutMs?: number } = {},
): Promise<PrewarmResult[]> {
  const serverTimeoutMs = options.serverTimeoutMs ?? DEFAULT_SERVER_TIMEOUT_MS;
  const config = await loadMcpConfig(appConfig.piWorkdir);
  const serverEntries = Object.entries(config.mcpServers);

  if (serverEntries.length === 0) {
    console.log("MCP cache prewarm: no MCP servers configured");
    return [];
  }

  const directServerEntries = serverEntries.filter(([, definition]) => isDirectToolsEnabled(config, definition));
  if (directServerEntries.length === 0) {
    console.log("MCP cache prewarm: no direct MCP tools configured");
    return serverEntries.map(([serverName]) => ({ serverName, status: "skipped" }));
  }

  const cachePath = getMetadataCachePath();
  const cache = await loadMetadataCache(cachePath);
  const results = await Promise.all(
    directServerEntries.map(async ([serverName, definition]) => {
      const existingEntry = cache?.servers?.[serverName];
      if (existingEntry && isServerCacheValid(existingEntry, definition)) {
        return {
          serverName,
          status: "cached" as const,
          toolCount: existingEntry.tools.length,
          resourceCount: existingEntry.resources.length,
        };
      }

      try {
        const discovered = await discoverServerMetadata(serverName, definition, serverTimeoutMs);
        await saveMetadataCache(cachePath, {
          version: MCP_CACHE_VERSION,
          servers: {
            [serverName]: {
              configHash: computeServerHash(definition),
              tools: discovered.tools,
              resources: discovered.resources,
              cachedAt: Date.now(),
            },
          },
        });

        return {
          serverName,
          status: "discovered" as const,
          toolCount: discovered.tools.length,
          resourceCount: discovered.resources.length,
        };
      } catch (error) {
        return {
          serverName,
          status: "failed" as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  logPrewarmResults(results);
  return results;
}

async function loadMcpConfig(cwd: string): Promise<McpConfig> {
  let config: McpConfig = { mcpServers: {} };

  for (const sourcePath of getMcpConfigPaths(cwd)) {
    const loaded = await readMcpConfig(sourcePath);
    if (!loaded) continue;
    config = mergeConfigs(config, loaded);
  }

  return config;
}

function getMcpConfigPaths(cwd: string): string[] {
  const home = homedir();
  return [
    join(home, ".config", "mcp", "mcp.json"),
    join(home, ".pi", "agent", "mcp.json"),
    resolve(cwd, ".mcp.json"),
    resolve(cwd, ".pi", "mcp.json"),
  ];
}

async function readMcpConfig(filePath: string): Promise<McpConfig | null> {
  if (!existsSync(filePath)) return null;

  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { mcpServers: {} };
    }

    const record = raw as Record<string, unknown>;
    const servers = record.mcpServers ?? record["mcp-servers"] ?? {};
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      return { mcpServers: {} };
    }

    return {
      mcpServers: servers as Record<string, ServerEntry>,
      settings:
        record.settings && typeof record.settings === "object" && !Array.isArray(record.settings)
          ? (record.settings as McpSettings)
          : undefined,
    };
  } catch (error) {
    console.warn(`MCP cache prewarm: failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function mergeConfigs(base: McpConfig, next: McpConfig): McpConfig {
  return {
    mcpServers: { ...base.mcpServers, ...next.mcpServers },
    settings: next.settings ? { ...base.settings, ...next.settings } : base.settings,
  };
}

function isDirectToolsEnabled(config: McpConfig, definition: ServerEntry): boolean {
  if (definition.directTools !== undefined) return Boolean(definition.directTools);
  return Boolean(config.settings?.directTools);
}

async function discoverServerMetadata(
  serverName: string,
  definition: ServerEntry,
  timeoutMs: number,
): Promise<{ tools: CachedTool[]; resources: CachedResource[] }> {
  if (!definition.command) {
    throw new Error(`server "${serverName}" is not a stdio MCP server; prewarm currently supports command-based servers`);
  }

  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const discovery = async () => {
    client = new Client({ name: `operator-agent-mcp-prewarm-${serverName}`, version: "1.0.0" });
    transport = new StdioClientTransport({
      command: definition.command!,
      args: definition.args ?? [],
      env: resolveEnv(definition.env),
      cwd: definition.cwd,
      stderr: definition.debug ? "inherit" : "ignore",
    });

    await client.connect(transport);
    const [tools, resources] = await Promise.all([fetchAllTools(client), fetchAllResources(client)]);
    return { tools: serializeTools(tools), resources: serializeResources(resources) };
  };

  try {
    return await Promise.race([
      discovery(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          void client?.close().catch(() => undefined);
          void transport?.close().catch(() => undefined);
          reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
  }
}

async function fetchAllTools(client: Client): Promise<Array<{ name: string; description?: string; inputSchema?: unknown; _meta?: unknown }>> {
  const allTools: Array<{ name: string; description?: string; inputSchema?: unknown; _meta?: unknown }> = [];
  let cursor: string | undefined;

  do {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    allTools.push(...(result.tools ?? []));
    cursor = result.nextCursor;
  } while (cursor);

  return allTools;
}

async function fetchAllResources(client: Client): Promise<Array<{ uri: string; name: string; description?: string }>> {
  try {
    const allResources: Array<{ uri: string; name: string; description?: string }> = [];
    let cursor: string | undefined;

    do {
      const result = await client.listResources(cursor ? { cursor } : undefined);
      allResources.push(...(result.resources ?? []));
      cursor = result.nextCursor;
    } while (cursor);

    return allResources;
  } catch {
    return [];
  }
}

function serializeTools(tools: Array<{ name: string; description?: string; inputSchema?: unknown }>): CachedTool[] {
  return tools
    .filter((tool) => tool?.name)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
}

function serializeResources(resources: Array<{ uri: string; name: string; description?: string }>): CachedResource[] {
  return resources
    .filter((resource) => resource?.uri && resource?.name)
    .map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
    }));
}

function resolveEnv(env?: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) resolved[key] = value;
  }

  if (!env) return resolved;

  for (const [key, value] of Object.entries(env)) {
    resolved[key] = value
      .replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "")
      .replace(/\$env:(\w+)/g, (_, name: string) => process.env[name] ?? "");
  }

  return resolved;
}

function getMetadataCachePath(): string {
  return join(homedir(), ".pi", "agent", "mcp-cache.json");
}

async function loadMetadataCache(cachePath: string): Promise<MetadataCache | null> {
  if (!existsSync(cachePath)) return null;

  try {
    const raw = JSON.parse(await readFile(cachePath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const cache = raw as MetadataCache;
    if (cache.version !== MCP_CACHE_VERSION || !cache.servers || typeof cache.servers !== "object") return null;
    return cache;
  } catch {
    return null;
  }
}

async function saveMetadataCache(cachePath: string, cache: MetadataCache): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });

  let merged: MetadataCache = { version: MCP_CACHE_VERSION, servers: {} };
  const existing = await loadMetadataCache(cachePath);
  if (existing) {
    merged = { version: MCP_CACHE_VERSION, servers: { ...existing.servers } };
  }

  merged.servers = { ...merged.servers, ...cache.servers };

  const tmpPath = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  await rename(tmpPath, cachePath);
}

function isServerCacheValid(entry: ServerCacheEntry, definition: ServerEntry): boolean {
  if (!entry || entry.configHash !== computeServerHash(definition)) return false;
  if (!entry.cachedAt || typeof entry.cachedAt !== "number") return false;
  if (Date.now() - entry.cachedAt > MCP_CACHE_MAX_AGE_MS) return false;
  return true;
}

function computeServerHash(definition: ServerEntry): string {
  const identity: Record<string, unknown> = {
    command: definition.command,
    args: definition.args,
    env: definition.env,
    cwd: definition.cwd,
    url: definition.url,
    headers: definition.headers,
    auth: definition.auth,
    bearerToken: definition.bearerToken,
    bearerTokenEnv: definition.bearerTokenEnv,
    exposeResources: definition.exposeResources,
    excludeTools: definition.excludeTools,
  };

  return createHash("sha256").update(stableStringify(identity)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "undefined" : serialized;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

function logPrewarmResults(results: PrewarmResult[]): void {
  for (const result of results) {
    if (result.status === "cached") {
      console.log(
        `MCP cache prewarm: ${result.serverName} already cached (${result.toolCount ?? 0} tools, ${result.resourceCount ?? 0} resources)`,
      );
      continue;
    }

    if (result.status === "discovered") {
      console.log(
        `MCP cache prewarm: ${result.serverName} discovered ${result.toolCount ?? 0} tools, ${result.resourceCount ?? 0} resources`,
      );
      continue;
    }

    if (result.status === "failed") {
      console.warn(`MCP cache prewarm: ${result.serverName} failed: ${result.message ?? "unknown error"}`);
    }
  }

  const discovered = results.filter((result) => result.status === "discovered" || result.status === "cached").length;
  console.log(`MCP cache prewarm complete: ${discovered}/${results.length} direct-tool servers ready`);
}
