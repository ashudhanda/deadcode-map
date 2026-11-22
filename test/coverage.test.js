'use strict';

/**
 * Coverage evidence tests: Cobertura XML + lcov parsing, merging
 * several runs into one signal (union of covered lines per file),
 * and the grade rule — coverage can only demote a would-be SAFE
 * finding to REVIEW, never promote one to SAFE. The demotion uses
 * body lines only: a `def` / `function` line executes when its module
 * is imported, so counting it would demote every function in an
 * imported module.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { scan } = require('../src/index');
const {
  parseCoverageXml, parseLcov, parseCoverage, mergeCoverage,
  coverageForSymbol, coverageForSymbolBody,
} = require('../src/coverage');

const ROOT = path.join(__dirname, '..');
const CLI_BIN = path.join(ROOT, 'bin', 'deadcode-map.js');

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// A tiny app: live_fn is imported and called by main.py; _dead is a
// private function nobody calls. Line numbers matter — see the tests.
const APP_PY = 'def live_fn():\n    return 1\n\n\ndef _dead():\n    x = 1\n    return x\n';
const MAIN_PY = 'from app import live_fn\n\nlive_fn()\n';

function appDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cov-'));
  write(dir, 'app.py', APP_PY);
  write(dir, 'main.py', MAIN_PY);
  return dir;
}

function coberturaXml({ deadBodyHits }) {
  // _dead spans lines 5-7 (def line 5, body lines 6-7). The def line is
  // always hit: importing the module executes it.
  return `<?xml version="1.0" ?>
<coverage><packages><package name=""><classes>
<class name="app" filename="app.py" line-rate="0.5"><lines>
<line number="1" hits="1"/>
<line number="2" hits="1"/>
<line number="5" hits="1"/>
<line number="6" hits="${deadBodyHits ? 1 : 0}"/>
<line number="7" hits="0"/>
</lines></class>
</classes></package></packages></coverage>
`;
}

function lcovInfo({ deadBodyHits }) {
  return `TN:
SF:app.py
DA:1,1
DA:2,1
DA:5,1
DA:6,${deadBodyHits ? 1 : 0}
DA:7,0
end_of_record
`;
}

function bySymbol(findings, file, symbol) {
  return findings.find((f) => f.file.endsWith(file) && f.symbol === symbol);
}

// Cobertura for app.py where exactly the given lines are hit.
function coberturaBodyLines(hitLines) {
  const line = (n) => `<line number="${n}" hits="${hitLines.includes(n) ? 1 : 0}"/>`;
  return `<?xml version="1.0" ?>
<coverage><packages><package name=""><classes>
<class name="app" filename="app.py" line-rate="0.5"><lines>
${[1, 2, 5, 6, 7].map(line).join('\n')}
</lines></class>
</classes></package></packages></coverage>
`;
}

// Two live modules, each with one dead private function, both
// imported by main.py — the same shape as appDir, doubled, so each
// run can cover a different dead symbol.
function twoFileApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cov-merge-'));
  const mod = (live, dead) => `def ${live}():\n    return 1\n\n\ndef ${dead}():\n    x = 1\n    return x\n`;
  write(dir, 'a.py', mod('live_a', '_dead_a'));
  write(dir, 'b.py', mod('live_b', '_dead_b'));
  write(dir, 'main.py', 'from a import live_a\nfrom b import live_b\n\nlive_a()\nlive_b()\n');
  return dir;
}

function coberturaTwoFile({ aBodyHit, bBodyHit }) {
  const cls = (name, filename, bodyHit) => `<class name="${name}" filename="${filename}" line-rate="0.5"><lines>
<line number="1" hits="1"/>
<line number="2" hits="1"/>
<line number="5" hits="1"/>
<line number="6" hits="${bodyHit ? 1 : 0}"/>
<line number="7" hits="0"/>
</lines></class>`;
  return `<?xml version="1.0" ?>
<coverage><packages><package name=""><classes>
${cls('a', 'a.py', aBodyHit)}
${cls('b', 'b.py', bBodyHit)}
</classes></package></packages></coverage>
`;
}

function lcovTwoFile({ aBodyHit, bBodyHit }) {
  const rec = (file, bodyHit) => `SF:${file}\nDA:1,1\nDA:2,1\nDA:5,1\nDA:6,${bodyHit ? 1 : 0}\nDA:7,0\nend_of_record\n`;
  return `TN:\n${rec('a.py', aBodyHit)}${rec('b.py', bBodyHit)}`;
}

// --- merging ---

test('coverage: mergeCoverage unions covered lines and totals per file', () => {
  // Both runs are parsed against the same root, as a real scan does —
  // the per-file keys are absolute paths under that root.
  const dir = appDir();
  write(dir, 'covA.xml', coberturaBodyLines([1, 2, 5, 6]));
  write(dir, 'covB.xml', coberturaBodyLines([1, 2, 5, 7]));
  write(dir, 'runC.info', 'TN:\nSF:app.py\nDA:1,1\nDA:2,1\nDA:5,1\nDA:6,0\nDA:7,1\nend_of_record\n');
  const app = path.join(dir, 'app.py');
  const mapA = parseCoverageXml(dir, 'covA.xml');
  const mapB = parseCoverageXml(dir, 'covB.xml');
  const merged = mergeCoverage([mapA, mapB]);
  const entry = merged.get(app);
  // Run A covers body line 6, run B covers body line 7: neither alone
  // covers the whole body, the union covers all of it.
  assert.deepEqual([...entry.coveredLines].sort((a, b) => a - b), [1, 2, 5, 6, 7]);
  assert.equal(entry.linesTotal, 5);
  assert.equal(entry.linesCovered, 5);
  assert.equal(entry.pct, 100);
  assert.equal(entry.source, 'cobertura', 'one shared source is kept');
  assert.deepEqual(coverageForSymbolBody(merged, app, 5, 7),
    { pct: 100, linesTotal: 2, linesCovered: 2, source: 'cobertura' });
  assert.equal(coverageForSymbolBody(mapA, app, 5, 7).pct, 50);
  assert.equal(coverageForSymbolBody(mapB, app, 5, 7).pct, 50);
  // Mixed formats merge with source 'merged'.
  const mixed = mergeCoverage([mapA, parseLcov(dir, 'runC.info')]);
  assert.equal(mixed.get(app).source, 'merged');
  assert.equal(mixed.get(app).pct, 100);
  // Merging is idempotent and skips null / empty inputs.
  assert.equal(mergeCoverage([mapA, mapA]).get(app).pct, 80);
  assert.equal(mergeCoverage([null, mapA]).get(app).pct, 80);
  assert.equal(mergeCoverage([]), null);
  assert.equal(mergeCoverage([null]), null);
  // Hand-built maps without allLines fall back to the largest total.
  const handA = new Map([['f.js', { linesTotal: 5, linesCovered: 1, pct: 20, coveredLines: new Set([6]), source: 'lcov' }]]);
  const handB = new Map([['f.js', { linesTotal: 5, linesCovered: 1, pct: 20, coveredLines: new Set([7]), source: 'lcov' }]]);
  const hand = mergeCoverage([handA, handB]).get('f.js');
  assert.equal(hand.linesTotal, 5);
  assert.equal(hand.linesCovered, 2);
  assert.equal(hand.pct, 40);
});

test('coverage: merging a directory of runs demotes what neither run alone demotes', () => {
  const dir = twoFileApp();
  const run1 = write(dir, 'cov/coverage-unit.xml', coberturaTwoFile({ aBodyHit: true, bBodyHit: false }));
  const run2 = write(dir, 'cov/lcov-e2e.info', lcovTwoFile({ aBodyHit: false, bBodyHit: true }));
  // Each run alone rescues only its own file's dead symbol.
  assert.equal(bySymbol(scan(dir, { coveragePath: run1 }).findings, 'a.py', '_dead_a').grade, 'REVIEW');
  assert.equal(bySymbol(scan(dir, { coveragePath: run1 }).findings, 'b.py', '_dead_b').grade, 'SAFE');
  assert.equal(bySymbol(scan(dir, { coveragePath: run2 }).findings, 'a.py', '_dead_a').grade, 'SAFE');
  assert.equal(bySymbol(scan(dir, { coveragePath: run2 }).findings, 'b.py', '_dead_b').grade, 'REVIEW');
  // The merged directory rescues both — and records the mixed source.
  const merged = scan(dir, { coveragePath: 'cov' }).findings;
  assert.equal(bySymbol(merged, 'a.py', '_dead_a').grade, 'REVIEW');
  assert.equal(bySymbol(merged, 'b.py', '_dead_b').grade, 'REVIEW');
  assert.equal(bySymbol(merged, 'a.py', '_dead_a').evidence.coverageSource, 'merged');
  assert.equal(bySymbol(merged, 'b.py', '_dead_b').evidence.coverageSource, 'merged');
});

test('coverage: parseCoverage merges a list of files and skips missing/empty inputs', () => {
  const dir = twoFileApp();
  const run1 = write(dir, 'run1.xml', coberturaTwoFile({ aBodyHit: true, bBodyHit: false }));
  const run2 = write(dir, 'run2.info', lcovTwoFile({ aBodyHit: false, bBodyHit: true }));
  const merged = scan(dir, { coveragePath: [run1, run2] }).findings;
  assert.equal(bySymbol(merged, 'a.py', '_dead_a').grade, 'REVIEW');
  assert.equal(bySymbol(merged, 'b.py', '_dead_b').grade, 'REVIEW');
  // A missing first input is skipped, not fatal: the result is exactly
  // the remaining run's signal.
  const withMissing = scan(dir, { coveragePath: [path.join(dir, 'nope.xml'), run1] }).findings;
  assert.equal(bySymbol(withMissing, 'a.py', '_dead_a').grade, 'REVIEW');
  assert.equal(bySymbol(withMissing, 'b.py', '_dead_b').grade, 'SAFE');
  // Only missing inputs, or an empty list, mean no coverage at all.
  const none = scan(dir, { coveragePath: [path.join(dir, 'nope.xml')] }).findings;
  assert.equal(bySymbol(none, 'a.py', '_dead_a').grade, 'SAFE');
  assert.equal(bySymbol(none, 'b.py', '_dead_b').grade, 'SAFE');
  const empty = scan(dir, { coveragePath: [] }).findings;
  assert.equal(bySymbol(empty, 'a.py', '_dead_a').grade, 'SAFE');
  assert.equal(parseCoverage(dir, []), null);
  assert.equal(parseCoverage(dir, ['missing.xml']), null);
});

test('coverage: a directory with one report behaves like that report; an empty directory is no coverage', () => {
  const dir = appDir();
  write(dir, 'cov/coverage.xml', coberturaXml({ deadBodyHits: true }));
  const single = parseCoverage(dir, 'cov/coverage.xml');
  const viaDir = parseCoverage(dir, 'cov');
  const key = path.join(dir, 'app.py');
  assert.deepEqual([...viaDir.get(key).coveredLines].sort((a, b) => a - b),
    [...single.get(key).coveredLines].sort((a, b) => a - b));
  assert.equal(viaDir.get(key).pct, single.get(key).pct);
  assert.equal(viaDir.get(key).source, 'cobertura', 'a lone report keeps its own source, not merged');
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cov-emptydir-'));
  fs.mkdirSync(path.join(emptyDir, 'cov'));
  assert.equal(parseCoverage(emptyDir, 'cov'), null);
  assert.equal(parseCoverage(dir, 'missing-dir'), null);
});

test('coverage: a bad or empty report inside a merged directory is skipped', () => {
  const dir = appDir();
  write(dir, 'cov/coverage.xml', coberturaXml({ deadBodyHits: true }));
  write(dir, 'cov/coverage-bad.xml', '<coverage><this is not valid');
  write(dir, 'cov/lcov-empty.info', '');
  write(dir, 'cov/notes.txt', 'not a report');
  const cov = parseCoverage(dir, 'cov');
  const app = cov.get(path.join(dir, 'app.py'));
  assert.equal(app.source, 'cobertura');
  assert.equal(app.pct, 80);
  assert.deepEqual([...app.coveredLines].sort((a, b) => a - b), [1, 2, 5, 6]);
  assert.equal(bySymbol(scan(dir, { coveragePath: 'cov' }).findings, 'app.py', '_dead').grade, 'REVIEW');
});

// --- parsers ---

test('coverage: Cobertura XML parses to per-file line coverage', () => {
  const dir = appDir();
  write(dir, 'coverage.xml', coberturaXml({ deadBodyHits: true }));
  const cov = parseCoverageXml(dir);
  assert.ok(cov, 'coverage map expected');
  const app = cov.get(path.join(dir, 'app.py'));
  assert.equal(app.source, 'cobertura');
  assert.equal(app.linesTotal, 5);
  assert.equal(app.linesCovered, 4);
  assert.equal(app.pct, 80);
  assert.deepEqual([...app.coveredLines].sort((a, b) => a - b), [1, 2, 5, 6]);
  assert.equal(parseCoverageXml(fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cov-none-'))), null);
});

test('coverage: lcov parses DA lines, checksums, and repeated SF blocks', () => {
  const dir = appDir();
  write(dir, 'lcov.info', `${lcovInfo({ deadBodyHits: true })}TN:
SF:app.py
DA:1,1
DA:2,0
end_of_record
`);
  const cov = parseLcov(dir);
  assert.ok(cov, 'coverage map expected');
  const app = cov.get(path.join(dir, 'app.py'));
  assert.equal(app.source, 'lcov');
  // The second SF block for the same file overwrites the first.
  assert.equal(app.linesTotal, 2);
  assert.equal(app.linesCovered, 1);
  assert.equal(app.pct, 50);
  // A DA line with a checksum third field parses the same way.
  const dir2 = appDir();
  write(dir2, 'lcov.info', 'TN:\nSF:app.py\nDA:6,3,abc123\nend_of_record\n');
  assert.equal(parseLcov(dir2).get(path.join(dir2, 'app.py')).linesCovered, 1);
});

test('coverage: parseCoverage prefers XML, explicit path wins, unknown extensions are sniffed', () => {
  const dir = appDir();
  write(dir, 'coverage.xml', coberturaXml({ deadBodyHits: true }));
  write(dir, 'lcov.info', lcovInfo({ deadBodyHits: false }));
  assert.equal(parseCoverage(dir).get(path.join(dir, 'app.py')).source, 'cobertura');
  assert.equal(parseCoverage(dir, 'lcov.info').get(path.join(dir, 'app.py')).source, 'lcov');
  // A coverage file with an unknown extension is sniffed by content.
  write(dir, 'cov.txt', lcovInfo({ deadBodyHits: true }));
  assert.equal(parseCoverage(dir, 'cov.txt').get(path.join(dir, 'app.py')).source, 'lcov');
  assert.equal(parseCoverage(dir, 'missing.info'), null);
});

test('coverage: body-line coverage excludes the definition line', () => {
  const dir = appDir();
  write(dir, 'coverage.xml', coberturaXml({ deadBodyHits: false }));
  const cov = parseCoverage(dir);
  const app = path.join(dir, 'app.py');
  // _dead spans lines 5-7; the def line (5) is hit, the body (6-7) is not.
  assert.deepEqual(coverageForSymbol(cov, app, 5, 7), { pct: 33, linesTotal: 3, linesCovered: 1, source: 'cobertura' });
  assert.deepEqual(coverageForSymbolBody(cov, app, 5, 7), { pct: 0, linesTotal: 2, linesCovered: 0, source: 'cobertura' });
  // A one-line definition has no body lines: no signal, never a demotion.
  assert.equal(coverageForSymbolBody(cov, app, 1, 1), null);
  assert.equal(coverageForSymbolBody(cov, path.join(dir, 'nope.py'), 1, 5), null);
  assert.equal(coverageForSymbolBody(null, app, 1, 5), null);
});

// --- grade rule ---

test('coverage: covered body lines demote SAFE to REVIEW (Cobertura + lcov)', () => {
  for (const [name, content] of [['coverage.xml', coberturaXml({ deadBodyHits: true })], ['lcov.info', lcovInfo({ deadBodyHits: true })]]) {
    const dir = appDir();
    write(dir, name, content);
    const f = scan(dir, {}).findings;
    const dead = bySymbol(f, 'app.py', '_dead');
    assert.equal(dead.grade, 'REVIEW', `${name}: covered body must demote to REVIEW`);
    assert.match(dead.reason, /covered by tests/);
    assert.equal(dead.evidence.coveragePct, 67, `${name}: evidence keeps the full-range pct (lines 5-7: hits on 5, 6)`);
    assert.equal(dead.evidence.coverageSource, name === 'coverage.xml' ? 'cobertura' : 'lcov');
    // The live function is untouched, and nothing else goes SAFE.
    assert.equal(bySymbol(f, 'app.py', 'live_fn'), undefined);
    assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
  }
});

test('coverage: uncovered body lines stay SAFE — the def line alone never demotes', () => {
  for (const [name, content] of [['coverage.xml', coberturaXml({ deadBodyHits: false })], ['lcov.info', lcovInfo({ deadBodyHits: false })]]) {
    const dir = appDir();
    write(dir, name, content);
    const f = scan(dir, {}).findings;
    // The def line (5) is hit in both files, but the body (6-7) is not:
    // _dead is still provably dead.
    assert.equal(bySymbol(f, 'app.py', '_dead').grade, 'SAFE', `${name}: uncovered body stays SAFE`);
  }
});

test('coverage: --no-coverage ignores the file, explicit --coverage reads it', () => {
  const dir = appDir();
  write(dir, 'coverage.xml', coberturaXml({ deadBodyHits: true }));
  assert.equal(bySymbol(scan(dir, { noCoverage: true }).findings, 'app.py', '_dead').grade, 'SAFE');
  // Explicit path: the coverage file lives outside the scanned repo.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cov-out-'));
  const covPath = write(outside, 'cov.info', lcovInfo({ deadBodyHits: true }));
  assert.equal(bySymbol(scan(dir, { coveragePath: covPath }).findings, 'app.py', '_dead').grade, 'REVIEW');
});

test('coverage: a dead file with covered lines is REVIEW, not SAFE', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cov-file-'));
  write(dir, 'dead.py', 'def orphan():\n    x = 1\n    return x\n');
  write(dir, 'main.py', 'print("entry")\n');
  const xml = `<?xml version="1.0" ?>
<coverage><packages><package name=""><classes>
<class name="dead" filename="dead.py" line-rate="0.66"><lines>
<line number="1" hits="1"/>
<line number="2" hits="1"/>
<line number="3" hits="0"/>
</lines></class>
</classes></package></packages></coverage>
`;
  write(dir, 'coverage.xml', xml);
  const f = scan(dir, {}).findings;
  const fileFinding = f.find((x) => x.category === 'file' && x.file.endsWith('dead.py'));
  assert.equal(fileFinding.grade, 'REVIEW');
  assert.match(fileFinding.reason, /covered by tests/);
  // Without coverage the same file is SAFE.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cov-file2-'));
  write(dir2, 'dead.py', 'def orphan():\n    x = 1\n    return x\n');
  write(dir2, 'main.py', 'print("entry")\n');
  assert.equal(scan(dir2, {}).findings.find((x) => x.category === 'file' && x.file.endsWith('dead.py')).grade, 'SAFE');
});

test('coverage: a one-line definition is never demoted by its covered line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cov-one-'));
  write(dir, 'app.py', 'def _one(): return 1\n');
  write(dir, 'main.py', 'print("entry")\n');
  write(dir, 'coverage.xml', `<?xml version="1.0" ?>
<coverage><packages><package name=""><classes>
<class name="app" filename="app.py" line-rate="1"><lines>
<line number="1" hits="1"/>
</lines></class>
</classes></package></packages></coverage>
`);
  assert.equal(bySymbol(scan(dir, {}).findings, 'app.py', '_one').grade, 'SAFE');
});

// --- CLI wiring ---

test('coverage: --coverage / --no-coverage flags work end to end', () => {
  const dir = appDir();
  const covPath = write(dir, 'cov.info', lcovInfo({ deadBodyHits: true }));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cov-cli-'));
  const run = (args) => {
    const r = spawnSync(process.execPath, [CLI_BIN, dir, '--json', path.join(out, 'r.json'), '--no-color', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(fs.readFileSync(path.join(out, 'r.json'), 'utf8')).findings;
  };
  assert.equal(bySymbol(run(['--coverage', covPath]), 'app.py', '_dead').grade, 'REVIEW');
  assert.equal(bySymbol(run(['--coverage', covPath, '--no-coverage']), 'app.py', '_dead').grade, 'SAFE');
});

test('coverage: --coverage <directory> merges its runs end to end', () => {
  const dir = twoFileApp();
  write(dir, 'cov/coverage-unit.xml', coberturaTwoFile({ aBodyHit: true, bBodyHit: false }));
  write(dir, 'cov/lcov-e2e.info', lcovTwoFile({ aBodyHit: false, bBodyHit: true }));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cov-cli-dir-'));
  const r = spawnSync(process.execPath, [CLI_BIN, dir, '--json', path.join(out, 'r.json'), '--no-color', '--coverage', path.join(dir, 'cov')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const findings = JSON.parse(fs.readFileSync(path.join(out, 'r.json'), 'utf8')).findings;
  assert.equal(bySymbol(findings, 'a.py', '_dead_a').grade, 'REVIEW');
  assert.equal(bySymbol(findings, 'b.py', '_dead_b').grade, 'REVIEW');
});
