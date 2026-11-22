'use strict';

/**
 * Framework-pack tests for Java (batch 7): the Spring and Jackson/JPA
 * packs are data only (frameworks/spring.json, frameworks/jackson-jpa.json)
 * and the CLI must honour them — a pack entry keeps the member, and a
 * pack-only class stereotype keeps the class's private members at
 * REVIEW. The packs add annotations the hardcoded fallback in
 * src/parse-java.js does not list, so these tests fail if the pack
 * wiring in src/confidence.js regresses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan } = require('../src/index');
const { loadFrameworks } = require('../src/confidence');

const ROOT = path.join(__dirname, '..');
const FRAMEWORKS_DIR = path.join(ROOT, 'frameworks');

function packByFile(packs, file) {
  return packs.find((p) => p._file === file);
}

function writeTempJava(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-java-packs-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

function bySymbol(findings, file, symbol) {
  return findings.find((f) => f.file.endsWith(file) && f.symbol === symbol);
}

test('java framework packs: spring and jackson-jpa packs load as data', () => {
  const packs = loadFrameworks(FRAMEWORKS_DIR);
  const spring = packByFile(packs, 'spring.json');
  const jacksonJpa = packByFile(packs, 'jackson-jpa.json');
  assert.ok(spring, 'frameworks/spring.json must load');
  assert.ok(jacksonJpa, 'frameworks/jackson-jpa.json must load');
  for (const [name, pack] of [['spring', spring], ['jackson-jpa', jacksonJpa]]) {
    assert.ok(Array.isArray(pack.keepDecorators) && pack.keepDecorators.length > 0,
      `${name} pack must list keepDecorators`);
    assert.ok(Array.isArray(pack.keepClassAnnotations) && pack.keepClassAnnotations.length > 0,
      `${name} pack must list keepClassAnnotations`);
    // Bare simple names only: no '@' prefix, no qualified names.
    for (const entry of [...pack.keepDecorators, ...pack.keepClassAnnotations]) {
      assert.equal(typeof entry, 'string', `${name} pack entries must be strings`);
      assert.ok(/^[A-Z][A-Za-z0-9]*$/.test(entry), `${name} pack entry ${JSON.stringify(entry)} must be a bare annotation simple name`);
    }
    // Every class stereotype is also a member keep: a class annotation
    // on a member itself must keep it too.
    for (const ann of pack.keepClassAnnotations) {
      assert.ok(pack.keepDecorators.includes(ann), `${name} pack: keepClassAnnotations entry ${ann} must also be in keepDecorators`);
    }
  }
  // Deduplicated across packs: no annotation lives in both packs.
  const springDecs = new Set(spring.keepDecorators);
  const overlap = jacksonJpa.keepDecorators.filter((d) => springDecs.has(d));
  assert.deepEqual(overlap, [], `spring and jackson-jpa packs must not share keepDecorators, overlap: ${overlap.join(', ')}`);
  const springClass = new Set(spring.keepClassAnnotations);
  const classOverlap = jacksonJpa.keepClassAnnotations.filter((d) => springClass.has(d));
  assert.deepEqual(classOverlap, [], `spring and jackson-jpa packs must not share keepClassAnnotations, overlap: ${classOverlap.join(', ')}`);
  // Spot checks: the entries the task names must be present.
  for (const ann of ['Component', 'Service', 'Repository', 'Controller', 'RestController', 'Autowired', 'Bean', 'Configuration', 'GetMapping', 'PostMapping', 'RequestMapping', 'Transactional']) {
    assert.ok(springDecs.has(ann), `spring pack must list @${ann}`);
  }
  for (const ann of ['JsonProperty', 'JsonIgnore', 'JsonCreator', 'Entity', 'Table', 'Column', 'Id']) {
    assert.ok(jacksonJpa.keepDecorators.includes(ann), `jackson-jpa pack must list @${ann}`);
  }
});

test('java framework packs: pack-only class stereotypes keep members at REVIEW', () => {
  // @ControllerAdvice, @ConfigurationProperties and
  // @JsonIgnoreProperties are in the packs only — not in the hardcoded
  // FRAMEWORK_CLASS_ANNOTATIONS fallback — so REVIEW here proves the
  // pack wiring, not the fallback.
  const dir = writeTempJava({
    'Advice.java': `package com.example;

@ControllerAdvice
public class Advice {
  private void deadInAdvice() {
  }

  private int deadFieldInAdvice;
}

@ConfigurationProperties("app")
class Props {
  private void deadInProps() {
  }
}

@JsonIgnoreProperties(ignoreUnknown = true)
class Dto {
  private void deadInDto() {
  }
}
`,
    'Plain.java': `package com.example;

public class Plain {
  private void stillDead() {
  }
}
`,
  });
  const f = scan(dir, { javaSafe: true }).findings;
  assert.equal(bySymbol(f, 'Advice.java', 'deadInAdvice').grade, 'REVIEW', '@ControllerAdvice member must be REVIEW');
  assert.equal(bySymbol(f, 'Advice.java', 'deadFieldInAdvice').grade, 'REVIEW', '@ControllerAdvice field must be REVIEW');
  assert.equal(bySymbol(f, 'Advice.java', 'deadInProps').grade, 'REVIEW', '@ConfigurationProperties member must be REVIEW');
  assert.equal(bySymbol(f, 'Advice.java', 'deadInDto').grade, 'REVIEW', '@JsonIgnoreProperties member must be REVIEW');
  // The packs must not over-keep: an unannotated private method in
  // the same scan is still SAFE.
  assert.equal(bySymbol(f, 'Plain.java', 'stillDead').grade, 'SAFE', 'an unannotated private method must stay SAFE');
  assert.equal(f.filter((x) => x.file.endsWith('Advice.java') && x.grade === 'SAFE').length, 0,
    'no member of a pack-stereotyped class may be SAFE');
});

test('java framework packs: @RestController class and Spring/Jackson member annotations are kept', () => {
  const dir = writeTempJava({
    'Api.java': `package com.example;

@RestController
public class Api {
  private void deadInController() {
  }

  private int deadFieldInController;
}
`,
    'Handlers.java': `package com.example;

public class Handlers {
  @GetMapping("/x")
  private String handle() {
    return "x";
  }

  @Scheduled(fixedRate = 1000)
  private void tick() {
  }

  @JsonCreator
  private static Handlers create() {
    return null;
  }

  @Transactional
  private void txWork() {
  }

  @JsonProperty("label")
  private String labelledField;

  @Column(name = "label")
  private String columnField;

  private void plainDead() {
  }
}
`,
  });
  const f = scan(dir, { javaSafe: true }).findings;
  // A Spring-annotated class member is kept: the @RestController
  // class's private members are REVIEW, never SAFE.
  assert.equal(bySymbol(f, 'Api.java', 'deadInController').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'Api.java', 'deadFieldInController').grade, 'REVIEW');
  // Spring / Jackson annotations on the member itself keep it.
  for (const symbol of ['handle', 'tick', 'create', 'txWork', 'labelledField', 'columnField']) {
    assert.equal(bySymbol(f, 'Handlers.java', symbol).grade, 'KEEP', `@-annotated member ${symbol} must be KEEP`);
  }
  // Control: the unannotated private method in the same file is SAFE.
  assert.equal(bySymbol(f, 'Handlers.java', 'plainDead').grade, 'SAFE');
});
