'use strict';

/**
 * Fixture tests: the FP rate on SAFE is the claim that matters.
 * Every live symbol in the fixtures must NOT be flagged SAFE;
 * every planted dead item must be found at SAFE or REVIEW.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan } = require('../src/index');

const ROOT = path.join(__dirname, '..');

function findingsFor(dir) {
  return scan(path.join(ROOT, 'fixtures', dir)).findings;
}

function bySymbol(findings, file, symbol) {
  return findings.find((f) => f.file.endsWith(file) && f.symbol === symbol);
}

function byCategory(findings, file, category) {
  return findings.find((f) => f.file.endsWith(file) && f.category === category && !f.symbol);
}

test('js-basic: live symbols are never flagged', () => {
  const f = findingsFor('js-basic');
  for (const [file, symbol] of [
    ['src/index.js', null],
    ['src/used.js', 'usedFn'],
    ['src/used.js', 'privateUsed'],
    ['src/helper.js', 'helper'],
  ]) {
    if (symbol) assert.equal(bySymbol(f, file, symbol), undefined, `${symbol} must not be flagged`);
  }
  // No live symbol may be SAFE.
  const live = ['usedFn', 'privateUsed', 'helper'];
  for (const finding of f.filter((x) => x.grade === 'SAFE')) {
    assert.ok(!live.includes(finding.symbol), `live symbol flagged SAFE: ${finding.symbol}`);
  }
});

test('js-basic: planted dead items are found', () => {
  const f = findingsFor('js-basic');
  assert.equal(byCategory(f, 'src/dead-file.js', 'file').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/used.js', 'unusedImport').grade, 'SAFE');
  assert.equal(byCategory(f, 'src/used.js', 'unreachable').grade, 'SAFE');
  // Exported-but-never-imported is REVIEW, never SAFE.
  assert.equal(bySymbol(f, 'src/used.js', 'privateDead').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/used.js', 'unusedExport').grade, 'REVIEW');
  // Same-file use is alive, not a finding: helper() calls sameFileOnly()
  // in its own file, so it is used — never REVIEW, never SAFE.
  assert.equal(bySymbol(f, 'src/helper.js', 'sameFileOnly'), undefined);
  // String-referenced symbol is REVIEW, never SAFE.
  assert.equal(bySymbol(f, 'src/string-ref.js', 'stringOnlyFn').grade, 'REVIEW');
  assert.equal(byCategory(f, 'src/string-ref.js', 'file').grade, 'REVIEW');
  // Dynamic-import target is REVIEW, never SAFE.
  assert.equal(bySymbol(f, 'src/lazy-target.js', 'lazyFn').grade, 'REVIEW');
});

test('js-basic: SAFE false-positive rate is 0%', () => {
  const f = findingsFor('js-basic');
  const safe = f.filter((x) => x.grade === 'SAFE');
  // Planted SAFE items: dead-file, unused import, unreachable code.
  // dynamic.js file is also genuinely dead (nothing imports it).
  const expectedSafe = new Set([
    'file:src/dead-file.js', 'file:src/dynamic.js',
    'import:src/used.js:unusedImport', 'unreachable:src/used.js',
  ]);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
  const fpRate = safe.filter((s) => !expectedSafe.has(`${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`)).length / Math.max(safe.length, 1);
  assert.ok(fpRate < 0.05, `SAFE FP rate ${fpRate} exceeds 5% target`);
});

test('py-basic: live symbols are never flagged, framework kept', () => {
  const f = findingsFor('py-basic');
  for (const symbol of ['used_fn', 'format_name', '_double']) {
    assert.equal(bySymbol(f, 'utils.py', symbol), undefined, `${symbol} must not be flagged`);
  }
  assert.equal(bySymbol(f, 'app.py', 'hello').grade, 'KEEP'); // @app.route
  assert.equal(bySymbol(f, 'test_utils.py', 'test_used_fn').grade, 'KEEP');
  assert.equal(bySymbol(f, 'utils.py', '__init__').grade, 'KEEP');
  assert.equal(bySymbol(f, 'utils.py', '__str__').grade, 'KEEP');
});

test('py-basic: planted dead items are found, SAFE FP rate 0%', () => {
  const f = findingsFor('py-basic');
  assert.equal(byCategory(f, 'dead_module.py', 'file').grade, 'SAFE');
  assert.equal(bySymbol(f, 'utils.py', '_private_dead').grade, 'SAFE');
  assert.equal(bySymbol(f, 'utils.py', 'dead_fn').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'utils.py', 'Greeter').grade, 'REVIEW');
  // Methods are REVIEW at most, never SAFE.
  assert.equal(bySymbol(f, 'utils.py', 'unused_method').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'utils.py', 'greet').grade, 'REVIEW');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['file:dead_module.py', 'function:utils.py:_private_dead']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('py-basic: runnable __main__ script is an entry point, comments are not unreachable', () => {
  const f = findingsFor('py-basic');
  assert.equal(bySymbol(f, 'run.py', 'run'), undefined, 'run() in a __main__ script must not be flagged');
  assert.equal(byCategory(f, 'run.py', 'file'), undefined, 'a __main__ script must not be a dead file');
  assert.equal(f.filter((x) => x.category === 'unreachable').length, 0, 'trailing comment after return must not be unreachable');
});

test('py-relative: relative imports resolve, live symbols are never flagged', () => {
  const f = findingsFor('py-relative');
  // Every live symbol must have NO finding at all. With broken relative
  // resolution these all came back REVIEW ("0 callers, but referenced
  // by name as a string elsewhere") and their files came back REVIEW too.
  assert.equal(bySymbol(f, 'pkg/utils.py', 'helper_fn'), undefined);
  assert.equal(bySymbol(f, 'pkg/core.py', 'run'), undefined);
  assert.equal(bySymbol(f, 'shared.py', 'shared_fn'), undefined);
  assert.equal(byCategory(f, 'pkg/utils.py', 'file'), undefined);
  assert.equal(byCategory(f, 'pkg/core.py', 'file'), undefined);
  assert.equal(byCategory(f, 'shared.py', 'file'), undefined);
  assert.equal(byCategory(f, 'pkg/__init__.py', 'file'), undefined);
  // __init__.py imports are re-exports of the package namespace
  // (`from . import utils` makes pkg.utils importable) — never dead
  // imports, even though nothing in the file itself uses the names.
  assert.equal(bySymbol(f, 'pkg/__init__.py', 'utils'), undefined);
  assert.equal(bySymbol(f, 'pkg/__init__.py', 'run'), undefined);
  // deep.py is genuinely unimported: the file is SAFE, the exported
  // function is REVIEW, never SAFE.
  assert.equal(byCategory(f, 'pkg/sub/deep.py', 'file').grade, 'SAFE');
  assert.equal(bySymbol(f, 'pkg/sub/deep.py', 'deep').grade, 'REVIEW');
});

test('py-relative: SAFE false-positive rate is 0%', () => {
  const f = findingsFor('py-relative');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['file:pkg/sub/deep.py']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('py-imports: module dunders are KEEP, never SAFE or deleted', () => {
  const f = findingsFor('py-imports');
  // __version__ / __author__ are read by packaging tooling, __all__
  // defines the public exports — all three were flagged SAFE before.
  assert.equal(bySymbol(f, 'pkg/__init__.py', '__version__').grade, 'KEEP');
  assert.equal(bySymbol(f, 'pkg/__init__.py', '__author__').grade, 'KEEP');
  assert.equal(bySymbol(f, 'pkg/__init__.py', '__all__').grade, 'KEEP');
  // The names listed in __all__ are live: main.py imports them.
  assert.equal(bySymbol(f, 'pkg/__init__.py', 'helper'), undefined);
});

test('py-imports: dotted imports bind the top-level name', () => {
  const f = findingsFor('py-imports');
  // `import pkg.sub` binds `pkg`; used as pkg.sub.deep_fn() — the
  // submodule and its function are live.
  assert.equal(bySymbol(f, 'pkg/sub.py', 'deep_fn'), undefined);
  assert.equal(byCategory(f, 'pkg/sub.py', 'file'), undefined);
  // `import os.path` binds `os`; unused here, so the dead import is
  // found (before, the import statement leaked its own names into the
  // reference set and no unused Python import was ever flagged).
  assert.equal(bySymbol(f, 'unused_imports.py', 'os').grade, 'SAFE');
  assert.equal(bySymbol(f, 'unused_imports.py', 'os').category, 'import');
  // The used import on the next line is not flagged.
  assert.equal(bySymbol(f, 'unused_imports.py', 'json'), undefined);
  assert.equal(bySymbol(f, 'unused_imports.py', 'alive'), undefined);
});

test('py-imports: SAFE false-positive rate is 0%', () => {
  const f = findingsFor('py-imports');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['import:unused_imports.py:os']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('py-multiline: multi-line imports resolve, dead ones are found (CLI parity)', () => {
  const f = findingsFor('py-multiline');
  assert.equal(bySymbol(f, 'multiline.py', 'defaultdict').grade, 'SAFE');
  assert.equal(bySymbol(f, 'multiline.py', 'OrderedDict').grade, 'SAFE');
  assert.equal(bySymbol(f, 'multiline.py', 'regex').grade, 'SAFE');
  assert.equal(bySymbol(f, 'multiline.py', 'Counter'), undefined);
  assert.equal(bySymbol(f, 'multiline.py', 'ospath'), undefined);
  assert.equal(bySymbol(f, 'multiline.py', 'json'), undefined);
  assert.equal(bySymbol(f, 'multiline.py', 'build'), undefined);
  assert.equal(byCategory(f, 'multiline.py', 'file'), undefined);
});

test('py-multiline: SAFE false-positive rate is 0% (CLI)', () => {
  const f = findingsFor('py-multiline');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'import:multiline.py:defaultdict', 'import:multiline.py:OrderedDict',
    'import:multiline.py:regex',
  ]);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('js-framework: Next.js route files are never flagged', () => {
  const f = findingsFor('js-framework');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
  assert.equal(f.filter((x) => x.grade === 'REVIEW').length, 0);
  assert.ok(f.every((x) => x.grade === 'KEEP'));
});

test('js-string: prose mentions are not string references', () => {
  const f = findingsFor('js-string');
  // Mentioned only as words in sentences (string literals, README, .txt).
  assert.equal(bySymbol(f, 'src/index.js', 'render').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/index.js', 'named').grade, 'SAFE');
  // Mentioned as code: dotted string and whole string in config.json.
  assert.equal(bySymbol(f, 'src/index.js', 'handler').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/index.js', 'wired').grade, 'REVIEW');
  // No other SAFE findings: nothing live is flagged, no file is dead.
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['function:src/index.js:render', 'function:src/index.js:named']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('py-string: docstring prose is not a string reference', () => {
  const f = findingsFor('py-string');
  // Mentioned only in a docstring, a sentence string, and README prose.
  assert.equal(bySymbol(f, 'main.py', '_load').grade, 'SAFE');
  // Mentioned as code: dotted string and whole string in config.yaml.
  assert.equal(bySymbol(f, 'main.py', 'sync').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'main.py', 'dump').grade, 'REVIEW');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['function:main.py:_load']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('fixtures: fixture directories are excluded by default, includeFixtures opts back in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-fixtures-'));
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write('package.json', JSON.stringify({ name: 't', main: 'src/index.js' }));
  write('src/index.js', "const { live } = require('./live');\nconsole.log(live());\n");
  write('src/live.js', 'function live() { return 1; }\nmodule.exports = { live };\n');
  // Planted dead code in fixture dirs at several depths.
  write('fixtures/dead.js', 'function plantedDead() { return 1; }\nmodule.exports = { plantedDead };\n');
  write('test/fixtures/dead2.js', 'function plantedDead2() { return 1; }\nmodule.exports = { plantedDead2 };\n');
  write('src/__fixtures__/dead3.js', 'function plantedDead3() { return 1; }\nmodule.exports = { plantedDead3 };\n');
  const def = scan(dir).findings;
  assert.equal(def.length, 0, `fixture dirs must be excluded by default, got: ${JSON.stringify(def.map((f) => `${f.file}:${f.symbol || ''}`))}`);
  const inc = scan(dir, { includeFixtures: true }).findings;
  assert.ok(inc.some((f) => f.symbol === 'plantedDead'), 'plantedDead must be found with includeFixtures');
  assert.ok(inc.some((f) => f.symbol === 'plantedDead2'), 'plantedDead2 must be found with includeFixtures');
  assert.ok(inc.some((f) => f.symbol === 'plantedDead3'), 'plantedDead3 must be found with includeFixtures');
});

test('js-deps: README-only deps are flagged, real imports are not', () => {
  const f = findingsFor('js-deps');
  const dep = (name) => f.find((x) => x.category === 'dependency' && x.symbol === name);
  // Mentioned only in README / .txt prose — dead dependencies.
  for (const name of ['left-pad', 'moment', 'unused-dep', '@dead/scope']) {
    assert.equal(dep(name).grade, 'REVIEW', `${name} must be flagged REVIEW`);
  }
  // Live: subpath import, plain require, scoped require, config string,
  // package.json script, scoped config string.
  for (const name of ['lodash', 'express', '@scope/pkg', 'chalk', 'rimraf', '@other/plugin']) {
    assert.equal(dep(name), undefined, `${name} must not be flagged`);
  }
  // Nothing in this fixture is SAFE.
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});
