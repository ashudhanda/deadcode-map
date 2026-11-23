'use strict';

/**
 * Batch 11: three small Java items, all diagnosis-first.
 *
 * Item 1 — name-keyed same-file gate, Java side: the usage map is
 * keyed by symbol NAME, so a dead local `int foo = 42;` in a method
 * that also calls `foo()` looked "used in the same file" and got NO
 * finding. Java locals now grade on binding-resolved reads
 * (readCount) alone — the name-based flag never keeps one alive —
 * and a private field is live only on a bare read from live code, so
 * a same-named method call does not keep it alive either, while a
 * bare read inside a dead method still does not (FJ-9).
 *
 * Item 2 — modifiersOf comment-word hazard: `modifiersOf` tested the
 * RAW text of the `modifiers` node with regexes, so a comment sitting
 * between two modifiers (public, then a comment containing the word
 * private, then static) flipped the flags. The flags now come from
 * the modifier keyword nodes themselves (their type IS the keyword);
 * a comment word — or a word inside an annotation's string argument —
 * can no longer flip them.
 * Note the task's example (public, then a comment containing the word
 * private, then void) does NOT reproduce: tree-sitter puts a comment
 * after the last modifier outside the modifiers node, so the raw text
 * never contained it. The hazard needs the comment between two real
 * modifiers.
 *
 * Item 3 — forClass quirk: `new TypeToken<List<Tweet>>()` recorded
 * forClass=Tweet (the LAST identifier of the type text) instead of
 * TypeToken (the class actually constructed), so the constructor
 * looked uncalled with its arity. forClass is now the OUTERMOST
 * constructed class name: the base of a generic type, the last
 * segment of a qualified name. The method-reference case had a
 * second bug on top: `new` is an ANONYMOUS child of a
 * method_reference, so the old `name === 'new'` test never fired —
 * `TypeToken::new` recorded a phantom method call named TypeToken
 * and `Outer.Inner::new` recorded nothing at all. The `::new` case
 * is now detected by the anonymous `new` child directly.
 *
 * These tests run with javaSafe: true — they measure the Java grading
 * engine itself. By default Java SAFE is OFF (batch 9 gate), so a
 * plain scan reports Java findings at REVIEW at most. The scan tests
 * use fixtures/java-batch11-gate (hand-written, not copied from any
 * repo); the parse tests use inline snippets like
 * test/java-batch10-arity.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { scan } = require('../src/index');
const { parseJava } = require('../src/parse-java');

const ROOT = path.join(__dirname, '..');
const FILE = 'src/Gate.java';

function findingsFor() {
  return scan(path.join(ROOT, 'fixtures', 'java-batch11-gate'), { includeFixtures: true, javaSafe: true }).findings;
}

function bySymbol(findings, symbol, grade) {
  return findings.find((f) => f.file.endsWith(FILE) && f.symbol === symbol && (!grade || f.grade === grade));
}

function parseSnippet(body) {
  const src = `class Probe {\n${body}\n}\n`;
  return parseJava(path.join(ROOT, 'Probe.java'), src);
}

// --- item 1: scan level ------------------------------------------------

test('gate (java): a dead local named after a called method is SAFE', () => {
  const f = findingsFor();
  assert.equal(bySymbol(f, 'foo', 'SAFE').grade, 'SAFE', 'dead local foo, only foo() shares the name');
  // The live local read bare in the same method is untouched.
  assert.equal(bySymbol(f, 'bar'), undefined, 'bar is read bare and must not be flagged');
});

test('gate (java): a dead private field named after a called method is SAFE', () => {
  const f = findingsFor();
  assert.equal(bySymbol(f, 'shadowed', 'SAFE').grade, 'SAFE', 'dead field shadowed, only shadowed() shares the name');
  // The field read bare by a live method stays live.
  assert.equal(bySymbol(f, 'liveField'), undefined, 'liveField is read bare by a live method and must not be flagged');
  // FJ-9 still holds: a field read only by a dead method stays SAFE.
  assert.equal(bySymbol(f, 'deadOnlyField', 'SAFE').grade, 'SAFE', 'deadOnlyField is read only by a dead method');
  assert.equal(bySymbol(f, 'readDeadOnly', 'SAFE').grade, 'SAFE', 'readDeadOnly is called by nothing');
});

// --- item 2: parse level -----------------------------------------------

test('gate (java): a comment between modifiers flips no flags', () => {
  const between = parseSnippet('  public /* private */ static void m() {}');
  const m = between.definitions.find((d) => d.name === 'm');
  assert.equal(m.visibility, 'public', 'public /* private */ static stays public');
  assert.equal(m.static, true, 'the real static modifier still counts');
  const lineComment = parseSnippet('  public // private\n  static void m() {}');
  assert.equal(lineComment.definitions.find((d) => d.name === 'm').visibility, 'public', 'a // comment between modifiers flips nothing');
  const annotationString = parseSnippet('  @Anno("private") public void m() {}');
  assert.equal(annotationString.definitions.find((d) => d.name === 'm').visibility, 'public', 'the word private inside an annotation string flips nothing');
  const publicComment = parseSnippet('  static /* public */ final void m() {}');
  assert.equal(publicComment.definitions.find((d) => d.name === 'm').visibility, 'package', '/* public */ between modifiers must not promote a package-private method');
  // Controls: real modifiers still read exactly.
  const realPrivate = parseSnippet('  private static void m() {}');
  assert.equal(realPrivate.definitions.find((d) => d.name === 'm').visibility, 'private', 'a real private modifier still counts');
  assert.equal(realPrivate.definitions.find((d) => d.name === 'm').static, true, 'a real static modifier still counts');
});

test('gate (java): a comment after the last modifier never flipped anything', () => {
  // tree-sitter puts the comment outside the modifiers node here, so
  // the raw text never contained the word — pin the behaviour so a
  // future grammar change cannot silently flip it.
  const trailing = parseSnippet('  public /* private */ void m() {}');
  assert.equal(trailing.definitions.find((d) => d.name === 'm').visibility, 'public', 'public /* private */ void stays public');
});

// --- item 2: scan level -------------------------------------------------

test('gate (java): a commented public method is REVIEW, never SAFE', () => {
  const f = findingsFor();
  assert.equal(bySymbol(f, 'commentedPublic', 'REVIEW').grade, 'REVIEW', 'public /* private */ static is public — reachable from outside this file');
  assert.equal(bySymbol(f, 'genuinelyPrivate', 'SAFE').grade, 'SAFE', 'a genuinely private uncalled method stays SAFE');
});

// --- item 1 follow-up: switch-case bindings ---------------------------
// A local declared in a switch case is not a direct child of a block,
// so pass 1b never registered its binding and its reads never
// resolved: readCount stayed 0 and the local was flagged SAFE even
// though live code reads it (gson's JsonReader pathIndex, which the
// bare-name rule exposed once the name flag stopped rescuing it).
// The binding is scoped to the enclosing switch block (its JLS scope).

test('gate (java): a local declared in a switch case resolves its reads', () => {
  const parsed = parseSnippet([
    '  String getPath(boolean usePreviousPath) {',
    '    StringBuilder result = new StringBuilder();',
    '    for (int i = 0; i < stackSize; i++) {',
    '      switch (i) {',
    '        case 0:',
    '          int pathIndex = pathIndices[i];',
    '          if (usePreviousPath && pathIndex > 0) { pathIndex--; }',
    '          result.append(pathIndex);',
    '          break;',
    '        default:',
    '          break;',
    '      }',
    '    }',
    '    return result.toString();',
    '  }',
  ].join('\n'));
  const d = parsed.definitions.find((x) => x.name === 'pathIndex');
  assert.ok(d, 'the switch-case local is collected as a definition');
  // Two reads (`pathIndex > 0`, `.append(pathIndex)`), plus the `--`
  // update, which the parser counts as a read, not a write.
  assert.equal(d.readCount, 3, 'the reads inside the case resolve to the local');
  assert.equal(d.writeCount, 0, 'the update counts as a read');
});

// --- item 3: parse level -----------------------------------------------

test('gate (java): generic construction records the outermost class', () => {
  const parsed = parseSnippet([
    '  void run() {',
    '    Object a = new TypeToken<List<Tweet>>();',
    '    Object b = new java.util.ArrayList<String>();',
    '    Object c = new Outer.Inner<String>();',
    '    Object d = new com.example.Outer<String>.Inner<Integer>();',
    '    Object e = new ArrayList<>();',
    '    Object f = new Plain();',
    '  }',
  ].join('\n'));
  const ctors = parsed.calls.filter((c) => c.name === 'constructor' && !c.methodRef);
  assert.deepEqual(
    ctors.map((c) => c.forClass),
    ['TypeToken', 'ArrayList', 'Inner', 'Inner', 'ArrayList', 'Plain'],
    'forClass is the constructed class, never a type argument',
  );
});

test('gate (java): a generic method reference constructs its class', () => {
  const parsed = parseSnippet([
    '  void run() {',
    '    java.util.function.Supplier s = TypeToken<List<Tweet>>::new;',
    '    java.util.function.Supplier t = Outer.Inner::new;',
    '    java.util.function.Supplier u = TypeToken::new;',
    '    java.util.function.Supplier v = LinkedHashMap::new;',
    '    Runnable r = this::helper;',
    '  }',
    '  void helper() {}',
  ].join('\n'));
  const ctors = parsed.calls.filter((c) => c.name === 'constructor' && c.methodRef);
  assert.deepEqual(
    ctors.map((c) => c.forClass),
    ['TypeToken', 'Inner', 'TypeToken', 'LinkedHashMap'],
    '::new records a constructor call for the referenced class',
  );
  // The class name in a `::new` reference is a real reference: the
  // identifier child is a definition site (the last named child,
  // since `new` is anonymous), so the walk never records it — the
  // `::new` handler must, or an import used only this way looks
  // unused and is flagged SAFE (LockManager.java's LinkedHashMap).
  assert.ok(parsed.references.has('TypeToken'), 'TypeToken::new references TypeToken');
  assert.ok(parsed.references.has('LinkedHashMap'), 'LinkedHashMap::new references LinkedHashMap');
  assert.ok(parsed.references.has('Inner'), 'Outer.Inner::new references Inner');
  const helper = parsed.calls.find((c) => c.name === 'helper' && c.methodRef);
  assert.ok(helper, 'a plain method reference still records its method call');
  assert.ok(!parsed.calls.some((c) => c.name === 'TypeToken' && c.methodRef), 'no phantom method call named after the constructed class');
});

// --- item 3: scan level -------------------------------------------------

test('gate (java): an import used only through ::new stays live', () => {
  const f = findingsFor();
  const imp = f.find((x) => x.file.endsWith(FILE) && x.category === 'import' && x.symbol === 'ArrayList');
  assert.equal(imp, undefined, 'ArrayList is used only as ArrayList::new — its import must not be flagged');
  assert.equal(bySymbol(f, 'makeList', 'REVIEW').grade, 'REVIEW', 'the public makeList method is REVIEW like the other public methods');
});

test('gate (java): a constructor reached only through generic construction is live', () => {
  const f = findingsFor();
  // TypeTokenA is constructed only via TypeTokenA<String>::new and
  // TypeTokenB only via new TypeTokenB<List<Tweet>>(): neither
  // constructor may be flagged at all.
  const ctors = f.filter((x) => x.file.endsWith(FILE) && x.symbol === 'constructor');
  assert.equal(ctors.filter((x) => x.grade === 'SAFE').length, 1, 'only the never-constructed TypeTokenC constructor may be SAFE');
  assert.equal(bySymbol(f, 'constructor', 'SAFE').reason.includes('never called with this arity'), true, 'the SAFE constructor is the never-constructed one');
});

test('gate (java): SAFE false-positive rate is 0% on the fixture', () => {
  const f = findingsFor();
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    `variable:${FILE}:foo`, `variable:${FILE}:shadowed`,
    `variable:${FILE}:deadOnlyField`, `method:${FILE}:readDeadOnly`,
    `method:${FILE}:genuinelyPrivate`, `method:${FILE}:constructor`,
  ]);
  assert.equal(safe.length, expectedSafe.size, `expected ${expectedSafe.size} SAFE findings, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.file}:${s.symbol || ''}`))}`);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
  assert.equal(f.filter((x) => x.grade === 'REVIEW').length, 10, 'REVIEW count is pinned too');
  assert.equal(f.filter((x) => x.grade === 'KEEP').length, 0, 'no KEEP findings on this fixture');
});
