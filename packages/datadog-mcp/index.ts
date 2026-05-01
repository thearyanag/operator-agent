// @ts-nocheck
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { client, v2 } from "@datadog/datadog-api-client";

// --- Env validation ---

const DD_API_KEY = process.env.DD_API_KEY;
const DD_APP_KEY = process.env.DD_APP_KEY;

if (!DD_API_KEY || !DD_APP_KEY) {
  console.error("DD_API_KEY and DD_APP_KEY environment variables are required");
  process.exit(1);
}

// --- Client init ---

const configuration = client.createConfiguration();
if (process.env.DD_SITE) {
  configuration.setServerVariables({ site: process.env.DD_SITE });
}
const logsApi = new v2.LogsApi(configuration);

// --- Helpers ---

function buildQuery(params: {
  query?: string;
  service?: string;
  env?: string;
  status?: string;
}): string {
  const parts: string[] = [];
  if (params.service) parts.push(`service:${params.service}`);
  if (params.env) parts.push(`env:${params.env}`);
  if (params.status) parts.push(`status:${params.status}`);
  if (params.query) parts.push(params.query);
  return parts.length > 0 ? parts.join(" AND ") : "*";
}

function formatLog(log: v2.Log): Record<string, unknown> {
  const attrs = log.attributes ?? {};
  return {
    id: log.id,
    timestamp: attrs.timestamp,
    service: attrs.service,
    status: attrs.status,
    host: attrs.host,
    message: attrs.message,
    tags: attrs.tags,
    attributes: attrs.attributes,
  };
}

// --- Server ---

const server = new McpServer({
  name: "datadog-logs",
  version: "1.0.0",
});

// Tool 1: Search/query logs
server.tool(
  "getLogs",
  "Search and retrieve logs from Datadog",
  {
    query: z
      .string()
      .optional()
      .describe("Raw Datadog query string (e.g. @http.status_code:500)"),
    service: z.string().optional().describe("Filter by service name"),
    env: z.string().optional().describe("Filter by environment"),
    status: z
      .enum(["error", "warn", "info", "debug"])
      .optional()
      .describe("Filter by log level"),
    timeRange: z
      .string()
      .default("now-15m")
      .describe("Lookback window (e.g. now-15m, now-1h, now-1d)"),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(25)
      .describe("Max logs to return"),
  } as any,
  async ({ query, service, env, status, timeRange, limit }: {
    query?: string;
    service?: string;
    env?: string;
    status?: "error" | "warn" | "info" | "debug";
    timeRange: string;
    limit: number;
  }) => {
    try {
      const filterQuery = buildQuery({ query, service, env, status });

      const response = await logsApi.listLogs({
        body: {
          filter: {
            query: filterQuery,
            from: timeRange,
            to: "now",
          },
          page: { limit },
          sort: "-timestamp" as v2.LogsSort,
        },
      });

      const logs = (response.data ?? []).map(formatLog);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { query: filterQuery, count: logs.length, logs },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: Get a single log by ID
server.tool(
  "getLogById",
  "Retrieve a single log entry by its ID",
  {
    logId: z.string().describe("The Datadog log ID"),
  } as any,
  async ({ logId }: { logId: string }) => {
    try {
      const response = await logsApi.listLogs({
        body: {
          filter: {
            query: `@_id:${logId}`,
            from: "now-30d",
            to: "now",
          },
          page: { limit: 1 },
        },
      });

      const logs = (response.data ?? []).map(formatLog);

      if (logs.length === 0) {
        return {
          content: [{ type: "text", text: `Log with ID '${logId}' not found` }],
          isError: true,
        };
      }

      return {
        content: [
          { type: "text", text: JSON.stringify(logs[0], null, 2) },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: List available services
server.tool(
  "getServices",
  "List all services that have emitted logs in the given time range",
  {
    env: z.string().optional().describe("Filter by environment"),
    timeRange: z
      .string()
      .default("now-1h")
      .describe("Lookback window (e.g. now-1h, now-1d)"),
  } as any,
  async ({ env, timeRange }: { env?: string; timeRange: string }) => {
    try {
      const filterQuery = buildQuery({ env });

      const response = await logsApi.aggregateLogs({
        body: {
          filter: {
            query: filterQuery,
            from: timeRange,
            to: "now",
          },
          compute: [
            { type: "total" as any, aggregation: "count" as any },
          ],
          groupBy: [
            {
              facet: "service",
              limit: 1000,
              sort: { aggregation: "count" as any, type: "measure" as any, order: "desc" as any },
            },
          ],
        },
      });

      const buckets = (response.data as any)?.buckets ?? [];
      const services = buckets.map((b: any) => ({
        service: b.by?.service,
        count: b.computes?.c0,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { count: services.length, services },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: Aggregate logs (analytics/counts)
server.tool(
  "aggregateLogs",
  "Get log counts, optionally grouped by a field (e.g. service, status, host)",
  {
    query: z
      .string()
      .optional()
      .describe("Raw Datadog query string"),
    service: z.string().optional().describe("Filter by service name"),
    env: z.string().optional().describe("Filter by environment"),
    timeRange: z
      .string()
      .default("now-15m")
      .describe("Lookback window (e.g. now-15m, now-1h)"),
    groupBy: z
      .string()
      .optional()
      .describe("Field to group by (e.g. service, status, host)"),
  } as any,
  async ({ query, service, env, timeRange, groupBy }: {
    query?: string;
    service?: string;
    env?: string;
    timeRange: string;
    groupBy?: string;
  }) => {
    try {
      const filterQuery = buildQuery({ query, service, env });

      const body: any = {
        filter: {
          query: filterQuery,
          from: timeRange,
          to: "now",
        },
        compute: [
          { type: "total", aggregation: "count" },
        ],
      };

      if (groupBy) {
        body.groupBy = [
          {
            facet: groupBy,
            limit: 100,
            sort: { aggregation: "count", type: "measure", order: "desc" },
          },
        ];
      }

      const response = await logsApi.aggregateLogs({ body });

      if (groupBy) {
        const buckets = (response.data as any)?.buckets ?? [];
        const groups = buckets.map((b: any) => ({
          [groupBy]: b.by?.[groupBy],
          count: b.computes?.c0,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { query: filterQuery, groupBy, groups },
                null,
                2
              ),
            },
          ],
        };
      }

      const total = (response.data as any)?.buckets?.[0]?.computes?.c0 ?? 0;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ query: filterQuery, total }, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Main ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Datadog Logs MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
