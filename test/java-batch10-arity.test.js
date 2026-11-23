'use strict';

/**
 * Batch 10: Java arity must ignore comments, and enum constants
 * invoke their enum's constructor.
 *
 * Comments are named nodes in tree-sitter-java, so a `//` comment
 * after an argument (or between parameters) used to inflate
 * namedChildCount: a 3-arg call with trailing `//` comments recorded
 * arity 7 and its private callee never matched its declaration
 * (junit5 CsvReaderConfiguration.validateDelimiter /
 * validateControlCharactersDiffer were false SAFEs). The same hazard
 * hit declarations (formal_parameters), `new` expressions and
 * this()/super() invocations. All arity counts now skip comments.
 *
 * Enum constants invoke their enum's constructor — `FOO(1, 2)` calls
 * the 2-arg constructor and a bare `FOO` calls the no-arg one — but
 * no call site named the constructor, so gson's ParseBenchmark
 * Document enum constructor (FJ-6) was a false SAFE. Enum constants
 * are now recorded as constructor calls with arity.
 *
 * These tests run with javaSafe: true — they measure the Java grading
 * engine itself. By default Java SAFE is OFF (batch 9 gate), so a
 * plain scan reports Java findings at REVIEW at most.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { scan } = require('../src/index');
const { parseJava } = require('../src/parse-java');

const ROOT = path.join(__dirname, '..');
const FILE = 'src/ArityComments.java';

function findingsFor() {
  return scan(path.join(ROOT, 'fixtures', 'java-batch10-arity'), { includeFixtures: true, javaSafe: true }).findings;
}

function bySymbol(findings, symbol, grade) {
  return findings.find((f) => f.file.endsWith(FILE) && f.symbol === symbol && (!grade || f.grade === grade));
}

function parseSnippet(body) {
  const src = `class Probe {\n${body}\n}\n`;
  return parseJava(path.join(ROOT, 'Probe.java'), src);
}

test('arity: multi-arg call with trailing // comments records 3, not 7', () => {
  const parsed = parseSnippet([
    '  String run(String s) {',
    '    return checked( //',
    '      s, //',
    '      1, //',
    '      true //',
    '    );',
    '  }',
    '  String checked(String s, int n, boolean flag) { return s; }',
  ].join('\n'));
  const call = parsed.calls.find((c) => c.name === 'checked');
  assert.ok(call, 'checked call recorded');
  assert.equal(call.arity, 3, '3 args plus 4 // comments must count as 3');
  const def = parsed.definitions.find((d) => d.name === 'checked');
  assert.equal(def.arity, 3, 'declaration arity is 3');
});

test('arity: call with /* */ comments between args records the real count', () => {
  const parsed = parseSnippet([
    '  String run(String s) {',
    '    return pair(/* first */ s, /* second */ 2);',
    '  }',
    '  String pair(String s, int n) { return s; }',
  ].join('\n'));
  const call = parsed.calls.find((c) => c.name === 'pair');
  assert.ok(call, 'pair call recorded');
  assert.equal(call.arity, 2, '2 args plus 2 /* */ comments must count as 2');
});

test('arity: new and this() with comments in the argument list', () => {
  const parsed = parseSnippet([
    '  Probe() { this(/* a */ 1, /* b */ 2); }',
    '  Probe(int a, int b) { }',
    '  Object make() { return new Inner(/* x */ "s"); }',
    '  static class Inner { Inner(String s) { } }',
  ].join('\n'));
  const thisCall = parsed.calls.find((c) => c.name === 'constructor' && c.forClass === 'Probe');
  assert.ok(thisCall, 'this() call recorded');
  assert.equal(thisCall.arity, 2, 'this() with 2 args plus comments must count as 2');
  const newCall = parsed.calls.find((c) => c.name === 'constructor' && c.forClass === 'Inner');
  assert.ok(newCall, 'new Inner() call recorded');
  assert.equal(newCall.arity, 1, 'new with 1 arg plus a comment must count as 1');
});

test('arity: varargs declaration with comments in its parameter list', () => {
  const parsed = parseSnippet(
    '  String join(String first, /* rest */ String... rest) { return first; }',
  );
  const def = parsed.definitions.find((d) => d.name === 'join');
  assert.ok(def, 'join declaration recorded');
  assert.equal(def.arity, 2, 'first + rest counts as 2, not 3');
  assert.equal(def.varargs, true, 'spread parameter still detected');
  assert.equal(def.fixedArity, 1, 'fixed arity is 1');
});

test('arity: enum-constant ctor invocations are recorded as constructor calls', () => {
  const parsed = parseSnippet([
    '  enum Kind {',
    '    SMALL(1),',
    '    LARGE(10);',
    '    private final int size;',
    '    private Kind(int size) { this.size = size; }',
    '  }',
    '  enum Plain {',
    '    A,',
    '    B;',
    '    private Plain() { }',
    '  }',
  ].join('\n'));
  const kindCalls = parsed.calls.filter((c) => c.name === 'constructor' && c.forClass === 'Kind');
  assert.equal(kindCalls.length, 2, 'one ctor call per constant with arguments');
  assert.ok(kindCalls.every((c) => c.arity === 1), 'both calls carry arity 1');
  const plainCalls = parsed.calls.filter((c) => c.name === 'constructor' && c.forClass === 'Plain');
  assert.equal(plainCalls.length, 2, 'bare constants invoke the no-arg constructor');
  assert.ok(plainCalls.every((c) => c.arity === 0), 'both calls carry arity 0');
});

test('arity: if (false) with a comment before false is still unreachable', () => {
  const parsed = parseSnippet(
    '  void m() { if (/* c */ false) { System.out.println(1); } }',
  );
  assert.equal(parsed.unreachable.length, 1, 'commented if (false) is flagged');
  assert.match(parsed.unreachable[0].reason, /if \(false\)/);
});

test('arity: method reference with an interleaved comment is still recorded', () => {
  const parsed = parseSnippet([
    '  void m() { Runnable r = this::/* c */helper; }',
    '  void helper() { }',
  ].join('\n'));
  const call = parsed.calls.find((c) => c.name === 'helper' && c.methodRef);
  assert.ok(call, 'method reference with a comment inside it is recorded');
});

test('arity: comment-laden calls keep their private callees live (scan)', () => {
  const f = findingsFor();
  assert.equal(bySymbol(f, 'checked'), undefined, 'checked/3 is called with trailing // comments and must not be flagged');
  assert.equal(bySymbol(f, 'pair'), undefined, 'pair/2 is called with /* */ comments and must not be flagged');
  assert.equal(bySymbol(f, 'join'), undefined, 'join/1 varargs call matches the commented declaration and must not be flagged');
});

test('arity: enum constructors invoked by constants are live (scan)', () => {
  const f = findingsFor();
  // The Kind(int) and Plain() constructors have no name-based caller
  // at all — only their enum constants invoke them.
  const ctors = f.filter((x) => x.file.endsWith(FILE) && x.symbol === 'constructor');
  assert.equal(ctors.length, 0, 'no enum constructor may be flagged');
});

test('arity: a genuinely dead private method is still SAFE (no recall loss)', () => {
  const f = findingsFor();
  const dead = bySymbol(f, 'neverCalled', 'SAFE');
  assert.ok(dead, 'neverCalled is called by nothing and must stay SAFE');
  assert.equal(dead.grade, 'SAFE');
});

function bySymbolIn(findings, file, symbol, grade) {
  return findings.find((f) => f.file.endsWith(file) && f.symbol === symbol && (!grade || f.grade === grade));
}

// The CommentedArgs fixture below covers the same fix at scan level
// (contributed by the batch-10 policy worker, which fixed the arity
// bug independently): a call written as `check(a, // note\n b)` has
// arity 2, not 3, and so does `new Holder(a, // note\n b)`.
test('arity: a call with comments in its argument list still matches the declaration', () => {
  const f = findingsFor();
  const file = 'src/CommentedArgs.java';
  // check/2 is called with two arguments and three trailing comments:
  // the call is arity 2, so the private callee is live.
  assert.equal(bySymbolIn(f, file, 'check'), undefined, 'check/2 is called (comments are not arguments) and must not be flagged');
  assert.equal(bySymbolIn(f, file, 'checkOne'), undefined, 'checkOne/1 is called and must not be flagged');
  // Same shape for a constructor call: new Holder("x", "y") with
  // comments is arity 2 and matches the two-parameter constructor.
  const holderCtors = f.filter((x) => x.file.endsWith(file) && x.symbol === 'constructor' && x.grade === 'SAFE');
  assert.equal(holderCtors.length, 1, 'only the outer class constructor may be SAFE');
  assert.equal(bySymbolIn(f, file, 'constructor', 'SAFE').startLine, 12,
    'the Holder constructor is called and must not be SAFE — only the outer private constructor is');
});

test('arity: SAFE false-positive rate is 0% on the CommentedArgs fixture', () => {
  const f = findingsFor().filter((x) => x.file.endsWith('src/CommentedArgs.java'));
  const safe = f.filter((x) => x.grade === 'SAFE');
  assert.equal(safe.length, 1, `expected 1 SAFE finding in CommentedArgs.java, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.symbol || ''}`))}`);
  assert.equal(safe[0].symbol, 'constructor', 'the only SAFE item is the uncalled outer constructor');
  assert.equal(safe[0].startLine, 12, 'the SAFE constructor is the outer private one');
});
