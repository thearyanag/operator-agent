// @ts-nocheck
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

function isReadOnly(sql: string): boolean {
  const normalized = sql
    .trim()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "")
    .trim();

  const forbidden = [
    "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE",
    "TRUNCATE", "GRANT", "REVOKE", "COPY", "EXECUTE", "DO",
    "CALL", "SET", "LOCK", "VACUUM", "REINDEX", "CLUSTER", "COMMENT",
  ];

  for (const keyword of forbidden) {
    if (new RegExp(`(^|;\\s*)${keyword}\\b`, "i").test(normalized)) {
      return false;
    }
  }

  return true;
}

const server = new McpServer({
  name: "postgres-readonly",
  version: "1.0.0",
});

// Tool 1: Get all table names
server.tool("getTables", "Returns names of all tables in the database", {}, async () => {
  try {
    const result = await pool.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
    `);

    const tables = result.rows.map((r) => `${r.table_schema}.${r.table_name}`);

    return {
      content: [{ type: "text", text: JSON.stringify(tables, null, 2) }],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// Tool 2: Get schema for a specific table
server.tool(
  "getTableSchema",
  "Returns the schema (columns, types, constraints) for a given table",
  { tableName: z.string().describe("Table name, e.g. 'public.users' or just 'users'") },
  async ({ tableName }) => {
    try {
      let schema = "public";
      let table = tableName;

      if (tableName.includes(".")) {
        const [schemaPart, tablePart] = tableName.split(".", 2);
        schema = schemaPart || "public";
        table = tablePart || tableName;
      }

      const columns = await pool.query(
        `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, table]
      );

      if (columns.rows.length === 0) {
        return {
          content: [{ type: "text", text: `Table '${tableName}' not found` }],
          isError: true,
        };
      }

      const pks = await pool.query(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
         WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'`,
        [schema, table]
      );

      const pkColumns = new Set(pks.rows.map((r) => r.column_name));

      const schemaInfo = columns.rows.map((col) => ({
        column: col.column_name,
        type: col.data_type,
        nullable: col.is_nullable === "YES",
        default: col.column_default,
        max_length: col.character_maximum_length,
        primary_key: pkColumns.has(col.column_name),
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(schemaInfo, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: Query a specific table with raw SQL
server.tool(
  "queryTable",
  "Run a read-only SQL query scoped to a specific table",
  {
    tableName: z.string().describe("The table name for context"),
    sql: z.string().describe("Raw SQL query (SELECT only)"),
  },
  async ({ tableName, sql }) => {
    if (!isReadOnly(sql)) {
      return {
        content: [{ type: "text", text: "Error: Only read-only (SELECT) queries are allowed" }],
        isError: true,
      };
    }

    try {
      const result = await pool.query(sql);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { table: tableName, rowCount: result.rowCount, rows: result.rows },
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

// Tool 4: Run any read-only SQL query
server.tool(
  "query",
  "Run any read-only SQL query against the database",
  { sql: z.string().describe("Raw SQL query (SELECT only)") },
  async ({ sql }) => {
    if (!isReadOnly(sql)) {
      return {
        content: [{ type: "text", text: "Error: Only read-only (SELECT) queries are allowed" }],
        isError: true,
      };
    }

    try {
      const result = await pool.query(sql);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ rowCount: result.rowCount, rows: result.rows }, null, 2),
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("PostgreSQL MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
