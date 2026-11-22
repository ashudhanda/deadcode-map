'use strict';

/**
 * Batch 9 (FJ-7 / FJ-9): Java same-file caller liveness.
 *
 * Java has no import resolution, so usageMap carries no cross-file
 * Java callers and the live roots used to be ~only topLevelUses —
 * usually empty. Every helper called only from a non-private method
 * of a package-private class then looked dead (FJ-7), and so did
 * every field read only from such a method (FJ-9). The fix seeds the
 * live roots with the file's own non-private methods, so liveness
 * flows transitively through same-file calls — while a genuinely
 * dead cluster (private A called only by private B, called by
 * nothing) must still be SAFE. Two more same-file shapes ride on
 * the same mechanism and are covered here too: calls from field
 * initializers (the class definition is a live root, since the tool
 * never proves a class dead) and calls between same-name /
 * same-arity overloads (the self-call exclusion is by definition
 * identity, not by (name, arity) key).
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
const FILE = 'src/CallerRoots.java';

function findingsFor() {
  return scan(path.join(ROOT, 'fixtures', 'java-batch9-fj7'), { includeFixtures: true, javaSafe: true }).findings;
}

function bySymbol(findings, symbol, grade) {
  return findings.find((f) => f.file.endsWith(FILE) && f.symbol === symbol && (!grade || f.grade === grade));
}

test('fj7: helpers called from non-private methods of a package-private class are live', () => {
  const f = findingsFor();
  // Direct calls from a public / package-private method, and the
  // transitive step through a private middle method.
  for (const symbol of ['helperFromPublic', 'helperFromPackage', 'middle', 'leaf']) {
    assert.equal(bySymbol(f, symbol), undefined, `${symbol} is called from a live root and must not be flagged`);
  }
  // Fields read by those live methods are live too (FJ-9).
  for (const symbol of ['usedByPublic', 'usedByPackage', 'usedByChain']) {
    assert.equal(bySymbol(f, symbol), undefined, `${symbol} is read from a live root and must not be flagged`);
  }
});

test('fj7: a dead cluster stays SAFE — the transitive verdict holds', () => {
  const f = findingsFor();
  // deadOuter is called only by deadInner, and deadInner is called by
  // nothing: "any same-file caller = live" at the name level would
  // rescue deadOuter, but liveness flows from live roots only.
  assert.equal(bySymbol(f, 'deadOuter').grade, 'SAFE', 'deadOuter is called only by a dead method');
  assert.equal(bySymbol(f, 'deadInner').grade, 'SAFE', 'deadInner is called by nothing');
  assert.equal(bySymbol(f, 'orphan').grade, 'SAFE', 'orphan is called by nothing');
  // A field read only by a dead method stays SAFE too (FJ-9), as does
  // a field never read or written at all.
  assert.equal(bySymbol(f, 'deadOnlyField').grade, 'SAFE', 'deadOnlyField is read only by a dead method');
  assert.equal(bySymbol(f, 'deadField').grade, 'SAFE', 'deadField is never read or written');
});

test('fj7: arity still decides — uncalled overloads stay SAFE', () => {
  const f = findingsFor();
  // The public method calls format/1; format/2 has no live caller.
  const formats = f.filter((x) => x.file.endsWith(FILE) && x.symbol === 'format');
  assert.equal(formats.length, 1, 'only format/2 may be flagged');
  assert.equal(formats[0].grade, 'SAFE', 'format/2 must be SAFE');
  // Same for the private overload sharing the public method's name:
  // serve/1 is a live root, but it never calls serve/2, so serve/2
  // must not become a root just by sharing the name.
  assert.equal(bySymbol(f, 'serve', 'SAFE').grade, 'SAFE', 'serve/2 must be SAFE');
  assert.equal(bySymbol(f, 'serve', 'REVIEW').grade, 'REVIEW', 'serve/1 stays REVIEW as a public method');
  // Pure self-call never rescues a method.
  assert.equal(bySymbol(f, 'selfOnly').grade, 'SAFE', 'selfOnly calls only itself');
});

test('fj7: helpers called from a field initializer are live', () => {
  const f = findingsFor();
  // A field initializer runs when the class loads, and the tool never
  // proves a class dead — so a helper called only from an initializer
  // is live, and so is the constant it reads and the field it builds
  // (the field is read by a public method too).
  for (const symbol of ['labelFromInitializer', 'PREFIX', 'label']) {
    assert.equal(bySymbol(f, symbol), undefined, `${symbol} is live through a field initializer and must not be flagged`);
  }
});

test('fj7: a call between same-name, same-arity overloads is not a self-call', () => {
  const f = findingsFor();
  // The public convert/1 (String) calls the private convert/1 (int):
  // two distinct overloads sharing a name and an arity. The old
  // key-based self-call exclusion swallowed that call and flagged the
  // private overload SAFE; the identity-based exclusion keeps it live.
  assert.equal(bySymbol(f, 'convert', 'SAFE'), undefined, 'convert/1 (int) is called by the public overload and must not be SAFE');
  assert.equal(bySymbol(f, 'convert', 'REVIEW').grade, 'REVIEW', 'convert/1 (String) stays REVIEW as a public method');
});

test('fj7: non-private methods keep their REVIEW findings', () => {
  const f = findingsFor();
  // Seeding the roots must not swallow the methods themselves: a
  // public / package-private method is REVIEW ("reachable from
  // outside this file"), never SAFE and never silently unflagged.
  for (const symbol of ['serve', 'pack', 'chain', 'show', 'showLabel', 'convert']) {
    assert.equal(bySymbol(f, symbol, 'REVIEW').grade, 'REVIEW', `${symbol} is non-private — REVIEW at most`);
  }
  // Constructors share the symbol 'constructor': the public ones are
  // REVIEW, the unused private arity-2 one is SAFE.
  const ctors = f.filter((x) => x.file.endsWith(FILE) && x.symbol === 'constructor');
  assert.ok(ctors.some((x) => x.grade === 'SAFE'), 'the unused private constructor must be SAFE');
  assert.ok(ctors.filter((x) => x.grade === 'REVIEW').length >= 2, 'the public constructors are REVIEW');
});

test('fj7: SAFE false-positive rate is 0% on the fixture', () => {
  const f = findingsFor();
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    `method:${FILE}:deadOuter`, `method:${FILE}:deadInner`,
    `method:${FILE}:orphan`, `method:${FILE}:format`,
    `method:${FILE}:selfOnly`, `method:${FILE}:serve`,
    `method:${FILE}:constructor`,
    `variable:${FILE}:deadField`, `variable:${FILE}:deadOnlyField`,
  ]);
  assert.equal(safe.length, expectedSafe.size, `expected ${expectedSafe.size} SAFE findings, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.file}:${s.symbol || ''}`))}`);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});
