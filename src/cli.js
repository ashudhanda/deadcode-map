'use strict';

/**
 * deadcode-map CLI.
 *
 * Usage:
 *   deadcode-map [path] [--json out.json] [--map out.html]
 *     [--fail-on safe|review] [--min-confidence safe|review]
 *     [--baseline] [--update-baseline] [--show-baseline]
 *     [--fix] [--prove] [--test-command "npm test"]
 *     [--include-review] [--include-fixtures] [--top N] [--no-color]
 *     [--config deadcode-map.config.json] [--diff <baseRef>]
 *     [--sarif report.sarif] [--cascade]
 */

const fs = require('fs');
const path = require('path');
const { scan, scanAsync } = require('../src/index');
const { printTerminal, summarize, toJsonReport } = require('../src/output');
const { writeMap } = require('../src/map');
const { loadBaseline, saveBaseline, splitBaseline } = require('../src/baseline');
const { applyFix, applyFixCascade } = require('../src/fix');
const { getGitDiff, filterFindingsByDiff } = require('../src/diff');
const { writeSarif } = require('../src/sarif');
const { prove } = require('../src/prove');
const { defaultTestCommand } = require('../src/git');

const VERSION = require('../package.json').version;

function help() {
  return `deadcode-map v${VERSION} — find dead code, prove it is dead, see it on a map.

Usage:
  deadcode-map [path] [options]
  deadcode-map mcp                 Start the MCP server on stdio (for AI tools)

Options:
  --json <file>                    Write the full JSON report to <file> (--json - writes it to stdout)
  --map <file>                     Write the single-file offline HTML map to <file>
  --fail-on <level>                Exit 1 when new SAFE (default) or REVIEW dead code exists
  --min-confidence <level>         Show only findings at or above this grade (safe|review)
  --baseline                       Hide findings already recorded in .deadcode-map.json
  --update-baseline                Write current findings to .deadcode-map.json and exit 0
  --show-baseline                  Show baseline findings too (default: hidden with --baseline)
  --fix                            Delete SAFE findings only (git-backed, one file at a time)
  --prove                          Delete SAFE findings in a scratch git worktree and run tests
  --test-command <cmd>             Test command for --prove (default: auto-detected)
  --include-review                 Let --fix / --prove act on REVIEW findings too (default: SAFE only)
  --config <file>                  Project config (deadcode-map.config.json); auto-discovered at the repo root
  --diff <baseRef>                 Incremental CI mode: only findings in files/lines changed vs <baseRef> (e.g. origin/main)
  --diff-scope <hunk|file>         --diff granularity: changed lines only (default) or whole changed files
  --sarif <file>                   Write a SARIF 2.1.0 report for GitHub Code Scanning
  --cascade                        With --fix: repeat scan-and-delete until no new SAFE findings appear
  --java-safe                      Opt in to SAFE grades for Java
  --include-fixtures               Scan fixture/test-data directories too (excluded by default)
  --no-gitignore                   Do not skip paths ignored by .gitignore
  --top <n>                        How many findings to list in the terminal (default 10)
  --cache                          Cache per-file parses to speed up repeat scans
  --no-cache                       Force a full scan: ignore the cache and write nothing
  --cache-stats                    Enable the cache and print hit/miss stats after the scan
  --coverage <file>                Use this Cobertura XML or lcov file/dir as a confidence signal
  --no-coverage                    Ignore any coverage file in the scanned repo
  --no-color                       Disable coloured output
  --version                        Print the version
  --help                           Print this help
`;
}

function usageError(msg) {
  console.error(`deadcode-map: ${msg}\n`);
  process.exit(2);
}

function requireValue(args, idx, flag) {
  const val = args[idx + 1];
  if (val === undefined || (val !== '-' && val.startsWith('--'))) {
    usageError(`option ${flag} requires a value`);
  }
  return val;
}

function parseArgs(argv) {
  const opts = {
    path: '.', json: null, map: null, failOn: null, minConfidence: null,
    baseline: false, updateBaseline: false, showBaseline: false,
    fix: false, prove: false, testCommand: null, includeReview: false,
    includeFixtures: false, noGitignore: false, top: 10, color: true,
    javaSafe: false, cache: false, noCache: false, cacheStats: false,
    coveragePath: null, noCoverage: false,
    configPath: null, diff: null, diffScope: 'hunk', sarif: null, cascade: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { console.log(help()); process.exit(0); }
    else if (a === '--version' || a === '-v') { console.log(VERSION); process.exit(0); }
    else if (a === '--json') { opts.json = requireValue(args, i, a); i += 1; }
    else if (a === '--map') { opts.map = requireValue(args, i, a); i += 1; }
    else if (a === '--fail-on') {
      const v = requireValue(args, i, a).toLowerCase();
      if (v !== 'safe' && v !== 'review') usageError(`invalid --fail-on level "${v}" (expected "safe" or "review")`);
      opts.failOn = v;
      i += 1;
    } else if (a === '--min-confidence') {
      const v = requireValue(args, i, a).toLowerCase();
      if (v !== 'safe' && v !== 'review') usageError(`invalid --min-confidence level "${v}" (expected "safe" or "review")`);
      opts.minConfidence = v;
      i += 1;
    } else if (a === '--baseline') opts.baseline = true;
    else if (a === '--update-baseline') opts.updateBaseline = true;
    else if (a === '--show-baseline') opts.showBaseline = true;
    else if (a === '--fix') opts.fix = true;
    else if (a === '--prove') opts.prove = true;
    else if (a === '--test-command') { opts.testCommand = requireValue(args, i, a); i += 1; }
    else if (a === '--include-review') opts.includeReview = true;
    else if (a === '--config') { opts.configPath = requireValue(args, i, a); i += 1; }
    else if (a === '--diff') { opts.diff = requireValue(args, i, a); i += 1; }
    else if (a === '--diff-scope') {
      const v = requireValue(args, i, a).toLowerCase();
      if (v !== 'hunk' && v !== 'file') usageError(`invalid --diff-scope "${v}" (expected "hunk" or "file")`);
      opts.diffScope = v;
      i += 1;
    } else if (a === '--sarif') { opts.sarif = requireValue(args, i, a); i += 1; }
    else if (a === '--cascade') opts.cascade = true;
    else if (a === '--java-safe') opts.javaSafe = true;
    else if (a === '--include-fixtures') opts.includeFixtures = true;
    else if (a === '--no-gitignore') opts.noGitignore = true;
    else if (a === '--top') {
      const n = parseInt(requireValue(args, i, a), 10);
      if (Number.isNaN(n) || n < 1) usageError(`invalid --top value (expected positive integer)`);
      opts.top = n;
      i += 1;
    } else if (a === '--cache') opts.cache = true;
    else if (a === '--no-cache') opts.noCache = true;
    else if (a === '--cache-stats') opts.cacheStats = true;
    else if (a === '--coverage') { opts.coveragePath = requireValue(args, i, a); i += 1; }
    else if (a === '--no-coverage') opts.noCoverage = true;
    else if (a === '--no-color') opts.color = false;
    else if (a.startsWith('-')) { console.error(`Unknown option: ${a}\n${help()}`); process.exit(2); }
    else opts.path = a;
  }
  return opts;
}

async function main() {
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
  const info = opts.json === '-' ? console.error : console.log;

  let stat;
  try {
    stat = fs.statSync(root);
  } catch (_) {
    console.error(`deadcode-map: no such directory: ${root}`);
    process.exit(2);
  }
  if (!stat.isDirectory()) {
    console.error(`deadcode-map: not a directory: ${root}`);
    process.exit(2);
  }

  const cacheOpts = { cache: opts.cache, noCache: opts.noCache, cacheStats: opts.cacheStats };
  const coverageOpts = { coveragePath: opts.coveragePath, noCoverage: opts.noCoverage };
  const excludeFiles = [opts.json, opts.map, opts.sarif]
    .filter((p) => p && p !== '-')
    .map((p) => path.resolve(p));

  const { discovery, graph, findings, cache } = await scanAsync(root, {
    includeFixtures: opts.includeFixtures,
    noGitignore: opts.noGitignore,
    excludeFiles,
    javaSafe: opts.javaSafe,
    configPath: opts.configPath,
    ...cacheOpts,
    ...coverageOpts,
  });

  let visible = findings;
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

  if (opts.minConfidence === 'safe') visible = visible.filter((f) => f.grade === 'SAFE');
  else if (opts.minConfidence === 'review') visible = visible.filter((f) => f.grade !== 'KEEP');

  let diffHidden = 0;
  if (opts.diff) {
    const diffData = getGitDiff(root, opts.diff);
    const filtered = filterFindingsByDiff(visible, diffData, { scope: opts.diffScope });
    visible = filtered.findings;
    diffHidden = filtered.hidden;
  }

  const summary = summarize(visible);
  if (opts.json !== '-') printTerminal(visible, { root, top: opts.top, color: opts.color });
  if (baselineCount && opts.json !== '-') console.log(`  (${baselineCount} findings hidden by baseline .deadcode-map.json)\n`);
  if (diffHidden && opts.json !== '-') console.log(`  (${diffHidden} findings hidden by --diff ${opts.diff})\n`);

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

  if (opts.sarif) {
    writeSarif(root, visible, path.resolve(opts.sarif));
    info(`SARIF 2.1.0 report written to ${opts.sarif}`);
  }

  if (opts.fix) {
    const label = opts.includeReview ? 'SAFE/REVIEW' : 'SAFE';
    if (opts.cascade) {
      const result = applyFixCascade(
        root,
        () => scan(root, {
          includeFixtures: opts.includeFixtures,
          noGitignore: opts.noGitignore,
          configPath: opts.configPath,
          excludeFiles,
          javaSafe: opts.javaSafe,
          ...coverageOpts,
        }),
        { includeReview: opts.includeReview, maxPasses: 5 },
      );
      info(`--fix --cascade: ${result.passes.length} pass(es), removed ${result.appliedCount} ${label} finding(s); ${result.deletedFiles.length} file(s) deleted.`);
      for (const c of result.changed) info(`  ${c.file}: removed ${c.removed} item(s)${c.error ? ` (error: ${c.error})` : ''}`);
    } else {
      const fixFindings = opts.includeReview ? visible : visible.filter((f) => f.grade === 'SAFE');
      const result = applyFix(root, graph, fixFindings, { includeReview: opts.includeReview });
      info(`--fix: removed ${result.appliedCount} ${label} finding(s); ${result.deletedFiles.length} file(s) deleted.`);
      for (const c of result.changed) info(`  ${c.file}: removed ${c.removed} item(s)${c.error ? ` (error: ${c.error})` : ''}`);
    }
    info('Review the diff with git before committing.');
  }

  if (opts.prove) {
    const testCmd = opts.testCommand || defaultTestCommand(root, discovery.pkg);
    info(`--prove: running "${testCmd || '(no test command)'}" in a scratch git worktree…`);
    const result = prove(
      root,
      graph,
      opts.includeReview ? visible : visible.filter((f) => f.grade === 'SAFE'),
      {
        testCommand: testCmd,
        includeReview: opts.includeReview,
        includeFixtures: opts.includeFixtures,
        noGitignore: opts.noGitignore,
        javaSafe: opts.javaSafe,
        coveragePath: opts.coveragePath,
        noCoverage: opts.noCoverage,
      },
    );
    info(`--prove: ${result.status} — ${result.proven || 0} proven, ${result.breaks || 0} break${result.breaks === 1 ? 's' : ''}.`);
    for (const r of result.results || []) info(`  ${r.status.padEnd(7)} ${r.cluster} — ${r.reason}`);
    if (result.reason) info(`  ${result.reason}`);
  }

  if (opts.cacheStats) {
    const out = opts.json === '-' ? console.error : console.log;
    if (!cache || !cache.enabled) {
      out('Cache: disabled (--no-cache), no stats collected.');
    } else {
      out(`Cache: ${cache.hits} hit(s), ${cache.misses} missed (${cache.hitRate}% hit rate), `
        + `~${cache.estimatedSavedMs}ms parse time saved — ${cache.location}`);
    }
  }

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

main().catch((e) => {
  console.error(`deadcode-map: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
