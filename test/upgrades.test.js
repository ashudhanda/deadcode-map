'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { discover, toPosix, isManualScriptPath } = require('../src/discover');
const { mergeRanges, applyFix, applyFixCascade } = require('../src/fix');
const { parseInlineIgnores } = require('../src/rules/ignore');
const { parseUnifiedDiff, filterFindingsByDiff } = require('../src/diff');
const { toSarifReport } = require('../src/sarif');
const { buildMapData, renderHtml } = require('../src/map');
const { scan, scanAsync } = require('../src/index');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Phase 1: toPosix normalizes Windows paths for manual scripts', () => {
  assert.equal(toPosix('scripts\\deploy\\run.js'), 'scripts/deploy/run.js');
  assert.equal(isManualScriptPath('scripts\\seed.js'), true);
  assert.equal(isManualScriptPath('pkg\\tools\\audit.py'), true);
  assert.equal(isManualScriptPath('src\\utils.js'), false);
});

test('Phase 1: discover respects nested .gitignore rules', () => {
  const dir = makeTempDir('dcm-gitignore-');
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'generated/\n*.gen.js\n!keep.gen.js\n');
    fs.mkdirSync(path.join(dir, 'generated'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'generated', 'dead.js'), 'function x() {}');
    fs.writeFileSync(path.join(dir, 'src', 'skip.gen.js'), 'function y() {}');
    fs.writeFileSync(path.join(dir, 'src', 'keep.gen.js'), 'function z() {}');
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'console.log(1);');

    const d = discover(dir);
    const rels = d.codeFiles.map((f) => toPosix(path.relative(dir, f))).sort();
    assert.deepEqual(rels, ['src/index.js', 'src/keep.gen.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase 1: mergeRanges safely merges partial overlaps and clamps bounds', () => {
  const merged = mergeRanges([[10, 20], [15, 25], [2, 5], [12, 18], [40, 999]], 50);
  assert.deepEqual(merged, [[2, 5], [10, 25], [40, 50]]);
});

test('Phase 1 & 3: applyFix removes full multi-specifier import & preserves CRLF', () => {
  const dir = makeTempDir('dcm-fix-');
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', main: 'src/index.js', private: true }));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'lib.js'), 'export function a() { return 1; }\r\nexport function b() { return 2; }\r\n');
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), "import { a, b } from './lib.js';\r\nconsole.log('hi');\r\n");

    const { graph, findings } = scan(dir);
    const res = applyFix(dir, graph, findings);
    assert.ok(res.appliedCount >= 2);

    const updated = fs.readFileSync(path.join(dir, 'src', 'index.js'), 'utf8');
    assert.equal(updated.includes('import'), false, 'entire empty import statement should be removed');
    assert.equal(updated.includes("console.log('hi');\r\n"), true, 'CRLF should be preserved');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase 2: scanAsync matches synchronous scan results', async () => {
  const fixture = path.join(__dirname, '..', 'fixtures', 'js-basic');
  const syncRes = scan(fixture, { includeFixtures: true });
  const asyncRes = await scanAsync(fixture, { includeFixtures: true });
  assert.deepEqual(
    asyncRes.findings.map((f) => `${f.grade}:${f.id}`).sort(),
    syncRes.findings.map((f) => `${f.grade}:${f.id}`).sort(),
  );
});

test('Phase 3: inline ignore directives suppress next-line, inline, and file findings', () => {
  const src = [
    '// deadcode-map-ignore-next -- reflection hook',
    'function keepMe() { return 1; }',
    'const x = 1; // deadcode-map-ignore temporary',
  ].join('\n');
  const parsed = parseInlineIgnores(src);
  assert.equal(parsed.ignoreFile, null);
  assert.equal(parsed.ignoredLines.get(2), 'reflection hook');
  assert.equal(parsed.ignoredLines.get(3), 'temporary');

  const fileIgnored = parseInlineIgnores('# deadcode-map: ignore-file generated\ndef foo(): pass\n');
  assert.equal(fileIgnored.ignoreFile, 'generated');
});

test('Phase 3: PR diff parser & hunk filter isolate touched findings', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '+++ b/src/a.js',
    '@@ -10,0 +11,3 @@',
    '+function deadNew() {}',
  ].join('\n');
  const diffData = parseUnifiedDiff(diff);
  const findings = [
    { id: '1', file: 'src/a.js', startLine: 11, endLine: 13, grade: 'SAFE', category: 'function' },
    { id: '2', file: 'src/a.js', startLine: 2, endLine: 4, grade: 'SAFE', category: 'function' },
    { id: '3', file: 'src/other.js', startLine: 1, endLine: 1, grade: 'SAFE', category: 'function' },
  ];
  const hunk = filterFindingsByDiff(findings, diffData, { scope: 'hunk' });
  assert.deepEqual(hunk.findings.map((f) => f.id), ['1']);
  const byFile = filterFindingsByDiff(findings, diffData, { scope: 'file' });
  assert.deepEqual(byFile.findings.map((f) => f.id), ['1', '2']);
});

test('Phase 3: SARIF 2.1.0 report structure is valid', () => {
  const sarif = toSarifReport('/repo', [
    { id: 'function:src/a.js:dead:5', file: 'src/a.js', symbol: 'dead', category: 'function', grade: 'SAFE', startLine: 5, endLine: 8, reason: '0 callers' },
    { id: 'function:src/a.js:kept:1', file: 'src/a.js', symbol: 'kept', category: 'function', grade: 'KEEP', startLine: 1, endLine: 2, reason: 'entry' },
  ]);
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0].results.length, 1);
  assert.equal(sarif.runs[0].results[0].ruleId, 'DCM002');
  assert.equal(sarif.runs[0].results[0].level, 'error');
});

test('Phase 4: map v2 generates offline HTML with parent-symbol containment edges', () => {
  const fixture = path.join(__dirname, '..', 'fixtures', 'js-basic');
  const { graph, findings } = scan(fixture, { includeFixtures: true });
  const data = buildMapData(fixture, graph, findings);
  assert.ok(data.edges.some((e) => e.kind === 'contains'), 'symbol nodes should link to parent files');
  const html = renderHtml(data);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.equal(/<script[^>]+src=/i.test(html), false, 'map must remain 100% offline with no external scripts');
});

test('Phase 3: applyFixCascade converges across passes', () => {
  const dir = makeTempDir('dcm-cascade-');
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', main: 'src/index.js', private: true }));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'console.log(1);\n');
    fs.writeFileSync(path.join(dir, 'src', 'dead.js'), 'function dead() { return 1; }\nmodule.exports = { dead };\n');
    const res = applyFixCascade(dir, () => scan(dir));
    assert.ok(res.deletedFiles.includes('src/dead.js'));
    assert.equal(fs.existsSync(path.join(dir, 'src', 'dead.js')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
