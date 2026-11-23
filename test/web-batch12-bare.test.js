'use strict';

/**
 * Batch 12: port the CLI's bare-reference local rule to the web
 * analyzer (docs/analyzer.js) for JavaScript/TypeScript.
 *
 * The CLI records `bareReferences` (bare identifier reads only —
 * never a member/property name, never a property definition site)
 * and grades a local definition on that: a member call `obj.foo()`
 * names the member, not the local `foo`, so a dead local named after
 * a called method is found instead of being swallowed by the old
 * name-keyed same-file flag. A bare call `foo()` still counts, via
 * the bare-call channel (`bareCalls`: a bare call only, never
 * `obj.foo()`). A getter/setter is invoked by property access, so an
 * accessor keeps the old flag (`ctx.slots` runs `get slots()`). And
 * a non-exported VARIABLE local gets no cross-file importer/caller
 * credit — a nested variable cannot be imported or called by name
 * from another file, so credit under the same name belongs to a
 * same-named top-level symbol instead. Function and method locals
 * keep their cross-file credit: they can escape through a returned
 * object and be called cross-file as members.
 *
 * The grading rule is keyed on `parsed.bareReferences` being an
 * array, not on language, so the Python parse layer plugs in with no
 * further grading change; a parse without the bare channel falls back
 * to the old name-based flag (fail open).
 *
 * These tests use the fixture directory fixtures/js-batch12-bare
 * (hand-written, not copied from any repo) and assert web/CLI
 * agreement on it: the two analyzers must produce the same findings
 * (grade, category, file, symbol, line) for every planted item.
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

// --- parser level: bareReferences -------------------------------------

test('bare (js): a member call is not a bare reference to a same-named local', () => {
  const parsed = parseJs('probe.js', [
    'const obj = { foo() { return 1; } };',
    'function outer() {',
    '  const foo = 42;',
    '  return obj.foo();',
    '}',
    'outer();',
  ].join('\n'));
  assert.ok(parsed.references.has('foo'), 'the flat reference set still records the member name');
  assert.ok(!parsed.bareReferences.includes('foo'), 'obj.foo() must not count as a bare read of a local foo');
  assert.ok(parsed.bareReferences.includes('obj'), 'the member-call object itself is a bare read');
  assert.ok(parsed.bareReferences.includes('outer'), 'a bare call is a bare read');
  assert.ok(parsed.calls.has('foo'), 'the flat call set still records the member call');
  assert.ok(!parsed.bareCalls.has('foo'), 'obj.foo() must not count as a bare call of a local foo');
  assert.ok(parsed.bareCalls.has('outer'), 'a bare call is a bare call');
});

test('bare (js): a bare call, a bare read, and a shorthand property are bare references', () => {
  const parsed = parseJs('probe.js', [
    'function outer() {',
    '  const foo = 42;',
    '  function bar() { return 1; }',
    '  return foo + bar() + ({ foo }).foo;',
    '}',
    'outer();',
  ].join('\n'));
  assert.ok(parsed.bareReferences.includes('foo'), 'a bare read counts');
  assert.ok(parsed.bareReferences.includes('bar'), 'a bare call counts');
  assert.ok(parsed.bareCalls.has('bar'), 'a bare call is a bare call');
  const shorthand = parseJs('probe.js', [
    'function outer() {',
    '  const foo = 42;',
    '  return { foo };',
    '}',
    'outer();',
  ].join('\n'));
  assert.ok(shorthand.bareReferences.includes('foo'), 'a shorthand property { foo } reads the variable');
});

test('bare (js): a spread is a bare read, a property key is not', () => {
  const parsed = parseJs('probe.js', [
    'function outer(a, b) {',
    '  const key = 1;',
    '  const o = { key: 2, other: 3 };',
    '  const arr = [...a];',
    '  const v = a ? b : key;',
    '  return o.other + arr.length + v;',
    '}',
    'outer([1], 2);',
  ].join('\n'));
  assert.ok(parsed.bareReferences.includes('a'), 'a spread ...a reads the variable');
  assert.ok(!parsed.bareReferences.includes('other'), 'an object key { other: 3 } is not a bare read');
  assert.ok(!parsed.bareReferences.includes('length'), 'a member name arr.length is not a bare read');
  assert.ok(parsed.bareReferences.includes('key'), 'a bare read in a ternary operand counts');
  assert.ok(parsed.bareReferences.includes('b'), 'a ternary operand counts');
});

test('bare (js): an object method definition is not a bare read or call', () => {
  const parsed = parseJs('probe.js', [
    'const o = {',
    '  async fetchIt() { return 1; },',
    '  get val() { return 2; },',
    '  *gen() { yield 3; },',
    '  rec() { return rec(); },',
    '};',
    'function outer() {',
    '  const fetchIt = 1;',
    '  const val = 2;',
    '  const gen = 3;',
    '  const rec = 4;',
    '  return o.fetchIt() + o.val + o.gen() + o.rec();',
    '}',
    'outer();',
  ].join('\n'));
  for (const name of ['fetchIt', 'val', 'gen']) {
    assert.ok(!parsed.bareReferences.includes(name), `the ${name} method definition must not count as a bare read of a local ${name}`);
    assert.ok(!parsed.bareCalls.has(name), `the ${name} method definition must not count as a bare call of a local ${name}`);
  }
  // The recursive call inside rec() IS a bare read and a bare call.
  assert.ok(parsed.bareReferences.includes('rec'), 'a recursive call reads the local');
  assert.ok(parsed.bareCalls.has('rec'), 'a recursive call is a bare call');
});

test('bare (js): a member chain split across lines and optional chaining are not bare', () => {
  const parsed = parseJs('probe.js', [
    'function outer() {',
    '  const foo = 1;',
    '  const obj = { foo() { return 2; } };',
    '  return obj',
    '    .foo() + obj?.foo();',
    '}',
    'outer();',
  ].join('\n'));
  assert.ok(!parsed.bareReferences.includes('foo'), 'obj.foo() across lines and obj?.foo() must not count as bare reads');
  assert.ok(!parsed.bareCalls.has('foo'), 'obj.foo() across lines and obj?.foo() must not count as bare calls');
  assert.ok(parsed.bareReferences.includes('obj'), 'the member-call object itself is a bare read');
});

test('bare (js): a call inside a bare block is still a bare call', () => {
  const parsed = parseJs('probe.js', [
    'function outer() {',
    '  const foo = 1;',
    '  { foo(); }',
    '  return foo;',
    '}',
    'outer();',
  ].join('\n'));
  assert.ok(parsed.bareReferences.includes('foo'), 'a call in a bare block reads the local');
  assert.ok(parsed.bareCalls.has('foo'), 'a call in a bare block is a bare call');
});

test('bare (js): bareReferences serializes as a sorted array, bareCalls stays a Set', () => {
  const parsed = parseJs('probe.js', 'function outer() { return foo + bar(); }\nouter();');
  assert.ok(Array.isArray(parsed.bareReferences), 'bareReferences must be an array — the grading loop keys on that');
  assert.deepEqual(parsed.bareReferences, [...parsed.bareReferences].sort(), 'bareReferences must be sorted, like the CLI');
  assert.ok(parsed.bareCalls instanceof Set, 'bareCalls stays a Set, like calls');
});

// --- parser level: local flags and accessors --------------------------

test('bare (js): nested definitions are locals, top-level ones are not', () => {
  const parsed = parseJs('probe.js', [
    'function outer(',
    '  a,',
    '  b',
    ') {',
    '  const deep = 1;',
    '  const f = () => {',
    '    const arrowLocal = 2;',
    '    return arrowLocal + deep;',
    '  };',
    '  setTimeout(function () {',
    '    const cbLocal = 3;',
    '    return cbLocal;',
    '  }, 0);',
    '  return f();',
    '}',
    'const top = 1;',
    'outer(1, 2);',
  ].join('\n'));
  const local = (name) => parsed.definitions.find((d) => d.name === name);
  assert.equal(local('outer').local, false, 'a top-level function is not a local');
  assert.equal(local('top').local, false, 'a top-level variable is not a local');
  assert.equal(local('deep').local, true, 'a variable inside a multi-line-signature function is a local');
  assert.equal(local('f').local, true, 'an arrow function inside a function is a local');
  assert.equal(local('arrowLocal').local, true, 'a variable inside an arrow body is a local');
  assert.equal(local('cbLocal').local, true, 'a variable inside a callback body is a local');
});

test('bare (js): methods are not locals, a variable inside a method is', () => {
  const parsed = parseJs('probe.js', [
    'class Holder {',
    '  get slots() { return 3; }',
    '  set slots(v) { this._s = v; }',
    '  plain() {',
    '    const inner = 1;',
    '    return inner;',
    '  }',
    '}',
    'function outer() {',
    '  class Inner {',
    '    meth() {',
    '      const x = 1;',
    '      return x;',
    '    }',
    '  }',
    '  return new Inner();',
    '}',
    'outer();',
  ].join('\n'));
  const defs = (name) => parsed.definitions.filter((d) => d.name === name);
  assert.equal(defs('plain')[0].local, false, 'a class method is not a local');
  assert.equal(defs('inner')[0].local, true, 'a variable inside a method body is a local');
  assert.equal(defs('Inner')[0].local, true, 'a class nested in a function is a local');
  assert.equal(defs('meth')[0].local, false, 'a method of a nested class is not a local');
  assert.equal(defs('x')[0].local, true, 'a variable inside a nested method body is a local');
});

test('bare (js): a getter is marked as an accessor, a plain method is not', () => {
  const parsed = parseJs('probe.js', [
    'class Holder {',
    '  get slots() { return 3; }',
    '  set slots(v) { this._s = v; }',
    '  plain() { return 4; }',
    '  get() { return 5; }',
    '}',
  ].join('\n'));
  const slots = parsed.definitions.filter((d) => d.name === 'slots');
  assert.equal(slots.filter((d) => d.isGetter).length, 1, 'the get slots() definition is marked isGetter');
  assert.equal(slots.filter((d) => d.isSetter).length, 1, 'the set slots(v) definition is marked isSetter');
  assert.equal(parsed.definitions.find((d) => d.name === 'plain').isGetter, undefined, 'a plain method is not a getter');
  assert.equal(parsed.definitions.find((d) => d.name === 'get').isGetter, undefined, 'a method literally named get is not a getter');
});

// --- scan level: web --------------------------------------------------

test('bare (js): a dead local named after a called method is SAFE', () => {
  const f = webFindings('js-batch12-bare');
  assert.equal(bySymbol(f, 'src/bare.js', 'dead', 'SAFE').grade, 'SAFE', 'dead local dead, only worker.dead() shares the name');
  assert.equal(bySymbol(f, 'src/bare.js', 'plainDead', 'SAFE').grade, 'SAFE', 'dead local plainDead, no same-name anything');
});

test('bare (js): a non-exported variable local gets no cross-file credit', () => {
  const f = webFindings('js-batch12-bare');
  assert.equal(bySymbol(f, 'src/bare.js', 'shared', 'SAFE').grade, 'SAFE', 'dead local variable shared: the cross-file use belongs to the same-named top-level shared, never to the local');
  assert.equal(bySymbol(f, 'src/bare.js', 'shared', 'SAFE').startLine, 21, 'the SAFE shared is the local on line 21, not the top-level shared on line 14');
  assert.equal(bySymbol(f, 'src/bare.js', 'escapes'), undefined, 'the local function escapes keeps its cross-file credit — a function local CAN escape');
});

test('bare (js): a dead method is REVIEW, never SAFE', () => {
  const f = webFindings('js-batch12-bare');
  assert.equal(bySymbol(f, 'src/bare.js', 'idle', 'REVIEW').grade, 'REVIEW', 'a method with 0 callers is REVIEW at most');
});

test('bare (js): live locals and methods are never flagged', () => {
  const f = webFindings('js-batch12-bare');
  for (const [file, symbol] of [
    ['src/bare.js', 'keptByCall'],
    ['src/bare.js', 'keptByRead'],
    ['src/bare.js', 'alive'],
    ['src/bare.js', 'slots'],
    ['src/bare.js', 'shared'],
    ['src/bare.js', 'escapes'],
    ['src/bare.js', 'worker'],
    ['src/bare.js', 'outer'],
    ['src/bare.js', 'Worker'],
    ['src/other.js', 'main'],
    ['src/other.js', 'bare'],
  ]) {
    // shared appears once, as the SAFE local above — the top-level
    // shared must have no finding of its own; every other name must
    // have no finding at all.
    if (symbol === 'shared') {
      const all = f.filter((x) => x.file.endsWith(file) && x.symbol === symbol);
      assert.equal(all.length, 1, 'shared must have exactly one finding: the SAFE local');
      assert.equal(all[0].grade, 'SAFE', 'the one shared finding is the SAFE local');
    } else {
      assert.equal(bySymbol(f, file, symbol), undefined, `${symbol} in ${file} must not be flagged`);
    }
  }
});

test('bare (js): SAFE false-positive rate is 0% on the fixture', () => {
  const f = webFindings('js-batch12-bare');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'variable:src/bare.js:dead', 'variable:src/bare.js:shared', 'variable:src/bare.js:plainDead',
  ]);
  assert.equal(safe.length, expectedSafe.size, `expected ${expectedSafe.size} SAFE findings, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.file}:${s.symbol || ''}`))}`);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

// --- web / CLI agreement ----------------------------------------------

test('bare (js): web and CLI agree exactly on the fixture', () => {
  const web = webFindings('js-batch12-bare');
  const cli = cliFindings('js-batch12-bare');
  const key = (f) => `${f.grade}|${f.category}|${f.file}|${f.symbol || ''}|${f.startLine}`;
  const webKeys = web.map(key).sort();
  const cliKeys = cli.map(key).sort();
  assert.deepEqual(webKeys, cliKeys, `web/CLI finding sets must match exactly.\nweb-only: ${JSON.stringify(webKeys.filter((k) => !cliKeys.includes(k)))}\ncli-only: ${JSON.stringify(cliKeys.filter((k) => !webKeys.includes(k)))}`);
});
