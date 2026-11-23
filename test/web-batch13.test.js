'use strict';

/**
 * Batch 13: fix five web-only SAFE false positives in the web
 * analyzer (docs/analyzer.js) — four named function-expression
 * callbacks on axios, one chained-call continuation line on umami.
 *
 * (1) Named function expressions. The web regex recorded any line
 * starting with `function name(` as a function declaration, including
 * a named function expression passed as a callback on its own line
 * (`settle(\n function _resolve...`, axios lib/adapters/xhr.js).
 * The CLI's tree-sitter parser records function_declaration nodes
 * only, never function_expression (src/parse-js.js) — and the name
 * of a named function expression is visible only inside itself, so
 * it can never be referenced from outside. The fix separates the
 * two by grammar: a `function name(` line inside an open paren or
 * bracket, or after a previous line that continues an expression,
 * is an expression, not a declaration. Either signal only ever
 * SKIPS a definition — a missed declaration is a false negative,
 * never a false positive.
 *
 * (2) Chained-call continuation. A return value continuing on the
 * next line with a computed member access (`return colord(x)` /
 * `[theme ...](...)`, umami WorldMap.tsx getFillColor) is one
 * expression, but the web unreachable pass treated the `[` line as
 * a new statement after the return and flagged it SAFE. The fix
 * treats a `[` line as a continuation of the expression above —
 * unless the previous line ends with `;`, which ends the statement
 * and makes the `[` a fresh array literal (genuinely unreachable
 * after a terminator, still flagged).
 *
 * These tests use the fixture directories
 * fixtures/js-batch13-named-callback and
 * fixtures/js-batch13-chain-call (hand-written, not copied from any
 * repo) and assert web/CLI agreement on them: the two analyzers
 * must produce the same findings (grade, category, file, symbol,
 * line) for every planted item.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scan } = require('../src/index');
const { analyzeFiles, parseJs } = require('../docs/analyzer');

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

function webFindings(dir) {
  return loadFixture(dir).findings;
}

function cliFindings(dir) {
  return scan(path.join(ROOT, 'fixtures', dir)).findings;
}

function bySymbol(findings, file, symbol, grade) {
  return findings.find((f) => f.file.endsWith(file) && f.symbol === symbol && (!grade || f.grade === grade));
}

// --- parser level: named function expressions -------------------------

test('named-callback (js): a named function expression passed as a callback is not a definition', () => {
  const parsed = parseJs('probe.js', [
    'function settle(onResolve, onReject, value) {',
    '  if (value) onResolve(value); else onReject(new Error());',
    '}',
    'function runJob(input) {',
    '  settle(',
    '    function _resolve(value) {',
    '      return value;',
    '    },',
    '    function _reject(err) {',
    '      throw err;',
    '    },',
    '    input,',
    '  );',
    '  return Promise.resolve(input).then(',
    '    function onFulfilled(value) {',
    '      return value;',
    '    },',
    '    function onRejected(reason) {',
    '      throw reason;',
    '    },',
    '  );',
    '}',
    'runJob({});',
  ].join('\n'));
  for (const name of ['_resolve', '_reject', 'onFulfilled', 'onRejected']) {
    assert.equal(parsed.definitions.find((d) => d.name === name), undefined, `the callback ${name} must not be recorded as a definition`);
    assert.ok(!parsed.calls.has(name), `the ${name}( signature must not be read as a call`);
    assert.ok(!parsed.bareReferences.includes(name), `the ${name} signature must not be read as a bare reference`);
  }
  assert.ok(parsed.definitions.find((d) => d.name === 'settle'), 'the settle declaration is still a definition');
  assert.ok(parsed.definitions.find((d) => d.name === 'runJob'), 'the runJob declaration is still a definition');
});

test('named-callback (js): forEach, async, and `=`-continuation callback shapes are expressions too', () => {
  const parsed = parseJs('probe.js', [
    'function applyHeaders(headers, target) {',
    '  Object.keys(headers).forEach(',
    '    function setHeader(key) {',
    '      target.set(key, headers[key]);',
    '    },',
    '  );',
    '}',
    'function checkAsync(run) {',
    '  return run(',
    '    async function stackCheck() {',
    '      return true;',
    '    },',
    '  );',
    '}',
    'function lazyFn() {',
    '  const f =',
    '    function namedLazy() {',
    '      return 1;',
    '    };',
    '  return f();',
    '}',
    'applyHeaders({}, new Map()); checkAsync((fn) => fn()); lazyFn();',
  ].join('\n'));
  for (const name of ['setHeader', 'stackCheck', 'namedLazy']) {
    assert.equal(parsed.definitions.find((d) => d.name === name), undefined, `the callback ${name} must not be recorded as a definition`);
  }
  for (const name of ['applyHeaders', 'checkAsync', 'lazyFn']) {
    assert.ok(parsed.definitions.find((d) => d.name === name), `the ${name} declaration is still a definition`);
  }
  assert.ok(parsed.definitions.find((d) => d.name === 'f'), 'the const f binding is still a definition');
});

test('named-callback (js): real declarations after `{`, `)`, and `;` are still definitions', () => {
  const parsed = parseJs('probe.js', [
    'function top() { return 1; }',
    'if (true) {',
    '  function inBlock() { return 2; }',
    '}',
    'if (false)',
    '  function bracelessBody() { return 3; }',
    'const x = 1;',
    'function afterSemicolon() { return 4; }',
    'top(); inBlock(); bracelessBody(); afterSemicolon();',
  ].join('\n'));
  for (const name of ['top', 'inBlock', 'bracelessBody', 'afterSemicolon']) {
    assert.ok(parsed.definitions.find((d) => d.name === name), `the ${name} declaration must still be recorded`);
  }
});

test('named-callback (js): a complete assignment ending in a string or regex does not hide the next declaration', () => {
  // Semicolonless style (vue2 class-util.ts): blanking the regex
  // literal left a dangling `=` in the stripped line, which misread
  // the complete assignment as a continuation and hid `addClass`.
  // The previous-line check reads the raw line, where the literal
  // itself ends the line. The same guard covers a string RHS, a
  // regex RHS, a `++` statement, and a TypeScript non-null
  // assertion — none of them continues an expression.
  const parsed = parseJs('probe.js', [
    'const whitespaceRE = /\\s+/',
    '',
    '/**',
    ' * Add class with compatibility for SVG.',
    ' */',
    'export function addClass(el, cls) {',
    '  return el;',
    '}',
    'const re2 = /\\d+/',
    'function afterRegex() { return 4; }',
    "const greeting = 'hello'",
    'function afterString() { return 1; }',
    'let count = 0',
    'count++',
    'function afterIncrement() { return 2; }',
    'const el = document.body',
    'el!',
    'function afterNonNull() { return 3; }',
    'addClass({}, 1); afterRegex(); afterString(); afterIncrement(); afterNonNull();',
  ].join('\n'));
  for (const name of ['addClass', 'afterRegex', 'afterString', 'afterIncrement', 'afterNonNull']) {
    assert.ok(parsed.definitions.find((d) => d.name === name), `the ${name} declaration must still be recorded`);
  }
});

test('named-callback (js): a declaration inside a callback body is a declaration, not an argument', () => {
  // The call's paren stays open for the whole callback body, so a
  // paren-depth count misread every declaration inside it as an
  // expression (vue2 types/test/v3/define-component-test.tsx:
  // `function install` inside `describe('...', () => { ... })`).
  // Only the innermost unclosed bracket — the body's `{` — decides.
  const parsed = parseJs('probe.js', [
    "describe('x', () => {",
    '  const comp = {};',
    '  function install(app) {',
    '    return app;',
    '  }',
    '  function nested() { return 1; }',
    '});',
    "describe('y', () => {});",
  ].join('\n'));
  const install = parsed.definitions.find((d) => d.name === 'install');
  assert.ok(install, 'a declaration inside a callback body must still be recorded');
  assert.equal(install.local, true, 'a declaration inside a callback body is a local');
  assert.ok(parsed.definitions.find((d) => d.name === 'nested'), 'a second declaration in the same body must still be recorded');
});

test('named-callback (js): a TypeScript return type `void` does not hide the next declaration', () => {
  // A line ending with `): void` is a .d.ts overload signature, not
  // a unary `void` operator — the next declaration must be recorded.
  // (A generic declaration, `expectType<T>(...)`, is not matched by
  // the web function regex at all — a pre-existing gap, out of scope
  // for this batch — so it is not asserted here.)
  const parsed = parseJs('probe.d.ts', [
    'export function describe(_name: string, _fn: () => void): void',
    'export function test(_name: string, _fn: () => any): void',
  ].join('\n'));
  for (const name of ['describe', 'test']) {
    assert.ok(parsed.definitions.find((d) => d.name === name), `the ${name} .d.ts declaration must still be recorded`);
  }
});

test('named-callback (js): locals inside a named-expression callback body are still locals', () => {
  const parsed = parseJs('probe.js', [
    'function outer() {',
    '  settle(',
    '    function _resolve(value) {',
    '      const inner = value;',
    '      return inner;',
    '    },',
    '    function _reject(err) {',
    '      const errInner = err;',
    '      return errInner;',
    '    },',
    '    null,',
    '  );',
    '}',
    'outer();',
  ].join('\n'));
  assert.equal(parsed.definitions.find((d) => d.name === '_resolve'), undefined, 'the callback name is not a definition');
  assert.equal(parsed.definitions.find((d) => d.name === 'inner').local, true, 'a variable inside the callback body is a local');
  assert.equal(parsed.definitions.find((d) => d.name === 'errInner').local, true, 'a variable inside the second callback body is a local');
});

// --- parser level: chained-call continuation --------------------------

test('chain-call (js): a `[` continuation line after a return is not unreachable', () => {
  const parsed = parseJs('probe.js', [
    'function getFillColor(code, theme) {',
    "  if (code === 'AQ') return;",
    '  const found = code !== 1;',
    '  if (!found) {',
    "    return '#ccc';",
    '  }',
    '  return colorOf(code)',
    "    [theme === 'light' ? 'lighten' : 'darken'](0.4)",
    '    .toHex();',
    '}',
    'function getTint(palette, theme) {',
    '  const base = palette;',
    '  return base',
    "    [theme === 'light' ? 'lighten' : 'darken'](0.4)",
    '    .toHex();',
    '}',
    'function colorOf(code) { return {}; }',
    'getFillColor(1, 2); getTint({}, 2);',
  ].join('\n'));
  assert.deepEqual(parsed.unreachable, [], 'the `[` lines are part of the return expressions, not new statements');
});

test('chain-call (js): a `[` line after a return that ends with `;` is still unreachable', () => {
  const parsed = parseJs('probe.js', [
    'function deadChain(flag) {',
    '  if (flag) {',
    '    return;',
    '    [1, 2].forEach((n) => n);',
    '  }',
    '  return 0;',
    '}',
    'deadChain(true);',
  ].join('\n'));
  assert.equal(parsed.unreachable.length, 1, 'the array-literal statement after `return;` is genuinely unreachable');
  assert.equal(parsed.unreachable[0].line, 4, 'the unreachable line is the `[` line');
});

// --- scan level: named-callback fixture --------------------------------

test('named-callback (js): callback names are never flagged', () => {
  const f = webFindings('js-batch13-named-callback');
  for (const symbol of ['_resolve', '_reject', 'onFulfilled', 'onRejected', 'setHeader', 'stackCheck', 'namedLazy']) {
    assert.equal(bySymbol(f, 'src/callbacks.js', symbol), undefined, `${symbol} must not be flagged at all`);
  }
});

test('named-callback (js): the dead declaration control is SAFE, live declarations are not flagged', () => {
  const f = webFindings('js-batch13-named-callback');
  assert.equal(bySymbol(f, 'src/callbacks.js', 'deadHandler', 'SAFE').grade, 'SAFE', 'a real declaration that nothing calls is still found SAFE');
  assert.equal(bySymbol(f, 'src/callbacks.js', 'deadHandler', 'SAFE').startLine, 76, 'the SAFE deadHandler is the declaration on line 76');
  for (const symbol of ['settle', 'runJob', 'applyHeaders', 'checkAsync', 'lazyFn', 'liveHandler', 'runAll']) {
    assert.equal(bySymbol(f, 'src/callbacks.js', symbol), undefined, `${symbol} must not be flagged`);
  }
});

test('named-callback (js): SAFE false-positive rate is 0% on the fixture', () => {
  const f = webFindings('js-batch13-named-callback');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['function:src/callbacks.js:deadHandler']);
  assert.equal(safe.length, expectedSafe.size, `expected ${expectedSafe.size} SAFE finding, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.file}:${s.symbol || ''}`))}`);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

// --- scan level: chain-call fixture ------------------------------------

test('chain-call (js): the chained return values are never flagged unreachable', () => {
  const f = webFindings('js-batch13-chain-call');
  for (const symbol of ['getFillColor', 'getTint', 'colorOf']) {
    assert.equal(bySymbol(f, 'src/chain.js', symbol), undefined, `${symbol} must not be flagged`);
  }
  assert.equal(f.filter((x) => x.category === 'unreachable' && x.file.endsWith('src/chain.js') && x.startLine < 40).length, 0, 'no unreachable finding in the live chain functions');
});

test('chain-call (js): genuinely unreachable code after a return is still SAFE', () => {
  const f = webFindings('js-batch13-chain-call');
  const unreach = f.filter((x) => x.category === 'unreachable' && x.file.endsWith('src/chain.js'));
  assert.equal(unreach.length, 2, `expected 2 unreachable SAFE findings, got ${unreach.length}: ${JSON.stringify(unreach.map((u) => u.startLine))}`);
  for (const u of unreach) assert.equal(u.grade, 'SAFE', 'genuinely unreachable code is SAFE');
  assert.deepEqual(unreach.map((u) => u.startLine).sort((a, b) => a - b), [44, 53], 'the flagged lines are the plain statement and the `[` line after `return;`');
  assert.equal(bySymbol(f, 'src/chain.js', 'deadAfterReturn', 'REVIEW').grade, 'REVIEW', 'an exported function holding unreachable code is REVIEW at most');
  assert.equal(bySymbol(f, 'src/chain.js', 'deadChainAfterReturn', 'REVIEW').grade, 'REVIEW', 'an exported function holding unreachable code is REVIEW at most');
});

test('chain-call (js): SAFE false-positive rate is 0% on the fixture', () => {
  const f = webFindings('js-batch13-chain-call');
  const safe = f.filter((x) => x.grade === 'SAFE');
  assert.equal(safe.length, 2, `expected 2 SAFE findings, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.file}:${s.symbol || ''}:${s.startLine}`))}`);
  for (const s of safe) {
    assert.equal(s.category, 'unreachable', 'the only SAFE findings are the unreachable controls');
    assert.ok(s.file.endsWith('src/chain.js'), 'the only SAFE findings are in src/chain.js');
  }
});

// --- web / CLI agreement ----------------------------------------------

test('named-callback (js): web and CLI agree exactly on the fixture', () => {
  const web = webFindings('js-batch13-named-callback');
  const cli = cliFindings('js-batch13-named-callback');
  const key = (f) => `${f.grade}|${f.category}|${f.file}|${f.symbol || ''}|${f.startLine}`;
  const webKeys = web.map(key).sort();
  const cliKeys = cli.map(key).sort();
  assert.deepEqual(webKeys, cliKeys, `web/CLI finding sets must match exactly.\nweb-only: ${JSON.stringify(webKeys.filter((k) => !cliKeys.includes(k)))}\ncli-only: ${JSON.stringify(cliKeys.filter((k) => !webKeys.includes(k)))}`);
});

test('chain-call (js): web and CLI agree exactly on the fixture', () => {
  const web = webFindings('js-batch13-chain-call');
  const cli = cliFindings('js-batch13-chain-call');
  const key = (f) => `${f.grade}|${f.category}|${f.file}|${f.symbol || ''}|${f.startLine}`;
  const webKeys = web.map(key).sort();
  const cliKeys = cli.map(key).sort();
  assert.deepEqual(webKeys, cliKeys, `web/CLI finding sets must match exactly.\nweb-only: ${JSON.stringify(webKeys.filter((k) => !cliKeys.includes(k)))}\ncli-only: ${JSON.stringify(cliKeys.filter((k) => !webKeys.includes(k)))}`);
});
