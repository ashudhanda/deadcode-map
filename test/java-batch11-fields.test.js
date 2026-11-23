'use strict';

/**
 * Batch 11: the field analog of the FJ-3 rule for locals.
 *
 * A private field that is never read or written, but whose
 * initializer calls a method or creates an object, is load-bearing:
 * deleting the declaration would remove that call (a field
 * initializer runs when the class loads / an instance is created,
 * so the call runs even though the field is never read). REVIEW,
 * never SAFE. A truly dead pure field stays SAFE, a call inside a
 * lambda body does not run at the declaration, so that field is
 * pure too, and a field with an effectful initializer that IS read
 * is live and gets no finding at all.
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
  return scan(path.join(ROOT, 'fixtures', 'java-batch11-fields'), { includeFixtures: true, javaSafe: true }).findings;
}

function bySymbol(findings, file, symbol, grade) {
  return findings.find((f) => f.file.endsWith(file) && f.symbol === symbol && (!grade || f.grade === grade));
}

test('field-analog: load-bearing unused fields are REVIEW, pure unused fields stay SAFE', () => {
  const f = findingsFor();
  const file = 'src/SideEffectFields.java';
  for (const symbol of ['count', 'copy', 'total', 'eager']) {
    assert.equal(bySymbol(f, file, symbol).grade, 'REVIEW',
      `${symbol} has a side-effecting initializer and must be REVIEW, never SAFE`);
    assert.equal(bySymbol(f, file, symbol, 'SAFE'), undefined, `${symbol} must not be SAFE`);
    assert.ok(bySymbol(f, file, symbol).reason.includes('initializer calls a method or creates an object'),
      `${symbol} reason must name the effectful initializer`);
  }
  // Pure initializers: a literal, and a lambda whose body does not
  // run at the declaration.
  assert.equal(bySymbol(f, file, 'pure').grade, 'SAFE', 'a pure unused field must stay SAFE');
  assert.equal(bySymbol(f, file, 'deferred').grade, 'SAFE',
    'a field initialized with a lambda is pure — the call inside the lambda body does not run at the declaration');
});

test('field-analog: a field with an effectful initializer that IS read is live', () => {
  const f = findingsFor();
  assert.equal(bySymbol(f, 'src/SideEffectFields.java', 'live'), undefined,
    'a read field gets no finding at all, even with an effectful initializer');
  // The helper the initializers call is live through the class
  // definition (field initializers run at class load), so it gets
  // no finding either.
  assert.equal(bySymbol(f, 'src/SideEffectFields.java', 'compute'), undefined,
    'a helper called only from field initializers is live through the class definition');
});

test('field-analog: SAFE false-positive rate is 0% on the fixture', () => {
  const f = findingsFor();
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'variable:src/SideEffectFields.java:pure',
    'variable:src/SideEffectFields.java:deferred',
  ]);
  assert.equal(safe.length, expectedSafe.size, `expected ${expectedSafe.size} SAFE findings, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.file}:${s.symbol || ''}`))}`);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
  assert.equal(f.length, 8, `expected 8 findings in total, got ${f.length}`);
  assert.equal(f.filter((x) => x.grade === 'REVIEW').length, 6, 'expected 6 REVIEW findings');
  assert.equal(f.filter((x) => x.grade === 'KEEP').length, 0, 'expected 0 KEEP findings');
});
