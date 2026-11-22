'use strict';

/** Public entry point: run a scan and return the report. */

const fs = require('fs');
const path = require('path');
const { discover } = require('./discover');
const { analyze } = require('./graph');
const { gradeFindings, loadFrameworks } = require('./confidence');
const { gitInfo } = require('./git');
const { parseCoverage } = require('./coverage');
const {
  computeConfigHash,
  computeContentHash,
  createCacheContext,
  resolveCacheLocation,
  sha256,
} = require('./cache');

/**
 * Cache wiring for a scan.
 *
 * The graph parses each file through parse-js / parse-py, which it
 * requires itself — so the cache is installed by briefly wrapping
 * those parser modules and re-requiring the graph, which then binds
 * the wrapped parsers. The wrappers are restored immediately after
 * the graph loads (the graph already holds its references), and the
 * re-require is synchronous inside scan(), so no other scan can
 * interleave. With the cache off, the plain top-level `analyze` runs
 * exactly as before.
 */
function analyzeWithCache(root, discovery, cacheCtx) {
  if (!cacheCtx) return analyze(root, discovery);
  const graphPath = require.resolve('./graph');
  delete require.cache[graphPath];
  const jsMod = require('./parse-js');
  const pyMod = require('./parse-py');
  const origJs = jsMod.parseJsTs;
  const origPy = pyMod.parsePy;
  jsMod.parseJsTs = (file, src, ext) => cacheCtx.parseJs(file, src, ext, origJs);
  pyMod.parsePy = (file, src) => cacheCtx.parsePy(file, src, origPy);
  let freshGraph;
  try {
    freshGraph = require('./graph');
  } finally {
    jsMod.parseJsTs = origJs;
    pyMod.parsePy = origPy;
  }
  try {
    return freshGraph.analyze(root, discovery);
  } finally {
    // Restore the pristine graph module in the require cache: the
    // fresh module above binds the cache-wrapped parsers, and a later
    // lazy require('./graph') in this process (prove.js re-runs the
    // analysis inside its worktree) must never see parsers bound to
    // this scan's cache context. graph.js requires only fs/path and
    // the two parsers, so reloading it here is cycle-free.
    delete require.cache[graphPath];
    require('./graph');
  }
}

/** Manifest files whose contents feed the config hash (see cache.js). */
const CONFIG_MANIFEST_NAMES = new Set([
  'package.json', 'pyproject.toml', 'tsconfig.json', 'jsconfig.json', 'setup.py', 'setup.cfg',
]);

function manifestHashes(discovery) {
  const out = {};
  for (const f of discovery.allFiles || []) {
    if (!CONFIG_MANIFEST_NAMES.has(path.basename(f))) continue;
    try {
      out[path.relative(discovery.root, f)] = computeContentHash(fs.readFileSync(f));
    } catch (_) { /* unreadable manifest — skip it */ }
  }
  return out;
}

/**
 * Cache options on `opts`:
 *   opts.cache       — enable the parse cache (--cache)
 *   opts.noCache     — force a full scan, no cache read or write (--no-cache, wins over --cache)
 *   opts.cacheStats  — print hit/miss stats; implies --cache (--cache-stats)
 *   opts.cacheLocation — explicit cache file path (tests / scripts)
 *
 * Output options on `opts`:
 *   opts.excludeFiles — exact file paths to leave out of discovery
 *     (absolute, or relative to the scanned root). The CLI passes the
 *     resolved --json / --map output paths here, so a report or map
 *     written inside the scanned root is never scanned on the next
 *     run. Applies whether or not --cache is on.
 *
 * Default: OFF. A scan is read-only by default and writes nothing
 * into the scanned repo unless the user opts in with --cache.
 */
function buildCacheContext(root, discovery, packs, opts) {
  if (!opts || opts.noCache) return null;
  if (!opts.cache && !opts.cacheStats) return null;
  const entries = [...discovery.entries.entries()]
    .map(([abs, reason]) => ({ file: path.relative(discovery.root, abs), reason }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const configHash = computeConfigHash({
    entries,
    includeFixtures: Boolean(opts.includeFixtures),
    // Coverage affects grades (a covered body line demotes SAFE to
    // REVIEW), so the coverage options join the config hash: changing
    // them re-parses instead of reusing parses graded under the old
    // coverage. The coverage file itself is re-read fresh every run
    // (see scan()), so a warm run still reflects current coverage.
    coveragePath: opts.coveragePath || null,
    noCoverage: Boolean(opts.noCoverage),
    packs: packs.map((p) => p._file || ''),
    packContents: sha256(JSON.stringify(packs)),
    manifests: manifestHashes(discovery),
  });
  const location = resolveCacheLocation(root, opts);
  return createCacheContext({ root, location, configHash });
}

function scan(root, opts) {
  const discovery = discover(root, opts);
  // The cache file must never be scanned, in any mode: it contains
  // cached symbol names, which would otherwise count as string
  // references and keep dead code alive. This applies even to a
  // --no-cache run, where a cache file from an earlier --cache run
  // may already exist. (The node_modules location is already skipped
  // by discovery; the dotfile location is filtered here.)
  const cacheFile = resolveCacheLocation(root, opts);
  if (cacheFile.startsWith(discovery.root + path.sep)) {
    discovery.textFiles = (discovery.textFiles || []).filter((f) => f !== cacheFile);
    discovery.allFiles = (discovery.allFiles || []).filter((f) => f !== cacheFile);
  }
  // Framework packs are loaded before the analysis so their contents
  // can feed the cache config hash (a pack change forces a re-parse).
  const packs = loadFrameworks(path.join(__dirname, '..', 'frameworks'));
  const cacheCtx = buildCacheContext(root, discovery, packs, opts);
  const graph = analyzeWithCache(root, discovery, cacheCtx);
  if (cacheCtx) {
    cacheCtx.save();
    // Warnings (load + save) go to stderr so `--json -` stdout stays pure JSON.
    for (const w of cacheCtx.warnings) console.error(`deadcode-map cache: ${w}`);
  }
  const git = gitInfo(root, discovery.codeFiles);
  // Coverage is re-read fresh every run (never cached): it is evidence
  // about the current code, and a stale coverage file can only demote
  // SAFE to REVIEW, never invent a SAFE. --coverage points at an
  // explicit Cobertura XML or lcov file; --no-coverage ignores any
  // coverage file in the repo.
  const coverage = opts && opts.noCoverage ? null : parseCoverage(root, opts && opts.coveragePath);
  const findings = gradeFindings({
    root: discovery.root, discovery, graph, git, coverage, packs,
    isLibrary: discovery.isLibrary,
  });
  return {
    root: discovery.root,
    discovery,
    graph,
    findings,
    git,
    coverage,
    packs,
    cache: cacheCtx
      ? cacheCtx.stats()
      : { enabled: false, location: null, files: 0, hits: 0, misses: 0, hitRate: 0, estimatedSavedMs: 0, warnings: [] },
  };
}

module.exports = { scan };
