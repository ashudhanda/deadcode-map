'use strict';

/**
 * Coverage evidence tests: Cobertura XML + lcov parsing, and the grade
 * rule — coverage can only demote a would-be SAFE finding to REVIEW,
 * never promote one to SAFE. The demotion uses body lines only: a
 * `def` / `function` line executes when its module is imported, so
 * counting it would demote every function in an imported module.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { scan } = require('../src/index');
const {
  parseCoverageXml, parseLcov, parseCoverage,
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
