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
