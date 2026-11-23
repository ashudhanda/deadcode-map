'use strict';

/**
 * Regression test: symbol names that collide with Object.prototype members
 * must not crash the web analyzer.
 *
 * docs/analyzer.js cached string mentions in a plain {} object, so
 * stringCache["constructor"] returned the inherited Object constructor
 * (a function) instead of a Set, and the .forEach call on it threw
 * "stringHits.forEach is not a function" — which broke the live web
 * checker on any repo defining a class constructor (e.g. this repo's own
 * test/mcp.test.js). The cache is now a null-prototype object.
 * The CLI never had this bug: it uses a Map for the same cache.
 *
 * Run with: node --test test/web-prototype-names.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeFiles } = require('../docs/analyzer');

const CLIENT = [
  'class Client {',
  '  constructor(script, args) { this.script = script; }',
  '  send(x) { return x; }',
  '  toString() { return "Client"; }',
  '  valueOf() { return 1; }',
  '}',
  'module.exports = { Client };',
  '',
].join('\n');

const INDEX = [
  'const { Client } = require("./client");',
  'const c = new Client("a", []);',
  'console.log(c.send(1));',
  '',
].join('\n');

test('web analyzer: Object.prototype symbol names do not crash the scan', () => {
  const out = analyzeFiles([
    { path: 'src/client.js', content: CLIENT },
    { path: 'src/index.js', content: INDEX },
  ]);
  assert.ok(Array.isArray(out.findings), 'findings must be an array');
  // Nothing here may ever be graded SAFE: the class is used, and a crash
  // used to hide every finding behind an error banner instead.
  for (const f of out.findings) {
    assert.notEqual(f.grade, 'SAFE', `${f.file}:${f.symbol} must not be SAFE`);
  }
});

test('web analyzer: a standalone function named like a prototype member is handled', () => {
  // b.js is the entry point (package.json main): the program is live,
  // so the function it imports and calls must not be flagged. (Without
  // the entry, b.js itself is dead — nothing imports it — and the CLI
  // grades both files SAFE and hasOwnProperty REVIEW, since its only
  // caller is dead code; the cascade must agree with that, not hide it.)
  const out = analyzeFiles([
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/b.js' }) },
    { path: 'src/a.js', content: 'function hasOwnProperty(x) { return !!x; }\nmodule.exports = { hasOwnProperty };\n' },
    { path: 'src/b.js', content: 'const { hasOwnProperty } = require("./a");\nconsole.log(hasOwnProperty(1));\n' },
  ]);
  assert.ok(Array.isArray(out.findings), 'findings must be an array');
  const flagged = out.findings.filter((f) => f.symbol === 'hasOwnProperty');
  assert.equal(flagged.length, 0, 'a used function must not be flagged');
});

test('web analyzer: string-index tokens named like prototype members return a Set', () => {
  // The inverted string index (docs/analyzer.js, mirroring src/graph.js)
  // is a null-prototype object for the same reason as the cache above:
  // a token like "toString" must look up a Set of files, never the
  // inherited Object.prototype.toString function. "toString" as a
  // code-like string token is a string mention, so the unexported
  // toString in a.js is REVIEW (string-referenced), never SAFE — and
  // the lookup itself must not throw.
  const out = analyzeFiles([
    { path: 'package.json', content: JSON.stringify({ name: 't', main: 'src/b.js' }) },
    { path: 'src/a.js', content: 'function toString() { return "x"; }\nmodule.exports = { toString };\n' },
    { path: 'src/b.js', content: 'const key = "toString";\nconsole.log(key);\n' },
  ]);
  assert.ok(Array.isArray(out.findings), 'findings must be an array');
  const flagged = out.findings.find((f) => f.file === 'src/a.js' && f.symbol === 'toString');
  assert.ok(flagged, 'toString must be found');
  assert.equal(flagged.grade, 'REVIEW', 'a string-referenced symbol is REVIEW, never SAFE');
});
