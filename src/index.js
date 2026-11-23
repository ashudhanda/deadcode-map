'use strict';

/** Public entry point: run a scan (sync or parallel async) and return the report. */

const fs = require('fs');
const path = require('path');
const { discover } = require('./discover');
const { analyze } = require('./graph');
const { parseJsTs } = require('./parse-js');
const { parsePy } = require('./parse-py');
const { parseJava } = require('./parse-java');
const { gradeFindings, loadFrameworks } = require('./confidence');
const { BASELINE_FILE } = require('./baseline');
const { gitInfo } = require('./git');
const { parseCoverage } = require('./coverage');
const { parseFilesParallel } = require('./parser-pool');
const { loadConfig, configToFrameworkPack } = require('./config');
const { applyInlineIgnores } = require('./rules/ignore');
const {
  computeConfigHash,
  computeContentHash,
  createCacheContext,
  resolveCacheLocation,
  sha256,
} = require('./cache');

const CONFIG_MANIFEST_NAMES = new Set([
  'package.json', 'pyproject.toml', 'tsconfig.json', 'jsconfig.json', 'setup.py', 'setup.cfg',
  'pom.xml', 'build.gradle', 'build.gradle.kts',
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
    noGitignore: Boolean(opts.noGitignore),
    javaSafe: Boolean(opts.javaSafe),
    coveragePath: opts.coveragePath || null,
    noCoverage: Boolean(opts.noCoverage),
    packs: packs.map((p) => p._file || ''),
    packContents: sha256(JSON.stringify(packs)),
    manifests: manifestHashes(discovery),
  });
  const location = resolveCacheLocation(root, opts);
  return createCacheContext({ root, location, configHash });
}

function buildCachedParsers(cacheCtx) {
  if (!cacheCtx) return null;
  return {
    parseJsTs: (file, src, ext) => cacheCtx.parseJs(file, src, ext, parseJsTs),
    parsePy: (file, src) => cacheCtx.parsePy(file, src, parsePy),
    parseJava: (file, src) => cacheCtx.parseJava(file, src, parseJava),
  };
}

function prepareScan(root, opts) {
  const loadedCfg = loadConfig(root, opts && opts.configPath);
  const cfg = loadedCfg.config || {};
  const mergedOpts = {
    ...opts,
    includeFixtures: (opts && opts.includeFixtures !== undefined) ? opts.includeFixtures : Boolean(cfg.includeFixtures),
    noGitignore: (opts && opts.noGitignore !== undefined) ? opts.noGitignore : Boolean(cfg.noGitignore),
    javaSafe: (opts && opts.javaSafe !== undefined) ? opts.javaSafe : Boolean(cfg.javaSafe),
    extraEntries: Array.isArray(cfg.entries) ? cfg.entries : [],
    ignorePatterns: Array.isArray(cfg.ignore) ? cfg.ignore : [],
  };
  const discovery = discover(root, mergedOpts);
  // Exclude the project config file itself from string-reference scanning.
  if (loadedCfg.path) {
    discovery.textFiles = (discovery.textFiles || []).filter((f) => f !== loadedCfg.path);
    discovery.allFiles = (discovery.allFiles || []).filter((f) => f !== loadedCfg.path);
  }
  // The cache file must never be scanned, in any mode: it contains
  // cached symbol names, which would otherwise count as string
  // references and keep dead code alive.
  const cacheFile = resolveCacheLocation(root, opts);
  if (cacheFile.startsWith(discovery.root + path.sep)) {
    discovery.textFiles = (discovery.textFiles || []).filter((f) => f !== cacheFile);
    discovery.allFiles = (discovery.allFiles || []).filter((f) => f !== cacheFile);
  }
  // The baseline file (.deadcode-map.json) is excluded the same way:
  // it lists finding ids and symbol names, so on the run after
  // --update-baseline its contents counted as string references and
  // demoted SAFE findings to REVIEW.
  const baselineFile = path.join(discovery.root, BASELINE_FILE);
  discovery.textFiles = (discovery.textFiles || []).filter((f) => f !== baselineFile);
  discovery.allFiles = (discovery.allFiles || []).filter((f) => f !== baselineFile);

  const packs = loadFrameworks(path.join(__dirname, '..', 'frameworks'));
  const customPack = configToFrameworkPack(cfg, loadedCfg.path);
  if (customPack) packs.push(customPack);
  const cacheCtx = buildCacheContext(root, discovery, packs, mergedOpts);
  return { discovery, packs, cacheCtx, mergedOpts, config: cfg };
}

function finalizeScan(root, opts, discovery, packs, cacheCtx, graph) {
  if (cacheCtx) {
    cacheCtx.save();
    for (const w of cacheCtx.warnings) console.error(`deadcode-map cache: ${w}`);
  }
  const git = gitInfo(root, discovery.codeFiles);
  // Coverage is re-read fresh every run (never cached): it is evidence
  // about the current code, and a stale coverage file can only demote
  // SAFE to REVIEW, never invent a SAFE.
  const coverage = opts && opts.noCoverage ? null : parseCoverage(root, opts && opts.coveragePath);
  const rawFindings = gradeFindings({
    root: discovery.root,
    discovery,
    graph,
    git,
    coverage,
    packs,
    isLibrary: discovery.isLibrary,
    javaSafe: Boolean(opts && opts.javaSafe),
  });
  const findings = applyInlineIgnores(discovery.root, graph, rawFindings);
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

function scan(root, opts) {
  const { discovery, packs, cacheCtx, mergedOpts } = prepareScan(root, opts);
  const graph = analyze(root, discovery, { parsers: buildCachedParsers(cacheCtx) });
  return finalizeScan(root, mergedOpts, discovery, packs, cacheCtx, graph);
}

async function scanAsync(root, opts) {
  const { discovery, packs, cacheCtx, mergedOpts } = prepareScan(root, opts);
  const preparsed = await parseFilesParallel(root, discovery, cacheCtx, opts && opts.workers);
  const graph = preparsed
    ? analyze(root, discovery, { preparsed })
    : analyze(root, discovery, { parsers: buildCachedParsers(cacheCtx) });
  return finalizeScan(root, mergedOpts, discovery, packs, cacheCtx, graph);
}

module.exports = { scan, scanAsync };
