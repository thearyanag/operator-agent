import { prewarmMcpDirectToolCache } from "../src/pi/mcp-prewarm";

const piWorkdir = Bun.env.PI_WORKDIR?.trim() || process.cwd();

try {
  await prewarmMcpDirectToolCache({ piWorkdir });
} catch (error) {
  console.warn(`MCP cache prewarm failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 0;
}
