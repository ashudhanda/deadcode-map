'use strict';

/**
 * deadcode-map MCP server (Model Context Protocol, stdio transport).
 *
 * Exposes the scan engine to AI tools (Claude Code, Claude Desktop,
 * Cursor, Codex, Gemini CLI, OpenCode, Windsurf, VS Code Copilot)
 * as five tools, one prompt and one resource.
 *
 * IMPORTANT: stdout is the JSON-RPC channel. Never write to stdout
 * here except through the MCP transport. Diagnostics go to stderr.
 *
 * Run it directly:
 *   node bin/deadcode-map-mcp.js
 * or as a subcommand of the main CLI:
 *   deadcode-map mcp
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { scan } = require('./index');
const { applyFix } = require('./fix');
const { writeMap, buildMapData } = require('./map');
const { loadBaseline } = require('./baseline');
const { summarize } = require('./output');
const { isGitRepo, defaultTestCommand } = require('./git');

const VERSION = require('../package.json').version;

const MAX_FINDINGS = 100;

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: `deadcode-map error: ${message}` }], isError: true };
}

/** Resolve a user-supplied path against the current directory and check it is a real directory. */
function resolveDir(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('path is required and must be a non-empty string');
  }
  const abs = path.resolve(process.cwd(), input);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (_) {
    throw new Error(`no such directory: ${abs}`);
  }
  if (!stat.isDirectory()) throw new Error(`not a directory: ${abs}`);
  return abs;
}

function gradeFilter(minGrade) {
  if (minGrade === 'SAFE') return (f) => f.grade === 'SAFE';
  return (f) => f.grade === 'SAFE' || f.grade === 'REVIEW';
}

function findingSummary(f) {
  const ev = f.evidence || {};
  return {
    id: f.id,
    category: f.category,
    file: f.file,
    symbol: f.symbol,
    grade: f.grade,
    startLine: f.startLine,
    endLine: f.endLine,
    size: f.size,
    reason: f.reason,
    evidence: {
      importers: ev.importers,
      callers: ev.callers,
      stringRefs: ev.stringRefs,
      exported: ev.exported,
      coveragePct: ev.coveragePct,
      gitAgeDays: ev.gitAgeDays,
      gitLastCommit: ev.gitLastCommit,
      gitCommits: ev.gitCommits,
    },
  };
}

function mapResourceUri(root) {
  return `deadcode://map/${encodeURIComponent(root)}`;
}

function renderMapHtml(root) {
  const { graph, findings } = scan(root, {});
  const tmp = path.join(os.tmpdir(), `deadcode-map-${process.pid}-${Date.now()}.html`);
  writeMap(root, graph, findings, tmp);
  try {
    return fs.readFileSync(tmp, 'utf8');
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* temp file cleanup is best effort */ }
  }
}

function createServer() {
  const server = new McpServer(
    { name: 'deadcode-map', version: VERSION },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );

  server.registerTool('scan_repo', {
    description: 'Scan a JS/TS or Python repo for dead code. Returns confidence-graded findings (SAFE = provably dead, REVIEW = needs a human eye). Lists at most 100 findings; use get_map or the CLI --json for the full set.',
    inputSchema: {
      path: z.string().describe('Path to the repo directory to scan (relative paths resolve against the server working directory)'),
      minGrade: z.enum(['SAFE', 'REVIEW']).optional().default('REVIEW').describe('Minimum grade to return: REVIEW returns SAFE + REVIEW, SAFE returns SAFE only'),
      includeFixtures: z.boolean().optional().default(false).describe('Also scan fixture/test-data directories (fixtures/, __fixtures__/); excluded by default'),
    },
  }, async (args) => {
    try {
      const root = resolveDir(args.path);
      const { findings } = scan(root, { includeFixtures: args.includeFixtures });
      const visible = findings.filter(gradeFilter(args.minGrade));
      const summary = summarize(visible);
      const shown = visible.slice(0, MAX_FINDINGS).map(findingSummary);
      const payload = {
        root,
        summary,
        total: visible.length,
        shown: shown.length,
        truncated: visible.length > MAX_FINDINGS,
        note: visible.length > MAX_FINDINGS
          ? `Showing the first ${MAX_FINDINGS} of ${visible.length} findings. Run deadcode-map --json report.json for the full list.`
          : undefined,
        findings: shown,
      };
      return textResult(JSON.stringify(payload, null, 2));
    } catch (e) {
      return errorResult(e.message);
    }
  });

  server.registerTool('explain_finding', {
    description: 'Re-scan a repo and return the FULL record for one finding id (all evidence fields plus the delete diff). Use it before deciding whether a REVIEW finding is really dead.',
    inputSchema: {
      path: z.string().describe('Path to the repo directory'),
      findingId: z.string().describe('Finding id from scan_repo, e.g. "function:src/used.js:unusedExport:22"'),
    },
  }, async (args) => {
    try {
      const root = resolveDir(args.path);
      const { findings } = scan(root, {});
      const found = findings.find((f) => f.id === args.findingId);
      if (!found) {
        return errorResult(`no finding with id "${args.findingId}" in ${root}. Run scan_repo first and copy the id exactly.`);
      }
      return textResult(JSON.stringify({ root, finding: found }, null, 2));
    } catch (e) {
      return errorResult(e.message);
    }
  });

  server.registerTool('fix_safe', {
    description: 'Delete SAFE findings only (never REVIEW or KEEP). Requires confirm=true. If findingIds is omitted, all SAFE findings are removed. Review the change with git diff before committing.',
    inputSchema: {
      path: z.string().describe('Path to the repo directory'),
      findingIds: z.array(z.string()).optional().describe('Finding ids to delete; omit to delete all SAFE findings'),
      confirm: z.boolean().describe('Must be true. The tool refuses to delete anything unless confirm is true.'),
    },
  }, async (args) => {
    try {
      if (args.confirm !== true) {
        return errorResult('refused: confirm must be true to delete anything. Re-run fix_safe with confirm=true after reviewing the findings.');
      }
      const root = resolveDir(args.path);
      const { graph, findings } = scan(root, {});
      let targets = findings.filter((f) => f.grade === 'SAFE');
      if (args.findingIds && args.findingIds.length) {
        const wanted = new Set(args.findingIds);
        const unknown = args.findingIds.filter((id) => !findings.some((f) => f.id === id));
        if (unknown.length) {
          return errorResult(`unknown finding id(s): ${unknown.join(', ')}. Run scan_repo first and copy the ids exactly.`);
        }
        targets = targets.filter((f) => wanted.has(f.id));
        const skipped = args.findingIds.filter((id) => {
          const f = findings.find((x) => x.id === id);
          return f && f.grade !== 'SAFE';
        });
        if (skipped.length) {
          return errorResult(`refused: these findings are not SAFE and will not be deleted: ${skipped.join(', ')}. Delete REVIEW findings only by hand, after a human has checked them.`);
        }
      }
      if (!targets.length) {
        return textResult(JSON.stringify({ root, removed: 0, deletedFiles: [], changed: [], note: 'No SAFE findings to delete.' }, null, 2));
      }
      const result = applyFix(root, graph, targets);
      const payload = {
        root,
        removed: result.safeCount,
        deletedFiles: result.deletedFiles,
        changed: result.changed,
        note: 'Review the change with git diff before committing. Run the test suite to confirm nothing broke.',
      };
      return textResult(JSON.stringify(payload, null, 2));
    } catch (e) {
      return errorResult(e.message);
    }
  });

  server.registerTool('get_map', {
    description: 'Return a summary of the visual dead-code map for a repo (node/edge counts, findings by grade) and the resource URI of the full single-file HTML map. Read the map itself from the deadcode://map resource.',
    inputSchema: {
      path: z.string().describe('Path to the repo directory'),
    },
  }, async (args) => {
    try {
      const root = resolveDir(args.path);
      const { graph, findings } = scan(root, {});
      const data = buildMapData(root, graph, findings);
      const payload = {
        root,
        mapResource: mapResourceUri(root),
        nodes: data.nodes.length,
        edges: data.edges.length,
        summary: summarize(findings),
        note: `Read the full interactive HTML map from the resource ${mapResourceUri(root)} (mimeType text/html). Or run: deadcode-map ${root} --map deadcode-map.html`,
      };
      return textResult(JSON.stringify(payload, null, 2));
    } catch (e) {
      return errorResult(e.message);
    }
  });

  server.registerTool('status', {
    description: 'Cheap repo status: finding counts by grade, whether a .deadcode-map.json baseline exists, whether the directory is a git repo, and the detected test command. No finding list.',
    inputSchema: {
      path: z.string().describe('Path to the repo directory'),
    },
  }, async (args) => {
    try {
      const root = resolveDir(args.path);
      const { discovery, findings } = scan(root, {});
      const baseline = loadBaseline(root);
      const pkg = discovery.pkg || null;
      const payload = {
        root,
        summary: summarize(findings),
        filesScanned: (discovery.codeFiles || []).length,
        baseline: baseline ? { present: true, entries: baseline.size } : { present: false },
        gitRepo: isGitRepo(root),
        testCommand: defaultTestCommand(root, pkg),
      };
      return textResult(JSON.stringify(payload, null, 2));
    } catch (e) {
      return errorResult(e.message);
    }
  });

  server.registerPrompt('cleanup-dead-code', {
    title: 'Clean up dead code',
    description: 'Guided dead-code cleanup for a repo: scan, triage SAFE first, prove before deleting, never delete REVIEW without asking.',
    argsSchema: {
      path: z.string().describe('Path to the repo directory to clean up'),
    },
  }, async ({ path: repoPath }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Clean up dead code in ${repoPath} with deadcode-map.\n`
          + '1. Run scan_repo on this path first and report the counts by grade (SAFE / REVIEW / KEEP).\n'
          + '2. Triage SAFE findings first: for each one, call explain_finding and check its evidence (0 importers, 0 callers, no string refs).\n'
          + '3. Before deleting anything, prove it: run the CLI `deadcode-map <path> --prove` (it deletes SAFE candidates in a scratch git worktree and runs the tests) or ask me to run it.\n'
          + '4. Delete SAFE findings only, with fix_safe and confirm=true. Never delete a REVIEW finding without asking me first, and never delete KEEP.\n'
          + '5. After deleting, run the test suite and show me the git diff for review.\n'
          + '6. If the repo has a visual map, read it from the deadcode://map resource (via get_map) and mention the worst files.',
      },
    }],
  }));

  server.registerResource('deadcode-map', new ResourceTemplate('deadcode://map/{path}', { list: undefined }), {
    title: 'deadcode-map visual map',
    description: 'Single-file offline HTML map of dead code for a repo (red = SAFE, amber = REVIEW, green = live). The {path} variable is the URL-encoded absolute repo path.',
    mimeType: 'text/html',
  }, async (uri, variables) => {
    try {
      const raw = variables.path;
      const root = resolveDir(decodeURIComponent(raw));
      const html = renderMapHtml(root);
      return { contents: [{ uri: uri.href, mimeType: 'text/html', text: html }] };
    } catch (e) {
      throw new Error(`deadcode-map error: ${e.message}`);
    }
  });

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`deadcode-map MCP server v${VERSION} running on stdio`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`deadcode-map MCP server failed to start: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { createServer, resolveDir, startMcpServer: main };
