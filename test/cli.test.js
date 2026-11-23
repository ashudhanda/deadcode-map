'use strict';

/** CLI end-to-end tests on copies of the fixtures (never on the originals). */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'deadcode-map.js');

function copyFixture(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dcm-${name}-`));
  fs.cpSync(path.join(ROOT, 'fixtures', name), dir, { recursive: true });
  return dir;
}

function run(dir, args) {
  const r = spawnSync(process.execPath, [BIN, dir, ...args], { encoding: 'utf8' });
  return r;
}

test('CLI: --json - writes pure JSON to stdout', () => {
  const dir = copyFixture('js-basic');
  const r = run(dir, ['--json', '-']);
  assert.equal(r.status, 0, r.stderr);
  // Stdout must be exactly one JSON document: no terminal summary mixed in.
  const report = JSON.parse(r.stdout);
  assert.equal(report.tool, 'deadcode-map');
  assert.ok(report.findings.some((f) => f.grade === 'SAFE'));
  assert.ok(!r.stdout.includes('deadcode-map  '), 'terminal summary must not leak into --json - output');
});

test('CLI: --json writes a report and --fail-on exits 1 on new SAFE', () => {
  const dir = copyFixture('js-basic');
  const jsonPath = path.join(dir, 'report.json');
  const r = run(dir, ['--json', jsonPath]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(report.tool, 'deadcode-map');
  assert.ok(report.findings.some((f) => f.grade === 'SAFE'));
  const fail = run(dir, ['--fail-on', 'safe']);
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /FAIL/);
});

test('CLI: --map writes a single self-contained HTML file', () => {
  const dir = copyFixture('js-basic');
  const mapPath = path.join(dir, 'deadcode-map.html');
  const r = run(dir, ['--map', mapPath]);
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(mapPath, 'utf8');
  assert.match(html, /deadcode-map/);
  assert.match(html, /SAFE/);
  assert.ok(!html.includes('https://cdn'), 'map must not reference a CDN');
  assert.ok(!html.includes('src="http'), 'map must not load external scripts');
});

test('CLI: --baseline hides grandfathered findings, --update-baseline records them', () => {
  const dir = copyFixture('js-basic');
  const r1 = run(dir, ['--update-baseline']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(fs.existsSync(path.join(dir, '.deadcode-map.json')));
  const r2 = run(dir, ['--baseline', '--fail-on', 'safe']);
  assert.equal(r2.status, 0, `baseline should hide all findings, got: ${r2.stdout} ${r2.stderr}`);
});

test('CLI: --include-fixtures scans fixture dirs, default excludes them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cli-fixtures-'));
  fs.mkdirSync(path.join(dir, 'fixtures'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', main: 'src/index.js' }));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), "console.log('hi');\n");
  fs.writeFileSync(path.join(dir, 'fixtures', 'dead.js'), 'function plantedDead() { return 1; }\nmodule.exports = { plantedDead };\n');
  const def = run(dir, ['--json', path.join(dir, 'r1.json')]);
  assert.equal(def.status, 0, def.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'r1.json'), 'utf8')).findings.length, 0, 'fixture dirs must be excluded by default');
  const inc = run(dir, ['--json', path.join(dir, 'r2.json'), '--include-fixtures']);
  assert.equal(inc.status, 0, inc.stderr);
  const findings = JSON.parse(fs.readFileSync(path.join(dir, 'r2.json'), 'utf8')).findings;
  assert.ok(findings.some((f) => f.symbol === 'plantedDead'), 'plantedDead must be found with --include-fixtures');
});

test('CLI: --fix deletes SAFE items only and leaves live code alone', () => {
  const dir = copyFixture('js-basic');
  const r = run(dir, ['--fix']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, 'src', 'dead-file.js')), 'dead file should be deleted');
  assert.ok(!fs.existsSync(path.join(dir, 'src', 'dynamic.js')), 'dynamic.js (SAFE file) should be deleted');
  const used = fs.readFileSync(path.join(dir, 'src', 'used.js'), 'utf8');
  assert.ok(!used.includes('unusedImport'), 'dead import should be removed');
  assert.ok(!used.includes('this line never runs'), 'unreachable code should be removed');
  assert.ok(used.includes('usedFn'), 'live function must survive --fix');
  assert.ok(used.includes('privateDead'), 'REVIEW export must survive --fix');
  assert.ok(used.includes('unusedExport'), 'REVIEW export must survive --fix');
});

test('CLI: --fix removes a dead dotted import without touching the live one or module dunders', () => {
  const dir = copyFixture('py-imports');
  // Put the dead and live imports on one line: the specifier-removal
  // path (not whole-line removal) must leave `import json` intact.
  fs.writeFileSync(path.join(dir, 'unused_imports.py'),
    'import os.path, json\n\n\ndef alive():\n    return json.dumps({"a": 1})\n');
  const before = fs.readFileSync(path.join(dir, 'pkg', '__init__.py'), 'utf8');
  const r = run(dir, ['--fix']);
  assert.equal(r.status, 0, r.stderr);
  const fixed = fs.readFileSync(path.join(dir, 'unused_imports.py'), 'utf8');
  assert.ok(!fixed.includes('os.path'), 'dead dotted import should be removed');
  assert.ok(fixed.includes('import json'), 'live import on the same line must survive --fix');
  assert.ok(fixed.includes('json.dumps'), 'live code must survive --fix');
  const init = fs.readFileSync(path.join(dir, 'pkg', '__init__.py'), 'utf8');
  assert.equal(init, before, '__init__.py dunders must survive --fix untouched');
  const rescan = run(dir, ['--fail-on', 'safe']);
  assert.equal(rescan.status, 0, `no SAFE findings should remain after --fix, got: ${rescan.stdout} ${rescan.stderr}`);
});

test('CLI: --fix on a CRLF file removes a dead require() without leaving a bare `const` or stray CR', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-fix-crlf-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', main: 'src/a.js' }));
  fs.writeFileSync(path.join(dir, 'src', 'dead.js'), 'module.exports = () => 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'used.js'), 'module.exports = () => 2;\n');
  // A require() record covers only its declarator, not the `const`:
  // deleting from the record start used to leave `const const used = ...`.
  fs.writeFileSync(path.join(dir, 'src', 'a.js'),
    "const unused = require('./dead');\r\nconst used = require('./used');\r\nconsole.log(used());\r\n");
  const r = run(dir, ['--fix']);
  assert.equal(r.status, 0, r.stderr);
  const fixed = fs.readFileSync(path.join(dir, 'src', 'a.js'));
  assert.ok(!fixed.includes('unused'), 'dead require must be removed');
  assert.ok(!fixed.includes('const const'), 'no bare `const` may be left behind');
  assert.ok(fixed.includes("require('./used')"), 'live require must survive');
  assert.ok(fixed.includes('console.log(used())'), 'live code must survive');
  for (let i = 0; i < fixed.length; i++) {
    if (fixed[i] === '\r') assert.equal(fixed[i + 1], '\n', 'no stray CR outside CRLF');
  }
  // The fixed file must still parse.
  execFileSync(process.execPath, ['--check', path.join(dir, 'src', 'a.js')]);
});

test('CLI: --fix removes only the dead declarator when require()s share one `const` line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-fix-shared-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', main: 'src/a.js' }));
  fs.writeFileSync(path.join(dir, 'src', 'dead.js'), 'module.exports = () => 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'used.js'), 'module.exports = () => 2;\n');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'),
    "const used = require('./used'), unused = require('./dead');\nconsole.log(used());\n");
  const r = run(dir, ['--fix']);
  assert.equal(r.status, 0, r.stderr);
  const fixed = fs.readFileSync(path.join(dir, 'src', 'a.js'), 'utf8');
  assert.ok(!fixed.includes('unused'), 'dead declarator must be removed');
  assert.ok(fixed.includes("const used = require('./used');"), 'live declarator must survive intact');
  assert.ok(fixed.includes('console.log(used())'), 'live code must survive');
  execFileSync(process.execPath, ['--check', path.join(dir, 'src', 'a.js')]);
});

test('CLI: --prove proves a deletion when tests pass', () => {
  const dir = copyFixture('js-basic');
  // Make it a git repo with a passing test script.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  pkg.scripts = { test: "node -e \"require('./src/index.js')\"" };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'fixture']);
  const r = run(dir, ['--prove']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /proven/);
  // The original repo must be untouched by --prove.
  assert.ok(fs.existsSync(path.join(dir, 'src', 'dead-file.js')), '--prove must not modify the working tree');
});

test('CLI: --prove skips cleanly when there is no test command', () => {
  const dir = copyFixture('js-basic');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'fixture']);
  const r = run(dir, ['--prove']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skipped|no test command/i);
});

test('CLI: --json report inside the repo is not scanned on the next run', () => {
  const dir = copyFixture('js-basic');
  const jsonPath = path.join(dir, 'report.json');
  // Baseline: no report file on disk at all (--json - writes to stdout).
  const base = run(dir, ['--json', '-', '--no-cache']);
  assert.equal(base.status, 0, base.stderr);
  const baseCount = JSON.parse(base.stdout).findings.length;
  assert.ok(baseCount > 0, 'fixture must have findings');
  const readCount = () => JSON.parse(fs.readFileSync(jsonPath, 'utf8')).findings.length;
  const r1 = run(dir, ['--json', jsonPath, '--no-cache']);
  assert.equal(r1.status, 0, r1.stderr);
  const n1 = readCount();
  const r2 = run(dir, ['--json', jsonPath, '--no-cache']);
  assert.equal(r2.status, 0, r2.stderr);
  const n2 = readCount();
  assert.equal(n1, baseCount, 'first run with a report file must match the no-file run');
  assert.equal(n2, n1, 'second run must match the first: the report must not count as references');
});

test('CLI: --map file inside the repo is not scanned on the next run', () => {
  const dir = copyFixture('js-basic');
  const mapPath = path.join(dir, 'deadcode-map.html');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-map-out-'));
  const r1Path = path.join(outside, 'r1.json');
  const r2Path = path.join(outside, 'r2.json');
  const r1 = run(dir, ['--map', mapPath, '--json', r1Path, '--no-cache']);
  assert.equal(r1.status, 0, r1.stderr);
  const n1 = JSON.parse(fs.readFileSync(r1Path, 'utf8')).findings.length;
  const r2 = run(dir, ['--map', mapPath, '--json', r2Path, '--no-cache']);
  assert.equal(r2.status, 0, r2.stderr);
  const n2 = JSON.parse(fs.readFileSync(r2Path, 'utf8')).findings.length;
  assert.ok(n1 > 0, 'fixture must have findings');
  assert.equal(n2, n1, 'second run must match the first: the map must not count as references');
});

test('CLI: a user file sharing the --json output name is still scanned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-jsonself-name-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', main: 'src/index.js' }));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), "require('./a');\nconsole.log('hi');\n");
  fs.writeFileSync(path.join(dir, 'src', 'a.js'),
    'function deadOne() { return 1; }\n'
    + 'function deadTwo() { return 2; }\n'
    + 'module.exports = {};\n');
  // Same basename as the tool output below, different directory: a
  // real user file that must keep being scanned.
  fs.writeFileSync(path.join(dir, 'sub', 'report.json'), JSON.stringify({ note: 'deadTwo' }));
  const jsonPath = path.join(dir, 'report.json');
  const bySymbol = (findings, symbol) => findings.find((f) => f.symbol === symbol);
  const r1 = run(dir, ['--json', jsonPath, '--no-cache']);
  assert.equal(r1.status, 0, r1.stderr);
  const f1 = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).findings;
  const r2 = run(dir, ['--json', jsonPath, '--no-cache']);
  assert.equal(r2.status, 0, r2.stderr);
  const f2 = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).findings;
  assert.equal(bySymbol(f1, 'deadOne')?.grade, 'SAFE', 'unreferenced function must stay SAFE');
  assert.equal(bySymbol(f2, 'deadOne')?.grade, 'SAFE', 'tool report must not resurrect deadOne on run 2');
  assert.equal(bySymbol(f1, 'deadTwo')?.grade, 'REVIEW', 'mention in the user report.json must keep deadTwo at REVIEW');
  assert.equal(bySymbol(f2, 'deadTwo')?.grade, 'REVIEW');
  assert.equal(f2.length, f1.length, 'finding counts must be identical across runs');
});

test('CLI: --json - with --map writes pure JSON to stdout', () => {
  const dir = copyFixture('js-basic');
  const mapPath = path.join(dir, 'deadcode-map.html');
  // Before the fix the "Map written to ..." line landed on stdout
  // after the JSON document, so JSON.parse(stdout) threw.
  const r = run(dir, ['--json', '-', '--map', mapPath, '--no-cache']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.tool, 'deadcode-map');
  assert.ok(report.findings.some((f) => f.grade === 'SAFE'));
  assert.ok(!r.stdout.includes('Map written to'), 'the map confirmation must not leak into --json - output');
  assert.ok(r.stderr.includes('Map written to'), 'the map confirmation goes to stderr instead');
  assert.ok(fs.existsSync(mapPath), 'the map file must still be written');
  // Argument order must not matter.
  const r2 = run(dir, ['--map', mapPath, '--json', '-', '--no-cache']);
  assert.equal(r2.status, 0, r2.stderr);
  JSON.parse(r2.stdout);
  assert.ok(!r2.stdout.includes('Map written to'));
});

test('CLI: --update-baseline does not change the next scan (baseline file is not scanned)', () => {
  const dir = copyFixture('js-basic');
  const base = run(dir, ['--json', '-', '--no-cache']);
  assert.equal(base.status, 0, base.stderr);
  const baseFindings = JSON.parse(base.stdout).findings
    .map((f) => `${f.category}:${f.file}:${f.symbol || ''}:${f.grade}`).sort();
  assert.ok(baseFindings.length > 0, 'fixture must have findings');
  const up = run(dir, ['--update-baseline', '--no-cache']);
  assert.equal(up.status, 0, up.stderr);
  assert.ok(fs.existsSync(path.join(dir, '.deadcode-map.json')), 'baseline must be written');
  // Before the fix the baseline file itself counted as a string
  // reference: a SAFE dead file came back REVIEW on the next run, with
  // the baseline as its only "mention".
  const r2 = run(dir, ['--json', '-', '--no-cache']);
  assert.equal(r2.status, 0, r2.stderr);
  const nextFindings = JSON.parse(r2.stdout).findings
    .map((f) => `${f.category}:${f.file}:${f.symbol || ''}:${f.grade}`).sort();
  assert.deepEqual(nextFindings, baseFindings, 'findings must be identical with the baseline file on disk');
  // --baseline still hides them (the file is read as a baseline, just
  // never scanned as a source of string references).
  const r3 = run(dir, ['--baseline', '--json', '-', '--no-cache']);
  assert.equal(r3.status, 0, r3.stderr);
  const hidden = JSON.parse(r3.stdout);
  assert.equal(hidden.findings.length, 0, 'baseline findings must be hidden with --baseline');
  assert.equal(hidden.meta.baselineHidden, baseFindings.length);
});

test('CLI: hoisted function declarations after return are not unreachable', () => {
  const dir = copyFixture('js-hoisted');
  const jsonPath = path.join(dir, 'report.json');
  const r = run(dir, ['--json', jsonPath]);
  assert.equal(r.status, 0, r.stderr);
  const findings = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).findings;
  assert.equal(findings.filter((f) => f.category === 'unreachable' && f.file.endsWith('src/hoisted.js')).length, 0,
    'hoisted helpers after return must not be reported unreachable');
  assert.ok(findings.some((f) => f.category === 'unreachable' && f.file.endsWith('src/still-dead.js') && f.grade === 'SAFE'),
    'a plain statement after return must still be reported unreachable');
});

test('CLI: *.e2e-spec.ts files are test files, kept like other test files', () => {
  const dir = copyFixture('ts-e2e-spec');
  const jsonPath = path.join(dir, 'report.json');
  const r = run(dir, ['--json', jsonPath]);
  assert.equal(r.status, 0, r.stderr);
  const findings = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).findings;
  for (const file of ['e2e/cats/cats.e2e-spec.ts', 'e2e/cats/cats.e2e-spec.js']) {
    // A test file is an entry point, so it is reachable and never gets
    // a file finding at all — the same as `*.spec.ts` / `*.test.ts`.
    assert.equal(findings.find((f) => f.category === 'file' && f.file.endsWith(file)), undefined,
      `${file} must never be reported as a dead file`);
    assert.ok(findings.some((f) => f.category === 'import' && f.file.endsWith(file) && f.grade === 'KEEP'),
      `unused import in ${file} must be kept as a test-file import`);
  }
  assert.ok(findings.some((f) => f.category === 'file' && f.file.endsWith('src/orphan.ts') && f.grade === 'SAFE'),
    'a plain unimported file must still be SAFE');
});
