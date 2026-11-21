'use strict';

/**
 * Fixture tests: the FP rate on SAFE is the claim that matters.
 * Every live symbol in the fixtures must NOT be flagged SAFE;
 * every planted dead item must be found at SAFE or REVIEW.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
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
  // Same-file-only use is REVIEW (unexport-to-local), not dead.
  assert.equal(bySymbol(f, 'src/helper.js', 'sameFileOnly').grade, 'REVIEW');
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

test('js-framework: Next.js route files are never flagged', () => {
  const f = findingsFor('js-framework');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
  assert.equal(f.filter((x) => x.grade === 'REVIEW').length, 0);
  assert.ok(f.every((x) => x.grade === 'KEEP'));
});
