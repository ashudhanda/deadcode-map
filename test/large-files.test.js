'use strict';

/**
 * Large-file parsing tests. tree-sitter 0.21's node binding rejects
 * string inputs of 32 KiB or more (parse() throws "Invalid argument"),
 * so a large file used to fail to parse at all and was silently
 * treated as live — fastapi's 271 KiB routing.py was invisible, none
 * of its imports existed, and everything it alone used looked dead.
 * The parsers now use the callback form for every file, and text()
 * picks the position unit per node (UTF-16 inside the first 8 KiB
 * chunk, bytes after it — see parse-js.js). These tests pin both:
 * files over 32 KiB parse with correct names, and non-ASCII content
 * before the chunk boundary does not corrupt names after it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan } = require('../src/index');
const { parsePy } = require('../src/parse-py');
const { parseJsTs } = require('../src/parse-js');

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// One long comment line pushes the definitions past 32 KiB.
const PAD = '# ' + 'x'.repeat(40000) + '\n';

test('large Python file parses: dead/live grading past 32 KiB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-large-py-'));
  const src = PAD + 'def live_fn():\n    return 1\n\n\ndef _dead():\n    x = 1\n    return x\n';
  assert.ok(Buffer.byteLength(src, 'utf8') > 32768);
  write(dir, 'app.py', src);
  write(dir, 'main.py', 'from app import live_fn\n\nlive_fn()\n');
  const result = scan(dir);
  const byId = new Map(result.findings.map((f) => [f.id.split(':').slice(0, 3).join(':'), f]));
  assert.equal(byId.get('function:app.py:_dead').grade, 'SAFE');
  assert.equal(byId.has('function:app.py:live_fn'), false);
});

test('large Python file with non-ASCII early: names after the boundary are exact', () => {
  const src = '# comment with emoji \u{1F600}\u{1F600}\u{1F600} and caf\u00e9\n' + PAD
    + 'def after_big():\n    return helper_fn()\n\ndef helper_fn():\n    return 1\n';
  const parsed = parsePy('big.py', src);
  assert.deepEqual(parsed.definitions.map((d) => d.name), ['after_big', 'helper_fn']);
  assert.deepEqual(parsed.definitions.find((d) => d.name === 'after_big').uses, ['helper_fn']);
});

test('emoji surrogate pair straddling the chunk boundary parses cleanly', () => {
  // The emoji's two UTF-16 units sit at 8191-8192, exactly on the
  // 8 KiB chunk edge: the chunk end must not split the pair.
  const pre = '# ' + 'x'.repeat(8189) + '\u{1F600}\n';
  assert.equal(pre.indexOf('\u{1F600}'), 8191);
  const parsed = parsePy('edge.py', pre + PAD + 'def edge_fn():\n    return 1\n');
  assert.deepEqual(parsed.definitions.map((d) => d.name), ['edge_fn']);
});

test('small non-ASCII Python file: names are exact', () => {
  const parsed = parsePy('small.py', '# caf\u00e9 \u{1F600}\ndef hello():\n    return world()\n\ndef world():\n    return 1\n');
  assert.deepEqual(parsed.definitions.map((d) => d.name), ['hello', 'world']);
  assert.deepEqual(parsed.definitions.find((d) => d.name === 'hello').uses, ['world']);
});

test('large JavaScript file parses: dead/live grading past 32 KiB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-large-js-'));
  const src = '// ' + 'y'.repeat(40000) + '\n'
    + 'function bigLive() { return bigHelper(); }\n'
    + 'function bigHelper() { return 1; }\n'
    + 'function bigDead() { return 2; }\n'
    + 'bigLive();\n';
  assert.ok(Buffer.byteLength(src, 'utf8') > 32768);
  write(dir, 'app.js', src);
  const result = scan(dir);
  const byId = new Map(result.findings.map((f) => [f.id.split(':').slice(0, 3).join(':'), f]));
  assert.equal(byId.get('function:app.js:bigDead').grade, 'SAFE');
  assert.equal(byId.has('function:app.js:bigLive'), false);
  assert.equal(byId.has('function:app.js:bigHelper'), false);
});

test('large JavaScript file with non-ASCII early: names after the boundary are exact', () => {
  const src = '// caf\u00e9 \u{1F600}\nconst pad = "' + 'y'.repeat(40000) + '";\n'
    + 'function bigLive() { return bigHelper(); }\n'
    + 'function bigHelper() { return 1; }\n';
  const parsed = parseJsTs('big.js', src, '.js');
  assert.deepEqual(parsed.definitions.map((d) => d.name), ['pad', 'bigLive', 'bigHelper']);
  assert.deepEqual(parsed.definitions.find((d) => d.name === 'bigLive').uses, ['bigHelper']);
});

test('small non-ASCII JavaScript file: names are exact', () => {
  const parsed = parseJsTs('small.js', '// caf\u00e9 \u{1F600}\nfunction hi() { return yo(); }\nfunction yo() { return 1; }\nhi();\n', '.js');
  assert.deepEqual(parsed.definitions.map((d) => d.name), ['hi', 'yo']);
  assert.deepEqual(parsed.definitions.find((d) => d.name === 'hi').uses, ['yo']);
});
