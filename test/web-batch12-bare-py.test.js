'use strict';

/**
 * Batch 12 (web, Python side): the CLI's bare-reference tracking,
 * ported to the web analyzer's Python parser (docs/analyzer.js
 * parsePy).
 *
 * The CLI's confidence engine grades a LOCAL definition on bare-name
 * use only: a member call `obj.foo()` names the member, not a local
 * `foo`, and a non-exported VARIABLE local can never be used from
 * another file, so cross-file credit under the same name belongs to a
 * same-named top-level symbol instead. The web parser now records
 * the same channel — `bareReferences` (sorted array) and `bareCalls`
 * (Set of names called bare) — plus `local` on every definition, so
 * the generic grading rule (keyed on `parsed.bareReferences` being
 * an array) applies to Python locals too.
 *
 * These tests use the fixture directory fixtures/py-batch12-bare
 * (hand-written, not copied from any repo), modeled on the CLI
 * batch-11 gate fixture fixtures/py-batch11-gate. A live local read
 * by its bare name, or called bare, must still get no finding, and a
 * method must stay live through `obj.method()`.
 *
 * Run with: node --test test/web-batch12-bare-py.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { analyzeFiles, parsePy } = require('../docs/analyzer');
const { scan } = require('../src/index');

const ROOT = path.join(__dirname, '..');
const DIR = 'py-batch12-bare';

function loadWeb(dir) {
  const base = path.join(ROOT, 'fixtures', dir);
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push({ path: path.relative(base, full).split(path.sep).join('/'), content: fs.readFileSync(full, 'utf8') });
    }
  })(base);
  return analyzeFiles(files).findings;
}

function loadCli(dir) {
  return scan(path.join(ROOT, 'fixtures', dir)).findings;
}

function bySymbol(findings, file, symbol, grade) {
  return findings.find((f) => f.file.endsWith(file) && f.symbol === symbol && (!grade || f.grade === grade));
}

function findingKey(f) {
  return f.category + ':' + f.file + ':' + (f.symbol || '') + ':' + (f.startLine || 0) + ':' + f.grade;
}

// --- parser level: bareReferences -------------------------------------

test('batch12 (py): a member call is not a bare reference to a same-named local', () => {
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

test('batch12 (py): a bare read and a bare call are bare references', () => {
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

test('batch12 (py): bareCalls tells a bare call from a member call', () => {
  const parsed = parsePy('gate.py', [
    'class Obj:',
    '    def foo(self):',
    '        return 1',
    '',
    'def outer():',
    '    foo = 42',
    '    bar = 7',
    '    return Obj().foo() + foo() + bar()',
    '',
    'outer()',
  ].join('\n'));
  // The name-only `calls` set cannot tell them apart — both spellings
  // land there — so the bare channel is the record the grading rule
  // uses. (Here `foo()` is a bare call of the local foo; the local
  // bar is called bare too.)
  assert.ok(parsed.calls.has('foo'), 'the flat calls set records the member call');
  assert.ok(parsed.bareCalls.has('foo'), 'the bare call foo() counts');
  assert.ok(parsed.bareCalls.has('bar'), 'the bare call bar() counts');
  const memberOnly = parsePy('gate.py', [
    'def outer():',
    '    foo = 42',
    '    return Obj().foo()',
    '',
    'outer()',
  ].join('\n'));
  assert.ok(memberOnly.calls.has('foo'), 'the flat calls set records the member call');
  assert.ok(!memberOnly.bareCalls.has('foo'), 'Obj().foo() must not count as a bare call of a local foo');
  assert.ok(!memberOnly.bareReferences.includes('foo'), 'Obj().foo() must not count as a bare read either');
});

test('batch12 (py): an attribute read is not a bare reference', () => {
  const parsed = parsePy('gate.py', [
    'def outer():',
    '    foo = 42',
    '    return self.foo + obj.foo',
    '',
    'outer()',
  ].join('\n'));
  assert.ok(!parsed.bareReferences.includes('foo'), 'self.foo / obj.foo name the member, not the local');
  assert.ok(parsed.bareReferences.includes('self'), 'the attribute object itself is a bare read');
  assert.ok(parsed.bareReferences.includes('obj'), 'the attribute object itself is a bare read');
});

test('batch12 (py): a multi-line member access is not a bare reference', () => {
  const parsed = parsePy('gate.py', [
    'def outer():',
    '    foo = 42',
    '    x = (obj',
    '         .foo)',
    '    y = (obj.',
    '         foo)',
    '    return x + y',
    '',
    'outer()',
  ].join('\n'));
  assert.ok(!parsed.bareReferences.includes('foo'), 'a member access split across lines still names the member');
  assert.ok(parsed.bareReferences.includes('obj'), 'the attribute object itself is a bare read');
});

test('batch12 (py): a decorator member is not a bare reference, its object is', () => {
  const parsed = parsePy('gate.py', [
    '@app.foo()',
    'def bar():',
    '    pass',
    '',
    'bar()',
  ].join('\n'));
  assert.ok(!parsed.bareReferences.includes('foo'), '@app.foo() names a member of the decorator object');
  assert.ok(parsed.bareReferences.includes('app'), 'the decorator object itself is a bare read');
  assert.ok(!parsed.references.has('foo'), 'a decorator member is not even a flat reference');
});

test('batch12 (py): annotation strings are bare references, %-format placeholders are not', () => {
  const parsed = parsePy('gate.py', [
    'def f(x: "Foo") -> "Bar":',
    '    return "%(foo)s" % {"foo": x}',
    '',
    'f(1)',
  ].join('\n'));
  assert.ok(parsed.bareReferences.includes('Foo'), 'a string annotation names a real type');
  assert.ok(parsed.bareReferences.includes('Bar'), 'a string annotation names a real type');
  assert.ok(parsed.references.has('foo'), '%(foo)s is a flat reference (the mapping is looked up at runtime)');
  assert.ok(!parsed.bareReferences.includes('foo'), '%(foo)s is not a bare read — the CLI records it as a plain reference only');
});

test('batch12 (py): a string prefix and a class attribute name are not bare references', () => {
  const parsed = parsePy('gate.py', [
    'def outer():',
    '    f = 42',
    '    x = 1',
    '    return f"{x}"',
    '',
    'outer()',
  ].join('\n'));
  assert.ok(parsed.bareReferences.includes('x'), 'the f-string expression reads x');
  assert.ok(!parsed.bareReferences.includes('f'), 'the f in f"..." is a string prefix, not a read of a local f');
  const attr = parsePy('gate.py', [
    'class C:',
    '    x = 1',
    '',
    'def outer():',
    '    x = 42',
    '    return C',
    '',
    'outer()',
  ].join('\n'));
  assert.ok(!attr.bareReferences.includes('x'), 'a class-attribute definition line is a definition site, not a read');
});

test('batch12 (py): a chained-assignment target is not a bare reference', () => {
  const parsed = parsePy('gate.py', [
    'class W:',
    '    first = second = make_default',
    '',
    'def outer():',
    '    a = b = 1',
    '    return a',
    '',
    'outer()',
  ].join('\n'));
  assert.ok(!parsed.bareReferences.includes('second'), 'a chained target in a class body is a definition site, not a read');
  assert.ok(!parsed.bareReferences.includes('b'), 'a chained target in a function body is a definition site, not a read');
  assert.ok(parsed.bareReferences.includes('make_default'), 'the chained value is a read');
  assert.ok(parsed.bareReferences.includes('a'), 'the first target, read later, is a bare read');
});

test('batch12 (py): a value-less annotation is not a bare reference', () => {
  const parsed = parsePy('gate.py', [
    'class C:',
    '    timeout: int',
    '',
    'def outer():',
    '    x: int',
    '    return 1',
    '',
    'outer()',
  ].join('\n'));
  assert.ok(!parsed.bareReferences.includes('timeout'), 'an annotated class attribute with no value is a definition site');
  assert.ok(!parsed.bareReferences.includes('x'), 'an annotated local with no value is a definition site');
  assert.ok(parsed.bareReferences.includes('int'), 'the annotation type itself is a read');
});

test('batch12 (py): a declaration line reads its own right-hand side', () => {
  const parsed = parsePy('gate.py', [
    'def outer():',
    '    foo = foo()',
    '    return foo',
    '',
    'outer()',
  ].join('\n'));
  assert.ok(parsed.bareReferences.includes('foo'), 'foo = foo() reads foo on the right-hand side');
});

// --- parser level: local flags ----------------------------------------

test('batch12 (py): nested definitions are locals, module definitions are not', () => {
  const parsed = parsePy('gate.py', [
    'def outer():',
    '    foo = 42',
    '    def baz():',
    '        return 1',
    '    class Inner:',
    '        pass',
    '    return foo + baz() + Inner',
    '',
    'def top():',
    '    return 1',
    '',
    'top()',
  ].join('\n'));
  const def = (name, kind) => parsed.definitions.find((d) => d.name === name && (!kind || d.kind === kind));
  assert.equal(def('foo', 'variable').local, true, 'a variable assigned in a function body is a local');
  assert.equal(def('baz', 'function').local, true, 'a nested function is a local');
  assert.equal(def('Inner', 'class').local, true, 'a class defined in a function is a local');
  assert.equal(def('outer', 'function').local, false, 'a module-level function is not a local');
  assert.equal(def('top', 'function').local, false, 'a module-level function is not a local');
});

test('batch12 (py): a method is not a local, but its own locals are', () => {
  const parsed = parsePy('gate.py', [
    'class C:',
    '    def method(self):',
    '        foo = 42',
    '        def nested():',
    '            return 1',
    '        return foo + nested()',
    '',
    'C().method()',
  ].join('\n'));
  const def = (name, kind) => parsed.definitions.find((d) => d.name === name && (!kind || d.kind === kind));
  assert.equal(def('method', 'method').local, false, 'a method is not a local of its class');
  assert.equal(def('foo', 'variable').local, true, 'a variable assigned in a method body is a local');
  assert.equal(def('nested', 'function').local, true, 'a function nested in a method is a local');
});

test('batch12 (py): a class attribute in a function is not a local', () => {
  const parsed = parsePy('gate.py', [
    'def outer():',
    '    class Inner:',
    '        x = 1',
    '    return Inner',
    '',
    'outer()',
  ].join('\n'));
  // The class attribute IS recorded as a definition (batch 14: the
  // CLI's tree-sitter parser records every class-body assignment,
  // and the web matches it) — but it is a class attribute of Inner,
  // not a local of outer: the class boundary wins over the enclosing
  // function. The class itself is the local.
  const x = parsed.definitions.find((d) => d.name === 'x');
  assert.ok(x, 'a class attribute is recorded as a definition');
  assert.equal(x.kind, 'variable');
  assert.equal(x.local, false, 'a class attribute is not a local variable definition');
  assert.equal(x.className, 'Inner', 'the attribute belongs to the Inner class');
  assert.equal(parsed.definitions.find((d) => d.name === 'Inner').local, true, 'the class itself is a local');
});

// --- scan level: web grades match the CLI grades ----------------------

test('batch12 (py): dead locals named after called methods are SAFE', () => {
  const f = loadWeb(DIR);
  assert.equal(bySymbol(f, 'gate1.py', 'foo', 'SAFE').grade, 'SAFE', 'dead local foo, only Obj().foo() shares the name');
  assert.equal(bySymbol(f, 'gate1.py', 'qux', 'SAFE').grade, 'SAFE', 'dead local function qux, only Obj().qux() shares the name');
  assert.equal(bySymbol(f, 'victim.py', 'foo', 'SAFE').grade, 'SAFE', 'dead local foo, star-import credit must not rescue a variable local');
});

test('batch12 (py): a live local is never flagged', () => {
  const f = loadWeb(DIR);
  for (const [file, symbol] of [
    ['gate1.py', 'bar'],
    ['gate1.py', 'baz'],
    ['gate1.py', 'helper'],
    ['gate1.py', 'Obj'],
    ['gate1.py', 'outer'],
    ['other.py', 'helper'],
    ['victim.py', 'bar'],
    ['victim.py', 'outer'],
    ['shared.py', 'foo'],
  ]) {
    assert.equal(bySymbol(f, file, symbol), undefined, `${symbol} in ${file} must not be flagged`);
  }
  // gate1.py foo/qux are ambiguous by name — the dead LOCALS are
  // flagged, but the live METHODS of the same name must not be.
  assert.equal(f.find((x) => x.file === 'gate1.py' && x.symbol === 'foo' && x.category === 'method'), undefined, 'method Obj.foo stays live through Obj().foo()');
  assert.equal(f.find((x) => x.file === 'gate1.py' && x.symbol === 'qux' && x.category === 'method'), undefined, 'method Obj.qux stays live through Obj().qux()');
});

test('batch12 (py): SAFE false-positive rate is 0% on the fixture', () => {
  const f = loadWeb(DIR);
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'variable:gate1.py:foo', 'function:gate1.py:qux', 'variable:victim.py:foo',
  ]);
  assert.equal(safe.length, expectedSafe.size, `expected ${expectedSafe.size} SAFE findings, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.file}:${s.symbol || ''}`))}`);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('batch12 (py): web grades match the CLI grades on the same fixture', () => {
  const web = loadWeb(DIR);
  const cli = loadCli(DIR);
  const webKeys = web.map(findingKey).sort();
  const cliKeys = cli.map(findingKey).sort();
  assert.deepEqual(webKeys, cliKeys, `web and CLI findings differ.\nweb-only: ${JSON.stringify(webKeys.filter((k) => !cliKeys.includes(k)))}\ncli-only: ${JSON.stringify(cliKeys.filter((k) => !webKeys.includes(k)))}`);
});
