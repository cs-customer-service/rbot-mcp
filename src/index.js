#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

try {
  const { server } = createServer({ config: loadConfig() });
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(`rbot-mcp: ${error.message}\n`);
  process.exit(1);
}
