'use strict';

/**
 * Incremental scan cache tests.
 *
 * Covers the cache design (per-file parse cache keyed by content hash
 * + tool/parser version + config hash; graph always rebuilt fresh):
 * identical warm/cold findings, per-file invalidation, export-set
 * changes re-evaluating dependents, config changes forcing a full
 * re-parse, fail-open on corrupt cache, --cache-stats, --no-cache.
 *
 * Scans run on temp copies, never on the repo's own fixtures, and the
 * cache file lives inside the scanned temp dir (which also proves the
 * cache file itself is never scanned as repo content).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'deadcode-map.js');
const { scan } = require('../src/index');
const { parseJsTs } = require('../src/parse-js');
const {
  computeConfigHash,
  deserializeParsed,
  exportSetOf,
  loadCache,
  resolveCacheLocation,
  serializeParsed,
} = require('../src/cache');

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cache-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

function cachePath(dir) {
  return path.join(dir, 'cache.json');
}

function scanCached(dir, extra) {
  return scan(dir, { cache: true, cacheLocation: cachePath(dir), ...(extra || {}) });
}

/**
 * Cold findings for a repo that already has a cache file: scan a
 * pristine copy without the cache file. (A plain scan of the original
 * would read cache.json as repo content — its stored symbol names
 * would count as string references. The cached scan filters the cache
 * file out; the comparison must too.)
 */
function coldFindingsOf(dir) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cache-cold-'));
  fs.cpSync(dir, copy, { recursive: true, filter: (src) => src !== cachePath(dir) });
  return scan(copy, {}).findings;
}

/** App repo: private package.json, so exported-but-uncalled symbols grade SAFE. */
function appRepo() {
  return makeRepo({
    'package.json': JSON.stringify({ name: 't', private: true, main: 'src/main.js' }),
    'src/main.js': "import { helper } from './lib.js';\nconsole.log(helper());\n",
    'src/lib.js': 'export function helper() { return 1; }\nexport function dead() { return 2; }\n',
  });
}

function findingIds(findings) {
  return findings.map((f) => `${f.category}|${f.file}|${f.symbol || ''}|${f.grade}`).sort();
}

function runCli(dir, args) {
  return spawnSync(process.execPath, [BIN, dir, ...args], { encoding: 'utf8' });
}

// --- unit: parse serialisation round-trip ---

test('cache: serialised parse round-trips identically (Sets restored)', () => {
  const src = "import { a } from './b.js';\nexport function alive() { return a; }\nfunction hidden() { return 1; }\n";
  const parsed = parseJsTs('/tmp/x.js', src, '.js');
  assert.ok(parsed.references instanceof Set, 'fresh parse has a references Set');
  const restored = deserializeParsed(JSON.parse(JSON.stringify(serializeParsed(parsed))));
  assert.ok(restored.references instanceof Set, 'restored parse has a references Set');
  assert.deepEqual(serializeParsed(restored), serializeParsed(parsed));
  assert.deepEqual(restored.definitions, parsed.definitions);
  assert.deepEqual(restored.imports, parsed.imports);
  assert.deepEqual(restored.exports, parsed.exports);
  assert.deepEqual(restored.calls, parsed.calls);
});

test('cache: exportSetOf lists sorted exported names', () => {
  const parsed = parseJsTs('/tmp/x.js', 'export function b() {}\nexport const a = 1;\nfunction c() {}\n', '.js');
  assert.deepEqual(exportSetOf(parsed), ['a', 'b']);
});

test('cache: config hash is stable under key order and changes with entries', () => {
  const a = computeConfigHash({ entries: [{ file: 'x.js', reason: 'r' }], includeFixtures: false });
  const b = computeConfigHash({ includeFixtures: false, entries: [{ file: 'x.js', reason: 'r' }] });
  assert.equal(a, b);
  const c = computeConfigHash({ entries: [{ file: 'y.js', reason: 'r' }], includeFixtures: false });
  assert.notEqual(a, c);
});

test('cache: default location prefers node_modules, else a dotfile', () => {
  const withNm = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cache-nm-'));
  fs.mkdirSync(path.join(withNm, 'node_modules'));
  assert.equal(
    resolveCacheLocation(withNm, {}),
    path.join(withNm, 'node_modules', '.cache', 'deadcode-map', 'cache.json'),
  );
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cache-bare-'));
  assert.equal(resolveCacheLocation(bare, {}), path.join(bare, '.deadcode-map-cache.json'));
});

test('cache: corrupt / missing / stale cache files fail open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cache-corrupt-'));
  const loc = path.join(dir, 'cache.json');
  const expected = { toolVersion: '0.1.0', parserVersion: 'p', configHash: 'c' };
  const missing = loadCache(loc, expected);
  assert.equal(missing.entries.size, 0);
  assert.equal(missing.warning, null, 'a missing cache is normal, not a warning');
  fs.writeFileSync(loc, '{not json');
  const corrupt = loadCache(loc, expected);
  assert.equal(corrupt.entries.size, 0);
  assert.match(corrupt.warning, /corrupt/);
  fs.writeFileSync(loc, JSON.stringify({ format: 2, toolVersion: '9.9.9', parserVersion: 'p', configHash: 'c', entries: {} }));
  const stale = loadCache(loc, expected);
  assert.equal(stale.entries.size, 0);
  assert.match(stale.warning, /tool version/);
  // A v1 cache file (written before per-definition scopes existed) is
  // rejected as unsupported format, never silently reused: its parses
  // lack `uses` / `topLevelUses`, so reusing them would silently
  // disable the same-file cascade.
  fs.writeFileSync(loc, JSON.stringify({ format: 1, toolVersion: '0.1.0', parserVersion: 'p', configHash: 'c', entries: {} }));
  const oldFormat = loadCache(loc, expected);
  assert.equal(oldFormat.entries.size, 0);
  assert.match(oldFormat.warning, /unsupported format/);
});

// --- scan: warm run is identical to a cold run ---

test('cache: warm findings are identical to cold findings (JS + Python fixtures)', () => {
  for (const name of ['js-basic', 'py-basic']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dcm-cache-${name}-`));
    fs.cpSync(path.join(ROOT, 'fixtures', name), dir, { recursive: true });
    const cold = scan(dir, {});
    const warm1 = scanCached(dir);
    const warm2 = scanCached(dir);
    assert.deepEqual(findingIds(warm1.findings), findingIds(cold.findings), `${name}: first cached run`);
    assert.deepEqual(findingIds(warm2.findings), findingIds(cold.findings), `${name}: second cached run`);
    assert.deepEqual(warm2.findings, cold.findings, `${name}: full finding objects identical`);
    assert.equal(warm1.cache.hits, 0, `${name}: first run misses everything`);
    assert.equal(warm1.cache.misses, warm1.cache.files, `${name}: first run misses everything`);
    assert.equal(warm2.cache.misses, 0, `${name}: second run hits everything`);
    assert.equal(warm2.cache.hits, warm2.cache.files, `${name}: second run hits everything`);
    assert.ok(warm2.cache.hitRate === 100);
  }
});

test('cache: default scan writes no cache file and reports the cache disabled', () => {
  const dir = appRepo();
  const result = scan(dir, {});
  assert.equal(result.cache.enabled, false);
  assert.equal(fs.existsSync(path.join(dir, '.deadcode-map-cache.json')), false);
  assert.equal(fs.existsSync(cachePath(dir)), false);
});

// --- scan: per-file invalidation ---

test('cache: content change re-parses only that file', () => {
  const dir = appRepo();
  scanCached(dir);
  const warm = scanCached(dir);
  assert.equal(warm.cache.misses, 0);
  // Change only lib.js (same export set, different body).
  fs.writeFileSync(path.join(dir, 'src', 'lib.js'),
    'export function helper() { return 10; }\nexport function dead() { return 20; }\n');
  const after = scanCached(dir);
  assert.equal(after.cache.misses, 1, 'only the changed file is re-parsed');
  assert.equal(after.cache.hits, 1, 'the unchanged file is a hit');
  assert.deepEqual(findingIds(after.findings), findingIds(coldFindingsOf(dir)));
});

test('cache: export-set change re-evaluates dependents without re-parsing them', () => {
  const dir = appRepo();
  const first = scanCached(dir);
  assert.ok(findingIds(first.findings).some((id) => id.includes('src/lib.js|dead|SAFE')),
    'dead export is SAFE before the change');
  // Add a new dead export to lib.js; main.js (the dependent) is untouched.
  fs.writeFileSync(path.join(dir, 'src', 'lib.js'),
    'export function helper() { return 1; }\nexport function dead() { return 2; }\n'
    + 'export function brandNew() { return 3; }\n');
  const after = scanCached(dir);
  assert.equal(after.cache.misses, 1, 'only lib.js is re-parsed');
  assert.equal(after.cache.hits, 1, 'main.js is a cache hit');
  assert.ok(findingIds(after.findings).some((id) => id.includes('src/lib.js|brandNew|SAFE')),
    'the new dead export is found on the warm run');
  assert.deepEqual(findingIds(after.findings), findingIds(coldFindingsOf(dir)),
    'warm findings match a cold scan after the export-set change');
  // The stored entry records the new export set.
  const stored = JSON.parse(fs.readFileSync(cachePath(dir), 'utf8'));
  assert.deepEqual(stored.entries['src/lib.js'].exportSet, ['brandNew', 'dead', 'helper']);
  // Remove the dead export again: its finding disappears on the warm run.
  fs.writeFileSync(path.join(dir, 'src', 'lib.js'),
    'export function helper() { return 1; }\n');
  const removed = scanCached(dir);
  assert.ok(!findingIds(removed.findings).some((id) => id.includes('src/lib.js|dead|')),
    'the removed export no longer reports');
  assert.deepEqual(findingIds(removed.findings), findingIds(coldFindingsOf(dir)));
});

test('cache: config change forces a full re-parse', () => {
  const dir = appRepo();
  scanCached(dir);
  assert.equal(scanCached(dir).cache.misses, 0);
  // Point package.json main at a different entry file: the resolved
  // entry set changes, so the config hash changes and every file is
  // re-parsed.
  fs.writeFileSync(path.join(dir, 'src', 'other.js'), "import { helper } from './lib.js';\nhelper();\n");
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 't', private: true, main: 'src/other.js' }));
  const after = scanCached(dir);
  assert.equal(after.cache.hits, 0, 'config change invalidates the whole cache');
  assert.equal(after.cache.misses, after.cache.files);
  assert.deepEqual(findingIds(after.findings), findingIds(coldFindingsOf(dir)));
});

test('cache: corrupt cache file fails open with a full scan, no crash', () => {
  const dir = appRepo();
  const cold = scan(dir, {});
  scanCached(dir);
  assert.equal(scanCached(dir).cache.misses, 0);
  fs.writeFileSync(cachePath(dir), '{this is not json');
  const after = scanCached(dir);
  assert.equal(after.cache.misses, after.cache.files, 'corrupt cache means a full re-parse');
  assert.ok(after.cache.warnings.some((w) => /corrupt/.test(w)));
  assert.deepEqual(findingIds(after.findings), findingIds(cold.findings));
});

// --- CLI flags ---

test('CLI: --cache-stats prints hit/miss counts, warm run is 100%', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cache-cli-'));
  fs.cpSync(path.join(ROOT, 'fixtures', 'js-basic'), dir, { recursive: true });
  // Reports live outside the scanned dir: a report written inside it
  // would be scanned as repo content on the next run (its symbol names
  // count as string references) — a pre-existing quirk, not a cache one.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cache-cli-out-'));
  const r1 = runCli(dir, ['--cache', '--cache-stats', '--json', path.join(out, 'r1.json')]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /Cache: 0 hit\(s\), 7 missed \(0% hit rate\)/);
  const r2 = runCli(dir, ['--cache', '--cache-stats', '--json', path.join(out, 'r2.json')]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /Cache: 7 hit\(s\), 0 missed \(100% hit rate\)/);
  const cold = JSON.parse(fs.readFileSync(path.join(out, 'r1.json'), 'utf8'));
  const warm = JSON.parse(fs.readFileSync(path.join(out, 'r2.json'), 'utf8'));
  assert.deepEqual(warm.findings, cold.findings);
});

test('CLI: --no-cache ignores the cache and writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cache-nocache-'));
  fs.cpSync(path.join(ROOT, 'fixtures', 'js-basic'), dir, { recursive: true });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cache-nocache-out-'));
  const r1 = runCli(dir, ['--cache', '--json', path.join(out, 'r1.json')]);
  assert.equal(r1.status, 0, r1.stderr);
  const cacheFile = path.join(dir, '.deadcode-map-cache.json');
  assert.ok(fs.existsSync(cacheFile), 'a --cache run writes the cache');
  const before = fs.readFileSync(cacheFile, 'utf8');
  const r2 = runCli(dir, ['--no-cache', '--cache-stats', '--json', path.join(out, 'r2.json')]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /Cache: disabled/);
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), before, '--no-cache must not touch the cache');
  const cold = JSON.parse(fs.readFileSync(path.join(out, 'r1.json'), 'utf8'));
  const forced = JSON.parse(fs.readFileSync(path.join(out, 'r2.json'), 'utf8'));
  assert.deepEqual(forced.findings, cold.findings);
});

test('CLI: --cache-stats with --json - keeps stdout pure JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cache-jsondash-'));
  fs.cpSync(path.join(ROOT, 'fixtures', 'js-basic'), dir, { recursive: true });
  runCli(dir, ['--cache']);
  const r = runCli(dir, ['--cache', '--cache-stats', '--json', '-']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout); // throws if stats leaked into stdout
  assert.equal(report.tool, 'deadcode-map');
  assert.match(r.stderr, /Cache: 7 hit\(s\)/);
});
