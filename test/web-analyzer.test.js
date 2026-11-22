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
  assert.equal(bySymbol(f, 'src/index.js', 'handler').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/index.js', 'wired').grade, 'REVIEW');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['function:src/index.js:render', 'function:src/index.js:named']);
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
  // symbols defined after it are found — parseHeaders is REVIEW
  // (exported, never called from outside), while normalizeHeader and
  // parseTokens are alive through same-file calls.
  const alone = analyzeFiles([{ path: 'src/headers.js', content: headers }]);
  assert.equal(bySymbol(alone.findings, 'src/headers.js', 'parseHeaders').grade, 'REVIEW');
  assert.equal(bySymbol(alone.findings, 'src/headers.js', 'normalizeHeader'), undefined);
  assert.equal(bySymbol(alone.findings, 'src/headers.js', 'parseTokens'), undefined);
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

test('web py-reexports: redundant aliases, noqa imports and compat shims are re-exports', () => {
  const f = loadFixture('py-reexports').findings;
  assert.equal(bySymbol(f, 'pkg/helpers.py', 'assist'), undefined, 'helpers.assist is used through the package');
  assert.equal(byCategory(f, 'pkg/helpers.py', 'file'), undefined, 'a re-exported module is not a dead file');
  for (const symbol of ['json', 'socket', 'OrderedDict', 'urlparse']) {
    assert.equal(bySymbol(f, 'pkg/compat.py', symbol), undefined, `${symbol} in a compat shim is a re-export, never a dead import`);
  }
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
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
