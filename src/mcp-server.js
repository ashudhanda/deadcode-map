'use strict';

/**
 * deadcode-map MCP server v2 (Model Context Protocol, stdio transport).
 *
 * Exposes six tools (`scan_repo`, `explain_finding`, `prove_safe`,
 * `fix_safe`, `get_map`, `status`), one prompt (`cleanup-dead-code`),
 * and one resource (`deadcode://map/{path}`).
 *
 * IMPORTANT: stdout is the JSON-RPC channel. Never write to stdout
 * here except through the MCP transport. Diagnostics go to stderr.
 */

const fs = require('fs');
const path = require('path');
const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { scanAsync } = require('./index');
const { applyFix } = require('./fix');
const { prove } = require('./prove');
const { buildMapData, renderHtml } = require('./map');
const { loadBaseline } = require('./baseline');
const { summarize } = require('./output');
const { isGitRepo, defaultTestCommand } = require('./git');

const VERSION = require('../package.json').version;
const MAX_FINDINGS = 100;
const MAX_CACHE_ENTRIES = 8;

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

/**
 * Lightweight read-only in-memory scan cache for back-to-back MCP calls.
 * Validates mtime + size of every scanned file so external edits never
 * return stale results, without writing any cache files into the repo.
 */
function createScanCache() {
  const store = new Map(); // cacheKey -> { result, stamps: Map<abs, string>, createdAt }

  function keyFor(root, opts) {
    return JSON.stringify({
      root,
      includeFixtures: Boolean(opts && opts.includeFixtures),
      javaSafe: Boolean(opts && opts.javaSafe),
      configPath: (opts && opts.configPath) || null,
    });
  }

  function snapshotStamps(files) {
    const stamps = new Map();
    for (const f of files || []) {
      try {
        const st = fs.statSync(f);
        stamps.set(f, `${st.size}:${st.mtimeMs}`);
      } catch (_) {
        stamps.set(f, 'missing');
      }
    }
    return stamps;
  }

  function isFresh(entry) {
    // Cap reuse window at 60s so newly added files in directories are picked up promptly.
    if (Date.now() - entry.createdAt > 60000) return false;
    for (const [f, prev] of entry.stamps) {
      try {
        const st = fs.statSync(f);
        if (`${st.size}:${st.mtimeMs}` !== prev) return false;
      } catch (_) {
        return false;
      }
    }
    return true;
  }

  async function getOrScan(root, opts, forceRefresh) {
    const key = keyFor(root, opts);
    if (!forceRefresh && store.has(key)) {
      const entry = store.get(key);
      if (isFresh(entry)) return entry.result;
      store.delete(key);
    }
    const result = await scanAsync(root, opts || {});
    if (store.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = store.keys().next().value;
      store.delete(oldestKey);
    }
    store.set(key, {
      result,
      stamps: snapshotStamps(result.discovery && result.discovery.allFiles),
      createdAt: Date.now(),
    });
    return result;
  }

  function invalidateRoot(root) {
    for (const key of [...store.keys()]) {
      if (key.includes(JSON.stringify(root))) store.delete(key);
    }
  }

  return { getOrScan, invalidateRoot };
}

function createServer() {
  const scanCache = createScanCache();
  const server = new McpServer(
    { name: 'deadcode-map', version: VERSION },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );

  const commonScanFields = {
    path: z.string().describe('Path to the repo directory to scan (relative paths resolve against the server working directory)'),
    includeFixtures: z.boolean().optional().default(false).describe('Also scan fixture/test-data directories (fixtures/, __fixtures__/); excluded by default'),
    javaSafe: z.boolean().optional().default(false).describe('Opt in to SAFE grades for Java findings'),
    configPath: z.string().optional().describe('Optional path to deadcode-map.config.json'),
  };

  server.registerTool('scan_repo', {
    description: 'Scan a JS/TS, Python, or Java repo for dead code. Returns confidence-graded findings (SAFE = provably dead, REVIEW = needs a human eye). Lists at most 100 findings; use get_map or the CLI --json for the full set.',
    inputSchema: {
      ...commonScanFields,
      minGrade: z.enum(['SAFE', 'REVIEW']).optional().default('REVIEW').describe('Minimum grade to return: REVIEW returns SAFE + REVIEW, SAFE returns SAFE only'),
      refresh: z.boolean().optional().default(false).describe('Bypass in-memory cache and force a fresh scan'),
    },
  }, async (args) => {
    try {
      const root = resolveDir(args.path);
      const { findings } = await scanCache.getOrScan(root, {
        includeFixtures: args.includeFixtures,
        javaSafe: args.javaSafe,
        configPath: args.configPath,
      }, args.refresh);
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
    description: 'Return the FULL record for one finding id (all evidence fields plus the delete diff). Use it before deciding whether a REVIEW finding is really dead.',
    inputSchema: {
      ...commonScanFields,
      findingId: z.string().describe('Finding id from scan_repo, e.g. "function:src/used.js:unusedExport:22"'),
    },
  }, async (args) => {
    try {
      const root = resolveDir(args.path);
      const { findings } = await scanCache.getOrScan(root, {
        includeFixtures: args.includeFixtures,
        javaSafe: args.javaSafe,
        configPath: args.configPath,
      }, false);
      const found = findings.find((f) => f.id === args.findingId);
      if (!found) {
        return errorResult(`no finding with id "${args.findingId}" in ${root}. Run scan_repo first and copy the id exactly.`);
      }
      return textResult(JSON.stringify({ root, finding: found }, null, 2));
    } catch (e) {
      return errorResult(e.message);
    }
  });

  server.registerTool('prove_safe', {
    description: 'Prove SAFE findings are truly dead by deleting them in an isolated scratch git worktree and running the repo test suite (leaves your working tree untouched).',
    inputSchema: {
      ...commonScanFields,
      findingIds: z.array(z.string()).optional().describe('Optional subset of SAFE finding ids to prove; omit to prove all SAFE findings'),
      testCommand: z.string().optional().describe('Optional test command override (auto-detected if omitted)'),
    },
  }, async (args) => {
    try {
      const root = resolveDir(args.path);
      const { discovery, graph, findings } = await scanCache.getOrScan(root, {
        includeFixtures: args.includeFixtures,
        javaSafe: args.javaSafe,
        configPath: args.configPath,
      }, true);
      let targets = findings.filter((f) => f.grade === 'SAFE');
      if (args.findingIds && args.findingIds.length) {
        const wanted = new Set(args.findingIds);
        targets = targets.filter((f) => wanted.has(f.id));
      }
      const testCmd = args.testCommand || defaultTestCommand(root, discovery.pkg);
      const result = prove(root, graph, targets, {
        testCommand: testCmd,
        includeFixtures: args.includeFixtures,
        javaSafe: args.javaSafe,
      });
      return textResult(JSON.stringify({ root, testCommand: testCmd, ...result }, null, 2));
    } catch (e) {
      return errorResult(e.message);
    }
  });

  server.registerTool('fix_safe', {
    description: 'Delete SAFE findings only (never REVIEW or KEEP). Requires confirm=true. If findingIds is omitted, all SAFE findings are removed. Review the change with git diff before committing.',
    inputSchema: {
      ...commonScanFields,
      findingIds: z.array(z.string()).optional().describe('Finding ids to delete; omit to delete all SAFE findings'),
      confirm: z.boolean().describe('Must be true. The tool refuses to delete anything unless confirm is true.'),
    },
  }, async (args) => {
    try {
      if (args.confirm !== true) {
        return errorResult('refused: confirm must be true to delete anything. Re-run fix_safe with confirm=true after reviewing the findings.');
      }
      const root = resolveDir(args.path);
      const { graph, findings } = await scanCache.getOrScan(root, {
        includeFixtures: args.includeFixtures,
        javaSafe: args.javaSafe,
        configPath: args.configPath,
      }, true);
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
      scanCache.invalidateRoot(root);
      const payload = {
        root,
        removed: result.appliedCount ?? result.safeCount,
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
    inputSchema: commonScanFields,
  }, async (args) => {
    try {
      const root = resolveDir(args.path);
      const { graph, findings } = await scanCache.getOrScan(root, {
        includeFixtures: args.includeFixtures,
        javaSafe: args.javaSafe,
        configPath: args.configPath,
      }, false);
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
    inputSchema: commonScanFields,
  }, async (args) => {
    try {
      const root = resolveDir(args.path);
      const { discovery, findings } = await scanCache.getOrScan(root, {
        includeFixtures: args.includeFixtures,
        javaSafe: args.javaSafe,
        configPath: args.configPath,
      }, false);
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
          + '3. Before deleting anything, prove it with prove_safe (or the CLI --prove flag) — it deletes SAFE candidates in a scratch git worktree and runs the test suite without modifying the working tree.\n'
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
      const { graph, findings } = await scanCache.getOrScan(root, {}, false);
      const html = renderHtml(buildMapData(root, graph, findings));
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
