'use strict';

/**
 * Java fixture tests: the FP rate on SAFE is the claim that matters.
 * Every live symbol in the Java fixture must NOT be flagged SAFE;
 * every planted dead item must be found at SAFE or REVIEW.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan } = require('../src/index');
const { parseJava } = require('../src/parse-java');
const { applyFix } = require('../src/fix');

const ROOT = path.join(__dirname, '..');
const BASIC = 'src/main/java/com/example/BasicService.java';
const FRAMEWORK = 'src/main/java/com/example/Frameworkish.java';
const MODERN = 'src/main/java/com/example/Modern.java';
const TEST_FILE = 'src/test/java/com/example/BasicServiceTest.java';

function findingsFor(dir) {
  return scan(path.join(ROOT, 'fixtures', dir), { includeFixtures: true }).findings;
}

function bySymbol(findings, file, symbol) {
  return findings.find((f) => f.file.endsWith(file) && f.symbol === symbol);
}

function byCategory(findings, file, category) {
  return findings.find((f) => f.file.endsWith(file) && f.category === category && !f.symbol);
}

test('java-basic: planted dead items are found at SAFE', () => {
  const f = findingsFor('java-basic');
  // Private methods (incl. private static, recursion-only, arity-2
  // overload, Javadoc-documented) and the unused private constructor.
  for (const symbol of ['deadMethod', 'recursiveMethod', 'format', 'privateStaticDead', 'documentedDead']) {
    assert.equal(bySymbol(f, BASIC, symbol).grade, 'SAFE', `${symbol} must be SAFE`);
    assert.equal(bySymbol(f, BASIC, symbol).category, 'method', `${symbol} must be a method finding`);
  }
  // Constructors share the symbol 'constructor': the private arity-2
  // one is SAFE, the public ones are REVIEW.
  const ctors = f.filter((x) => x.file.endsWith(BASIC) && x.symbol === 'constructor');
  assert.ok(ctors.some((x) => x.grade === 'SAFE'), 'the unused private constructor must be SAFE');
  assert.ok(ctors.filter((x) => x.grade === 'REVIEW').length >= 2, 'the public constructors are REVIEW');
  // Private fields, incl. both declarators of one statement and one
  // declarator of a mixed statement.
  for (const symbol of ['deadCounter', 'unusedLabel', 'multiA', 'multiB', 'mixedDead']) {
    assert.equal(bySymbol(f, BASIC, symbol).grade, 'SAFE', `${symbol} must be SAFE`);
    assert.equal(bySymbol(f, BASIC, symbol).category, 'variable', `${symbol} must be a variable finding`);
  }
  // Unused local in a live private method, unused imports, unreachable.
  assert.equal(bySymbol(f, BASIC, 'unusedLocal').grade, 'SAFE');
  assert.equal(bySymbol(f, BASIC, 'Map').grade, 'SAFE');
  assert.equal(bySymbol(f, BASIC, 'Map').category, 'import');
  assert.equal(bySymbol(f, BASIC, 'PI').grade, 'SAFE');
  assert.equal(bySymbol(f, BASIC, 'PI').category, 'import');
  assert.equal(byCategory(f, BASIC, 'unreachable').grade, 'SAFE');
  // Varargs method with no callers.
  assert.equal(bySymbol(f, MODERN, 'joinDead').grade, 'SAFE');
});

test('java-basic: SAFE false-positive rate is 0%', () => {
  const f = findingsFor('java-basic');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    `method:${BASIC}:deadMethod`, `method:${BASIC}:recursiveMethod`,
    `method:${BASIC}:format`, `method:${BASIC}:privateStaticDead`,
    `method:${BASIC}:documentedDead`, `method:${BASIC}:constructor`,
    `variable:${BASIC}:deadCounter`, `variable:${BASIC}:unusedLabel`,
    `variable:${BASIC}:multiA`, `variable:${BASIC}:multiB`,
    `variable:${BASIC}:mixedDead`, `variable:${BASIC}:unusedLocal`,
    `import:${BASIC}:Map`, `import:${BASIC}:PI`,
    `unreachable:${BASIC}`,
    `method:${MODERN}:joinDead`,
  ]);
  assert.equal(safe.length, expectedSafe.size, `expected ${expectedSafe.size} SAFE findings, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.file}:${s.symbol || ''}`))}`);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('java-basic: live symbols are never flagged', () => {
  const f = findingsFor('java-basic');
  // Called private methods (arity 1 overload, static, recursive
  // target, method-ref / lambda / anonymous-class targets).
  for (const [file, symbol] of [
    [BASIC, 'helperUsed'], [BASIC, 'privateStaticUsed'], [BASIC, 'compute'],
    [BASIC, 'counter'], [BASIC, 'total'], [BASIC, 'mixedLive'],
    [MODERN, 'viaMethodRef'], [MODERN, 'viaLambda'], [MODERN, 'viaAnon'],
    [MODERN, 'innerUsed'], [MODERN, 'join'],
  ]) {
    assert.equal(bySymbol(f, file, symbol), undefined, `${symbol} must not be flagged`);
  }
  // Same-arity overloads are one unit: only process(1) is called, but
  // both overloads stay live — exactly one `process` finding would be
  // a false SAFE, and there is none at all.
  assert.equal(bySymbol(f, MODERN, 'process'), undefined, 'process(int) and process(String) are one unit — both live');
  // The arity-1 overload has no finding either (format/2 is the only
  // `format` finding, and it is the dead one).
  assert.equal(f.filter((x) => x.symbol === 'format').length, 1, 'only format/2 may be flagged');
});

test('java-basic: framework traps are KEEP or REVIEW, never SAFE', () => {
  const f = findingsFor('java-basic');
  // Any annotation on a private member keeps it; native and
  // serialVersionUID are kept too.
  assert.equal(bySymbol(f, FRAMEWORK, 'serialVersionUID').grade, 'KEEP');
  assert.equal(bySymbol(f, FRAMEWORK, 'repo').grade, 'KEEP'); // @Autowired
  assert.equal(bySymbol(f, FRAMEWORK, 'injected').grade, 'KEEP'); // @Value
  assert.equal(bySymbol(f, FRAMEWORK, 'init').grade, 'KEEP'); // @PostConstruct
  assert.equal(bySymbol(f, FRAMEWORK, 'labelled').grade, 'KEEP'); // @JsonProperty
  assert.equal(bySymbol(f, FRAMEWORK, 'pollEvents').grade, 'KEEP'); // native
  // A framework stereotype on the enclosing class keeps members at
  // REVIEW at most — Spring, Lombok, JPA alike.
  assert.equal(bySymbol(f, FRAMEWORK, 'deadInService').grade, 'REVIEW');
  assert.equal(bySymbol(f, FRAMEWORK, 'deadFieldInService').grade, 'REVIEW');
  assert.equal(bySymbol(f, FRAMEWORK, 'beanHelper').grade, 'REVIEW'); // @Data
  assert.equal(bySymbol(f, FRAMEWORK, 'name').grade, 'REVIEW'); // @Data field
  assert.equal(bySymbol(f, FRAMEWORK, 'count').grade, 'REVIEW'); // @Data field
  assert.equal(bySymbol(f, FRAMEWORK, 'entityHelper').grade, 'REVIEW'); // @Entity
  assert.equal(bySymbol(f, FRAMEWORK, 'id').grade, 'REVIEW'); // @Entity field
});

test('java-basic: string mentions downgrade to REVIEW, never SAFE', () => {
  const f = findingsFor('java-basic');
  // Reflection in the same file, Spring properties, a MyBatis mapper
  // XML, and a string literal in another Java file.
  assert.equal(bySymbol(f, BASIC, 'byNameOnly').grade, 'REVIEW');
  assert.equal(bySymbol(f, FRAMEWORK, 'byNameOnly').grade, 'REVIEW');
  assert.equal(bySymbol(f, BASIC, 'configOnly').grade, 'REVIEW');
  assert.equal(bySymbol(f, BASIC, 'xmlOnly').grade, 'REVIEW');
  assert.equal(bySymbol(f, BASIC, 'javaStringOnly').grade, 'REVIEW');
});

test('java-basic: write-only fields, non-private members and unused parameters are REVIEW, never SAFE', () => {
  const f = findingsFor('java-basic');
  // Written but never read: deleting the declaration would leave the
  // assignments behind.
  assert.equal(bySymbol(f, BASIC, 'side').grade, 'REVIEW');
  assert.equal(bySymbol(f, BASIC, 'writeOnlyCounter').grade, 'REVIEW');
  // Public / protected / package-private members are reachable from
  // outside the file.
  for (const symbol of ['live', 'sum', 'describe', 'items', 'runCompute']) {
    assert.equal(bySymbol(f, BASIC, symbol).grade, 'REVIEW', `${symbol} is public — REVIEW at most`);
  }
  assert.equal(bySymbol(f, MODERN, 'demo').grade, 'REVIEW');
  assert.equal(bySymbol(f, MODERN, 'runProcess').grade, 'REVIEW');
  // Unused parameters are REVIEW, never SAFE: deleting one changes
  // the method's arity, so every call site would break.
  for (const symbol of ['unusedParam', 'flag', 'n']) {
    assert.equal(bySymbol(f, BASIC, symbol).grade, 'REVIEW', `${symbol} is an unused parameter — REVIEW at most`);
  }
  assert.equal(bySymbol(f, MODERN, 'parts').grade, 'REVIEW');
  // The public constructor's unused parameter is REVIEW for the same
  // reason (plus the API break).
  assert.equal(bySymbol(f, BASIC, 'label').grade, 'REVIEW');
});

test('java-basic: test sources are KEEP at most, never SAFE', () => {
  const f = findingsFor('java-basic');
  assert.equal(byCategory(f, TEST_FILE, 'file'), undefined, 'a Java test file is never a dead file');
  assert.equal(bySymbol(f, TEST_FILE, 'testLive').grade, 'KEEP');
  assert.equal(bySymbol(f, TEST_FILE, 'testHelper').grade, 'KEEP');
  assert.equal(bySymbol(f, TEST_FILE, 'Test').grade, 'KEEP');
  assert.equal(bySymbol(f, TEST_FILE, 'Test').category, 'import');
  assert.equal(f.filter((x) => x.file.endsWith(TEST_FILE) && x.grade === 'SAFE').length, 0);
});

test('java-basic: modern syntax parses cleanly, no Java file is a dead file', () => {
  const { graph, findings } = scan(path.join(ROOT, 'fixtures', 'java-basic'), { includeFixtures: true });
  for (const [, info] of graph.files) {
    if (info.ext !== '.java') continue;
    assert.ok(info.parsed, `${info.rel} must parse`);
    assert.equal(info.parseError, null, `${info.rel} must have no parse errors`);
    assert.equal(info.parsed.hasErrors, false, `${info.rel} must have no ERROR/MISSING nodes`);
  }
  // Records, sealed types, pattern matching, text blocks, var and
  // switch expressions all parsed (Modern.java has definitions).
  const modern = [...graph.files.values()].find((i) => i.rel.endsWith('Modern.java'));
  assert.ok(modern.parsed.definitions.some((d) => d.name === 'Point'), 'record Point must be parsed');
  assert.ok(modern.parsed.definitions.some((d) => d.name === 'Shape'), 'sealed interface Shape must be parsed');
  assert.equal(findings.filter((x) => x.category === 'file' && x.file.endsWith('.java')).length, 0,
    'Java files are never dead-file candidates (no import resolution yet)');
});

test('java: a file with ERROR/MISSING nodes yields no SAFE findings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-java-broken-'));
  const broken = 'package broken;\npublic class Broken {\n  private void dead() {\n    int x = ;\n  }\n  private int alsoDead;\n}\n';
  fs.writeFileSync(path.join(dir, 'Broken.java'), broken);
  const parsed = parseJava(path.join(dir, 'Broken.java'), broken);
  assert.equal(parsed.hasErrors, true, 'the broken file must set hasErrors');
  const f = scan(dir).findings;
  assert.equal(f.length, 0, `a broken file must yield no findings at all, got: ${JSON.stringify(f.map((x) => `${x.file}:${x.symbol || ''}`))}`);
});

test('java-basic: --fix deletes dead methods with their Javadoc, dead fields and unused imports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-java-fix-'));
  fs.cpSync(path.join(ROOT, 'fixtures', 'java-basic'), dir, { recursive: true });
  const before = scan(dir);
  const safe = before.findings.filter((x) => x.grade === 'SAFE');
  assert.ok(safe.length > 0, 'fixture must have SAFE findings to fix');
  const result = applyFix(dir, before.graph, safe);
  assert.equal(result.safeCount, safe.length);
  const basic = fs.readFileSync(path.join(dir, BASIC), 'utf8');
  // The dead method and its Javadoc are gone together.
  assert.ok(!basic.includes('documentedDead'), 'documentedDead must be deleted');
  assert.ok(!basic.includes('Javadoc for a dead method'), 'the orphaned Javadoc must go with the method');
  assert.ok(!basic.includes('deadMethod'), 'deadMethod must be deleted');
  assert.ok(!basic.includes('recursiveMethod'), 'recursiveMethod must be deleted');
  assert.ok(!basic.includes('privateStaticDead'), 'privateStaticDead must be deleted');
  // Both declarators of one statement go together (whole statement);
  // the mixed statement keeps its live declarator, comma intact.
  assert.ok(!basic.includes('multiA'), 'multiA must be deleted');
  assert.ok(!basic.includes('multiB'), 'multiB must be deleted');
  assert.ok(!basic.includes('mixedDead'), 'mixedDead must be deleted');
  assert.ok(basic.includes('mixedLive'), 'mixedLive must stay');
  assert.ok(!basic.includes('private int mixedDead'), 'no bare type must be left behind');
  // Unused imports are gone; the used ones and the on-demand import stay.
  assert.ok(!basic.includes('import java.util.Map;'), 'unused Map import must be deleted');
  assert.ok(!basic.includes('import static java.lang.Math.PI;'), 'unused PI import must be deleted');
  assert.ok(basic.includes('import java.util.List;'), 'used List import must stay');
  assert.ok(basic.includes('import java.util.*;'), 'on-demand import must stay');
  // The unused local is gone; the unused parameter is REVIEW, so the
  // signature and its call site are untouched.
  assert.ok(!basic.includes('unusedLocal'), 'unusedLocal must be deleted');
  assert.ok(basic.includes('compute(int used, int unusedParam)'), 'an unused parameter is REVIEW — the signature must stay');
  assert.ok(basic.includes('compute(21, 0)'), 'the call site must stay');
  // The fixed files still parse cleanly, and a re-scan finds 0 SAFE.
  for (const rel of [BASIC, MODERN]) {
    const parsed = parseJava(path.join(dir, rel), fs.readFileSync(path.join(dir, rel), 'utf8'));
    assert.equal(parsed.hasErrors, false, `${rel} must still parse after --fix`);
  }
  const after = scan(dir);
  assert.equal(after.findings.filter((x) => x.grade === 'SAFE').length, 0,
    `re-scan after --fix must find 0 SAFE, got: ${JSON.stringify(after.findings.filter((x) => x.grade === 'SAFE').map((x) => `${x.file}:${x.symbol || ''}`))}`);
});
