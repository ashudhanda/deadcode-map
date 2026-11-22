'use strict';

/**
 * Incremental scan cache.
 *
 * Design recommendation (assembled from Knip / Skylos / graveyard
 * behaviour — see the advanced-research report §4.2; it is a design
 * recommendation, not a verified fact): cache per-file parse results,
 * keyed by content hash, and rebuild the import graph fresh on every
 * run from the cached parses plus fresh entry-point discovery.
 *
 * Cache key per file: SHA-256(file content) + tool version +
 * parser/grammar version + config hash. The config hash covers the
 * resolved entry points, the framework packs, the manifest files
 * (package.json / pyproject.toml / tsconfig / setup files) and the CLI
 * flags that affect findings. A config or tool/parser change therefore
 * forces a full re-parse automatically.
 *
 * Cached value per file: the parsed symbols (definitions, imports with
 * their sources, exports, calls, dynamic-import flags, decorator list,
 * string literals, unreachable ranges), plus the file's export set.
 * The resolved import edge list is NOT cached: an edge depends on the
 * whole repo file set (a new file can change what an import resolves
 * to), so the graph rebuilds edges from the cached parses every run,
 * which is exactly the "graph is always rebuilt" rule. Because the
 * graph is rebuilt, an export-set change in one file is picked up by
 * every file that imports it with no extra invalidation step.
 *
 * Safety: cache read/write failures are fail-open (warn, do a full
 * scan, never abort). `prove` results are never cached: only parses
 * are cached, and `prove` re-runs the test suite every time. A warm
 * run must produce identical findings to a cold run.
 *
 * Default location: node_modules/.cache/deadcode-map/cache.json when
 * the scanned root has a node_modules directory, else
 * .deadcode-map-cache.json next to the scanned root. Both are
 * gitignored-friendly (node_modules is ignored by convention; the
 * dotfile can be ignored with one line). The cache file is never a
 * committed source file.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FORMAT_VERSION = 4; // v4: conditional module-level defs are exported (batch 7: `if`/`try`-nested defs report parentType 'module'), and JS parses carry hasModuleSyntax — v3 caches lack both
const DOTFILE_NAME = '.deadcode-map-cache.json';
const NODE_MODULES_CACHE_REL = path.join('node_modules', '.cache', 'deadcode-map', 'cache.json');

function toolVersion() {
  try {
    return require('../package.json').version;
  } catch (_) {
    return 'unknown';
  }
}

function parserVersion() {
  try {
    const versionOf = (name) => require(`${name}/package.json`).version;
    return ['tree-sitter', 'tree-sitter-javascript', 'tree-sitter-typescript', 'tree-sitter-python', 'tree-sitter-java']
      .map((name) => `${name}@${versionOf(name)}`)
      .join('+');
  } catch (_) {
    return 'unknown';
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** JSON with sorted object keys, so equal configs hash equally. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Config hash: resolved entry points, framework packs, manifest files, finding-affecting flags. */
function computeConfigHash(config) {
  return sha256(stableStringify(config));
}

function computeContentHash(content) {
  return sha256(typeof content === 'string' ? content : content);
}

/** Sorted exported names of a parsed file: its export set. */
function exportSetOf(parsed) {
  if (!parsed) return [];
  const names = new Set();
  for (const e of parsed.exports || []) if (e && e.name) names.add(e.name);
  for (const d of parsed.definitions || []) if (d && d.exported && d.name) names.add(d.name);
  return [...names].sort();
}

/**
 * Parsers return Sets for `references` (and `dunder` in Python); the
 * rest of the parsed shape is plain JSON. Serialise the Sets as arrays
 * and restore them on read, so a cached parse is identical to a fresh
 * one for every consumer (graph, confidence, fix).
 */
function serializeParsed(parsed) {
  if (!parsed) return null;
  const out = { ...parsed };
  out.references = [...(parsed.references || [])];
  if (parsed.dunder) out.dunder = [...parsed.dunder];
  return out;
}

function deserializeParsed(data) {
  if (!data) return null;
  const out = { ...data };
  out.references = new Set(Array.isArray(data.references) ? data.references : []);
  if (Array.isArray(data.dunder)) out.dunder = new Set(data.dunder);
  return out;
}

/** Default cache file for a scanned root (see the module header). */
function resolveCacheLocation(root, opts) {
  if (opts && opts.cacheLocation) return path.resolve(opts.cacheLocation);
  const absRoot = path.resolve(root);
  try {
    if (fs.statSync(path.join(absRoot, 'node_modules')).isDirectory()) {
      return path.join(absRoot, NODE_MODULES_CACHE_REL);
    }
  } catch (_) { /* no node_modules — fall through to the dotfile */ }
  return path.join(absRoot, DOTFILE_NAME);
}

function emptyCache() {
  return { entries: new Map(), valid: false, warning: null, avgParseMs: 0 };
}

/**
 * Load a cache file. Fail-open: a missing, corrupt, or incompatible
 * file yields an empty cache plus a warning, never an abort.
 */
function loadCache(location, expected) {
  const cache = emptyCache();
  let raw;
  try {
    raw = fs.readFileSync(location, 'utf8');
  } catch (_) {
    return cache; // missing cache is normal on a first run
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    cache.warning = `ignoring corrupt cache file ${location}: not valid JSON`;
    return cache;
  }
  if (!data || data.format !== FORMAT_VERSION || typeof data.entries !== 'object' || data.entries === null) {
    cache.warning = `ignoring cache file ${location}: unsupported format`;
    return cache;
  }
  if (data.toolVersion !== expected.toolVersion) {
    cache.warning = `ignoring cache file ${location}: tool version changed (${data.toolVersion} -> ${expected.toolVersion})`;
    return cache;
  }
  if (data.parserVersion !== expected.parserVersion) {
    cache.warning = `ignoring cache file ${location}: parser version changed`;
    return cache;
  }
  if (data.configHash !== expected.configHash) {
    cache.warning = `ignoring cache file ${location}: scan configuration changed`;
    return cache;
  }
  for (const [rel, entry] of Object.entries(data.entries)) {
    if (!entry || typeof entry.hash !== 'string' || !entry.parsed) continue;
    cache.entries.set(rel, entry);
  }
  cache.valid = true;
  cache.avgParseMs = typeof data.avgParseMs === 'number' && data.avgParseMs > 0 ? data.avgParseMs : 0;
  return cache;
}

/**
 * Save a cache file. Fail-open: a write failure yields a warning and
 * the scan results are unaffected. Writes via a temp file + rename so
 * a concurrent reader never sees a half-written cache.
 */
function saveCache(location, data) {
  try {
    fs.mkdirSync(path.dirname(location), { recursive: true });
    const tmp = `${location}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, location);
    return { ok: true, warning: null };
  } catch (e) {
    return { ok: false, warning: `could not write cache file ${location}: ${e.message}` };
  }
}

/**
 * A per-scan cache session: holds the loaded entries, counts hits and
 * misses, and wraps the tree-sitter parsers so the graph reuses cached
 * parses without any change to the graph itself.
 */
function createCacheContext({ root, location, configHash }) {
  const expected = { toolVersion: toolVersion(), parserVersion: parserVersion(), configHash };
  const loaded = loadCache(location, expected);
  const warnings = [];
  if (loaded.warning) warnings.push(loaded.warning);
  const entries = loaded.entries; // Map<rel, { hash, exportSet, parsed }>
  const seen = new Set();
  let hits = 0;
  let misses = 0;
  let parseMs = 0;
  // Successful parses only. Files that fail to parse throw before any
  // time is recorded and are never stored, so counting them in the
  // average would drag it to ~0 (fastapi has 13 such files, every run).
  let parsedCount = 0;
  // Average parse cost from the run that populated the cache. A warm
  // run has almost no misses, so its own average would be noise (and
  // files that fail to parse throw before any time is recorded);
  // the stored average is what makes the time-saved estimate honest.
  const storedAvgParseMs = loaded.avgParseMs || 0;

  function lookup(rel, contentHash) {
    seen.add(rel);
    const entry = entries.get(rel);
    if (entry && entry.hash === contentHash) {
      hits += 1;
      return deserializeParsed(entry.parsed);
    }
    misses += 1;
    return null;
  }

  function store(rel, contentHash, parsed) {
    let stored;
    try {
      // Normalise through JSON: what is stored is exactly what a later
      // run reads back, so a warm parse is identical to a fresh one.
      stored = JSON.parse(JSON.stringify(serializeParsed(parsed)));
    } catch (_) {
      return; // unserialisable parse — skip caching this file, keep scanning
    }
    entries.set(rel, { hash: contentHash, exportSet: exportSetOf(parsed), parsed: stored });
  }

  function wrapParse(rel, content, parseFn) {
    const contentHash = computeContentHash(content);
    const cached = lookup(rel, contentHash);
    if (cached) return cached;
    const start = Date.now();
    const parsed = parseFn();
    parseMs += Date.now() - start;
    parsedCount += 1;
    if (parsed) store(rel, contentHash, parsed);
    return parsed;
  }

  return {
    enabled: true,
    root: path.resolve(root),
    location,
    warnings,
    parseJs(file, src, ext, origParseJsTs) {
      const rel = path.relative(path.resolve(root), file);
      return wrapParse(rel, src, () => origParseJsTs(file, src, ext));
    },
    parsePy(file, src, origParsePy) {
      const rel = path.relative(path.resolve(root), file);
      return wrapParse(rel, src, () => origParsePy(file, src));
    },
    parseJava(file, src, origParseJava) {
      const rel = path.relative(path.resolve(root), file);
      return wrapParse(rel, src, () => origParseJava(file, src));
    },
    /** Persist entries for files seen in this scan; drop deleted files. */
    save() {
      for (const rel of [...entries.keys()]) {
        if (!seen.has(rel)) entries.delete(rel);
      }
      const data = {
        format: FORMAT_VERSION,
        toolVersion: expected.toolVersion,
        parserVersion: expected.parserVersion,
        configHash: expected.configHash,
        // Keep the last measured average when this run parsed too few
        // files to measure one (a pure warm run, or a run whose only
        // misses are files that fail to parse), so later runs can still
        // estimate savings.
        avgParseMs: parsedCount >= 10 ? parseMs / parsedCount : storedAvgParseMs,
        entries: Object.fromEntries(entries),
      };
      const result = saveCache(location, data);
      if (result.warning) warnings.push(result.warning);
      return result.ok;
    },
    stats() {
      const files = hits + misses;
      // Prefer the stored average from the run that populated the
      // cache: it measured hundreds of parses, while this run may have
      // only a couple of misses (or only files that fail to parse).
      const avgMissMs = storedAvgParseMs > 0
        ? storedAvgParseMs
        : (parsedCount > 0 ? parseMs / parsedCount : 0);
      return {
        enabled: true,
        location,
        files,
        hits,
        misses,
        hitRate: files > 0 ? Math.round((hits / files) * 100) : 0,
        // Estimate only: each hit skipped a parse, and a parse costs
        // about the average miss time on this run (or the stored
        // average from the run that populated the cache).
        estimatedSavedMs: Math.round(hits * avgMissMs),
        warnings: [...warnings],
      };
    },
  };
}

module.exports = {
  FORMAT_VERSION,
  DOTFILE_NAME,
  toolVersion,
  parserVersion,
  sha256,
  stableStringify,
  computeConfigHash,
  computeContentHash,
  exportSetOf,
  serializeParsed,
  deserializeParsed,
  resolveCacheLocation,
  loadCache,
  saveCache,
  createCacheContext,
};
