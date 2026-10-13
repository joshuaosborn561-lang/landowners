#!/usr/bin/env node
/**
 * Stdio MCP entrypoint for Claude Desktop / Cursor local MCP.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadAppSettings } from '../server/lib/appSettings.js';
import { createPermitsMcpServer } from './createServer.js';

async function main() {
  await loadAppSettings();
  const server = createPermitsMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[permits-mcp] fatal', err);
  process.exit(1);
});
