'use strict';

/**
 * deadcode-map CLI.
 *
 * Usage:
 *   deadcode-map [path] [--json out.json] [--map out.html]
 *                [--fail-on safe|review] [--min-confidence safe|review]
 *                [--baseline] [--update-baseline] [--show-baseline]
 *                [--fix] [--prove] [--test-command "npm test"]
 *                [--include-review] [--include-fixtures] [--top N] [--no-color]
 */

const fs = require('fs');
const path = require('path');
const { scan } = require('../src/index');
const { printTerminal, summarize, toJsonReport } = require('../src/output');
const { writeMap } = require('../src/map');
const { loadBaseline, saveBaseline, splitBaseline } = require('../src/baseline');
const { applyFix } = require('../src/fix');
const { prove } = require('../src/prove');
const { defaultTestCommand } = require('../src/git');

const VERSION = require('../package.json').version;

function help() {
  return `deadcode-map v${VERSION} — find dead code, prove it is dead, see it on a map.

Usage:
  deadcode-map [path] [options]
  deadcode-map mcp              Start the MCP server on stdio (for AI tools)

Options:
  --json <file>        Write the full JSON report to <file> (--json - writes it to stdout)
  --map <file>         Write the single-file offline HTML map to <file>
  --fail-on <level>    Exit 1 when new SAFE (default) or REVIEW dead code exists
  --min-confidence <level>
                       Show only findings at or above this grade (safe|review)
  --baseline           Hide findings already recorded in .deadcode-map.json
  --update-baseline    Write current findings to .deadcode-map.json and exit 0
  --show-baseline      Show baseline findings too (default: hidden with --baseline)
  --fix                Delete SAFE findings only (git-backed, one file at a time)
  --prove              Delete SAFE findings in a scratch git worktree and run tests
  --test-command <cmd> Test command for --prove (default: "npm test" when present)
  --include-review     Let --fix / --prove act on REVIEW findings too (default: SAFE only)
  --include-fixtures   Scan fixture/test-data directories too (fixtures/, __fixtures__/ —
                       excluded by default, at any depth)
  --top <n>            How many findings to list in the terminal (default 10)
  --cache              Cache per-file parses to speed up repeat scans
                       (default: off; cache lives in node_modules/.cache/
                       deadcode-map/ when node_modules exists, else in
                       .deadcode-map-cache.json next to the scanned root)
  --no-cache           Force a full scan: ignore the cache and write nothing
  --cache-stats        Enable the cache and print hit/miss stats after the scan
  --coverage <file>    Use this Cobertura XML or lcov file as a confidence
                       signal (default: auto-discover coverage.xml or
                       lcov.info in the scanned root). Covered body lines
                       demote a would-be SAFE finding to REVIEW — coverage
                       never promotes a finding to SAFE, so a stale file
                       can only add REVIEWs, never false SAFEs
  --no-coverage        Ignore any coverage file in the scanned repo
  --no-color           Disable coloured output
  --version            Print the version
  --help               Print this help
`;
}

function parseArgs(argv) {
  const opts = {
    path: '.', json: null, map: null, failOn: null, minConfidence: null,
    baseline: false, updateBaseline: false, showBaseline: false,
    fix: false, prove: false, testCommand: null, includeReview: false,
    includeFixtures: false, top: 10, color: true,
    cache: false, noCache: false, cacheStats: false,
    coveragePath: null, noCoverage: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { console.log(help()); process.exit(0); }
    else if (a === '--version' || a === '-v') { console.log(VERSION); process.exit(0); }
    else if (a === '--json') opts.json = args[++i];
    else if (a === '--map') opts.map = args[++i];
    else if (a === '--fail-on') opts.failOn = args[++i];
    else if (a === '--min-confidence') opts.minConfidence = args[++i];
    else if (a === '--baseline') opts.baseline = true;
    else if (a === '--update-baseline') opts.updateBaseline = true;
    else if (a === '--show-baseline') opts.showBaseline = true;
    else if (a === '--fix') opts.fix = true;
    else if (a === '--prove') opts.prove = true;
    else if (a === '--test-command') opts.testCommand = args[++i];
    else if (a === '--include-review') opts.includeReview = true;
    else if (a === '--include-fixtures') opts.includeFixtures = true;
    else if (a === '--top') opts.top = parseInt(args[++i], 10) || 10;
    else if (a === '--cache') opts.cache = true;
    else if (a === '--no-cache') opts.noCache = true;
    else if (a === '--cache-stats') opts.cacheStats = true;
    else if (a === '--coverage') opts.coveragePath = args[++i];
    else if (a === '--no-coverage') opts.noCoverage = true;
    else if (a === '--no-color') opts.color = false;
    else if (a.startsWith('-')) { console.error(`Unknown option: ${a}\n${help()}`); process.exit(2); }
    else opts.path = a;
  }
  return opts;
}

function main() {
  // MCP subcommand: `deadcode-map mcp` starts the MCP server on stdio.
  if (process.argv[2] === 'mcp') {
    const { startMcpServer } = require('./mcp-server');
    startMcpServer().catch((e) => {
      console.error(`deadcode-map MCP server failed to start: ${e.message}`);
      process.exit(1);
    });
    return;
  }

  const opts = parseArgs(process.argv);
  const root = path.resolve(opts.path);
  // With --json - stdout is pure JSON: every informational message
  // after the report (map written, --fix / --prove results) goes to
  // stderr instead, or a consumer doing JSON.parse(stdout) breaks on
  // the trailing "Map written to ..." line.
  const info = opts.json === '-' ? console.error : console.log;
  if (!fs.existsSync(root)) {
    console.error(`deadcode-map: no such directory: ${root}`);
    process.exit(2);
  }

  const cacheOpts = { cache: opts.cache, noCache: opts.noCache, cacheStats: opts.cacheStats };
  const coverageOpts = { coveragePath: opts.coveragePath, noCoverage: opts.noCoverage };
  // The tool's own outputs must never be scanned: a --json report or
  // --map file written inside the scanned root would otherwise count
  // as string references on the next run and change the findings.
  // Only the exact output paths are excluded, resolved against the
  // working directory — the same place the files are written.
  // '--json -' writes to stdout, so there is no file to exclude, and
  // a path outside the scanned root matches nothing.
  const excludeFiles = [opts.json, opts.map]
    .filter((p) => p && p !== '-')
    .map((p) => path.resolve(p));
  const { graph, findings, cache } = scan(root, { includeFixtures: opts.includeFixtures, excludeFiles, ...cacheOpts, ...coverageOpts });
  let visible = findings;

  // Baseline handling.
  const baseline = opts.baseline || opts.updateBaseline ? loadBaseline(root) : null;
  if (opts.updateBaseline) {
    const p = saveBaseline(root, findings);
    console.log(`Baseline written to ${p} (${findings.length} findings).`);
    process.exit(0);
  }
  let baselineCount = 0;
  if (baseline && !opts.showBaseline) {
    const split = splitBaseline(findings, baseline);
    baselineCount = split.baseline.length;
    visible = split.fresh;
  }

  // Confidence filter.
  if (opts.minConfidence === 'safe') visible = visible.filter((f) => f.grade === 'SAFE');
  else if (opts.minConfidence === 'review') visible = visible.filter((f) => f.grade !== 'KEEP');

  const summary = summarize(visible);
  // --json - writes the report to stdout: keep stdout pure JSON, no terminal summary.
  if (opts.json !== '-') printTerminal(visible, { root, top: opts.top, color: opts.color });
  if (baselineCount && opts.json !== '-') console.log(`  (${baselineCount} findings hidden by baseline .deadcode-map.json)\n`);

  if (opts.json) {
    const report = toJsonReport(root, visible, summary, { baselineHidden: baselineCount });
    if (opts.json === '-') {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      fs.writeFileSync(opts.json, JSON.stringify(report, null, 2) + '\n', 'utf8');
      console.log(`JSON report written to ${opts.json}`);
    }
  }

  if (opts.map) {
    writeMap(root, graph, visible, path.resolve(opts.map));
    info(`Map written to ${opts.map} (open it by double-clicking)`);
  }

  if (opts.fix) {
    const fixFindings = opts.includeReview ? visible : visible.filter((f) => f.grade === 'SAFE');
    const result = applyFix(root, graph, fixFindings);
    info(`--fix: removed ${result.safeCount} SAFE finding(s); ${result.deletedFiles.length} file(s) deleted.`);
    for (const c of result.changed) info(`  ${c.file}: removed ${c.removed} item(s)${c.error ? ` (error: ${c.error})` : ''}`);
    info('Review the diff with git before committing.');
  }

  if (opts.prove) {
    const testCmd = opts.testCommand || defaultTestCommand(root, scan(root, { includeFixtures: opts.includeFixtures }).discovery.pkg);
    info(`--prove: running "${testCmd || '(no test command)'}" in a scratch git worktree…`);
    const result = prove(root, graph, opts.includeReview ? visible : visible.filter((f) => f.grade === 'SAFE'), { testCommand: testCmd });
    info(`--prove: ${result.status} — ${result.proven || 0} proven, ${result.breaks || 0} break${result.breaks === 1 ? 's' : ''}.`);
    for (const r of result.results || []) info(`  ${r.status.padEnd(7)} ${r.cluster} — ${r.reason}`);
    if (result.reason) info(`  ${result.reason}`);
  }

  if (opts.cacheStats) {
    // With --json - stdout is pure JSON, so stats go to stderr instead.
    const out = opts.json === '-' ? console.error : console.log;
    if (!cache || !cache.enabled) {
      out('Cache: disabled (--no-cache), no stats collected.');
    } else {
      out(`Cache: ${cache.hits} hit(s), ${cache.misses} missed (${cache.hitRate}% hit rate), `
        + `~${cache.estimatedSavedMs}ms parse time saved — ${cache.location}`);
    }
  }

  // Exit code for CI.
  if (opts.failOn) {
    const level = opts.failOn === 'review' ? ['SAFE', 'REVIEW'] : ['SAFE'];
    const failing = visible.filter((f) => level.includes(f.grade));
    if (failing.length) {
      console.error(`deadcode-map: FAIL — ${failing.length} new ${opts.failOn}-level dead-code finding(s).`);
      process.exit(1);
    }
  }
  process.exit(0);
}

main();
