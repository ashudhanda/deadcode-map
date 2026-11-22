'use strict';

/**
 * javac validation of the Java analyzer output (batch 7).
 *
 * javac is NOT installed in this environment (no /usr/lib/jvm, no
 * javac on PATH), so the compile check below is skipped here and the
 * static verification runs instead: the --fix output must still parse
 * cleanly through tree-sitter with zero ERROR/MISSING nodes, and a
 * re-scan must find 0 SAFE. That is the documented substitute, not a
 * silent pass — the skipped test names the reason.
 *
 * Where javac IS installed (major version 21 or later), the skipped
 * test compiles the fixture main sources before and after --fix and
 * requires both compilations to succeed. Two fixture facts force the
 * shape of that test, documented here so a future failure is
 * diagnosable rather than mysterious:
 *  - The fixtures use framework annotations with no imports
 *    (@Service, @Autowired, @Value, @PostConstruct, @JsonProperty,
 *    @Data, @Entity) and a UserRepo type with no definition, so the
 *    test generates stub annotation types and a UserRepo stub in the
 *    same package (com.example) in a scratch copy. The fixtures
 *    themselves are untouched.
 *  - Modern.java uses pattern matching in a switch expression, which
 *    is standard only from Java 21 (preview in 17-20), so the compile
 *    test requires javac 21+. Test sources are never compiled: they
 *    import org.junit.jupiter.api, which is not on this machine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan } = require('../src/index');
const { parseJava } = require('../src/parse-java');
const { applyFix } = require('../src/fix');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'fixtures', 'java-basic');
const MAIN_JAVA = path.join('src', 'main', 'java');

function detectJavac() {
  try {
    const run = spawnSync('javac', ['-version'], { encoding: 'utf8' });
    if (run.error || run.status !== 0) return { present: false, version: null, major: null };
    const out = `${run.stdout || ''}${run.stderr || ''}`.trim();
    const m = out.match(/javac\s+(\d+)(?:\.(\d+))?/);
    return { present: true, version: out, major: m ? parseInt(m[1], 10) : null };
  } catch (_) {
    return { present: false, version: null, major: null };
  }
}

const JAVAC = detectJavac();

// Stub annotation types and the UserRepo type the fixtures reference
// without defining or importing. Generated into the scratch compile
// copy only, in the fixtures' own package so the unqualified names
// resolve. Each stub is the smallest compilable shape for its use:
// @Value("${app.name}") and @JsonProperty("label") take a String
// value; the rest are marker annotations.
const STUBS = {
  'Service.java': 'package com.example;\nimport java.lang.annotation.*;\n@Retention(RetentionPolicy.RUNTIME)\n@Target(ElementType.TYPE)\npublic @interface Service {}\n',
  'Autowired.java': 'package com.example;\nimport java.lang.annotation.*;\n@Retention(RetentionPolicy.RUNTIME)\n@Target({ElementType.FIELD, ElementType.METHOD, ElementType.CONSTRUCTOR, ElementType.PARAMETER})\npublic @interface Autowired {}\n',
  'Value.java': 'package com.example;\nimport java.lang.annotation.*;\n@Retention(RetentionPolicy.RUNTIME)\n@Target({ElementType.FIELD, ElementType.METHOD, ElementType.PARAMETER, ElementType.ANNOTATION_TYPE})\npublic @interface Value { String value(); }\n',
  'PostConstruct.java': 'package com.example;\nimport java.lang.annotation.*;\n@Retention(RetentionPolicy.RUNTIME)\n@Target(ElementType.METHOD)\npublic @interface PostConstruct {}\n',
  'JsonProperty.java': 'package com.example;\nimport java.lang.annotation.*;\n@Retention(RetentionPolicy.RUNTIME)\n@Target({ElementType.FIELD, ElementType.METHOD, ElementType.PARAMETER})\npublic @interface JsonProperty { String value() default ""; }\n',
  'Data.java': 'package com.example;\nimport java.lang.annotation.*;\n@Retention(RetentionPolicy.RUNTIME)\n@Target(ElementType.TYPE)\npublic @interface Data {}\n',
  'Entity.java': 'package com.example;\nimport java.lang.annotation.*;\n@Retention(RetentionPolicy.RUNTIME)\n@Target(ElementType.TYPE)\npublic @interface Entity {}\n',
  'UserRepo.java': 'package com.example;\npublic class UserRepo {}\n',
};

function listJavaFiles(dir) {
  const out = [];
  const walkDir = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const target = path.join(d, entry.name);
      if (entry.isDirectory()) walkDir(target);
      else if (entry.name.endsWith('.java')) out.push(target);
    }
  };
  walkDir(dir);
  return out.sort();
}

function compileMainSources(mainJavaDir, label) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-java-javac-out-'));
  const files = listJavaFiles(mainJavaDir);
  assert.ok(files.length > 0, `no Java sources to compile (${label})`);
  const run = spawnSync('javac', ['-d', outDir, ...files], { encoding: 'utf8' });
  assert.equal(run.status, 0, `javac must compile the fixture main sources (${label}); stderr:\n${run.stderr || ''}`);
  return outDir;
}

function compileCopyWithStubs(sourceMainJavaDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-java-javac-'));
  const target = path.join(dir, MAIN_JAVA);
  fs.cpSync(sourceMainJavaDir, target, { recursive: true });
  const stubDir = path.join(target, 'com', 'example');
  for (const [name, content] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(stubDir, name), content);
  }
  return target;
}

test('java: --fix output parses cleanly (static verification, runs without javac)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-java-fix-verify-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  // Every fixture Java file parses with zero ERROR/MISSING nodes
  // before the fix, so the after-fix check below measures the fix.
  for (const file of listJavaFiles(dir)) {
    const parsed = parseJava(file, fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.hasErrors, false, `${path.relative(dir, file)} must parse before --fix`);
  }
  const before = scan(dir, { javaSafe: true });
  const safe = before.findings.filter((x) => x.grade === 'SAFE');
  assert.equal(safe.length, 16, `the fixture exact SAFE set must be 16 before --fix, got ${safe.length}`);
  const result = applyFix(dir, before.graph, safe);
  assert.equal(result.safeCount, safe.length);
  for (const file of listJavaFiles(dir)) {
    const parsed = parseJava(file, fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.hasErrors, false,
      `${path.relative(dir, file)} must still parse with zero ERROR/MISSING nodes after --fix`);
  }
  const after = scan(dir, { javaSafe: true });
  assert.equal(after.findings.filter((x) => x.grade === 'SAFE').length, 0,
    're-scan after --fix must find 0 SAFE');
});

test('java: javac compiles fixtures before and after --fix', {
  skip: !JAVAC.present
    ? 'javac is not installed in this environment (no /usr/lib/jvm, no javac on PATH) — compile check skipped; the static tree-sitter verification above covers the fix output instead'
    : JAVAC.major === null || JAVAC.major < 21
      ? `javac ${JAVAC.version || 'unknown version'} is older than 21 — Modern.java uses switch pattern matching, standard only from Java 21`
      : false,
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-java-javac-fix-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  // Before --fix: the fixture main sources (plus generated stubs for
  // the annotation types and UserRepo the fixtures reference without
  // defining) must compile.
  compileMainSources(compileCopyWithStubs(path.join(dir, MAIN_JAVA)), 'before --fix');
  const before = scan(dir, { javaSafe: true });
  const safe = before.findings.filter((x) => x.grade === 'SAFE');
  assert.equal(safe.length, 16, `the fixture exact SAFE set must be 16 before --fix, got ${safe.length}`);
  const result = applyFix(dir, before.graph, safe);
  assert.equal(result.safeCount, safe.length);
  // After --fix: the same sources must still compile — a fix that
  // broke the build is a failed fix, whatever the re-scan says.
  compileMainSources(compileCopyWithStubs(path.join(dir, MAIN_JAVA)), 'after --fix');
  const after = scan(dir, { javaSafe: true });
  assert.equal(after.findings.filter((x) => x.grade === 'SAFE').length, 0,
    're-scan after --fix must find 0 SAFE');
});

test('java: javac availability is reported, not assumed', () => {
  // This test documents the environment fact the other tests depend
  // on, so a future run that suddenly has (or loses) javac is visible
  // in the test output rather than silently changing coverage.
  if (JAVAC.present) {
    assert.ok(JAVAC.version, 'a present javac must report a version');
  } else {
    assert.equal(JAVAC.version, null);
  }
});
