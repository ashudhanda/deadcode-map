#!/usr/bin/env node
'use strict';

// Launcher for the Claude Code plugin. The plugin ships inside the
// deadcode-map repo, so the real MCP server lives at ../../src/mcp-server.js.
// This file exists so the plugin.json entry points at a real file inside
// the plugin directory.
const { startMcpServer } = require('../../src/mcp-server');

startMcpServer().catch((e) => {
  console.error(`deadcode-map MCP server failed to start: ${e.message}`);
  process.exit(1);
});
