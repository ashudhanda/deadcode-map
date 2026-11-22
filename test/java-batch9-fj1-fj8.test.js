'use strict';

/**
 * Batch 9 FJ-1 / FJ-8: Java imports that are live only through Javadoc
 * or through a package-info annotation must never be flagged SAFE.
 *
 * FJ-1 — an import referenced only in Javadoc {@link} / {@linkplain} /
 * {@code} / @see resolves a documentation link; removing it breaks
 * Javadoc compilation, so it is live.
 * FJ-8 — an import used as an annotation on the package declaration in
 * package-info.java (e.g. @NullMarked) is a real use; the batch-7
 * annotation fix covered class/method annotations but not package
 * annotations, whose name sits inside the package_declaration node.
 *
 * These tests run with javaSafe: true — they measure the Java grading
 * engine itself. Java SAFE is OFF by default (batch 9 gate).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan } = require('../src/index');
const { parseJava } = require('../src/parse-java');

function bySymbol(findings, file, symbol) {
  return findings.find((f) => f.file.endsWith(file) && f.symbol === symbol);
}

function writeTemp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-java-fj1-fj8-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('fj-1: an import used only in Javadoc {@link} is live, never SAFE', () => {
  const dir = writeTemp({
    'Doc.java': `package com.example;

import java.util.Arrays;
import java.util.Objects;
import java.util.HashMap;

/**
 * Compares values, see {@link Arrays} and {@link Objects#equals(Object, Object)}.
 */
public class Doc {
  public boolean same(Object a, Object b) {
    return a == b;
  }
}
`,
  });
  const f = scan(dir, { javaSafe: true }).findings;
  assert.equal(bySymbol(f, 'Doc.java', 'Arrays'), undefined, 'an import used only in {@link} must not be flagged');
  assert.equal(bySymbol(f, 'Doc.java', 'Objects'), undefined, 'an import used only in {@link Type#member} must not be flagged');
  assert.equal(bySymbol(f, 'Doc.java', 'HashMap').grade, 'SAFE', 'a genuinely unused import in the same file must still be SAFE');
});

test('fj-1: {@linkplain}, {@code} and @see keep an import live; plain prose does not', () => {
  const dir = writeTemp({
    'Doc2.java': `package com.example;

import java.util.List;
import java.util.Set;
import java.util.Map;
import java.util.Queue;

/**
 * A {@linkplain List} of entries.
 * Example: {@code Set} holds the keys.
 * The Queue is drained elsewhere, not here.
 *
 * @see Map
 */
public class Doc2 {
  public int size() {
    return 0;
  }
}
`,
  });
  const f = scan(dir, { javaSafe: true }).findings;
  assert.equal(bySymbol(f, 'Doc2.java', 'List'), undefined, '{@linkplain} keeps the import live');
  assert.equal(bySymbol(f, 'Doc2.java', 'Set'), undefined, '{@code} keeps the import live');
  assert.equal(bySymbol(f, 'Doc2.java', 'Map'), undefined, '@see keeps the import live');
  assert.equal(bySymbol(f, 'Doc2.java', 'Queue').grade, 'SAFE', 'a plain prose mention in a comment must NOT keep an import live');
});

test('fj-1: fully-qualified {@link} and {@link #member} references', () => {
  const dir = writeTemp({
    'Doc3.java': `package com.example;

import java.util.Date;
import java.util.Calendar;

/**
 * See {@link java.util.Date} for the epoch.
 * See {@link #today()} for the current day.
 */
public class Doc3 {
  public String today() {
    return "";
  }
}
`,
  });
  const f = scan(dir, { javaSafe: true }).findings;
  assert.equal(bySymbol(f, 'Doc3.java', 'Date'), undefined, 'a fully-qualified {@link} names its simple type');
  assert.equal(bySymbol(f, 'Doc3.java', 'Calendar').grade, 'SAFE', 'an import named by no tag stays SAFE');
  // A {@link #member} names no type: it must not rescue anything by
  // accident, and the method itself stays gradable.
  const parsed = parseJava(path.join(dir, 'Doc3.java'), fs.readFileSync(path.join(dir, 'Doc3.java'), 'utf8'));
  assert.ok(parsed.references.has('Date'), 'Date must be in references');
  assert.ok(!parsed.references.has('today'), 'a #member link must not add a reference');
});

test('fj-1: types inside a member signature, nested types, @throws and {@value}', () => {
  const dir = writeTemp({
    'Doc5.java': `package com.example;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SortedMap;

/**
 * See {@link Reader#setStrictness(List)} and
 * {@link Outer.Inner#PER_CLASS PER_CLASS} for the lifecycle.
 * See {@value Outer#PLACEHOLDER} for the placeholder.
 *
 * @see Helper#combine(Map, Set)
 * @throws IllegalStateException if the value is not valid
 */
public class Doc5 {
  public int size() {
    return 0;
  }
}
`,
  });
  const f = scan(dir, { javaSafe: true }).findings;
  assert.equal(bySymbol(f, 'Doc5.java', 'List'), undefined, 'a type inside a {@link} member signature keeps its import live');
  assert.equal(bySymbol(f, 'Doc5.java', 'Map'), undefined, 'a type inside an @see member signature keeps its import live');
  assert.equal(bySymbol(f, 'Doc5.java', 'Set'), undefined, 'a second type inside an @see member signature keeps its import live');
  assert.equal(bySymbol(f, 'Doc5.java', 'SortedMap').grade, 'SAFE', 'an import named by no tag stays SAFE');
  const parsed = parseJava(path.join(dir, 'Doc5.java'), fs.readFileSync(path.join(dir, 'Doc5.java'), 'utf8'));
  assert.ok(parsed.references.has('Outer'), 'a nested type before # names its outer type too');
  assert.ok(parsed.references.has('Inner'), 'a nested type before # names its inner type too');
  assert.ok(parsed.references.has('IllegalStateException'), '@throws names its exception type');
});

test('fj-1: a {@link #member(Type)} signature names the parameter type, not the member', () => {
  const dir = writeTemp({
    'Doc6.java': `package com.example;

import java.util.Date;

/**
 * See {@link #at(Date)} for the dated variant.
 */
public class Doc6 {
  public String at(Date d) {
    return "";
  }
}
`,
  });
  // Date is used in code here as well as in the doc link; the point
  // of this test is the parser shape: the #member itself adds no
  // reference, the parameter type does.
  const parsed = parseJava(path.join(dir, 'Doc6.java'), fs.readFileSync(path.join(dir, 'Doc6.java'), 'utf8'));
  assert.ok(parsed.references.has('Date'), 'the parameter type inside a #member signature is a reference');
  assert.ok(!parsed.references.has('at'), 'the #member name itself is not a reference');
  const f = scan(dir, { javaSafe: true }).findings;
  assert.equal(bySymbol(f, 'Doc6.java', 'Date'), undefined, 'the import stays live');
});

test('fj-1: a lowercase {@code} token is code, not a type — it keeps nothing live', () => {
  const dir = writeTemp({
    'Doc7.java': `package com.example;

import java.util.Map;

/**
 * The {@code cache} is drained elsewhere. See {@code Map} for the type.
 */
public class Doc7 {
  private String cache;

  private void dead() {
  }
}
`,
  });
  const parsed = parseJava(path.join(dir, 'Doc7.java'), fs.readFileSync(path.join(dir, 'Doc7.java'), 'utf8'));
  assert.ok(!parsed.references.has('cache'), 'a lowercase {@code} token must not become a reference');
  assert.ok(parsed.references.has('Map'), 'a capitalized {@code} token is a type reference');
  const f = scan(dir, { javaSafe: true }).findings;
  assert.equal(bySymbol(f, 'Doc7.java', 'Map'), undefined, 'the capitalized {@code} import stays live');
  assert.equal(bySymbol(f, 'Doc7.java', 'cache').grade, 'SAFE', 'a field named only by a lowercase {@code} token stays SAFE');
});

test('fj-1: a Javadoc reference is not a code occurrence (no live-root leak)', () => {
  const dir = writeTemp({
    'Doc4.java': `package com.example;

import java.util.ArrayList;

/**
 * Builds an {@link ArrayList}.
 */
public class Doc4 {
  private String deadList;

  private void deadHelper() {
  }
}
`,
  });
  const parsed = parseJava(path.join(dir, 'Doc4.java'), fs.readFileSync(path.join(dir, 'Doc4.java'), 'utf8'));
  assert.ok(parsed.references.has('ArrayList'), 'the doc name must be a reference');
  assert.ok(!parsed.topLevelUses.includes('ArrayList'), 'a doc name must not become a top-level use');
  const f = scan(dir, { javaSafe: true }).findings;
  assert.equal(bySymbol(f, 'Doc4.java', 'ArrayList'), undefined, 'the {@link} import stays live');
  assert.equal(bySymbol(f, 'Doc4.java', 'deadHelper').grade, 'SAFE', 'an unrelated dead method stays SAFE');
});

test('fj-8: an import used as a package annotation in package-info.java is live', () => {
  const dir = writeTemp({
    'package-info.java': `/**
 * Annotation-based conditions for enabling or disabling tests.
 */

@NullMarked
package com.example.cond;

import org.jspecify.annotations.NullMarked;
import java.util.List;
`,
  });
  const f = scan(dir, { javaSafe: true }).findings;
  assert.equal(bySymbol(f, 'package-info.java', 'NullMarked'), undefined, 'an import used only by a package annotation must not be flagged');
  assert.equal(bySymbol(f, 'package-info.java', 'List').grade, 'SAFE', 'a genuinely unused import in package-info.java must still be SAFE');
});

test('fj-8: a qualified package annotation and @NullUnmarked are live too', () => {
  const dir = writeTemp({
    'package-info.java': `/**
 * Package docs.
 */

@NullUnmarked
package com.example.other;

import org.jspecify.annotations.NullUnmarked;
`,
    'Other.java': `package com.example.other;

import org.jspecify.annotations.NullMarked;

@org.jspecify.annotations.NullMarked
public class Other {
}
`,
  });
  const f = scan(dir, { javaSafe: true }).findings;
  assert.equal(bySymbol(f, 'package-info.java', 'NullUnmarked'), undefined, '@NullUnmarked on the package declaration must not be flagged');
  assert.equal(bySymbol(f, 'Other.java', 'NullMarked'), undefined, 'a qualified package-style annotation use must not be flagged');
});

test('fj-8: package path identifiers are still not references', () => {
  const dir = writeTemp({
    'package-info.java': `/**
 * Package docs.
 */

@NullMarked
package org.example.cond;

import org.jspecify.annotations.NullMarked;
`,
  });
  const parsed = parseJava(path.join(dir, 'package-info.java'), fs.readFileSync(path.join(dir, 'package-info.java'), 'utf8'));
  assert.ok(parsed.references.has('NullMarked'), 'the package annotation name must be a reference');
  assert.ok(!parsed.references.has('org'), 'package path segments must not be references');
  assert.ok(!parsed.references.has('cond'), 'package path segments must not be references');
});
