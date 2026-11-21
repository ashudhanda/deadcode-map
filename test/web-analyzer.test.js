'use strict';

/**
 * Web analyzer tests: the browser analyzer (docs/analyzer.js, regex-based)
 * must match the CLI's fixture results — live symbols never flagged SAFE,
 * planted dead items found, SAFE false-positive rate 0%.
 *
 * Run with: node --test test/web-analyzer.test.js
 * (Kept out of `npm test` so the CLI suite stays at 15/15.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { analyzeFiles } = require('../docs/analyzer');

const ROOT = path.join(__dirname, '..');

function loadFixture(dir) {
  const base = path.join(ROOT, 'fixtures', dir);
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push({ path: path.relative(base, full).split(path.sep).join('/'), content: fs.readFileSync(full, 'utf8') });
    }
  })(base);
  return analyzeFiles(files);
}

function bySymbol(findings, file, symbol) {
  return findings.find((f) => f.file.endsWith(file) && f.symbol === symbol);
}
function byCategory(findings, file, category) {
  return findings.find((f) => f.file.endsWith(file) && f.category === category && !f.symbol);
}

test('web js-basic: live symbols are never flagged', () => {
  const f = loadFixture('js-basic').findings;
  for (const symbol of ['usedFn', 'privateUsed', 'helper']) {
    assert.equal(bySymbol(f, 'used.js', symbol), undefined, `${symbol} must not be flagged`);
    assert.equal(bySymbol(f, 'helper.js', symbol), undefined, `${symbol} must not be flagged`);
  }
  const live = ['usedFn', 'privateUsed', 'helper'];
  for (const finding of f.filter((x) => x.grade === 'SAFE')) {
    assert.ok(!live.includes(finding.symbol), `live symbol flagged SAFE: ${finding.symbol}`);
  }
});

test('web js-basic: planted dead items are found', () => {
  const f = loadFixture('js-basic').findings;
  assert.equal(byCategory(f, 'src/dead-file.js', 'file').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/used.js', 'unusedImport').grade, 'SAFE');
  assert.equal(byCategory(f, 'src/used.js', 'unreachable').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/used.js', 'privateDead').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/used.js', 'unusedExport').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/helper.js', 'sameFileOnly').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/string-ref.js', 'stringOnlyFn').grade, 'REVIEW');
  assert.equal(byCategory(f, 'src/string-ref.js', 'file').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/lazy-target.js', 'lazyFn').grade, 'REVIEW');
});

test('web js-basic: SAFE false-positive rate is 0%', () => {
  const f = loadFixture('js-basic').findings;
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'file:src/dead-file.js', 'file:src/dynamic.js',
    'import:src/used.js:unusedImport', 'unreachable:src/used.js',
  ]);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('web py-basic: live symbols are never flagged, framework kept', () => {
  const f = loadFixture('py-basic').findings;
  for (const symbol of ['used_fn', 'format_name', '_double']) {
    assert.equal(bySymbol(f, 'utils.py', symbol), undefined, `${symbol} must not be flagged`);
  }
  assert.equal(bySymbol(f, 'app.py', 'hello').grade, 'KEEP');
  assert.equal(bySymbol(f, 'test_utils.py', 'test_used_fn').grade, 'KEEP');
  assert.equal(bySymbol(f, 'utils.py', '__init__').grade, 'KEEP');
  assert.equal(bySymbol(f, 'utils.py', '__str__').grade, 'KEEP');
});

test('web py-basic: planted dead items are found, SAFE FP rate 0%', () => {
  const f = loadFixture('py-basic').findings;
  assert.equal(byCategory(f, 'dead_module.py', 'file').grade, 'SAFE');
  assert.equal(bySymbol(f, 'utils.py', '_private_dead').grade, 'SAFE');
  assert.equal(bySymbol(f, 'utils.py', 'dead_fn').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'utils.py', 'Greeter').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'utils.py', 'unused_method').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'utils.py', 'greet').grade, 'REVIEW');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['file:dead_module.py', 'function:utils.py:_private_dead']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('web py-basic: runnable __main__ script is an entry point', () => {
  const f = loadFixture('py-basic').findings;
  assert.equal(bySymbol(f, 'run.py', 'run'), undefined, 'run() in a __main__ script must not be flagged');
  assert.equal(byCategory(f, 'run.py', 'file'), undefined, 'a __main__ script must not be a dead file');
  assert.equal(f.filter((x) => x.category === 'unreachable').length, 0, 'trailing comment after return must not be unreachable');
});

test('web py-relative: relative imports resolve, live symbols are never flagged', () => {
  const f = loadFixture('py-relative').findings;
  assert.equal(bySymbol(f, 'pkg/utils.py', 'helper_fn'), undefined);
  assert.equal(bySymbol(f, 'pkg/core.py', 'run'), undefined);
  assert.equal(bySymbol(f, 'shared.py', 'shared_fn'), undefined);
  assert.equal(byCategory(f, 'pkg/utils.py', 'file'), undefined);
  assert.equal(byCategory(f, 'pkg/core.py', 'file'), undefined);
  assert.equal(byCategory(f, 'shared.py', 'file'), undefined);
  assert.equal(byCategory(f, 'pkg/__init__.py', 'file'), undefined);
  assert.equal(byCategory(f, 'pkg/sub/deep.py', 'file').grade, 'SAFE');
  assert.equal(bySymbol(f, 'pkg/sub/deep.py', 'deep').grade, 'REVIEW');
});

test('web py-relative: SAFE false-positive rate is 0%', () => {
  const f = loadFixture('py-relative').findings;
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['file:pkg/sub/deep.py']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('web js-framework: Next.js route files are never flagged', () => {
  const f = loadFixture('js-framework').findings;
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
  assert.equal(f.filter((x) => x.grade === 'REVIEW').length, 0);
  assert.ok(f.every((x) => x.grade === 'KEEP'));
});

test('web js-realworld: regex literals, comments and try/catch do not create false positives', () => {
  const files = [
    {
      path: 'src/a.js',
      content: [
        'const fs = require(\'fs\');',
        '// Import bindings (const x = require(\'...\') / import x from \'...\') are',
        '// covered by the dead-import findings below, not as dead symbols.',
        'function live() {',
        '  if (/__name__\\s*==\\s*[\'"]__main__[\'"]/.test(fs.readFileSync(\'a\', \'utf8\'))) return true;',
        '  return false;',
        '}',
        'function deadAfterRegex() { return 1; }',
        'module.exports = { live };',
      ].join('\n'),
    },
    {
      path: 'src/b.js',
      content: [
        'const { live } = require(\'./a\');',
        'function tryCatch() {',
        '  try {',
        '    return live();',
        '  } catch (_) {',
        '    return null;',
        '  }',
        '}',
        'function multiLineReturn() {',
        '  return {',
        '    a: 1,',
        '    b: 2,',
        '  };',
        '}',
        'function templateReturn(name) {',
        '  return `<div>${name}</div>`;',
        '}',
        'function switcher(x) {',
        '  switch (x) {',
        '    case 1:',
        '      return 1;',
        '    default:',
        '      return 0;',
        '  }',
        '}',
        'module.exports = { tryCatch, multiLineReturn, templateReturn, switcher };',
      ].join('\n'),
    },
    { path: 'package.json', content: JSON.stringify({ main: 'src/b.js' }) },
  ];
  const r = analyzeFiles(files);
  const safe = r.findings.filter((x) => x.grade === 'SAFE');
  // Only the genuinely dead function may be SAFE; nothing else.
  assert.deepEqual(
    safe.map((x) => `${x.category}:${x.file}:${x.symbol || ''}`),
    ['function:src/a.js:deadAfterRegex'],
  );
  assert.equal(r.findings.filter((x) => x.category === 'unreachable').length, 0);
  assert.equal(bySymbol(r.findings, 'src/a.js', 'live'), undefined);
});
