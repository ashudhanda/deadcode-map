#!/usr/bin/env node
'use strict';

const { startMcpServer } = require('../src/mcp-server');

startMcpServer().catch((e) => {
  console.error(`deadcode-map MCP server failed to start: ${e.message}`);
  process.exit(1);
});
