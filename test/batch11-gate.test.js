'use strict';

/**
 * Batch 11: the name-keyed same-file gate must not swallow a dead
 * local named after a called method or function (JS + Python).
 *
 * The usage map in src/graph.js is keyed by symbol NAME, and the
 * confidence engine's same-file flag was too: a dead local
 * `const foo = ...` (never read) in a file that also calls a method
 * named `foo()` looked "used in the same file" by name, so it got NO
 * finding at all — a recall gap, not a precision bug. The parsers now
 * record `bareReferences` (bare identifier reads only — never a
 * member/property name and never a member-call base), and locals grade
 * on that: a member call `obj.foo()` or attribute read `obj.foo`
 * names the member, not the local. A non-exported variable local can
 * never be used from another file either, so cross-file import/call
 * credit under the same name belongs to a same-named top-level
 * symbol, never to the local. (Function and method locals keep their
 * cross-file credit: they can escape through a returned object and be
 * called cross-file as members, e.g. the tool's own cacheCtx.parseJs.)
 *
 * These tests use the fixture directories fixtures/js-batch11-gate
 * and fixtures/py-batch11-gate (hand-written, not copied from any
 * repo). A live local read by its bare name, or called bare, must
 * still get no finding.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { scan } = require('../src/index');
const { parseJsTs } = require('../src/parse-js');
const { parsePy } = require('../src/parse-py');

const ROOT = path.join(__dirname, '..');

function findingsFor(dir) {
  return scan(path.join(ROOT, 'fixtures', dir)).findings;
}

function bySymbol(findings, file, symbol, grade) {
  return findings.find((f) => f.file.endsWith(file) && f.symbol === symbol && (!grade || f.grade === grade));
}

// --- parser level: bareReferences -------------------------------------

test('gate: a member call is not a bare reference to a same-named local (JS)', () => {
  const parsed = parseJsTs('gate.js', [
    'const obj = { foo() { return 1; } };',
    'function outer() {',
    '  const foo = 42;',
    '  return obj.foo();',
    '}',
    'outer();',
  ].join('\n'), '.js');
  assert.ok(parsed.references.has('foo'), 'the flat reference set still records the member name');
  assert.ok(!parsed.bareReferences.includes('foo'), 'obj.foo() must not count as a bare read of a local foo');
  assert.ok(parsed.bareReferences.includes('obj'), 'the member-call object itself is a bare read');
  assert.ok(parsed.bareReferences.includes('outer'), 'a bare call is a bare read');
});

test('gate: a bare call and a bare read are bare references (JS)', () => {
  const parsed = parseJsTs('gate.js', [
    'function outer() {',
    '  const foo = 42;',
    '  function bar() { return 1; }',
    '  return foo + bar();',
    '}',
    'outer();',
  ].join('\n'), '.js');
  assert.ok(parsed.bareReferences.includes('foo'), 'a bare read counts');
  assert.ok(parsed.bareReferences.includes('bar'), 'a bare call counts');
  const shorthand = parseJsTs('gate.js', [
    'function outer() {',
    '  const foo = 42;',
    '  return { foo };',
    '}',
    'outer();',
  ].join('\n'), '.js');
  assert.ok(shorthand.bareReferences.includes('foo'), 'a shorthand property { foo } reads the variable');
});

test('gate: an attribute read is not a bare reference to a same-named local (Python)', () => {
  const parsed = parsePy('gate.py', [
    'class Obj:',
    '    def foo(self):',
    '        return 1',
    '',
    'def outer():',
    '    foo = 42',
    '    return Obj().foo()',
    '',
    'outer()',
  ].join('\n'));
  assert.ok(parsed.references.has('foo'), 'the flat reference set still records the attribute name');
  assert.ok(!parsed.bareReferences.includes('foo'), 'Obj().foo() must not count as a bare read of a local foo');
  assert.ok(parsed.bareReferences.includes('Obj'), 'the attribute object itself is a bare read');
  assert.ok(parsed.bareReferences.includes('outer'), 'a bare call is a bare read');
});

test('gate: a bare read and a bare call are bare references (Python)', () => {
  const parsed = parsePy('gate.py', [
    'def outer():',
    '    foo = 42',
    '    def bar():',
    '        return 1',
    '    return foo + bar()',
    '',
    'outer()',
  ].join('\n'));
  assert.ok(parsed.bareReferences.includes('foo'), 'a bare read counts');
  assert.ok(parsed.bareReferences.includes('bar'), 'a bare call counts');
});

// --- scan level: JS ---------------------------------------------------

test('gate (js): a dead local named after a called method is SAFE', () => {
  const f = findingsFor('js-batch11-gate');
  assert.equal(bySymbol(f, 'src/gate.js', 'foo', 'SAFE').grade, 'SAFE', 'dead local foo, only obj.foo() shares the name');
  assert.equal(bySymbol(f, 'src/gate.js', 'qux', 'SAFE').grade, 'SAFE', 'dead local function qux, only obj.qux() shares the name');
  assert.equal(bySymbol(f, 'src/other.js', 'foo', 'SAFE').grade, 'SAFE', 'dead local foo in the other file, only obj2.foo() shares the name');
});

test('gate: a getter is marked as an accessor, a plain method is not (JS)', () => {
  const parsed = parseJsTs('probe.js', [
    'const o = {',
    '  get slots() { return 1; },',
    '  set slots(v) { this._s = v; },',
    '  plain() { return 2; },',
    '};',
    'o.slots;',
  ].join('\n'), '.js');
  const getters = parsed.definitions.filter((d) => d.name === 'slots');
  assert.equal(getters.filter((d) => d.isGetter).length, 1, 'the get slots() definition is marked isGetter');
  assert.equal(getters.filter((d) => d.isSetter).length, 1, 'the set slots(v) definition is marked isSetter');
  assert.equal(parsed.definitions.find((d) => d.name === 'plain').isGetter, undefined, 'a plain method is not a getter');
  assert.ok(!parsed.bareReferences.includes('slots'), 'a property read is not a bare reference — the accessor rule, not the bare rule, keeps it alive');
});

test('gate (js): a getter read as a property is live', () => {
  const f = findingsFor('js-batch11-gate');
  const slots = f.find((x) => x.file === 'src/gate.js' && x.symbol === 'slots');
  assert.equal(slots, undefined, 'get slots() runs when code reads obj.slots — a property access invokes the getter');
});

test('gate (js): a factory-returned method called cross-file as a member is live', () => {
  const f = findingsFor('js-batch11-gate');
  const ping = f.find((x) => x.file === 'src/other.js' && x.symbol === 'ping');
  assert.equal(ping, undefined, 'ping escapes through the returned object and is called as createCtx().ping() — method locals keep cross-file member-call credit');
});

test('gate (js): a live local is never flagged', () => {
  const f = findingsFor('js-batch11-gate');
  for (const [file, symbol] of [
    ['src/gate.js', 'bar'],
    ['src/gate.js', 'baz'],
    ['src/gate.js', 'helper'],
    ['src/gate.js', 'obj'],
    ['src/gate.js', 'outer'],
    ['src/other.js', 'helper'],
    ['src/other.js', 'obj2'],
  ]) {
    assert.equal(bySymbol(f, file, symbol), undefined, `${symbol} in ${file} must not be flagged`);
  }
});

test('gate (js): SAFE false-positive rate is 0% on the fixture', () => {
  const f = findingsFor('js-batch11-gate');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'variable:src/gate.js:foo', 'function:src/gate.js:qux', 'variable:src/other.js:foo',
  ]);
  assert.equal(safe.length, expectedSafe.size, `expected ${expectedSafe.size} SAFE findings, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.file}:${s.symbol || ''}`))}`);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

// --- scan level: Python -----------------------------------------------

test('gate (py): a dead local named after a called method is SAFE', () => {
  const f = findingsFor('py-batch11-gate');
  assert.equal(bySymbol(f, 'gate1.py', 'foo', 'SAFE').grade, 'SAFE', 'dead local foo, only Obj().foo() shares the name');
  assert.equal(bySymbol(f, 'gate1.py', 'qux', 'SAFE').grade, 'SAFE', 'dead local function qux, only Obj().qux() shares the name');
  assert.equal(bySymbol(f, 'other.py', 'foo', 'SAFE').grade, 'SAFE', 'dead local foo in the other file, only Obj2().foo() shares the name');
});

test('gate (py): a live local is never flagged', () => {
  const f = findingsFor('py-batch11-gate');
  for (const [file, symbol] of [
    ['gate1.py', 'bar'],
    ['gate1.py', 'baz'],
    ['gate1.py', 'helper'],
    ['gate1.py', 'Obj'],
    ['gate1.py', 'outer'],
    ['other.py', 'helper'],
    ['other.py', 'Obj2'],
  ]) {
    assert.equal(bySymbol(f, file, symbol), undefined, `${symbol} in ${file} must not be flagged`);
  }
});

test('gate (py): SAFE false-positive rate is 0% on the fixture', () => {
  const f = findingsFor('py-batch11-gate');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'variable:gate1.py:foo', 'function:gate1.py:qux', 'variable:other.py:foo',
  ]);
  assert.equal(safe.length, expectedSafe.size, `expected ${expectedSafe.size} SAFE findings, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.file}:${s.symbol || ''}`))}`);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});
