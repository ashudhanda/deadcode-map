'use strict';

/**
 * Web analyzer tests: the browser analyzer (docs/analyzer.js, regex-based)
 * must match the CLI's fixture results — live symbols never flagged SAFE,
 * planted dead items found, SAFE false-positive rate 0%.
 *
 * Run with: node --test test/web-analyzer.test.js
 * (Kept out of `npm test` so the CLI suite stays at 19/19.)
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
  // Same-file use is alive, not a finding: helper() calls sameFileOnly()
  // in its own file, so it is used — never REVIEW, never SAFE.
  assert.equal(bySymbol(f, 'src/helper.js', 'sameFileOnly'), undefined);
  assert.equal(bySymbol(f, 'src/string-ref.js', 'stringOnlyFn').grade, 'REVIEW');
  assert.equal(byCategory(f, 'src/string-ref.js', 'file').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/lazy-target.js', 'lazyFn').grade, 'REVIEW');
});

test('web js-basic: SAFE false-positive rate is 0%', () => {
  const f = loadFixture('js-basic').findings;
  const safe = f.filter((x) => x.grade === 'SAFE');
  // Planted SAFE items: dead-file, unused import, unreachable code.
  // dynamic.js file is also genuinely dead (nothing imports it).
  // lazy-target.js is second-order dead (cascade): its only importer is
  // dead dynamic.js, which loads it via import() — deleting dynamic.js
  // leaves lazy-target.js unreferenced in the same run (the CLI grades
  // it SAFE the same way; the web used to keep it at REVIEW on the
  // dead file's string mention).
  const expectedSafe = new Set([
    'file:src/dead-file.js', 'file:src/dynamic.js', 'file:src/lazy-target.js',
    'import:src/used.js:unusedImport', 'unreachable:src/used.js',
  ]);
  const lazyTarget = byCategory(f, 'src/lazy-target.js', 'file');
  assert.equal(lazyTarget.grade, 'SAFE');
  assert.ok(lazyTarget.evidence.cascade, 'lazy-target.js must carry cascade evidence');
  assert.deepEqual(lazyTarget.evidence.cascade.via, ['src/dynamic.js']);
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

test('web py-imports: unused Python imports are flagged, live ones are not', () => {
  const f = loadFixture('py-imports').findings;
  // The CLI flags `import os.path` here (os is never used); the web
  // analyzer used to miss every dead Python import because each import
  // local was added to `references` by its own statement.
  assert.equal(bySymbol(f, 'unused_imports.py', 'os').grade, 'SAFE');
  assert.equal(bySymbol(f, 'unused_imports.py', 'json'), undefined, 'json is used by alive()');
  assert.equal(bySymbol(f, 'main.py', 'pkg'), undefined, 'pkg.sub is used');
  assert.equal(bySymbol(f, 'main.py', 'helper'), undefined);
  assert.equal(bySymbol(f, 'main.py', 'PUBLIC_CONST'), undefined);
  assert.equal(bySymbol(f, 'main.py', 'alive'), undefined);
  // __init__.py imports are re-exports, never flagged.
  assert.equal(bySymbol(f, 'pkg/__init__.py', 'helper'), undefined);
  assert.equal(bySymbol(f, 'pkg/__init__.py', 'PUBLIC_CONST'), undefined);
});

test('web py-imports: SAFE false-positive rate is 0%', () => {
  const f = loadFixture('py-imports').findings;
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['import:unused_imports.py:os']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('web py-multiline: multi-line imports are parsed, dead ones flagged', () => {
  const f = loadFixture('py-multiline').findings;
  // Parenthesized from-import: the two unused names must be found SAFE,
  // the used one (Counter) must not be flagged. Before the fix the
  // statement recorded no names at all, so both were silently missed.
  assert.equal(bySymbol(f, 'multiline.py', 'defaultdict').grade, 'SAFE');
  assert.equal(bySymbol(f, 'multiline.py', 'OrderedDict').grade, 'SAFE');
  assert.equal(bySymbol(f, 'multiline.py', 'Counter'), undefined);
  // Backslash continuation: `re as regex` is unused and must be SAFE.
  // Before the fix the trailing backslash was recorded as a bogus import
  // named `\` and flagged SAFE instead.
  assert.equal(bySymbol(f, 'multiline.py', 'regex').grade, 'SAFE');
  assert.equal(bySymbol(f, 'multiline.py', '\\'), undefined);
  assert.equal(bySymbol(f, 'multiline.py', 'json'), undefined);
  assert.equal(bySymbol(f, 'multiline.py', 'ospath'), undefined);
  assert.equal(bySymbol(f, 'multiline.py', 'build'), undefined);
  assert.equal(byCategory(f, 'multiline.py', 'file'), undefined);
});

test('web py-multiline: SAFE false-positive rate is 0%', () => {
  const f = loadFixture('py-multiline').findings;
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

test('web import-lines: unused JS imports report their real line, not line 1', () => {
  const f = loadFixture('js-import-lines').findings;
  // Before the fix every import finding carried startLine 1, so the web
  // id (import:file:symbol:1) never matched the CLI id for the same
  // import (vue2 types/v3-define-component.d.ts: Data at line 19).
  const unused = bySymbol(f, 'src/main.js', 'unusedImport');
  assert.equal(unused.grade, 'SAFE');
  assert.equal(unused.startLine, 4, 'the import sits on line 4, not line 1');
  assert.equal(unused.id, 'import:src/main.js:unusedImport:4');
  // A multi-line import reports the line the import starts on.
  const multi = bySymbol(f, 'src/main.js', 'unusedMulti');
  assert.equal(multi.grade, 'SAFE');
  assert.equal(multi.startLine, 7, 'a multi-line import starts on its import line');
  assert.equal(multi.endLine, 11, 'the multi-line import ends on its from line');
  assert.equal(bySymbol(f, 'src/main.js', 'alsoUnused').startLine, 7);
  // A destructured require below line 1 reports its own line too.
  assert.equal(bySymbol(f, 'src/main.js', 'unusedReq').startLine, 12);
  // Live imports are never flagged.
  assert.equal(bySymbol(f, 'src/main.js', 'usedHelper'), undefined);
  assert.equal(bySymbol(f, 'src/main.js', 'usedOther'), undefined);
});

test('web import-lines: JS SAFE false-positive rate is 0%', () => {
  const f = loadFixture('js-import-lines').findings;
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'import:src/main.js:unusedImport', 'import:src/main.js:unusedMulti',
    'import:src/main.js:alsoUnused', 'import:src/main.js:unusedReq',
  ]);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
  assert.equal(safe.length, expectedSafe.size, 'every planted dead import is found');
});

test('web import-lines: unused Python imports report their real line, not line 1', () => {
  const f = loadFixture('py-import-lines').findings;
  const unused = bySymbol(f, 'imports.py', 'unusedmod');
  assert.equal(unused.grade, 'SAFE');
  assert.equal(unused.startLine, 4, 'the import sits on line 4, not line 1');
  assert.equal(unused.id, 'import:imports.py:unusedmod:4');
  // A multi-line from-import reports the line the import starts on.
  const multi = bySymbol(f, 'imports.py', 'UnusedA');
  assert.equal(multi.grade, 'SAFE');
  assert.equal(multi.startLine, 6, 'a multi-line import starts on its from line');
  assert.equal(multi.endLine, 10, 'the multi-line import ends on its closing paren line');
  assert.equal(bySymbol(f, 'imports.py', 'UnusedB').startLine, 6);
  // Live imports are never flagged.
  assert.equal(bySymbol(f, 'imports.py', 'json'), undefined);
  assert.equal(bySymbol(f, 'imports.py', 'Counter'), undefined);
});

test('web import-lines: Python SAFE false-positive rate is 0%', () => {
  const f = loadFixture('py-import-lines').findings;
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'import:imports.py:unusedmod', 'import:imports.py:UnusedA',
    'import:imports.py:UnusedB',
  ]);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
  assert.equal(safe.length, expectedSafe.size, 'every planted dead import is found');
});

test('web py-multiline: star imports are not flagged as dead imports', () => {
  const r = analyzeFiles([{ path: 'main.py', content: 'from pkg import *\n\nprint(1)\n' }]);
  assert.equal(r.findings.filter((x) => x.category === 'import').length, 0, 'a star import is a wildcard, not a dead import');
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

test('web js-string: prose mentions are not string references', () => {
  const f = loadFixture('js-string').findings;
  assert.equal(bySymbol(f, 'src/index.js', 'render').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/index.js', 'named').grade, 'SAFE');
  // Mentioned only inside a URL-encoded token: `%70age` is not a
  // reference to `age` (a digit before the name breaks the boundary).
  assert.equal(bySymbol(f, 'src/index.js', 'age').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/index.js', 'handler').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/index.js', 'wired').grade, 'REVIEW');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['function:src/index.js:render', 'function:src/index.js:named', 'function:src/index.js:age']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('web py-string: docstring prose is not a string reference', () => {
  const f = loadFixture('py-string').findings;
  assert.equal(bySymbol(f, 'main.py', '_load').grade, 'SAFE');
  assert.equal(bySymbol(f, 'main.py', 'sync').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'main.py', 'dump').grade, 'REVIEW');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['function:main.py:_load']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('web fixtures: fixture directories are excluded by default, includeFixtures opts back in', () => {
  var files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    { path: 'src/index.js', content: "const { live } = require('./live');\nconsole.log(live());\n" },
    { path: 'src/live.js', content: 'function live() { return 1; }\nmodule.exports = { live };\n' },
    { path: 'fixtures/dead.js', content: 'function plantedDead() { return 1; }\nmodule.exports = { plantedDead };\n' },
    { path: 'test/fixtures/dead2.js', content: 'function plantedDead2() { return 1; }\nmodule.exports = { plantedDead2 };\n' },
    { path: 'src/__fixtures__/dead3.js', content: 'function plantedDead3() { return 1; }\nmodule.exports = { plantedDead3 };\n' },
  ];
  var def = analyzeFiles(files).findings;
  assert.equal(def.length, 0, 'fixture dirs must be excluded by default, got: ' + JSON.stringify(def.map(function (f) { return f.file + ':' + (f.symbol || ''); })));
  var inc = analyzeFiles(files, { includeFixtures: true }).findings;
  assert.ok(inc.some(function (f) { return f.symbol === 'plantedDead'; }), 'plantedDead must be found with includeFixtures');
  assert.ok(inc.some(function (f) { return f.symbol === 'plantedDead2'; }), 'plantedDead2 must be found with includeFixtures');
  assert.ok(inc.some(function (f) { return f.symbol === 'plantedDead3'; }), 'plantedDead3 must be found with includeFixtures');
});

test('web inline require: require("./x").fn() keeps the export alive', () => {
  var files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/main.js' }) },
    // Member call on the same line as the binding…
    { path: 'src/main.js', content: "const x = require('./util').helper(1);\nconst y = require('./util2').other();\nconsole.log(x, y);\n" },
    { path: 'src/util.js', content: 'function helper(n) { return n + 1; }\nmodule.exports = { helper };\n' },
    // …and an inline require on a continuation line (ternary), the shape
    // src/confidence.js uses for require('./coverage').coverageForSymbol.
    { path: 'src/util2.js', content: 'function other() { return 2; }\nmodule.exports = { other };\n' },
  ];
  var r = analyzeFiles(files);
  assert.equal(bySymbol(r.findings, 'src/util.js', 'helper'), undefined, 'helper is called via inline require, must not be flagged');
  assert.equal(byCategory(r.findings, 'src/util.js', 'file'), undefined);
  assert.equal(bySymbol(r.findings, 'src/util2.js', 'other'), undefined, 'other is called via inline require, must not be flagged');
  assert.equal(byCategory(r.findings, 'src/util2.js', 'file'), undefined);
  // The bound names themselves are not phantom uses: an unused const
  // require binding is still a dead import.
  var files2 = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/main.js' }) },
    { path: 'src/main.js', content: "const { unused } = require('./util');\nconsole.log('hi');\n" },
    { path: 'src/util.js', content: 'function unused() { return 1; }\nmodule.exports = { unused };\n' },
  ];
  var r2 = analyzeFiles(files2);
  assert.equal(bySymbol(r2.findings, 'src/main.js', 'unused').grade, 'SAFE', 'unused destructured require binding must still be a dead import');
});

test('web imports inside strings are not phantom imports', () => {
  // A test file holding code in a string used to create a phantom import
  // of './util' (and a dead-import finding for `unused`) in the web
  // analyzer, because import parsing ran on raw lines. The CLI
  // (tree-sitter) never had this bug.
  var files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/main.js' }) },
    { path: 'src/main.js', content: "console.log('hi');\n" },
    { path: 'src/util.js', content: 'function helper(n) { return n + 1; }\nmodule.exports = { helper };\n' },
    { path: 'test/example.test.js', content: 'const snippet = "const { unused } = require(\'./util\');";\ntest(\'x\', () => { assert.equal(snippet.length > 0, true); });\n' },
  ];
  var r = analyzeFiles(files);
  assert.equal(r.findings.filter(function (f) { return f.category === 'import' && f.file === 'test/example.test.js'; }).length, 0, 'a require inside a string must not create an import');
  assert.equal(bySymbol(r.findings, 'test/example.test.js', 'unused'), undefined);
});

test('web js-deps: README-only deps are flagged, real imports are not', () => {
  const f = loadFixture('js-deps').findings;
  const dep = (name) => f.find((x) => x.category === 'dependency' && x.symbol === name);
  for (const name of ['left-pad', 'moment', 'unused-dep', '@dead/scope']) {
    assert.equal(dep(name).grade, 'REVIEW', `${name} must be flagged REVIEW`);
  }
  for (const name of ['lodash', 'express', '@scope/pkg', 'chalk', 'rimraf', '@other/plugin']) {
    assert.equal(dep(name), undefined, `${name} must not be flagged`);
  }
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web regex-arrow: a backtick inside a regex after => does not swallow the file', () => {
  // The axios AxiosHeaders shape: `const f = (s) => /^[...`|...]+$/.test(s)`
  // used to be misread as division, so the backtick inside the regex
  // character class opened a template literal that blanked the rest of
  // the file — normalizeHeader / parseTokens / parseHeaders all looked
  // dead. The `=>` case is now a regex-start context in stripJs.
  const headers = [
    "const isValidHeaderName = (str) => /^[-_a-zA-Z0-9^`|~,!#$%&'*+.]+$/.test(str);",
    'function normalizeHeader(header) { return isValidHeaderName(header) ? header : \'\'; }',
    'function parseTokens(str) { return normalizeHeader(str); }',
    'function parseHeaders(raw) { return parseTokens(raw); }',
    'module.exports = { normalizeHeader, parseTokens, parseHeaders };',
    '',
  ].join('\n');
  const caller = "const { normalizeHeader, parseTokens, parseHeaders } = require('./headers');\nconsole.log(normalizeHeader('x'), parseTokens('y'), parseHeaders('z'));\n";
  const out = analyzeFiles([
    { path: 'src/headers.js', content: headers },
    { path: 'src/index.js', content: caller },
  ]);
  // The file parsed fully: parseHeaders is defined AFTER the regex line
  // and is live. Nothing here may be flagged at all.
  assert.equal(out.findings.length, 0, `expected no findings, got ${JSON.stringify(out.findings.map((f) => f.symbol || f.category))}`);
  // The same file scanned alone still parses past the regex line: the
  // symbols defined after it are found — and all three are REVIEW
  // (exported, never called from outside), exactly as the CLI grades
  // them: the `module.exports = { ... }` shorthand names are exports,
  // not uses, so nothing in the file is a live root, and a dead chain
  // whose head is dead does not rescue its members (the same-file
  // live-root BFS, not the old flat same-file flag).
  const alone = analyzeFiles([{ path: 'src/headers.js', content: headers }]);
  assert.equal(bySymbol(alone.findings, 'src/headers.js', 'parseHeaders').grade, 'REVIEW');
  assert.equal(bySymbol(alone.findings, 'src/headers.js', 'normalizeHeader').grade, 'REVIEW');
  assert.equal(bySymbol(alone.findings, 'src/headers.js', 'parseTokens').grade, 'REVIEW');
});

test('web f-string: names used only inside an f-string expression are live', () => {
  // The typer _click/termui.py shape: _format_default is called only
  // inside f"{prompt} [{_format_default(default)}]".
  const termui = [
    'def _format_default(default):',
    '    return str(default)',
    '',
    'def render_prompt(prompt, default):',
    '    return f"{prompt} [{_format_default(default)}]"',
    '',
    'def main():',
    "    print(render_prompt('Name', 'x'))",
    '',
  ].join('\n');
  const f = analyzeFiles([{ path: 'src/termui.py', content: termui }]).findings;
  assert.equal(bySymbol(f, 'src/termui.py', '_format_default'), undefined, '_format_default is called inside the f-string expression');
  assert.equal(bySymbol(f, 'src/termui.py', 'render_prompt'), undefined, 'render_prompt is called by main');
});

test('web dedupe: the same file twice and the same finding twice are reported once', () => {
  const files = [
    { path: 'src/a.js', content: 'function deadFn() { return 1; }\nmodule.exports = { deadFn };\n' },
    { path: 'src/a.js', content: 'function deadFn() { return 1; }\nmodule.exports = { deadFn };\n' },
    { path: 'src/index.js', content: "console.log('hi');\n" },
  ];
  const out = analyzeFiles(files);
  assert.equal(out.filesScanned, 2, 'the duplicated input file is scanned once');
  const ids = out.findings.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'no finding id repeats');
});

test('web constructor: new Client() in an importer calls the constructor in its file', () => {
  const client = [
    'class Client {',
    '  constructor(script, args) { this.script = script; }',
    '  send(x) { return x; }',
    '  neverCalled() { return 0; }',
    '}',
    'module.exports = { Client };',
    '',
  ].join('\n');
  const index = [
    'const { Client } = require("./client");',
    'const c = new Client("a", []);',
    'console.log(c.send(1));',
    '',
  ].join('\n');
  const f = analyzeFiles([
    { path: 'src/client.js', content: client },
    { path: 'src/index.js', content: index },
  ]).findings;
  assert.equal(bySymbol(f, 'src/client.js', 'constructor'), undefined, 'constructor is called via new Client() across files');
  assert.equal(bySymbol(f, 'src/client.js', 'send'), undefined, 'send is called on the instance');
  assert.equal(bySymbol(f, 'src/client.js', 'neverCalled').grade, 'REVIEW', 'an uncalled method is still REVIEW');
});

test('web py-annotations: string annotations, __all__ tuple, re-exported module use', () => {
  const f = loadFixture('py-annotations').findings;
  for (const symbol of ['Context', 'Buffer', 'TypeAdapter', 'Annotated', 'get_type_hints', 'run']) {
    assert.equal(bySymbol(f, 'pkg/core.py', symbol), undefined, `${symbol} is used in a string annotation or re-exported via __all__`);
  }
  assert.equal(bySymbol(f, 'pkg/colors.py', 'RED'), undefined, 'pkg.colors.RED is used through the package');
  assert.equal(bySymbol(f, 'pkg/colors.py', 'GREEN'), undefined, 'pkg.colors.GREEN is used through the package');
  assert.equal(bySymbol(f, 'pkg/colors.py', 'BLUE').grade, 'REVIEW', 're-exported but never used: REVIEW at most, never SAFE');
  assert.equal(bySymbol(f, 'pkg/core.py', 'os').grade, 'SAFE');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['import:pkg/core.py:os']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('web py-typer: @app.command() / @app.callback() are KEEP entry points', () => {
  const f = loadFixture('py-typer').findings;
  // A decorated `def callback` must not be self-referenced by its own
  // `@app.callback()` decorator, and both commands are framework-kept.
  assert.equal(bySymbol(f, 'app.py', 'main').grade, 'KEEP');
  assert.equal(bySymbol(f, 'app.py', 'callback').grade, 'KEEP');
  assert.equal(bySymbol(f, 'app.py', 'helper').grade, 'REVIEW');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web js-alias: tsconfig paths aliases (@/* and exact @util) resolve to real files', () => {
  const f = loadFixture('js-alias').findings;
  assert.equal(bySymbol(f, 'src/lib/util.ts', 'helper'), undefined, 'helper is imported through @/lib/util and @util');
  // onlyAlias is imported ONLY through the @/* star alias: before the
  // resolveAlias empty-suffix fix no @/* import ever resolved, so it
  // looked unimported. This pins the fix.
  assert.equal(bySymbol(f, 'src/lib/util.ts', 'onlyAlias'), undefined, 'onlyAlias is imported only through @/lib/util');
  assert.equal(byCategory(f, 'src/lib/util.ts', 'file'), undefined, 'util.ts is imported through an alias');
  assert.equal(bySymbol(f, 'src/lib/util.ts', 'unusedFn').grade, 'REVIEW');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web py-decorated: decorated methods, bare annotations, TypeAlias strings, %-format placeholders', () => {
  const f = loadFixture('py-decorated').findings;
  assert.equal(bySymbol(f, 'app.py', 'session'), undefined, 'session is called via an instance in main.py');
  assert.equal(bySymbol(f, 'app.py', 'unused_ctx').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'app.py', 'timeout'), undefined, 'a bare annotation is a type declaration, not a definition');
  assert.equal(bySymbol(f, 'app.py', 'Response'), undefined, 'a TypeAlias value string is a forward reference');
  assert.equal(bySymbol(f, 'app.py', 'complete_func'), undefined, 'a %-format placeholder is a use');
  assert.equal(bySymbol(f, 'app.py', 'TEMPLATE').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'app.py', 'Hook').grade, 'REVIEW');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web py-typechecking: unreferenced type aliases inside if blocks are SAFE', () => {
  // Regression test for the requests _types.py gap: aliases bound
  // inside `if TYPE_CHECKING:` (CookiesType, ProxiesType) were missed
  // entirely because the parser only recorded assignments at indent 0.
  // A name bound inside a plain block is a module definition at any
  // indent — the CLI's tree-sitter parser records it the same way.
  const f = loadFixture('py-typechecking').findings;
  assert.equal(bySymbol(f, 'aliases.py', 'DeadType').grade, 'SAFE');
  assert.equal(bySymbol(f, 'aliases.py', 'OtherDeadType').grade, 'SAFE');
  assert.equal(bySymbol(f, 'aliases.py', 'LegacyType').grade, 'SAFE');
  // SAFE false-positive rate is 0%: every other SAFE finding would be
  // a live symbol flagged dead.
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['variable:aliases.py:DeadType', 'variable:aliases.py:OtherDeadType', 'variable:aliases.py:LegacyType', 'variable:aliases.py:retries']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('web py-typechecking: used aliases and function locals stay unflagged; a dead class attribute is SAFE', () => {
  const f = loadFixture('py-typechecking').findings;
  assert.equal(bySymbol(f, 'aliases.py', 'NameType'), undefined, 'NameType is used by a string annotation in aliases.py and main.py');
  assert.equal(bySymbol(f, 'aliases.py', 'format_name'), undefined, 'format_name is called from main.py');
  assert.equal(bySymbol(f, 'main.py', 'show'), undefined, 'show is called in its own file');
  assert.equal(bySymbol(f, 'aliases.py', 'retries').grade, 'SAFE', 'a plain class attribute is recorded as a definition, and unreferenced it is SAFE — the CLI grades it the same way');
  assert.equal(bySymbol(f, 'aliases.py', 'timeout'), undefined, 'a function local is not a module definition');
  assert.equal(bySymbol(f, 'aliases.py', 'make_config').grade, 'REVIEW', 'an exported but never imported function is REVIEW, never SAFE');
});

test('web py-reexports: redundant aliases, noqa imports and compat shims are re-exports', () => {
  const f = loadFixture('py-reexports').findings;
  assert.equal(bySymbol(f, 'pkg/helpers.py', 'assist'), undefined, 'helpers.assist is used through the package');
  assert.equal(byCategory(f, 'pkg/helpers.py', 'file'), undefined, 'a re-exported module is not a dead file');
  for (const symbol of ['json', 'socket', 'OrderedDict', 'urlparse']) {
    assert.equal(bySymbol(f, 'pkg/compat.py', symbol), undefined, `${symbol} in a compat shim is a re-export, never a dead import`);
  }
  // An explicit re-export or backwards-compatibility comment marks one
  // name (mirrors the CLI): Counter is noted on its own line,
  // OrderedDict by the note above its single-name import.
  assert.equal(bySymbol(f, 'pkg/core.py', 'Counter'), undefined, 'Counter is re-exported by comment, never a dead import');
  assert.equal(bySymbol(f, 'pkg/core.py', 'OrderedDict'), undefined, 'OrderedDict is kept for backwards compatibility, never a dead import');
  // The genuinely dead import is still found.
  assert.equal(bySymbol(f, 'pkg/core.py', 'os').grade, 'SAFE');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['import:pkg/core.py:os']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('web js-reexports: export { X } re-exports an import, and .js imports resolve to .ts files', () => {
  const f = loadFixture('js-reexports').findings;
  assert.equal(bySymbol(f, 'src/reexport.ts', 'helper'), undefined, 'export { helper } is a use of the imported binding');
  assert.equal(bySymbol(f, 'src/lib.ts', 'helper'), undefined, 'helper is imported (and re-exported) through the .js specifier');
  assert.equal(bySymbol(f, 'src/runner.ts', 'run'), undefined, 'run is imported through the .js specifier');
  assert.equal(byCategory(f, 'src/runner.ts', 'file'), undefined);
  assert.equal(byCategory(f, 'src/lib.ts', 'file'), undefined);
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web js-export-list: local export { ... } lists do not leak names into references', () => {
  const f = loadFixture('js-export-list').findings;
  // Before the fix the names in a local `export { ... }` list leaked
  // into the references pass, so every exported-but-unimported function
  // looked used and had no finding at all. Now they grade REVIEW like
  // the CLI (single-line list, `as` alias, and multi-line list), the
  // unexported dead function is SAFE, and the imported function has no
  // finding. Only the dead function is SAFE.
  assert.equal(bySymbol(f, 'src/lib.js', 'onlyExported').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/lib.js', 'aliasedFn').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/lib.js', 'multiExported').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/lib.js', 'deadFn').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/lib.js', 'importedFn'), undefined, 'importedFn is imported and called by the entry point');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 1);
});

test('web py-pydantic: model fields, validators and overload groups are framework-invoked', () => {
  const f = loadFixture('py-pydantic').findings;
  // Model fields and validators: either no finding (a string hit or a
  // call proves them used) or a KEEP finding — never SAFE or REVIEW.
  // extra_field sits in a BaseModelWithConfig subclass (fastapi's
  // openapi/models.py shape): the base name contains BaseModel.
  for (const symbol of ['name', 'schema_', 'vocabulary', 'x', 'y', 'check', 'get', 'extra_field']) {
    const found = bySymbol(f, 'models.py', symbol);
    assert.ok(!found || found.grade === 'KEEP', `${symbol} is a model field / framework-invoked — must be KEEP or absent, never ${found && found.grade}`);
  }
  assert.equal(bySymbol(f, 'models.py', 'unused_fn').grade, 'REVIEW');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web ts-ambient: declare module augmentation is declaration merging, never dead', () => {
  const f = loadFixture('ts-ambient').findings;
  assert.equal(bySymbol(f, 'src/devtools.ts', 'StoreMutators').grade, 'KEEP');
  assert.equal(byCategory(f, 'src/devtools.ts', 'file'), undefined, 'the augmentation file is imported by the entry point');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web ts-testfile: a file literally named test.ts holds type-test functions — KEEP, never SAFE', () => {
  const f = loadFixture('ts-testfile').findings;
  assert.equal(byCategory(f, 'src/foo/test.ts', 'file').grade, 'KEEP');
  assert.equal(bySymbol(f, 'src/foo/test.ts', '_test').grade, 'KEEP');
  assert.equal(bySymbol(f, 'src/lib.ts', 'usedFn'), undefined);
  assert.equal(bySymbol(f, 'src/lib.ts', 'unusedExport').grade, 'REVIEW');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web js-methods: a method is not used by its own declaration line', () => {
  const f = loadFixture('js-methods').findings;
  assert.equal(bySymbol(f, 'src/widget.js', 'neverCalled').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/widget.js', 'constructor'), undefined, 'constructor is called via new Widget()');
  assert.equal(bySymbol(f, 'src/widget.js', 'used'), undefined, 'used is called on the instance');
});

test('web js-framework: docker/proxy.ts middleware and config are KEEP', () => {
  const f = loadFixture('js-framework').findings;
  // proxy.ts is an entry point (Next.js resolves it), so it gets no
  // file finding at all — only its symbols are graded, and they are KEEP.
  assert.equal(byCategory(f, 'docker/proxy.ts', 'file'), undefined);
  assert.equal(bySymbol(f, 'docker/proxy.ts', 'middleware').grade, 'KEEP');
  assert.equal(bySymbol(f, 'docker/proxy.ts', 'config').grade, 'KEEP');
  assert.equal(bySymbol(f, 'docker/proxy.ts', 'NextRequest'), undefined, 'the type-only import is used as a parameter type');
});

test('web module.exports chain, __future__, braceless return: three regex-parser traps', () => {
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    { path: 'src/index.js', content: "var express = require('./lib');\nvar app = module.exports = express();\nconst { describe } = require('./cmd');\ndescribe('x');\nconsole.log(app);\n" },
    { path: 'src/lib.js', content: 'module.exports = function() { return 1; };\n' },
    { path: 'src/cmd.js', content: [
      'function describe(str) {',
      '  if (str === undefined)',
      '    return "none";',
      '  this.description = str;',
      '  return this;',
      '}',
      'module.exports = { describe };',
      '',
    ].join('\n') },
    { path: 'main.py', content: 'from app import run\n\nif __name__ == "__main__":\n    print(run())\n' },
    { path: 'app.py', content: 'from __future__ import annotations\n\n\ndef run():\n    return 1\n' },
  ];
  const f = analyzeFiles(files).findings;
  // `var app = module.exports = express()` calls express() — the import
  // is used, even though module.exports appears on the same line.
  assert.equal(bySymbol(f, 'src/index.js', 'express'), undefined, 'express() is called on the module.exports line');
  // A return that is the body of a braceless `if` does not terminate
  // the block — the assignment after it is reachable.
  assert.equal(byCategory(f, 'src/cmd.js', 'unreachable'), undefined, 'the assignment after a braceless-if return is reachable');
  // `from __future__ import annotations` is a compiler directive.
  assert.equal(bySymbol(f, 'app.py', 'annotations'), undefined, '__future__ imports are never flagged');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web jsx-apostrophe: an apostrophe in JSX text does not swallow the file', () => {
  // preact demos: `I'm memoed` / `I'm (fake) lazy loaded` / `we're` in
  // JSX text used to open a "string" that blanked the rest of the file,
  // so the imports looked dead and reachable code looked unreachable.
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    {
      path: 'src/demo.jsx',
      content: [
        "import { Component, memo } from 'react';",
        '',
        'function Foo() {',
        "\treturn <div>I'm memoed</div>;",
        '}',
        '',
        'function LazyComp() {',
        "\treturn <div>I'm (fake) lazy loaded</div>;",
        '}',
        '',
        'const Memoed = memo(Foo);',
        'export default class Demo extends Component {',
        '  render() { return <div><Foo /><LazyComp /><Memoed /></div>; }',
        '}',
        '',
      ].join('\n'),
    },
    { path: 'src/index.js', content: "const Demo = require('./demo.jsx');\nconsole.log(Demo);\n" },
  ];
  const r = analyzeFiles(files);
  assert.equal(r.findings.filter((x) => x.category === 'unreachable').length, 0, 'JSX apostrophes must not create unreachable findings');
  assert.equal(bySymbol(r.findings, 'src/demo.jsx', 'Component'), undefined, 'Component is the base class of Demo');
  assert.equal(bySymbol(r.findings, 'src/demo.jsx', 'memo'), undefined, 'memo wraps Foo');
  assert.equal(bySymbol(r.findings, 'src/demo.jsx', 'Foo'), undefined, 'Foo is rendered in JSX');
  assert.equal(bySymbol(r.findings, 'src/demo.jsx', 'LazyComp'), undefined, 'LazyComp is rendered in JSX');
});

test('web class-calls: a call line inside a class body is not a method definition', () => {
  // commander lib/command.js: `handleOptionValue(val, ...)` and
  // `checkForUnknownOptions()` are calls inside methods, but the old
  // method regex recorded each call site as a phantom method — which
  // also suppressed the real call, so the arrow-function definition
  // looked dead (SAFE). date-fns MonthParser had the same shape with
  // a nested `parseNumericPattern(...)` call.
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    {
      path: 'src/lib.js',
      content: [
        'class Command {',
        '  parseOptions() {',
        '    const handleOptionValue = (val) => { return val; };',
        '    handleOptionValue("a");',
        '    handleOptionValue("b");',
        '  }',
        '  check() {',
        '    const checkForUnknownOptions = () => { return true; };',
        '    checkForUnknownOptions();',
        '    checkForUnknownOptions();',
        '  }',
        '  used() { return 1; }',
        '}',
        'module.exports = { Command };',
        '',
      ].join('\n'),
    },
    {
      path: 'src/parser.js',
      content: [
        "const { mapValue, parseNumericPattern } = require('./utils');",
        'class MonthParser {',
        '  parse(dateString) {',
        '    return mapValue(',
        '      parseNumericPattern(1, dateString),',
        '      (v) => v,',
        '    );',
        '  }',
        '}',
        'module.exports = { MonthParser };',
        '',
      ].join('\n'),
    },
    {
      path: 'src/utils.js',
      content: [
        'function mapValue(v, fn) { return fn(v); }',
        'function parseNumericPattern(a, b) { return a + b; }',
        'module.exports = { mapValue, parseNumericPattern };',
        '',
      ].join('\n'),
    },
    { path: 'src/index.js', content: "const { Command } = require('./lib');\nconst { MonthParser } = require('./parser');\nconst c = new Command();\nconsole.log(c.used(), new MonthParser().parse('x'));\n" },
  ];
  const r = analyzeFiles(files);
  assert.equal(bySymbol(r.findings, 'src/lib.js', 'handleOptionValue'), undefined, 'the arrow function is called in its own method');
  assert.equal(bySymbol(r.findings, 'src/lib.js', 'checkForUnknownOptions'), undefined, 'the arrow function is called in its own method');
  assert.equal(bySymbol(r.findings, 'src/parser.js', 'parseNumericPattern'), undefined, 'the nested call is a use of the import');
  assert.equal(bySymbol(r.findings, 'src/parser.js', 'mapValue'), undefined, 'mapValue is called in parse()');
  // No phantom method findings at the call lines, and no SAFE at all.
  assert.equal(r.findings.filter((x) => x.category === 'method' && (x.symbol === 'handleOptionValue' || x.symbol === 'checkForUnknownOptions' || x.symbol === 'parseNumericPattern')).length, 0, 'call lines must not become phantom methods');
  assert.equal(r.findings.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web return-continuation: a return whose expression continues on the next line does not terminate the block', () => {
  // commander help.js (`return str` + `.split(...).map(...)`), zustand
  // persist.ts (`return toThenable(...)` + `.then(...)`), and a return
  // ending with an operator (`return a +`).
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    {
      path: 'src/a.js',
      content: [
        'function styleUsage(str) {',
        '  return str',
        "    .split(' ')",
        '    .map((word) => {',
        "      if (word === '[options]') return word;",
        "      if (word[0] === '[') return word;",
        '      return word;',
        '    })',
        "    .join(' ');",
        '}',
        'function fetchIt(x) {',
        '  return getIt(x)',
        '    .then((v) => v);',
        '}',
        'function sum(a, b) {',
        '  return a +',
        '    b;',
        '}',
        'module.exports = { styleUsage, fetchIt, sum };',
        '',
      ].join('\n'),
    },
    { path: 'src/index.js', content: "const { styleUsage, fetchIt, sum } = require('./a');\nconsole.log(styleUsage('x'), fetchIt(1), sum(1, 2));\n" },
  ];
  const r = analyzeFiles(files);
  assert.equal(r.findings.filter((x) => x.category === 'unreachable').length, 0, 'continued returns must not flag the following lines unreachable');
  assert.equal(r.findings.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web braceless-multiline: a braceless if header spanning lines does not terminate the block', () => {
  // commander command.js and date-fns buildMds.ts / _lib/tp/index.ts:
  // `if (\n cond\n )` followed by a bare `return ...;` — the `)`
  // line before the return used to defeat the braceless check, so the
  // statement after the return was flagged unreachable.
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    {
      path: 'src/a.js',
      content: [
        'function check(x) {',
        '  if (',
        '    x === 1 ||',
        '    x === 2',
        '  )',
        '    return false;',
        '  return true;',
        '}',
        'function walk(list) {',
        '  list.forEach((item) => {',
        '    if (',
        '      item === "a" ||',
        '      item === "b"',
        '    )',
        '      return;',
        '    console.log(item);',
        '  });',
        '}',
        'module.exports = { check, walk };',
        '',
      ].join('\n'),
    },
    { path: 'src/index.js', content: "const { check, walk } = require('./a');\nconsole.log(check(1));\nwalk(['a']);\n" },
  ];
  const r = analyzeFiles(files);
  assert.equal(r.findings.filter((x) => x.category === 'unreachable').length, 0, 'the statement after a braceless-if return is reachable');
  assert.equal(r.findings.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web py-multiline-raise: a raise/return split over lines does not flag its continuation unreachable', () => {
  // flask cli.py / app.py / debughelpers.py, click, fastapi: `raise
  // NoAppException(\n ...\n ) from e` — the `) from e` line was flagged
  // unreachable, and `return (\n ...\n ).rstrip()` the same.
  const files = [
    { path: 'main.py', content: 'from app import load_app, render\n\nif __name__ == "__main__":\n    print(load_app("x"), render("y"))\n' },
    {
      path: 'app.py',
      content: [
        'class NoAppException(Exception):',
        '    pass',
        '',
        '',
        'def load_app(name):',
        '    try:',
        '        return name',
        '    except Exception as e:',
        '        raise NoAppException(',
        '            f"Failed to find {name}."',
        '        ) from e',
        '',
        '',
        'def render(value):',
        '    return (',
        '        value',
        '        % {"label": "x"}',
        '    ).rstrip()',
        '',
      ].join('\n'),
    },
  ];
  const r = analyzeFiles(files);
  assert.equal(r.findings.filter((x) => x.category === 'unreachable').length, 0, 'a multi-line raise/return continuation is not unreachable');
});

test('web ts-type-list: names in an export type list are not phantom definitions', () => {
  // zustand src/middleware.ts: `export {\n type DevtoolsOptions,\n
  // type NamedSet,\n} from ...` — each list item used to become a
  // phantom `type` definition that looked dead (SAFE).
  const files = [
    {
      path: 'src/middleware.ts',
      content: [
        'export {',
        '  devtools,',
        '  type DevtoolsOptions,',
        '  type NamedSet,',
        "} from './devtools';",
        'export type RealType = {',
        '  name: string;',
        '};',
        '',
      ].join('\n'),
    },
    {
      path: 'src/devtools.ts',
      content: [
        'export type DevtoolsOptions = { enabled: boolean };',
        'export type NamedSet = { set: (x: number) => void };',
        'export function devtools() { return 1; }',
        '',
      ].join('\n'),
    },
    { path: 'src/index.ts', content: "import { devtools, RealType } from './middleware';\nimport { DevtoolsOptions } from './devtools';\nconst x: RealType = { name: 'a' };\nconst y: DevtoolsOptions = { enabled: true };\nconsole.log(devtools(), x, y);\n" },
  ];
  const r = analyzeFiles(files);
  assert.equal(bySymbol(r.findings, 'src/middleware.ts', 'DevtoolsOptions'), undefined, 'a type-list item is not a definition in this file');
  assert.equal(bySymbol(r.findings, 'src/middleware.ts', 'NamedSet'), undefined, 'a type-list item is not a definition in this file');
  assert.equal(r.findings.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web ts-type-import: import { type X } binds X, not "type X"', () => {
  // date-fns: `import { type constructFromSymbol }` recorded a bogus
  // import named `type constructFromSymbol` that could never be used,
  // so the real import was flagged SAFE.
  const files = [
    {
      path: 'src/types.ts',
      content: [
        'import { type constructFromSymbol } from "./constants";',
        'export type HasSymbol = {',
        '  [constructFromSymbol]: (v: number) => number;',
        '};',
        '',
      ].join('\n'),
    },
    {
      path: 'src/constants.ts',
      content: [
        'export const constructFromSymbol = Symbol.for("constructDateFrom");',
        '',
      ].join('\n'),
    },
    { path: 'src/index.ts', content: "import { HasSymbol } from './types';\nconst h: HasSymbol | null = null;\nconsole.log(h);\n" },
  ];
  const r = analyzeFiles(files);
  assert.equal(bySymbol(r.findings, 'src/types.ts', 'constructFromSymbol'), undefined, 'the type import is used as a computed property key');
  assert.equal(bySymbol(r.findings, 'src/types.ts', 'type constructFromSymbol'), undefined, 'no bogus import named "type constructFromSymbol"');
  assert.equal(r.findings.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web module-exports-expr: calls and arguments on a module.exports line are uses', () => {
  // next-blog next.config.js: `module.exports =
  // withBundleAnalyzer({...})` calls the import. date-fns buildMds.ts:
  // `module.exports = nodes.filter(isExportNode)` passes the import as
  // an argument. Both used to be skipped outright, so the imports were
  // flagged SAFE. `module.exports = solo` (a bare identifier) is still
  // an export, not a use — it grades REVIEW, never SAFE.
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    {
      path: 'src/index.js',
      content: [
        "const withBundleAnalyzer = require('@next/bundle-analyzer')({ enabled: true });",
        'module.exports = withBundleAnalyzer({});',
        '',
      ].join('\n'),
    },
    {
      path: 'src/build.js',
      content: [
        "const { isExportNode } = require('./data');",
        'module.exports = nodes.filter(isExportNode);',
        '',
      ].join('\n'),
    },
    {
      path: 'src/data.js',
      content: [
        'function isExportNode(n) { return n.type === "export"; }',
        'module.exports = { isExportNode };',
        '',
      ].join('\n'),
    },
    {
      path: 'src/single.js',
      content: [
        'function solo() { return 1; }',
        'module.exports = solo;',
        '',
      ].join('\n'),
    },
    { path: 'src/main.js', content: "require('./build');\nrequire('./single');\nconsole.log('ok');\n" },
  ];
  const r = analyzeFiles(files);
  assert.equal(bySymbol(r.findings, 'src/index.js', 'withBundleAnalyzer'), undefined, 'withBundleAnalyzer() is called on the module.exports line');
  assert.equal(bySymbol(r.findings, 'src/build.js', 'isExportNode'), undefined, 'isExportNode is passed as an argument on the module.exports line');
  assert.equal(bySymbol(r.findings, 'src/single.js', 'solo').grade, 'REVIEW', 'module.exports = solo exports it — REVIEW, never SAFE');
});

test('web py-noqa: a # noqa import is a re-export even though comments are stripped', () => {
  // requests sessions.py / utils.py / models.py and flask cli.py: the
  // `# noqa: F401` marker lives in a comment, which the stripped code
  // blanks — so the web parser could not see it and flagged the import
  // SAFE. The check must run on the raw statement, including the
  // opening line of a multi-line import.
  const files = [
    { path: 'main.py', content: 'import sessions\n\nprint(sessions.make())\n' },
    {
      path: 'sessions.py',
      content: [
        'from .models import (  # noqa: F401',
        '    REDIRECT_STATI,',
        '    PreparedRequest,',
        ')',
        'import cryptography  # noqa: F401',
        'import os',
        '',
        '',
        'def make():',
        '    return 1',
        '',
      ].join('\n'),
    },
    {
      path: 'models.py',
      content: [
        'REDIRECT_STATI = (301, 302)',
        '',
        '',
        'class PreparedRequest:',
        '    pass',
        '',
      ].join('\n'),
    },
  ];
  const r = analyzeFiles(files);
  assert.equal(bySymbol(r.findings, 'sessions.py', 'REDIRECT_STATI'), undefined, 'a multi-line noqa import is a re-export');
  assert.equal(bySymbol(r.findings, 'sessions.py', 'PreparedRequest'), undefined, 'a multi-line noqa import is a re-export');
  assert.equal(bySymbol(r.findings, 'sessions.py', 'cryptography'), undefined, 'a single-line noqa import is a re-export');
  assert.equal(bySymbol(r.findings, 'sessions.py', 'os').grade, 'SAFE', 'an unused import without noqa is still flagged');
});

test('web py-print-cls: print and cls are not keywords, so imports bound to them count as used', () => {
  // fastapi scripts/translate.py: `from rich import print` — every
  // `print(...)` call was skipped as a "keyword", so the import looked
  // unused. flask app.py: `from .testing import FlaskClient as cls` —
  // the `cls(...)` call was skipped the same way.
  const files = [
    { path: 'main.py', content: 'from app import make_client\nfrom translate import main\n\nif __name__ == "__main__":\n    print(make_client(), main())\n' },
    {
      path: 'app.py',
      content: [
        'from .testing import FlaskClient as cls',
        '',
        '',
        'def make_client():',
        '    return cls()',
        '',
      ].join('\n'),
    },
    { path: 'testing.py', content: 'class FlaskClient:\n    pass\n' },
    {
      path: 'translate.py',
      content: [
        'from rich import print',
        '',
        '',
        'def main():',
        '    print("translating")',
        '    return 1',
        '',
      ].join('\n'),
    },
  ];
  const r = analyzeFiles(files);
  assert.equal(bySymbol(r.findings, 'app.py', 'cls'), undefined, 'cls(...) calls the aliased import');
  assert.equal(bySymbol(r.findings, 'translate.py', 'print'), undefined, 'print(...) calls the rich print import');
});

test('web string-index-digits: a token starting mid-number is not a string reference', () => {
  // The inverted string index must mirror the \b boundary of the old
  // per-name scan: "%5c" in a URL is not a reference to `c`, and
  // "%70age" is not a reference to `age`.
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/b.js' }) },
    {
      path: 'src/a.js',
      content: [
        'function c() { return 1; }',
        'function age() { return 2; }',
        'module.exports = {};',
        '',
      ].join('\n'),
    },
    {
      path: 'src/b.js',
      content: [
        'const URL = "/%5c..%5csecret.txt";',
        'const OTHER = "?%70age=2";',
        'console.log(URL, OTHER);',
        '',
      ].join('\n'),
    },
  ];
  const r = analyzeFiles(files);
  assert.equal(bySymbol(r.findings, 'src/a.js', 'c').grade, 'SAFE', '"%5c" must not count as a use of c');
  assert.equal(bySymbol(r.findings, 'src/a.js', 'age').grade, 'SAFE', '"%70age" must not count as a use of age');
});

test('web tests-dir: files under tests/ or test/ are KEEP at most, never SAFE', () => {
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    { path: 'src/index.js', content: "const { usedFn } = require('./lib');\nconsole.log(usedFn());\n" },
    { path: 'src/lib.js', content: 'function usedFn() { return 1; }\nmodule.exports = { usedFn };\n' },
    { path: 'tests/helpers/type-check.js', content: 'function deadHelper() { return 1; }\nmodule.exports = { deadHelper };\n' },
    { path: 'src/test/test-utils.tsx', content: 'export function renderAll() { return 1; }\n' },
  ];
  const f = analyzeFiles(files).findings;
  assert.equal(byCategory(f, 'tests/helpers/type-check.js', 'file').grade, 'KEEP');
  assert.equal(bySymbol(f, 'tests/helpers/type-check.js', 'deadHelper').grade, 'KEEP');
  assert.equal(byCategory(f, 'src/test/test-utils.tsx', 'file').grade, 'KEEP');
  assert.equal(bySymbol(f, 'src/test/test-utils.tsx', 'renderAll').grade, 'KEEP');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web re-export multiline: export { ... } from keeps the target live', () => {
  const files = [
    { path: 'src/index.js', content: "const b = require('./barrel');\nconsole.log(b);\n" },
    { path: 'src/barrel.js', content: "export {\n  A,\n  B,\n} from './x';\n" },
    { path: 'src/x.js', content: 'export function A() {}\nexport function B() {}\n' },
  ];
  const f = analyzeFiles(files).findings;
  assert.equal(byCategory(f, 'src/x.js', 'file'), undefined, 'x.js is re-exported by the barrel, so it is not a dead file');
  assert.equal(bySymbol(f, 'src/x.js', 'A'), undefined);
  assert.equal(bySymbol(f, 'src/x.js', 'B'), undefined);
});

test('web module-exports multiline: a name only listed in the export object is not a live use', () => {
  const files = [
    { path: 'src/index.js', content: "const r = require('./reexp');\nconsole.log(r);\n" },
    { path: 'src/reexp.js', content: "const foo = require('./foo');\nmodule.exports = {\n  foo,\n};\n" },
    { path: 'src/foo.js', content: 'module.exports = function foo() {};\n' },
  ];
  const f = analyzeFiles(files).findings;
  // `foo` appears only on a continuation line of the export object: that
  // is an export, not a use, so the import is dead (matches the CLI).
  assert.equal(bySymbol(f, 'src/reexp.js', 'foo').grade, 'SAFE');
});

test('web module-exports multiline: names after a function value are still marked exported', () => {
  const files = [
    { path: 'src/index.js', content: "const u = require('./under');\nconsole.log(u);\n" },
    { path: 'src/under.js', content: 'function _internal() {}\nfunction A() {}\nmodule.exports = {\n  A,\n  run: () => { return 1; },\n  _internal,\n};\n' },
  ];
  const f = analyzeFiles(files).findings;
  // The old single `[^}]*` match stopped at the arrow function's `}`,
  // so `_internal` was never marked exported and graded SAFE.
  assert.equal(bySymbol(f, 'src/under.js', '_internal').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/under.js', 'A').grade, 'REVIEW');
});

test('web module-exports multiline: a nested value is still a live use', () => {
  const files = [
    { path: 'src/index.js', content: "const n = require('./nested');\nconsole.log(n);\n" },
    { path: 'src/nested.js', content: 'function A() {}\nfunction B() {}\nmodule.exports = {\n  A,\n  nested: { B },\n};\n' },
  ];
  const f = analyzeFiles(files).findings;
  // `B` sits inside a nested object in the export value, so it is a real
  // reference (matches the CLI); only the top-level `A` is an export.
  assert.equal(bySymbol(f, 'src/nested.js', 'B'), undefined);
  assert.equal(bySymbol(f, 'src/nested.js', 'A').grade, 'REVIEW');
});

// --- Batch 4: multi-line imports + JSX-pragma rule ---
// (Pre-act demo/suspense.jsx and demo/people/router.tsx: every name on
// a multi-line import's continuation lines leaked into the references
// pass and looked used, so no unused import split across lines was
// ever flagged; and the JSX pragma imports createElement / Fragment /
// h were flagged SAFE by the CLI even though the JSX transform calls
// them. Both are fixed: continuation lines are bindings, not uses,
// and pragma bindings count as used in a JSX file.)

const { parseJs } = require('../docs/analyzer');

test('web multi-line import: continuation-line names are bindings, not uses', () => {
  const p = parseJs('src/a.js', [
    'import {',
    '  usedFn,',
    '  deadFn',
    "} from './lib.js';",
    'usedFn();',
    '',
  ].join('\n'));
  assert.deepEqual(p.imports[0].names.map((n) => n.local), ['usedFn', 'deadFn']);
  assert.equal(p.references.has('usedFn'), true);
  assert.equal(p.references.has('deadFn'), false);
});

test('web multi-line import: an unused name on a continuation line is SAFE', () => {
  const files = [
    { path: 'src/index.js', content: "import { run } from './a.js';\nrun();\n" },
    { path: 'src/a.js', content: [
      'import {',
      '  usedFn,',
      '  deadFn',
      "} from './lib.js';",
      'export function run() { usedFn(); }',
      '',
    ].join('\n') },
    { path: 'src/lib.js', content: 'export function usedFn() { return 1; }\nexport function deadFn() { return 2; }\n' },
  ];
  const f = analyzeFiles(files).findings;
  assert.equal(bySymbol(f, 'src/a.js', 'deadFn').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/a.js', 'usedFn'), undefined);
});

test('web multi-line import: a 13-name import spanning 15 lines still parses', () => {
  const names = [];
  for (let i = 0; i < 12; i++) names.push('n' + i);
  const lines = ['import {'];
  names.forEach((n) => lines.push('  ' + n + ','));
  lines.push('  deadLast');
  lines.push("} from './lib.js';");
  lines.push('export function run() { ' + names.map((n) => n + '()').join(' ') + ' }');
  const p = parseJs('src/a.js', lines.join('\n'));
  // The old 10-line accumulation bound cut this statement off before
  // its `from` clause, so the import edge vanished entirely.
  assert.equal(p.imports.length, 1);
  assert.equal(p.imports[0].names.length, 13);
  assert.equal(p.references.has('deadLast'), false);
  names.forEach((n) => assert.equal(p.references.has(n), true, n + ' must be referenced'));
});

test('web multi-line require: destructured names are flaggable', () => {
  const files = [
    { path: 'src/index.js', content: "require('./a.js');\n" },
    { path: 'src/a.js', content: [
      'const {',
      '  usedHelper,',
      '  deadHelper',
      "} = require('./util.js');",
      'usedHelper();',
      '',
    ].join('\n') },
    { path: 'src/util.js', content: 'exports.usedHelper = () => 1;\nexports.deadHelper = () => 2;\n' },
  ];
  const f = analyzeFiles(files).findings;
  assert.equal(bySymbol(f, 'src/a.js', 'deadHelper').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/a.js', 'usedHelper'), undefined);
});

test('web multi-line require: a member call after the require still counts as a use', () => {
  const p = parseJs('src/a.js', [
    'const {',
    '  a',
    "} = require('./util.js').helper();",
    'a();',
    '',
  ].join('\n'));
  assert.equal(p.imports.length, 1);
  assert.equal(p.imports[0].source, './util.js');
  assert.deepEqual(p.imports[0].names.map((n) => n.local), ['a']);
  // `helper` is a real use (the member call), not a binding: only `a`
  // is bound on these lines, so it must still be recorded.
  assert.equal(p.references.has('helper'), true);
  assert.equal(p.calls.has('helper'), true);
  assert.equal(p.references.has('a'), true);
});

test('web multi-line require: a require split before its argument still parses', () => {
  const p = parseJs('src/a.js', [
    'const x =',
    "  require('./util.js');",
    'x();',
    '',
  ].join('\n'));
  assert.equal(p.imports.length, 1);
  assert.equal(p.imports[0].source, './util.js');
  assert.deepEqual(p.imports[0].names.map((n) => n.local), ['x']);
});

test('web multi-line re-export: the edge is recorded and the names do not leak', () => {
  const p = parseJs('src/re.js', [
    'export {',
    '  A,',
    '  B',
    "} from './x.js';",
    'function A() { return 1; }',
    '',
  ].join('\n'));
  assert.equal(p.imports.length, 1);
  assert.equal(p.imports[0].reExport, true);
  assert.equal(p.imports[0].source, './x.js');
  // The re-exported names ride on the edge (matches the CLI): the
  // graph marks the target's symbols as imported through them.
  assert.deepEqual(p.imports[0].names.map((n) => n.imported), ['A', 'B']);
  // A and B name the source module's exports, not locals: the
  // continuation lines must not make the local A look used.
  assert.equal(p.references.has('A'), false);
  assert.equal(p.references.has('B'), false);
});

test('web JSX pragma: createElement and Fragment count as used in a JSX file, memo does not', () => {
  const files = [
    { path: 'src/index.jsx', content: "import { run } from './app.jsx';\nrun();\n" },
    { path: 'src/app.jsx', content: [
      'import {',
      '  createElement,',
      '  memo,',
      '  Fragment',
      "} from 'react';",
      'export function run() { return <><div>hi</div></>; }',
      '',
    ].join('\n') },
  ];
  const f = analyzeFiles(files).findings;
  assert.equal(bySymbol(f, 'src/app.jsx', 'createElement'), undefined);
  assert.equal(bySymbol(f, 'src/app.jsx', 'Fragment'), undefined);
  // memo is a higher-order component, never called by the transform.
  assert.equal(bySymbol(f, 'src/app.jsx', 'memo').grade, 'SAFE');
});

test('web JSX pragma: h and React count as used with JSX, flaggable without it', () => {
  const withJsx = [
    { path: 'src/index.jsx', content: "import { run } from './app.jsx';\nrun();\n" },
    { path: 'src/app.jsx', content: "import { h } from 'preact';\nimport React from 'react';\nexport function run() { return <div>hi</div>; }\n" },
  ];
  const f1 = analyzeFiles(withJsx).findings;
  assert.equal(bySymbol(f1, 'src/app.jsx', 'h'), undefined);
  assert.equal(bySymbol(f1, 'src/app.jsx', 'React'), undefined);
  const noJsx = [
    { path: 'src/index.js', content: "import { run } from './app.js';\nrun();\n" },
    { path: 'src/app.js', content: "import { h } from 'preact';\nimport React from 'react';\nexport function run() { return 1; }\n" },
  ];
  const f2 = analyzeFiles(noJsx).findings;
  assert.equal(bySymbol(f2, 'src/app.js', 'h').grade, 'SAFE');
  assert.equal(bySymbol(f2, 'src/app.js', 'React').grade, 'SAFE');
});

test('web JSX pragma: automatic-runtime jsx counts as used in a JSX file', () => {
  const files = [
    { path: 'src/index.jsx', content: "import { run } from './app.jsx';\nrun();\n" },
    { path: 'src/app.jsx', content: "import { jsx } from 'react/jsx-runtime';\nexport function run() { return <div>hi</div>; }\n" },
  ];
  const f = analyzeFiles(files).findings;
  assert.equal(bySymbol(f, 'src/app.jsx', 'jsx'), undefined);
});

test('web JSX detection: a spread-only element counts as JSX', () => {
  const p = parseJs('src/a.jsx', "import { h } from 'preact';\nexport function run(props) { return <div {...props}>hi</div>; }\n");
  assert.equal(p.hasJsx, true);
  assert.equal(p.references.has('h'), true);
});

test('web JSX detection: generics and comparisons are not JSX', () => {
  const p = parseJs('src/a.ts', [
    "import { h } from 'preact';",
    'function id<T>(x: T): T { return x; }',
    "const y = id<string>('s');",
    'const ok = 1 < 2;',
    'export function run() { return y; }',
    '',
  ].join('\n'));
  assert.equal(p.hasJsx, false);
  // No JSX, so the pragma import stays flaggable.
  assert.equal(p.references.has('h'), false);
});

test('web multi-line import: an ASI side-effect import swallows no following lines', () => {
  // Regression: `import './x'` with no trailing `;` used to accumulate
  // the following lines (up to the guard) and record them as import
  // lines, so every symbol in the next function looked dead (zustand
  // Scene.jsx: Experience, Canvas, scaleN and group all went SAFE).
  const p = parseJs('src/a.jsx', [
    "import './setup';",
    "import './other'",
    'function Experience() {',
    '  const scaleN = 1;',
    '  return <div>{scaleN}</div>;',
    '}',
    'export function run() { return Experience(); }',
    '',
  ].join('\n'));
  assert.equal(p.imports.length, 2);
  assert.equal(p.references.has('scaleN'), true);
  assert.equal(p.references.has('Experience'), true);
});

test('web multi-line import: a comment inside the specifier list is not a name', () => {
  const p = parseJs('src/a.js', [
    'import {',
    '  // the main helper',
    '  usedFn,',
    '  deadFn',
    "} from './lib.js';",
    'usedFn();',
    '',
  ].join('\n'));
  assert.deepEqual(p.imports[0].names.map((n) => n.local), ['usedFn', 'deadFn']);
  assert.equal(p.references.has('deadFn'), false);
});

test('web keyword-imports: of/from/get/set imports count as used when called', () => {
  // WP-1: RxJS `of` / `from` (and lodash `get` / `set`) collide with JS
  // keywords, so the use-counter used to skip their calls and flag the
  // imports SAFE even though they are called (nestjs hello.controller:
  // `of` called at :23, `from` called in streaming.module).
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    {
      path: 'src/index.js',
      content: [
        "const { HelloController } = require('./hello.controller');",
        'const c = new HelloController();',
        'console.log(c.streamGreeting(), c.loadAll(), c.update({}));',
        '',
      ].join('\n'),
    },
    {
      path: 'src/hello.controller.js',
      content: [
        "import { of } from 'rxjs';",
        "import { from } from 'rxjs';",
        "import { get, set } from 'lodash';",
        "import { neverCalled } from 'rxjs';",
        'export class HelloController {',
        '  streamGreeting() {',
        '    return of(this.greeting());',
        '  }',
        '  loadAll() {',
        '    return from([1, 2]).pipe(get);',
        '  }',
        '  greeting() { return "hi"; }',
        '  update(obj) { set(obj, "a", 1); return obj; }',
        '}',
        '',
      ].join('\n'),
    },
  ];
  const f = analyzeFiles(files).findings;
  for (const name of ['of', 'from', 'get', 'set']) {
    assert.equal(bySymbol(f, 'src/hello.controller.js', name), undefined, `${name} is called in its own file and must not be flagged`);
  }
  // The control: an unused keyword-colliding import is still flagged.
  assert.equal(bySymbol(f, 'src/hello.controller.js', 'neverCalled').grade, 'SAFE');
  assert.deepEqual(
    f.filter((x) => x.grade === 'SAFE').map((x) => `${x.category}:${x.file}:${x.symbol || ''}`),
    ['import:src/hello.controller.js:neverCalled'],
  );
});

test('web keyword-imports: a local named from/get used only in ${} is live', () => {
  // The sveltekit write_types shape: `const from = ...` is used only
  // inside `` `${from}` ``, and `get()` only by a same-file call — both
  // used to look unused because `from` / `get` are JS keywords.
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    { path: 'src/index.js', content: "const { build } = require('./build');\nconsole.log(build('x'));\n" },
    {
      path: 'src/build.js',
      content: [
        'function build(path) {',
        "  const from = './proxy' + path;",
        "  const type = `typeof import('${from}').load`;",
        '  return type;',
        '}',
        'function get() { return 1; }',
        'function caller() { return get(); }',
        'module.exports = { build, caller };',
        '',
      ].join('\n'),
    },
  ];
  const f = analyzeFiles(files).findings;
  assert.equal(bySymbol(f, 'src/build.js', 'from'), undefined, 'from is used in the ${} interpolation');
  assert.equal(bySymbol(f, 'src/build.js', 'get'), undefined, 'get() is called by caller()');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web unreachable-template: ${} lines inside a template literal after return are not unreachable', () => {
  // WP-2: adapter-netlify generates edge-function source in a template
  // literal after `return `...`` — the ${...} expression lines inside
  // it are part of the return statement, not new statements after it.
  // The genuinely unreachable return in dead() is still flagged.
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    { path: 'src/index.js', content: "const { build } = require('./build');\nconsole.log(build('x'));\n" },
    {
      path: 'src/build.js',
      content: [
        'function build(name) {',
        '  return `\\',
        '${name}',
        'export default async (request) => {',
        '  return name;',
        '};',
        '`;',
        '}',
        'function dead() {',
        '  return 1;',
        '  return 2;',
        '}',
        'module.exports = { build, dead };',
        '',
      ].join('\n'),
    },
  ];
  const r = analyzeFiles(files);
  const unreach = r.findings.filter((x) => x.category === 'unreachable');
  assert.equal(unreach.length, 1, 'only the genuinely unreachable return is flagged: ' + JSON.stringify(unreach));
  assert.equal(unreach[0].file, 'src/build.js');
  assert.equal(unreach[0].startLine, 11, 'the second return in dead()');
});

test('web template-continuation: line numbers after a backslash-newline template stay aligned', () => {
  // A `\` + newline inside a template literal used to eat the newline
  // in the stripped code, so every later definition's startLine drifted
  // (adapter-netlify findings pointed at the wrong lines).
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    {
      path: 'src/a.js',
      content: [
        'const s = `a\\',
        'b`;',
        'function afterTemplate() { return 1; }',
        'module.exports = { afterTemplate };',
        '',
      ].join('\n'),
    },
    { path: 'src/index.js', content: "require('./a');\nconsole.log('hi');\n" },
  ];
  const f = analyzeFiles(files).findings;
  assert.equal(bySymbol(f, 'src/a.js', 'afterTemplate').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/a.js', 'afterTemplate').startLine, 3, 'the definition sits on raw line 3, not the drifted line 2');
});

test('web dedupe: same-name definitions in one file emit one finding, one per unreachable block', () => {
  // Django's 114 `Meta` classes / 52 `http_options` variables all
  // used to emit one finding per definition / per line. The hoisted
  // functions in outer() are reachable (FP-12) and emit nothing; the
  // genuinely unreachable block in dead() emits exactly one finding.
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    { path: 'src/index.js', content: "const { A, B } = require('./lib');\nconsole.log(new A(), new B());\n" },
    {
      path: 'src/lib.js',
      content: [
        'class A {',
        '  neverCalled() { return 1; }',
        '}',
        'class B {',
        '  neverCalled() { return 2; }',
        '}',
        'function outer() {',
        '  return 1;',
        '  function hoistedA() { return 2; }',
        '  function hoistedB() { return 3; }',
        '}',
        'function dead() {',
        '  return 1;',
        '  console.log(1);',
        '  console.log(2);',
        '}',
        'module.exports = { A, B, outer, dead };',
        '',
      ].join('\n'),
    },
  ];
  const f = analyzeFiles(files).findings;
  const methods = f.filter((x) => x.category === 'method' && x.symbol === 'neverCalled');
  assert.equal(methods.length, 1, 'one finding for both neverCalled methods: ' + JSON.stringify(methods));
  assert.equal(methods[0].startLine, 2, 'the first definition wins');
  const unreach = f.filter((x) => x.category === 'unreachable');
  assert.equal(unreach.length, 1, 'one finding for the genuinely unreachable block: ' + JSON.stringify(unreach));
  assert.equal(unreach[0].startLine, 14, 'the block starts at the first dead statement in dead()');
});

test('web unreachable-hoisted: function declarations after return are reachable (FP-12)', () => {
  // SvelteKit shape: get_data_type / apply_handle / create_leaf_loader
  // are function declarations after `return` in the same scope — they
  // hoist, so they and their bodies are reachable. A const after the
  // same return still never runs (temporal dead zone) and is flagged.
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    { path: 'src/index.js', content: "const { outer } = require('./lib');\nconsole.log(outer());\n" },
    {
      path: 'src/lib.js',
      content: [
        'function outer() {',
        '  const x = getData();',
        '  return x;',
        '  function getData() {',
        '    return 42;',
        '  }',
        '  async function load() { return 1; }',
        '  function* gen() { yield 1; }',
        '  const afterReturn = 1;',
        '}',
        'module.exports = { outer };',
        '',
      ].join('\n'),
    },
  ];
  const f = analyzeFiles(files).findings;
  const unreach = f.filter((x) => x.category === 'unreachable');
  assert.equal(unreach.length, 1, 'only the const after return is unreachable: ' + JSON.stringify(unreach));
  assert.equal(unreach[0].startLine, 9, 'the const line, not the hoisted functions');
});

test('web template-import: a name used only in a dynamic import() template is live', () => {
  // The pydantic-core wasm-preview worker.js shape: PYODIDE_VERSION is
  // used only inside `import(`https://...v${PYODIDE_VERSION}/...`)` —
  // the references pass used to skip every line starting with `import`,
  // including dynamic import() lines, so the name looked unused.
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    { path: 'src/index.js', content: "const { load } = require('./worker');\nconsole.log(load());\n" },
    {
      path: 'src/worker.js',
      content: [
        "const PYODIDE_VERSION = '314.0.7';",
        'async function load() {',
        '  const [m] = await Promise.all([',
        '    import(`https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.mjs`),',
        '  ]);',
        '  return m;',
        '}',
        'module.exports = { load };',
        '',
      ].join('\n'),
    },
  ];
  const f = analyzeFiles(files).findings;
  assert.equal(bySymbol(f, 'src/worker.js', 'PYODIDE_VERSION'), undefined, 'PYODIDE_VERSION is interpolated into the dynamic import URL');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('web return-as-cast: a return ending in as continues on the next line', () => {
  // The nestjs standard-schema-validation.pipe.ts shape: `return x as`
  // with the type on the next line is one statement, not a completed
  // return followed by unreachable code.
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/index.js' }) },
    { path: 'src/index.js', content: "const { validate } = require('./pipe');\nconsole.log(validate(1));\n" },
    {
      path: 'src/pipe.ts',
      content: [
        'function validate(value) {',
        '  return value as',
        '    string;',
        '}',
        'module.exports = { validate };',
        '',
      ].join('\n'),
    },
  ];
  const r = analyzeFiles(files);
  assert.equal(r.findings.filter((x) => x.category === 'unreachable').length, 0, 'the type on the next line is part of the return');
});

test('web py-probe: an uppercase `# NOQA` import-as-probe is intentional, never SAFE', () => {
  const f = loadFixture('py-probe').findings;
  // Django: `from PIL import Image  # NOQA` inside try/except in
  // db/models/fields/files.py exists to test whether Pillow is
  // installed; the import IS the use. The noqa marker was missed
  // because the check was case-sensitive (`noqa` but not `NOQA`).
  assert.equal(bySymbol(f, 'checks.py', 'Image'), undefined, 'uppercase # NOQA probe import must not be flagged');
  assert.equal(bySymbol(f, 'checks.py', '_Image2'), undefined, 'lowercase # noqa: F401 probe import must not be flagged');
  // Control: a genuinely unused import with no marker is still SAFE.
  assert.equal(bySymbol(f, 'checks.py', 'os').grade, 'SAFE');
  assert.equal(bySymbol(f, 'checks.py', 'os').category, 'import');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['import:checks.py:os']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('web py-try-import: an unused import inside try/except is an availability probe (FP-13)', () => {
  const f = loadFixture('py-try-import').findings;
  // Django FP-13: `try: import numpy` (contrib/gis/shortcuts.py) and
  // `try: from PIL import Image` (db/models/fields/files.py) exist to
  // test whether the dependency is installed; the import IS the use.
  // Without a `# NOQA` marker they are REVIEW, never SAFE — a leftover
  // optional import in a try block looks identical, so a human checks.
  assert.equal(bySymbol(f, 'probe.py', 'numpy').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'probe.py', 'Image').grade, 'REVIEW');
  // A try-wrapped import that IS referenced afterwards is live.
  assert.equal(bySymbol(f, 'probe.py', 'usedlib'), undefined, 'used try-wrapped import must not be flagged');
  // Control: a plain unused import with no try and no marker is SAFE.
  assert.equal(bySymbol(f, 'probe.py', 'deadlib').grade, 'SAFE');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['import:probe.py:deadlib']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
  assert.deepEqual(new Set(safe.map((s) => `${s.category}:${s.file}:${s.symbol}`)), expectedSafe);
});

test('web ts-e2e-spec: *.e2e-spec.ts / *.e2e-spec.js files are test files — KEEP, never SAFE', () => {
  const f = loadFixture('ts-e2e-spec').findings;
  // NestJS: 22 `sample/*/e2e/*.e2e-spec.ts` files were graded SAFE
  // although each sample runs them via its own vitest.config.e2e.mts
  // (`include: ['e2e/**/*.e2e-spec.ts']`, `test:e2e` script). The
  // `.e2e-spec.` suffix is a test-file marker like `.spec.` / `.test.`.
  for (const file of ['e2e/cats/cats.e2e-spec.ts', 'e2e/cats/cats.e2e-spec.js']) {
    // A test file is an entry point, so it is reachable and never gets
    // a file finding at all — the same as `*.spec.ts` / `*.test.ts`.
    assert.equal(byCategory(f, file, 'file'), undefined, `${file} is a test entry point, never a dead file`);
    assert.equal(bySymbol(f, file, 'unusedHelper').grade, 'KEEP', 'unused import in a test file is kept');
  }
  // The specs are entries, so the modules they import stay live.
  assert.equal(byCategory(f, 'src/cats/cats.module.ts', 'file'), undefined);
  assert.equal(byCategory(f, 'src/cats/cats.service.ts', 'file'), undefined);
  assert.equal(byCategory(f, 'src/cats/unused-helper.ts', 'file'), undefined);
  // The fix is filename-based, not directory-based: a non-spec file
  // under e2e/ and a plain unimported file are still dead.
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['file:e2e/helpers/seed-data.ts', 'file:src/orphan.ts']);
  assert.deepEqual(new Set(safe.map((s) => `${s.category}:${s.file}`)), expectedSafe);
});

test('web js-global-scripts: classic-script globals called from other classic scripts are live', () => {
  const f = loadFixture('js-global-scripts').findings;
  // core.js, widget.js and calls.js use no module system: the top-level
  // functions are page globals, and widget.js calls globalFn() by bare
  // name — a real call, so globalFn is live with no finding at all
  // (Django admin JS: quickElement in core.js, called from
  // SelectFilter2.js / calendar.js / DateTimeShortcuts.js).
  assert.equal(bySymbol(f, 'core.js', 'globalFn'), undefined, 'globalFn is called from widget.js and must not be flagged');
  // The template loads all three scripts, so no file is a dead file.
  assert.equal(byCategory(f, 'core.js', 'file').grade, 'REVIEW');
  assert.equal(byCategory(f, 'widget.js', 'file').grade, 'REVIEW');
  // Dead equivalents still grade SAFE: a global nothing calls, and a
  // name two classic scripts both define (the call in calls.js is
  // ambiguous and rescues neither definition).
  assert.equal(bySymbol(f, 'core.js', 'deadGlobal').grade, 'SAFE');
  assert.equal(bySymbol(f, 'core.js', 'clash').grade, 'SAFE');
  assert.equal(bySymbol(f, 'widget.js', 'clash').grade, 'SAFE');
  // A global constructed with `new` from another classic script is
  // live too: `new MemoryStats()` in use-stats.js constructs the
  // global defined in stats.js (vuejs/vue dbmon: monitor.js builds
  // `new MemoryStats()` from memory-stats.js). A constructor nothing
  // builds stays SAFE.
  assert.equal(bySymbol(f, 'stats.js', 'MemoryStats'), undefined, 'MemoryStats is constructed from use-stats.js and must not be flagged');
  assert.equal(bySymbol(f, 'stats.js', 'DeadStats').grade, 'SAFE');
  const safe = f.filter((x) => x.grade === 'SAFE');
  assert.deepEqual(new Set(safe.map((s) => `${s.category}:${s.file}:${s.symbol}`)), new Set([
    'function:core.js:deadGlobal',
    'function:core.js:clash',
    'function:widget.js:clash',
    'function:stats.js:DeadStats',
  ]));
});

test('web js-jsdoc-link: an import used only in a JSDoc {@link} is live', () => {
  const f = loadFixture('js-jsdoc-link').findings;
  // Same rule as the CLI: a {@link} / {@linkcode} target is a real
  // reference to the imported type (vuejs/vue types/options.d.ts).
  for (const symbol of ['ObjectDirective', 'FunctionDirective']) {
    assert.equal(bySymbol(f, 'src/options.ts', symbol), undefined, `${symbol} is linked from JSDoc and must not be flagged`);
  }
  // The genuinely dead imports are still found: one never mentioned
  // at all, and one mentioned only in a prose comment sentence.
  assert.equal(bySymbol(f, 'src/options.ts', 'UnusedDirective').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/options.ts', 'PlainMention').grade, 'SAFE');
});

test('web py-unittest: __unittest module attribute is KEEP, never SAFE', () => {
  // Django's contrib/messages/test.py sets `__unittest = True` so
  // unittest trims the module's frames from tracebacks: the test
  // runner reads the attribute, so it is never dead code. The file
  // here is deliberately NOT a test file (test.py would be KEEP
  // anyway) — the rule itself must keep the attribute.
  const f = analyzeFiles([
    { path: 'pkg/helpers.py', content: '# Make unittest ignore frames in this module when reporting failures.\n__unittest = True\n\n\nclass Mixin:\n    def check(self):\n        return True\n' },
    { path: 'pkg/dead.py', content: 'def _dead_helper():\n    return 1\n' },
  ]).findings;
  assert.equal(bySymbol(f, 'pkg/helpers.py', '__unittest').grade, 'KEEP', '__unittest is read by the test runner, never SAFE');
  // Precision: a genuinely dead private function next to it is still SAFE.
  assert.equal(bySymbol(f, 'pkg/dead.py', '_dead_helper').grade, 'SAFE');
});

test('web py-conditional-import: an import shadowed by a same-file definition is not dead', () => {
  const f = loadFixture('py-conditional').findings;
  // The version-gated import IS the public API on its branch
  // (Django's utils/copy.py): no dead-import finding for it, and the
  // backport definition is live through its importer.
  assert.equal(bySymbol(f, 'shim.py', 'replace'), undefined, 'the conditional import of replace is the alternate branch of the same public name');
  // Dead equivalents still grade SAFE: a plain unused import that
  // shares no name with a definition.
  assert.equal(bySymbol(f, 'shim.py', 'deepcopy').grade, 'SAFE');
  const safe = f.filter((x) => x.grade === 'SAFE');
  assert.ok(!safe.some((s) => s.category === 'import' && s.file === 'shim.py' && s.symbol === 'replace'), 'replace must never be SAFE');
});

/* ------------------------------------------------------------------ */
/* Java support (tree-sitter WASM, docs/parse-java-web.js)             */
/* ------------------------------------------------------------------ */

const { analyzeFilesAsync, javaFrameworkClassAnnotations } = require('../docs/analyzer');
const { parseJava } = require('../src/parse-java');
const javaWeb = require('../docs/parse-java-web');

function loadFixtureAsync(dir, options) {
  const base = path.join(ROOT, 'fixtures', dir);
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push({ path: path.relative(base, full).split(path.sep).join('/'), content: fs.readFileSync(full, 'utf8') });
    }
  })(base);
  return analyzeFilesAsync(files, options);
}

// The CLI's javaSafe:true findings for the Java fixtures, derived from
// src/index scan (see the batch-10 work notes). The web checker IS the
// opted-in surface, so it must match these exactly — same findings,
// same grades, same SAFE sets. The counts below are the CLI's own:
// java-basic 65 (16 SAFE / 36 REVIEW / 13 KEEP), arity 13 (2 / 11 / 0),
// policy 35 (7 / 20 / 8).
const JAVA_FIXTURE_EXPECTATIONS = {
  'java-basic': { total: 65, safe: 16, review: 36, keep: 13, safeKeys: new Set([
    'import:src/main/java/com/example/BasicService.java:Map',
    'import:src/main/java/com/example/BasicService.java:PI',
    'method:src/main/java/com/example/BasicService.java:constructor',
    'method:src/main/java/com/example/BasicService.java:deadMethod',
    'method:src/main/java/com/example/BasicService.java:documentedDead',
    'method:src/main/java/com/example/BasicService.java:format',
    'method:src/main/java/com/example/BasicService.java:privateStaticDead',
    'method:src/main/java/com/example/BasicService.java:recursiveMethod',
    'method:src/main/java/com/example/Modern.java:joinDead',
    'unreachable:src/main/java/com/example/BasicService.java',
    'variable:src/main/java/com/example/BasicService.java:deadCounter',
    'variable:src/main/java/com/example/BasicService.java:mixedDead',
    'variable:src/main/java/com/example/BasicService.java:multiA',
    'variable:src/main/java/com/example/BasicService.java:multiB',
    'variable:src/main/java/com/example/BasicService.java:unusedLabel',
    'variable:src/main/java/com/example/BasicService.java:unusedLocal',
  ]) },
  'java-batch10-arity': { total: 13, safe: 2, review: 11, keep: 0, safeKeys: new Set([
    'method:src/ArityComments.java:neverCalled',
    'method:src/CommentedArgs.java:constructor',
  ]) },
  'java-batch10-policy': { total: 35, safe: 7, review: 20, keep: 8, safeKeys: new Set([
    'method:src/NonUtilityCtor.java:constructor',
    'method:src/SerializationCallbacks.java:readObject',
    'method:src/SerializationCallbacks.java:writeReplace',
    'method:src/SideEffectLocals.java:constructor',
    'method:src/UtilityClass.java:helper',
    'variable:src/SideEffectLocals.java:deferred',
    'variable:src/SideEffectLocals.java:pure',
  ]) },
  'java-batch11-fields': { total: 8, safe: 2, review: 6, keep: 0, safeKeys: new Set([
    'variable:src/SideEffectFields.java:deferred',
    'variable:src/SideEffectFields.java:pure',
  ]) },
};

for (const [dir, expected] of Object.entries(JAVA_FIXTURE_EXPECTATIONS)) {
  test(`web ${dir}: analyzeFilesAsync matches the CLI (javaSafe:true) exactly`, async () => {
    const r = await loadFixtureAsync(dir);
    assert.equal(r.javaSkipped, false, 'the wasm parser must load for the fixture');
    assert.equal(r.summary.total, expected.total, `expected ${expected.total} findings, got ${r.summary.total}`);
    assert.equal(r.summary.safe, expected.safe, `expected ${expected.safe} SAFE, got ${r.summary.safe}`);
    assert.equal(r.summary.review, expected.review, `expected ${expected.review} REVIEW, got ${r.summary.review}`);
    assert.equal(r.summary.keep, expected.keep, `expected ${expected.keep} KEEP, got ${r.summary.keep}`);
    const safe = r.findings.filter((x) => x.grade === 'SAFE');
    assert.equal(safe.length, expected.safeKeys.size, `expected ${expected.safeKeys.size} SAFE findings, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.file}:${s.symbol || ''}`))}`);
    for (const s of safe) {
      const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
      assert.ok(expected.safeKeys.has(key), `unexpected SAFE finding (false positive): ${key}`);
    }
  });
}

test('web java: the web parser matches the CLI parser on every Java fixture', async () => {
  await javaWeb.initJava();
  // The vendored web traversal must not drift from src/parse-java.js:
  // this is the CI guard for checklist item 4 — a drift fails a test
  // instead of shipping a false SAFE. Compares the full
  // grading-relevant shape (definitions with every field the
  // confidence engine reads, references, calls, imports, strings,
  // unreachable, uses / usesArity, topLevelUses / topLevelUsesArity,
  // hasErrors, readCount / writeCount, stringMention).
  function normalise(r) {
    const def = (d) => {
      const o = {};
      for (const k of Object.keys(d).sort()) o[k] = d[k];
      if (Array.isArray(o.uses)) o.uses = [...o.uses].sort();
      if (Array.isArray(o.usesArity)) o.usesArity = [...o.usesArity].sort();
      if (Array.isArray(o.annotations)) o.annotations = [...o.annotations].sort();
      if (Array.isArray(o.classAnnotations)) o.classAnnotations = [...o.classAnnotations].sort();
      if (Array.isArray(o.decorators)) o.decorators = [...o.decorators].sort();
      return o;
    };
    return {
      language: r.language, hasErrors: r.hasErrors, imports: r.imports,
      definitions: r.definitions.map(def), references: [...r.references].sort(),
      calls: r.calls, strings: r.strings, unreachable: r.unreachable,
      decorators: [...r.decorators].sort(), topLevelUses: r.topLevelUses,
      topLevelUsesArity: r.topLevelUsesArity, dynamic: r.dynamic,
    };
  }
  const files = [];
  for (const dir of ['java-basic', 'java-batch10-arity', 'java-batch10-policy', 'java-batch11-fields', 'java-batch9-fj7']) {
    const base = path.join(ROOT, 'fixtures', dir);
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (full.endsWith('.java')) files.push(full);
      }
    })(base);
  }
  assert.ok(files.length > 0, 'Java fixture files must exist');
  let totalDefs = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const cli = normalise(parseJava(f, src));
    const web = normalise(javaWeb.parseJavaWeb(f, src));
    totalDefs += cli.definitions.length;
    assert.deepEqual(web, cli, `web parse must match CLI parse for ${path.relative(ROOT, f)}`);
  }
  assert.ok(totalDefs > 200, `expected 200+ definitions across the Java fixtures, got ${totalDefs}`);
});

test('web java: a broken Java file yields no findings', async () => {
  const broken = 'package broken;\npublic class Broken {\n  private void dead() {\n    int x = ;\n  }\n  private int alsoDead;\n}\n';
  const r = await analyzeFilesAsync([{ path: 'Broken.java', content: broken }]);
  assert.equal(r.javaSkipped, false, 'the parser loaded — the file itself is broken, not the parser');
  assert.equal(r.findings.length, 0, `a broken file must yield no findings at all, got: ${JSON.stringify(r.findings.map((x) => `${x.file}:${x.symbol || ''}`))}`);
});

test('web java: an import used only by an annotation is live, never SAFE', async () => {
  const r = await analyzeFilesAsync([{ path: 'Ann.java', content: `package com.example;

import com.fasterxml.jackson.annotation.JsonProperty;

public class Ann {
  @JsonProperty("label")
  private String labelled() {
    return "x";
  }

  private void deadPlain() {
  }
}
` }]);
  assert.equal(r.javaSkipped, false);
  assert.equal(bySymbol(r.findings, 'Ann.java', 'JsonProperty'), undefined, 'an import used only by an annotation must not be flagged');
  assert.equal(bySymbol(r.findings, 'Ann.java', 'labelled').grade, 'KEEP');
  assert.equal(bySymbol(r.findings, 'Ann.java', 'deadPlain').grade, 'SAFE');
});

test('web java: no wasm available degrades to skipped-Java (no SAFE)', async () => {
  const r = await loadFixtureAsync('java-basic', { javaInit: false });
  assert.equal(r.javaSkipped, true, 'javaInit:false must report Java as skipped');
  assert.ok(r.javaSkipReason.length > 0, 'the skip reason must be recorded for the UI');
  assert.equal(r.findings.filter((x) => x.grade === 'SAFE').length, 0,
    `degraded mode must find 0 SAFE, got: ${JSON.stringify(r.findings.filter((x) => x.grade === 'SAFE').map((x) => `${x.file}:${x.symbol || ''}`))}`);
  assert.equal(r.findings.filter((x) => x.file.endsWith('.java')).length, 0,
    'degraded mode must emit no findings for Java files at all');
});

test('web java: the sync analyzer still skips Java files (back-compat)', () => {
  const r = analyzeFiles([
    { path: 'A.java', content: 'public class A {\n  private void dead() {}\n}\n' },
    { path: 'b.js', content: 'function deadJs() { return 1; }\n' },
  ]);
  assert.equal(r.javaSkipped, true, 'sync analyzeFiles must report Java as skipped');
  assert.equal(r.findings.filter((x) => x.file.endsWith('.java')).length, 0, 'sync analyzeFiles must emit no Java findings');
  assert.equal(bySymbol(r.findings, 'b.js', 'deadJs').grade, 'SAFE', 'JS grading is unchanged by the Java skip');
});

test('web java: framework stereotype lists match the packs', () => {
  // docs/analyzer.js inlines the union of the hardcoded fallback in
  // src/parse-java.js FRAMEWORK_CLASS_ANNOTATIONS plus the
  // keepClassAnnotations of frameworks/spring.json and
  // frameworks/jackson-jpa.json. If a pack gains a stereotype, this
  // test fails until the inline list is regenerated.
  const packs = ['spring.json', 'jackson-jpa.json'];
  for (const file of packs) {
    const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'frameworks', file), 'utf8'));
    for (const ann of pack.keepClassAnnotations || []) {
      assert.ok(javaFrameworkClassAnnotations.has(ann), `keepClassAnnotations entry ${ann} from ${file} must be in the web stereotype set`);
    }
  }
  for (const ann of javaWeb.FRAMEWORK_CLASS_ANNOTATIONS) {
    assert.ok(javaFrameworkClassAnnotations.has(ann), `hardcoded stereotype ${ann} from parse-java-web.js must be in the web stereotype set`);
  }
});

test('web java: framework pack data matches frameworks/*.json', () => {
  // The keepExports / keepNames / keepDecorators maps inlined in
  // docs/analyzer.js must be the union of every pack, first pack in
  // filename order winning a key — rebuild them here and compare.
  const analyzer = require('../docs/analyzer');
  const expectedExports = Object.create(null);
  const expectedNames = Object.create(null);
  const expectedDecorators = [];
  const seenDecorators = new Set();
  for (const file of fs.readdirSync(path.join(ROOT, 'frameworks')).sort()) {
    if (!file.endsWith('.json')) continue;
    const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'frameworks', file), 'utf8'));
    for (const n of pack.keepExports || []) if (!expectedExports[n]) expectedExports[n] = file;
    for (const n of pack.keepNames || []) if (!expectedNames[n]) expectedNames[n] = file;
    for (const d of pack.keepDecorators || []) {
      if (!seenDecorators.has(d)) { seenDecorators.add(d); expectedDecorators.push([d, file]); }
    }
  }
  assert.deepEqual(analyzer.javaPackKeepExports, expectedExports, 'keepExports map must match the packs');
  assert.deepEqual(analyzer.javaPackKeepNames, expectedNames, 'keepNames map must match the packs');
  assert.deepEqual(analyzer.javaPackKeepDecoratorsList, expectedDecorators, 'keepDecorators list must match the packs in CLI iteration order');
});

test('web manual-script: symbols under scripts/ or tools/ are KEEP, never SAFE', async () => {
  // Mirrors isManualScriptPath in src/discover.js: a file under a
  // scripts/ or tools/ directory is a manually-run tool the operator
  // invokes by hand, so its symbols cannot be proven dead. The
  // junit5 bench surfaced this: the CLI KEEPs 79 symbols under
  // documentation/src/tools/java/, while the web emitted nothing.
  const r = await analyzeFilesAsync([
    { path: 'tools/audit.js', content: 'function auditAll() { return 1; }\n' },
    { path: 'scripts/seed.py', content: 'def seed_all():\n    return 1\n' },
    { path: 'documentation/src/tools/java/Report.java', content: 'public class Report {\n  private void deadHelper() {\n  }\n}\n' },
    // A dead file under scripts/ is an entry point, never a dead file.
    { path: '.github/scripts/release.js', content: 'function release() { return 1; }\n' },
  ]);
  assert.equal(r.javaSkipped, false);
  assert.equal(bySymbol(r.findings, 'tools/audit.js', 'auditAll').grade, 'KEEP');
  assert.equal(bySymbol(r.findings, 'scripts/seed.py', 'seed_all').grade, 'KEEP');
  const javaKeep = bySymbol(r.findings, 'documentation/src/tools/java/Report.java', 'deadHelper');
  assert.equal(javaKeep.grade, 'KEEP', 'a private dead method in a tools/ Java file is KEEP, not SAFE');
  assert.ok(javaKeep.reason.indexOf('manually-run script') >= 0, `reason must name the manual-script rule, got: ${javaKeep.reason}`);
  assert.equal(r.findings.filter((x) => x.category === 'file' && x.file === '.github/scripts/release.js').length, 0,
    'a script under scripts/ is an entry point, never a dead file');
  assert.equal(r.findings.filter((x) => x.grade === 'SAFE').length, 0, 'no SAFE may come out of a manual-script file');
});

test('web hidden-dirs: files under hidden directories are never scanned, except .github', () => {
  // Port of src/discover.js: the CLI's walker skips every directory
  // whose name starts with '.', except .github — a changeset config,
  // an IDE directory, or a docs-site build directory is not repo
  // code. The web used to scan them, so sveltejs-kit's
  // .changeset/changelog.js (loaded by the changesets CLI, never
  // imported) looked like a dead export and went SAFE once the
  // exported rule was narrowed to app-kind files. A hidden FILE in a
  // visible directory is still scanned, exactly as in the CLI, which
  // skips hidden directories only.
  const r = analyzeFiles([
    { path: '.changeset/changelog.js', content: 'export function getReleaseLine() { return ""; }\n' },
    { path: 'docs/.vitepress/theme/x.js', content: 'export function helper() { return 1; }\n' },
    { path: '.github/scripts/release.js', content: 'function release() { return 1; }\n' },
    { path: '.eslintrc.cjs', content: 'export function lint() { return 1; }\n' },
  ]);
  assert.equal(r.findings.filter((x) => x.file === '.changeset/changelog.js').length, 0, '.changeset/ is never scanned');
  assert.equal(r.findings.filter((x) => x.file === 'docs/.vitepress/theme/x.js').length, 0, '.vitepress/ is never scanned');
  assert.ok(r.findings.some((x) => x.file === '.github/scripts/release.js'), '.github/ is scanned');
  assert.ok(r.findings.some((x) => x.file === '.eslintrc.cjs'), 'a hidden file in a visible directory is scanned');
});

test('web root-pkg: the dead-dependency check reads the root package.json, not a nested one', () => {
  // The CLI's discover reads the root manifest. The web used to take
  // the first package.json in input order, so a nested docs/ package
  // (listed first) made its own dependencies look like repo
  // dependencies — axios's docs-only @splidejs/splide was flagged
  // REVIEW once the hidden-dir skip removed the .vitepress string
  // mention that used to save it. The shallowest manifest wins now,
  // whatever order the files arrive in.
  const docsPkg = JSON.stringify({ name: 'docs', dependencies: { '@splidejs/splide': '^4.1.4' } });
  const rootPkg = JSON.stringify({ name: 'axios', version: '1.0.0', dependencies: { formdata: '^1.0.0' } });
  const r = analyzeFiles([
    { path: 'docs/package.json', content: docsPkg },
    { path: 'package.json', content: rootPkg },
    { path: 'lib/index.js', content: "import FormData from 'formdata';\nconsole.log(FormData);\n" },
  ]);
  assert.equal(r.findings.filter((x) => x.category === 'dependency' && x.symbol === '@splidejs/splide').length, 0,
    'a docs-only dependency is not a repo dependency');
  assert.equal(r.findings.filter((x) => x.category === 'dependency' && x.symbol === 'formdata').length, 0,
    'an imported root dependency is not flagged');
});

const { parsePy } = require('../docs/analyzer');

// --- batch 13: string annotations in nested / multi-line positions ---

test('web batch13 (py): a string nested in a generic is a use of the type', () => {
  // The typer shapes: `ctx: Union["Context", None]` (single-line def)
  // and `cls: type["TyperCommand"]` (multi-line def). The old per-line
  // regex only saw a string directly after `:` or `->`, so these
  // imports looked dead.
  const single = parsePy('gate.py', [
    'from typing import Union',
    'from ._types import Context',
    'def f(ctx: Union["Context", None]) -> str:',
    '    return ""',
    '',
    'f(None)',
  ].join('\n'));
  assert.ok(single.references.has('Context'), 'Union["Context", None] names a real type');
  assert.ok(single.bareReferences.includes('Context'), 'the annotation string is a bare reference too');

  const multi = parsePy('gate.py', [
    'from ._types import TyperCommand',
    'class C:',
    '    def __init__(self, *, cls: type["TyperCommand"] | None = None):',
    '        self.cls = cls',
    '',
    'C()',
  ].join('\n'));
  assert.ok(multi.references.has('TyperCommand'), 'type["TyperCommand"] on a def continuation line names a real type');
  assert.ok(multi.bareReferences.includes('TyperCommand'), 'the annotation string is a bare reference too');
});

test('web batch13 (py): a string annotation spread over lines is a use', () => {
  // A Callable annotation whose list["CompletionItem"] sits on its own
  // line, and a return annotation that spans lines — both are
  // annotation position, even though no `:` precedes the string.
  const callable = parsePy('gate.py', [
    'from typing import Callable',
    'from ._types import CompletionItem',
    'def register(',
    '    shell_complete: Callable[',
    '        [str],',
    '        list["CompletionItem"] | list[str],',
    '    ]',
    '    | None = None,',
    ') -> None:',
    '    return None',
    '',
    'register()',
  ].join('\n'));
  assert.ok(callable.references.has('CompletionItem'), 'list["CompletionItem"] inside a multi-line Callable names a real type');

  const ret = parsePy('gate.py', [
    'from ._types import Typer',
    'def make() -> list[',
    '    "Typer"',
    ']:',
    '    return []',
    '',
    'make()',
  ].join('\n'));
  assert.ok(ret.references.has('Typer'), 'a return annotation that spans lines names a real type');

  const varAnn = parsePy('gate.py', [
    'from typing import Optional',
    'from ._types import Typer',
    'handler: Optional["Typer"] = None',
    '',
    'print(handler)',
  ].join('\n'));
  assert.ok(varAnn.references.has('Typer'), 'Optional["Typer"] in a variable annotation names a real type');
});

test('web batch13 (py): a string outside annotation position is not a use', () => {
  // The narrowness controls: a default string value, a docstring, an
  // error message, and prose inside Doc("...") in an annotation must
  // never keep a dead import alive — only the annotation span counts.
  const parsed = parsePy('gate.py', [
    'from typing import Annotated',
    'from ._types import DeadAsDefault, DeadInDocstring, DeadInMessage, Widget',
    'def Doc(text):',
    '    return text',
    '',
    'def pick(mode="DeadAsDefault"):',
    '    return mode',
    '',
    'def describe():',
    '    """DeadInDocstring is mentioned here, and nowhere else."""',
    '    return 1',
    '',
    'def fail():',
    '    raise ValueError("DeadInMessage failed")',
    '',
    'def show(item: Annotated[str, Doc("Widget is only prose")]) -> str:',
    '    return item',
    '',
    'pick()',
    'describe()',
    'show("x")',
  ].join('\n'));
  for (const name of ['DeadAsDefault', 'DeadInDocstring', 'DeadInMessage', 'Widget']) {
    assert.ok(!parsed.references.has(name), `${name} must not count as a reference`);
    assert.ok(!parsed.bareReferences.includes(name), `${name} must not count as a bare reference`);
  }
});

test('web batch13 (py): a TypeVar definition is flagged on the definition, not by name', () => {
  const parsed = parsePy('gate.py', [
    'from typing import TypeVar',
    'import typing',
    '',
    'if TYPE_CHECKING:',
    '    GrpType = TypeVar("GrpType", bound=int)',
    '    OtherType = typing.TypeVar("OtherType")',
    '',
    '_HiddenType = TypeVar("_HiddenType")',
    '_dead_count = 0',
    '',
    'def main():',
    '    return 1',
    '',
    'main()',
  ].join('\n'));
  const def = (name) => parsed.definitions.find((d) => d.name === name);
  assert.equal(def('GrpType').typeVar, true, 'TypeVar(...) marks the definition');
  assert.equal(def('OtherType').typeVar, true, 'typing.TypeVar(...) marks the definition');
  assert.equal(def('_HiddenType').typeVar, true, 'a top-level TypeVar marks the definition');
  assert.equal(def('_dead_count').typeVar, false, 'a plain value is not a TypeVar');
});

test('web batch13 py-string-annotation: live imports are never flagged, dead controls are SAFE', () => {
  const f = loadFixture('py-batch13-string-annotation').findings;
  for (const symbol of ['Context', 'CompletionItem', 'Typer', 'TyperCommand', 'TyperGroup']) {
    assert.equal(bySymbol(f, 'main.py', symbol), undefined, `${symbol} is used only in a string annotation and must not be flagged`);
  }
  for (const symbol of ['DeadAsDefault', 'DeadInDocstring', 'DeadInMessage', 'Widget']) {
    assert.equal(bySymbol(f, 'main.py', symbol).grade, 'SAFE', `${symbol} appears only outside annotation position and must still be found SAFE`);
  }
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'import:main.py:DeadAsDefault', 'import:main.py:DeadInDocstring',
    'import:main.py:DeadInMessage', 'import:main.py:Widget',
  ]);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
  assert.equal(safe.length, expectedSafe.size, `expected ${expectedSafe.size} SAFE findings, got ${safe.length}`);
});

test('web batch13 py-typevar: TypeVars are REVIEW, plain dead values stay SAFE', () => {
  const f = loadFixture('py-batch13-typevar').findings;
  assert.equal(bySymbol(f, 'main.py', 'GrpType'), undefined, 'GrpType is used in a string annotation and must not be flagged');
  assert.equal(bySymbol(f, 'main.py', 'OtherType').grade, 'REVIEW', 'an unreferenced typing.TypeVar is REVIEW, never SAFE');
  assert.equal(bySymbol(f, 'main.py', '_HiddenType').grade, 'REVIEW', 'an unreferenced top-level TypeVar is REVIEW, never SAFE');
  assert.equal(bySymbol(f, 'main.py', '_dead_count').grade, 'SAFE', 'a plain dead value stays SAFE');
  assert.equal(bySymbol(f, 'main.py', '_dead_factory').grade, 'SAFE', 'a dead value with an ordinary call initializer stays SAFE — the rule is specific to TypeVar');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['variable:main.py:_dead_count', 'variable:main.py:_dead_factory']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
  assert.equal(safe.length, expectedSafe.size, `expected ${expectedSafe.size} SAFE findings, got ${safe.length}`);
});
