'use strict';

/**
 * Batch 10 (FJ-2 / FJ-3 / FJ-4): Java policy judgments.
 *
 * FJ-2 — a private constructor of an all-static utility class is an
 * instantiation guard, not dead code: its purpose is precisely to be
 * uncallable, and deleting it would expose a public default
 * constructor and change the class's API (and trip Error Prone's
 * PrivateConstructorForUtilityClass check). So it is KEEP, never
 * SAFE — while a private constructor of a class WITH instance
 * members stays SAFE when uncalled. A private enum constructor is
 * KEEP too, but only when no constant invokes it: the constants
 * invoke the constructor at class-load time and the call graph
 * records that (batch 10), so an invoked constructor is live and
 * gets no finding; an uninvoked one is still the wrong deletion
 * unit for an enum.
 *
 * FJ-3 — an unused local whose initializer calls a method or creates
 * an object is load-bearing: deleting the declaration would remove
 * that call (advancing a reader, validating input, running the
 * measured work). REVIEW, never SAFE. A truly dead pure local stays
 * SAFE, and a call inside a lambda body does not run at the
 * declaration, so that local is pure too.
 *
 * FJ-4 — private Java serialization callbacks (readObject /
 * writeObject arity 1, readObjectNoData / readResolve / writeReplace
 * arity 0) are invoked by the serialization runtime via reflection,
 * never by in-repo code: KEEP, never SAFE. The (name, arity) pair
 * is the contract — a same-named method with another arity grades
 * normally.
 *
 * These tests run with javaSafe: true — they measure the Java grading
 * engine itself. By default Java SAFE is OFF (batch 9 gate), so a
 * plain scan reports Java findings at REVIEW at most.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { scan } = require('../src/index');

const ROOT = path.join(__dirname, '..');

function findingsFor() {
  return scan(path.join(ROOT, 'fixtures', 'java-batch10-policy'), { includeFixtures: true, javaSafe: true }).findings;
}

function inFile(findings, file) {
  return findings.filter((f) => f.file.endsWith(file));
}

function bySymbol(findings, file, symbol, grade) {
  return findings.find((f) => f.file.endsWith(file) && f.symbol === symbol && (!grade || f.grade === grade));
}

test('fj2: a private constructor of an all-static utility class is KEEP', () => {
  const f = findingsFor();
  // No SAFE constructor in the utility class — and the KEEP verdict
  // is recorded, not silently dropped.
  assert.equal(bySymbol(f, 'src/UtilityClass.java', 'constructor', 'SAFE'), undefined,
    'the utility-class constructor is an instantiation guard, never SAFE');
  assert.equal(bySymbol(f, 'src/UtilityClass.java', 'constructor', 'KEEP').grade, 'KEEP',
    'the utility-class constructor must be KEEP');
  // The anonymous Runnable inside the class must not count as an
  // instance member: the class is still a utility class.
  assert.equal(bySymbol(f, 'src/UtilityClass.java', 'constructor', 'KEEP').reason.includes('utility class'), true,
    'the KEEP reason must name the utility-class policy');
  // The genuinely dead private static helper in the same class still
  // grades normally.
  assert.equal(bySymbol(f, 'src/UtilityClass.java', 'helper').grade, 'SAFE',
    'an uncalled private static helper of a utility class is still SAFE');
});

test('fj2: a private enum constructor invoked by constants is live, one no constant invokes is KEEP', () => {
  const f = findingsFor();
  const ctors = f.filter((x) => x.file.endsWith('src/EnumConstants.java') && x.symbol === 'constructor');
  // The EnumConstants(String) constructor is invoked by FIRST and
  // SECOND at class-load time, and the call graph records that — so
  // it is live and gets no finding at all. Only the UnusedArity(int)
  // constructor, invoked by no constant, is flagged.
  assert.equal(ctors.length, 1, 'exactly one enum constructor is flagged: the uninvoked one');
  assert.equal(ctors[0].grade, 'KEEP', 'the uninvoked constructor is KEEP, never SAFE');
  assert.ok(ctors[0].reason.includes('wrong deletion unit'),
    'the KEEP reason must name the deletion-unit policy');
});

test('fj2: a private constructor of a class with instance members stays SAFE', () => {
  const f = findingsFor();
  // NonUtilityCtor has an instance field and an instance method, so
  // the guard reasoning does not apply: the uncalled private
  // constructor is dead code.
  assert.equal(bySymbol(f, 'src/NonUtilityCtor.java', 'constructor').grade, 'SAFE',
    'an uncalled private constructor of a non-utility class must stay SAFE');
  // Same boundary inside the locals fixture: SideEffectLocals has an
  // instance method, so its private constructor is SAFE too.
  assert.equal(bySymbol(f, 'src/SideEffectLocals.java', 'constructor').grade, 'SAFE',
    'an uncalled private constructor of a class with an instance method must stay SAFE');
});

test('fj3: load-bearing unused locals are REVIEW, pure unused locals stay SAFE', () => {
  const f = findingsFor();
  const file = 'src/SideEffectLocals.java';
  for (const symbol of ['count', 'copy', 'total', 'eager']) {
    assert.equal(bySymbol(f, file, symbol).grade, 'REVIEW',
      `${symbol} has a side-effecting initializer and must be REVIEW, never SAFE`);
    assert.equal(bySymbol(f, file, symbol, 'SAFE'), undefined, `${symbol} must not be SAFE`);
  }
  // Pure initializers: a literal, and a lambda whose body does not
  // run at the declaration.
  assert.equal(bySymbol(f, file, 'pure').grade, 'SAFE', 'a pure unused local must stay SAFE');
  assert.equal(bySymbol(f, file, 'deferred').grade, 'SAFE',
    'a local initialized with a lambda is pure — the call inside the lambda body does not run at the declaration');
});

test('fj4: serialization callbacks are KEEP, wrong-arity namesakes grade normally', () => {
  const f = findingsFor();
  const file = 'src/SerializationCallbacks.java';
  for (const symbol of ['writeObject', 'readObject', 'readObjectNoData', 'readResolve', 'writeReplace']) {
    assert.equal(bySymbol(f, file, symbol, 'KEEP').grade, 'KEEP',
      `${symbol} is a serialization callback and must be KEEP`);
  }
  // The callbacks with no same-named namesake must have no SAFE
  // finding at all; readObject / writeReplace have one each, covered
  // below.
  for (const symbol of ['writeObject', 'readObjectNoData', 'readResolve']) {
    assert.equal(bySymbol(f, file, symbol, 'SAFE'), undefined, `${symbol} must not be SAFE`);
  }
  // Same name, wrong arity: not a callback — an ordinary private
  // method with no callers, so SAFE. There are two findings per
  // name (one KEEP callback, one SAFE namesake).
  for (const symbol of ['readObject', 'writeReplace']) {
    const all = inFile(f, file).filter((x) => x.symbol === symbol);
    assert.equal(all.length, 2, `${symbol} must have exactly two findings (KEEP callback + SAFE namesake)`);
    assert.ok(all.some((x) => x.grade === 'SAFE'), `${symbol} with the wrong arity must be SAFE`);
  }
});

test('fj2/fj3/fj4: SAFE false-positive rate is 0% on the fixture', () => {
  const f = findingsFor();
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'method:src/UtilityClass.java:helper',
    'method:src/SerializationCallbacks.java:readObject',
    'method:src/SerializationCallbacks.java:writeReplace',
    'method:src/SideEffectLocals.java:constructor',
    'method:src/NonUtilityCtor.java:constructor',
    'variable:src/SideEffectLocals.java:pure',
    'variable:src/SideEffectLocals.java:deferred',
  ]);
  assert.equal(safe.length, expectedSafe.size, `expected ${expectedSafe.size} SAFE findings, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.file}:${s.symbol || ''}`))}`);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});
