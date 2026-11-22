'use strict';

/**
 * Web analyzer batch-9 tests: the four web-only SAFE false positives on
 * vuejs/vue (batch 8) — a require() nested in a function body whose uses
 * the accumulator swallowed, and a classic-script global defined with
 * the `var X = X || ...` namespace idiom.
 *
 * Run with: node --test test/web-batch9-vue.test.js
 * (Kept out of `npm test` for now — the coordinator wires it in at merge.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeFiles } = require('../docs/analyzer');

function bySymbol(findings, file, symbol) {
  return findings.find((f) => f.file.endsWith(file) && f.symbol === symbol);
}

test('web batch9 vue2 require-in-function: a require() nested in a function body is live when called', () => {
  // vuejs/vue packages/compiler-sfc/src/stylePreprocessors.ts: each
  // preprocessor is an arrow function that requires its engine lazily
  // (`const nodeSass = require('sass')`) and calls it on the next
  // lines (`nodeSass.renderSync(...)`). The old multi-line require
  // accumulator swallowed the whole arrow-function body starting at
  // the `const scss: ... = (...) => {` line, found the nested require,
  // and marked every swallowed line as a binding line — so the real
  // uses were skipped as "import binding, not a use" and all three
  // engines looked like dead imports.
  const f = analyzeFiles([
    {
      path: 'src/stylePreprocessors.ts',
      content: [
        "import merge from 'merge-source-map'",
        '',
        'export type StylePreprocessor = (source: string) => string',
        '',
        'const scss: StylePreprocessor = (source, map, options) => {',
        "  const nodeSass = require('sass')",
        '  const result = nodeSass.renderSync({ data: source })',
        '  return result.css.toString()',
        '}',
        '',
        'const less: StylePreprocessor = (source, map, options) => {',
        "  const nodeLess = require('less')",
        '  nodeLess.render(source, {}, (err, output) => {})',
        '  return source',
        '}',
        '',
        'const styl: StylePreprocessor = (source, map, options) => {',
        "  const nodeStylus = require('stylus')",
        '  return source',
        '}',
        '',
        'export { scss, less, styl }',
      ].join('\n'),
    },
  ]).findings;
  assert.equal(bySymbol(f, 'src/stylePreprocessors.ts', 'nodeSass'), undefined, 'nodeSass is called (renderSync) and must not be flagged');
  assert.equal(bySymbol(f, 'src/stylePreprocessors.ts', 'nodeLess'), undefined, 'nodeLess is called (render) and must not be flagged');
  // Precision: a require nested in a function body that is never used
  // is still a dead import — the fix must not blind the check.
  assert.equal(bySymbol(f, 'src/stylePreprocessors.ts', 'nodeStylus').grade, 'SAFE', 'nodeStylus is never used and must still be a dead import');
});

test('web batch9 vue2 multiline-require: a destructuring require split across lines still binds per line', () => {
  // The binding names of a multi-line `const {\n a,\n b\n} =
  // require('./x')` live on the lines the match spans: a use of `a`
  // on a later line counts, and an unused `b` is still SAFE. This is
  // the shape the requireLineBindings range exists for — the batch-9
  // fix narrows that range to the match span, so this must keep
  // working exactly as before.
  const f = analyzeFiles([
    {
      path: 'src/main.js',
      content: [
        'const {',
        '  live,',
        '  unused',
        "} = require('./util');",
        'console.log(live());',
      ].join('\n'),
    },
    {
      path: 'src/util.js',
      content: 'function live() { return 1; }\nfunction unused() { return 2; }\nmodule.exports = { live, unused };',
    },
  ]).findings;
  assert.equal(bySymbol(f, 'src/main.js', 'live'), undefined, 'live is called and must not be flagged');
  assert.equal(bySymbol(f, 'src/main.js', 'unused').grade, 'SAFE', 'unused is never referenced and must still be a dead import');
});

test('web batch9 vue2 global-namespace: var X = X || ... reads the pre-existing global', () => {
  // vuejs/vue benchmarks/dbmon: monitor.js opens with
  // `var Monitoring = Monitoring || (function() {...})` and app.js
  // calls `Monitoring.renderRate.ping()`. The right-hand side read of
  // Monitoring is a real use — the CLI's tree-sitter parse counts it
  // (the declaration site is one node, the read is another) — while
  // the old web skip dropped every occurrence of the declared name on
  // its declaration line, so the global looked unreferenced.
  const f = analyzeFiles([
    {
      path: 'benchmarks/dbmon/lib/monitor.js',
      content: [
        'var Monitoring = Monitoring || (function() {',
        '  return {',
        '    renderRate: { ping: function () {} },',
        '  };',
        '})();',
      ].join('\n'),
    },
    {
      path: 'benchmarks/dbmon/app.js',
      content: 'Monitoring.renderRate.ping();',
    },
    {
      path: 'benchmarks/dbmon/lib/dead.js',
      content: 'function deadGlobal() { return 1; }',
    },
  ]).findings;
  assert.equal(bySymbol(f, 'benchmarks/dbmon/lib/monitor.js', 'Monitoring'), undefined, 'Monitoring is read on its own declaration line and called from app.js and must not be flagged');
  // Precision: a classic-script global nothing reads or calls is still SAFE.
  assert.equal(bySymbol(f, 'benchmarks/dbmon/lib/dead.js', 'deadGlobal').grade, 'SAFE', 'deadGlobal is never used and must still be SAFE');
});
