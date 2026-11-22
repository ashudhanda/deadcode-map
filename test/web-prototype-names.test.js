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
  const out = analyzeFiles([
    { path: 'src/a.js', content: 'function hasOwnProperty(x) { return !!x; }\nmodule.exports = { hasOwnProperty };\n' },
    { path: 'src/b.js', content: 'const { hasOwnProperty } = require("./a");\nconsole.log(hasOwnProperty(1));\n' },
  ]);
  assert.ok(Array.isArray(out.findings), 'findings must be an array');
  const flagged = out.findings.filter((f) => f.symbol === 'hasOwnProperty');
  assert.equal(flagged.length, 0, 'a used function must not be flagged');
});
