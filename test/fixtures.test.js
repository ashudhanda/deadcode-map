'use strict';

/**
 * Fixture tests: the FP rate on SAFE is the claim that matters.
 * Every live symbol in the fixtures must NOT be flagged SAFE;
 * every planted dead item must be found at SAFE or REVIEW.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan } = require('../src/index');

const ROOT = path.join(__dirname, '..');

function findingsFor(dir) {
  return scan(path.join(ROOT, 'fixtures', dir)).findings;
}

function bySymbol(findings, file, symbol) {
  return findings.find((f) => f.file.endsWith(file) && f.symbol === symbol);
}

function byCategory(findings, file, category) {
  return findings.find((f) => f.file.endsWith(file) && f.category === category && !f.symbol);
}

test('js-basic: live symbols are never flagged', () => {
  const f = findingsFor('js-basic');
  for (const [file, symbol] of [
    ['src/index.js', null],
    ['src/used.js', 'usedFn'],
    ['src/used.js', 'privateUsed'],
    ['src/helper.js', 'helper'],
  ]) {
    if (symbol) assert.equal(bySymbol(f, file, symbol), undefined, `${symbol} must not be flagged`);
  }
  // No live symbol may be SAFE.
  const live = ['usedFn', 'privateUsed', 'helper'];
  for (const finding of f.filter((x) => x.grade === 'SAFE')) {
    assert.ok(!live.includes(finding.symbol), `live symbol flagged SAFE: ${finding.symbol}`);
  }
});

test('js-basic: planted dead items are found', () => {
  const f = findingsFor('js-basic');
  assert.equal(byCategory(f, 'src/dead-file.js', 'file').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/used.js', 'unusedImport').grade, 'SAFE');
  assert.equal(byCategory(f, 'src/used.js', 'unreachable').grade, 'SAFE');
  // Exported-but-never-imported is REVIEW, never SAFE.
  assert.equal(bySymbol(f, 'src/used.js', 'privateDead').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/used.js', 'unusedExport').grade, 'REVIEW');
  // Same-file use is alive, not a finding: helper() calls sameFileOnly()
  // in its own file, so it is used — never REVIEW, never SAFE.
  assert.equal(bySymbol(f, 'src/helper.js', 'sameFileOnly'), undefined);
  // String-referenced symbol is REVIEW, never SAFE.
  assert.equal(bySymbol(f, 'src/string-ref.js', 'stringOnlyFn').grade, 'REVIEW');
  assert.equal(byCategory(f, 'src/string-ref.js', 'file').grade, 'REVIEW');
  // Dynamic-import target is REVIEW, never SAFE.
  assert.equal(bySymbol(f, 'src/lazy-target.js', 'lazyFn').grade, 'REVIEW');
});

test('js-basic: SAFE false-positive rate is 0%', () => {
  const f = findingsFor('js-basic');
  const safe = f.filter((x) => x.grade === 'SAFE');
  // Planted SAFE items: dead-file, unused import, unreachable code.
  // dynamic.js file is also genuinely dead (nothing imports it).
  // lazy-target.js is second-order dead (cascade): its only importer is
  // dead dynamic.js, which loads it via import() — deleting dynamic.js
  // leaves lazy-target.js unreferenced in the same run.
  const expectedSafe = new Set([
    'file:src/dead-file.js', 'file:src/dynamic.js', 'file:src/lazy-target.js',
    'import:src/used.js:unusedImport', 'unreachable:src/used.js',
  ]);
  const lazyTarget = byCategory(f, 'src/lazy-target.js', 'file');
  assert.equal(lazyTarget.grade, 'SAFE');
  assert.ok(lazyTarget.evidence.cascade, 'lazy-target.js must carry cascade evidence');
  assert.deepEqual(lazyTarget.evidence.cascade.via, ['src/dynamic.js']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
  const fpRate = safe.filter((s) => !expectedSafe.has(`${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`)).length / Math.max(safe.length, 1);
  assert.ok(fpRate < 0.05, `SAFE FP rate ${fpRate} exceeds 5% target`);
});

test('py-basic: live symbols are never flagged, framework kept', () => {
  const f = findingsFor('py-basic');
  for (const symbol of ['used_fn', 'format_name', '_double']) {
    assert.equal(bySymbol(f, 'utils.py', symbol), undefined, `${symbol} must not be flagged`);
  }
  assert.equal(bySymbol(f, 'app.py', 'hello').grade, 'KEEP'); // @app.route
  assert.equal(bySymbol(f, 'test_utils.py', 'test_used_fn').grade, 'KEEP');
  assert.equal(bySymbol(f, 'utils.py', '__init__').grade, 'KEEP');
  assert.equal(bySymbol(f, 'utils.py', '__str__').grade, 'KEEP');
});

test('py-basic: planted dead items are found, SAFE FP rate 0%', () => {
  const f = findingsFor('py-basic');
  assert.equal(byCategory(f, 'dead_module.py', 'file').grade, 'SAFE');
  assert.equal(bySymbol(f, 'utils.py', '_private_dead').grade, 'SAFE');
  assert.equal(bySymbol(f, 'utils.py', 'dead_fn').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'utils.py', 'Greeter').grade, 'REVIEW');
  // Methods are REVIEW at most, never SAFE.
  assert.equal(bySymbol(f, 'utils.py', 'unused_method').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'utils.py', 'greet').grade, 'REVIEW');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['file:dead_module.py', 'function:utils.py:_private_dead']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('py-basic: runnable __main__ script is an entry point, comments are not unreachable', () => {
  const f = findingsFor('py-basic');
  assert.equal(bySymbol(f, 'run.py', 'run'), undefined, 'run() in a __main__ script must not be flagged');
  assert.equal(byCategory(f, 'run.py', 'file'), undefined, 'a __main__ script must not be a dead file');
  assert.equal(f.filter((x) => x.category === 'unreachable').length, 0, 'trailing comment after return must not be unreachable');
});

test('py-relative: relative imports resolve, live symbols are never flagged', () => {
  const f = findingsFor('py-relative');
  // Every live symbol must have NO finding at all. With broken relative
  // resolution these all came back REVIEW ("0 callers, but referenced
  // by name as a string elsewhere") and their files came back REVIEW too.
  assert.equal(bySymbol(f, 'pkg/utils.py', 'helper_fn'), undefined);
  assert.equal(bySymbol(f, 'pkg/core.py', 'run'), undefined);
  assert.equal(bySymbol(f, 'shared.py', 'shared_fn'), undefined);
  assert.equal(byCategory(f, 'pkg/utils.py', 'file'), undefined);
  assert.equal(byCategory(f, 'pkg/core.py', 'file'), undefined);
  assert.equal(byCategory(f, 'shared.py', 'file'), undefined);
  assert.equal(byCategory(f, 'pkg/__init__.py', 'file'), undefined);
  // __init__.py imports are re-exports of the package namespace
  // (`from . import utils` makes pkg.utils importable) — never dead
  // imports, even though nothing in the file itself uses the names.
  assert.equal(bySymbol(f, 'pkg/__init__.py', 'utils'), undefined);
  assert.equal(bySymbol(f, 'pkg/__init__.py', 'run'), undefined);
  // deep.py is genuinely unimported: the file is SAFE, the exported
  // function is REVIEW, never SAFE.
  assert.equal(byCategory(f, 'pkg/sub/deep.py', 'file').grade, 'SAFE');
  assert.equal(bySymbol(f, 'pkg/sub/deep.py', 'deep').grade, 'REVIEW');
});

test('py-relative: SAFE false-positive rate is 0%', () => {
  const f = findingsFor('py-relative');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['file:pkg/sub/deep.py']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('py-imports: module dunders are KEEP, never SAFE or deleted', () => {
  const f = findingsFor('py-imports');
  // __version__ / __author__ are read by packaging tooling, __all__
  // defines the public exports — all three were flagged SAFE before.
  assert.equal(bySymbol(f, 'pkg/__init__.py', '__version__').grade, 'KEEP');
  assert.equal(bySymbol(f, 'pkg/__init__.py', '__author__').grade, 'KEEP');
  assert.equal(bySymbol(f, 'pkg/__init__.py', '__all__').grade, 'KEEP');
  // The names listed in __all__ are live: main.py imports them.
  assert.equal(bySymbol(f, 'pkg/__init__.py', 'helper'), undefined);
});

test('py-imports: dotted imports bind the top-level name', () => {
  const f = findingsFor('py-imports');
  // `import pkg.sub` binds `pkg`; used as pkg.sub.deep_fn() — the
  // submodule and its function are live.
  assert.equal(bySymbol(f, 'pkg/sub.py', 'deep_fn'), undefined);
  assert.equal(byCategory(f, 'pkg/sub.py', 'file'), undefined);
  // `import os.path` binds `os`; unused here, so the dead import is
  // found (before, the import statement leaked its own names into the
  // reference set and no unused Python import was ever flagged).
  assert.equal(bySymbol(f, 'unused_imports.py', 'os').grade, 'SAFE');
  assert.equal(bySymbol(f, 'unused_imports.py', 'os').category, 'import');
  // The used import on the next line is not flagged.
  assert.equal(bySymbol(f, 'unused_imports.py', 'json'), undefined);
  assert.equal(bySymbol(f, 'unused_imports.py', 'alive'), undefined);
});

test('py-imports: SAFE false-positive rate is 0%', () => {
  const f = findingsFor('py-imports');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['import:unused_imports.py:os']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('py-multiline: multi-line imports resolve, dead ones are found (CLI parity)', () => {
  const f = findingsFor('py-multiline');
  assert.equal(bySymbol(f, 'multiline.py', 'defaultdict').grade, 'SAFE');
  assert.equal(bySymbol(f, 'multiline.py', 'OrderedDict').grade, 'SAFE');
  assert.equal(bySymbol(f, 'multiline.py', 'regex').grade, 'SAFE');
  assert.equal(bySymbol(f, 'multiline.py', 'Counter'), undefined);
  assert.equal(bySymbol(f, 'multiline.py', 'ospath'), undefined);
  assert.equal(bySymbol(f, 'multiline.py', 'json'), undefined);
  assert.equal(bySymbol(f, 'multiline.py', 'build'), undefined);
  assert.equal(byCategory(f, 'multiline.py', 'file'), undefined);
});

test('py-multiline: SAFE false-positive rate is 0% (CLI)', () => {
  const f = findingsFor('py-multiline');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'import:multiline.py:defaultdict', 'import:multiline.py:OrderedDict',
    'import:multiline.py:regex',
  ]);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('js-framework: Next.js route files are never flagged', () => {
  const f = findingsFor('js-framework');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
  assert.equal(f.filter((x) => x.grade === 'REVIEW').length, 0);
  assert.ok(f.every((x) => x.grade === 'KEEP'));
});

test('js-framework: middleware / proxy files are framework entry points at any depth', () => {
  const f = findingsFor('js-framework');
  // docker/proxy.ts is the Next.js middleware (Next 15.2+ renames
  // middleware.ts to proxy.ts). The default-exported middleware function
  // and the config.matcher export are framework-resolved, never dead.
  assert.equal(byCategory(f, 'docker/proxy.ts', 'file').grade, 'KEEP');
  assert.equal(bySymbol(f, 'docker/proxy.ts', 'middleware').grade, 'KEEP');
  assert.equal(bySymbol(f, 'docker/proxy.ts', 'config').grade, 'KEEP');
  // The type-only import is used (parameter type) — not a dead import.
  assert.equal(bySymbol(f, 'docker/proxy.ts', 'NextRequest'), undefined);
});

test('js-string: prose mentions are not string references', () => {
  const f = findingsFor('js-string');
  // Mentioned only as words in sentences (string literals, README, .txt).
  assert.equal(bySymbol(f, 'src/index.js', 'render').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/index.js', 'named').grade, 'SAFE');
  // Mentioned only inside a URL-encoded token: `%70age` is not a
  // reference to `age` (a digit before the name breaks the boundary).
  assert.equal(bySymbol(f, 'src/index.js', 'age').grade, 'SAFE');
  // Mentioned as code: dotted string and whole string in config.json.
  assert.equal(bySymbol(f, 'src/index.js', 'handler').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/index.js', 'wired').grade, 'REVIEW');
  // No other SAFE findings: nothing live is flagged, no file is dead.
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['function:src/index.js:render', 'function:src/index.js:named', 'function:src/index.js:age']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('py-string: docstring prose is not a string reference', () => {
  const f = findingsFor('py-string');
  // Mentioned only in a docstring, a sentence string, and README prose.
  assert.equal(bySymbol(f, 'main.py', '_load').grade, 'SAFE');
  // Mentioned as code: dotted string and whole string in config.yaml.
  assert.equal(bySymbol(f, 'main.py', 'sync').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'main.py', 'dump').grade, 'REVIEW');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['function:main.py:_load']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('fixtures: fixture directories are excluded by default, includeFixtures opts back in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-fixtures-'));
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write('package.json', JSON.stringify({ name: 't', main: 'src/index.js' }));
  write('src/index.js', "const { live } = require('./live');\nconsole.log(live());\n");
  write('src/live.js', 'function live() { return 1; }\nmodule.exports = { live };\n');
  // Planted dead code in fixture dirs at several depths.
  write('fixtures/dead.js', 'function plantedDead() { return 1; }\nmodule.exports = { plantedDead };\n');
  write('test/fixtures/dead2.js', 'function plantedDead2() { return 1; }\nmodule.exports = { plantedDead2 };\n');
  write('src/__fixtures__/dead3.js', 'function plantedDead3() { return 1; }\nmodule.exports = { plantedDead3 };\n');
  const def = scan(dir).findings;
  assert.equal(def.length, 0, `fixture dirs must be excluded by default, got: ${JSON.stringify(def.map((f) => `${f.file}:${f.symbol || ''}`))}`);
  const inc = scan(dir, { includeFixtures: true }).findings;
  assert.ok(inc.some((f) => f.symbol === 'plantedDead'), 'plantedDead must be found with includeFixtures');
  assert.ok(inc.some((f) => f.symbol === 'plantedDead2'), 'plantedDead2 must be found with includeFixtures');
  assert.ok(inc.some((f) => f.symbol === 'plantedDead3'), 'plantedDead3 must be found with includeFixtures');
});

test('ts-types: references in type positions count as uses', () => {
  const f = findingsFor('ts-types');
  // import type bindings used only as annotations / type arguments /
  // typeof — the axios declaration-consumer / umami api-client shape.
  for (const symbol of ['Client', 'Response', 'User', 'CustomResponse']) {
    assert.equal(bySymbol(f, 'src/consumer.ts', symbol), undefined, `${symbol} is used in a type position and must not be flagged`);
  }
  assert.equal(bySymbol(f, 'src/consumer.ts', 'client'), undefined, 'declare const client is used via typeof');
  assert.equal(bySymbol(f, 'src/consumer.ts', 'request'), undefined, 'request is called with type arguments');
  assert.equal(bySymbol(f, 'src/consumer.ts', 'runCheck'), undefined, 'runCheck is imported by the entry point');
  // The genuinely dead items are still found.
  assert.equal(bySymbol(f, 'src/consumer.ts', 'UnusedImport').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/consumer.ts', 'UnusedImport').category, 'import');
  assert.equal(bySymbol(f, 'src/consumer.ts', 'LocalDead').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/client.ts', 'NeverUsed').grade, 'REVIEW');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'import:src/consumer.ts:UnusedImport', 'type:src/consumer.ts:LocalDead',
  ]);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('py-annotations: string annotations, TYPE_CHECKING and __all__ count as uses', () => {
  const f = findingsFor('py-annotations');
  // TYPE_CHECKING imports used only in string annotations.
  for (const symbol of ['Context', 'Buffer', 'TypeAdapter']) {
    assert.equal(bySymbol(f, 'pkg/core.py', symbol), undefined, `${symbol} is used in a string annotation and must not be flagged`);
  }
  // Names re-exported via __all__ (tuple form) are live re-exports.
  for (const symbol of ['Annotated', 'get_type_hints']) {
    assert.equal(bySymbol(f, 'pkg/core.py', symbol), undefined, `${symbol} is re-exported via __all__ and must not be flagged`);
  }
  assert.equal(bySymbol(f, 'pkg/core.py', 'run'), undefined, 'run is re-exported by the package __init__');
  // Module re-exported from __init__: its contents are public API, and
  // attribute use through the package (pkg.colors.RED) counts as use.
  assert.equal(bySymbol(f, 'pkg/colors.py', 'RED'), undefined, 'typer.colors.RED shape: used via the package attribute');
  assert.equal(bySymbol(f, 'pkg/colors.py', 'GREEN'), undefined);
  assert.equal(bySymbol(f, 'pkg/colors.py', 'BLUE').grade, 'REVIEW', 're-exported but never used anywhere: REVIEW at most, never SAFE');
  // The genuinely dead import is still found.
  assert.equal(bySymbol(f, 'pkg/core.py', 'os').grade, 'SAFE');
  assert.equal(bySymbol(f, 'pkg/core.py', 'os').category, 'import');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set(['import:pkg/core.py:os']);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('py-reexports: redundant aliases, noqa imports and compat shims are re-exports, never dead imports', () => {
  const f = findingsFor('py-reexports');
  // `from . import helpers as helpers` in __init__ re-exports the module.
  assert.equal(bySymbol(f, 'pkg/helpers.py', 'assist'), undefined, 'helpers.assist is used through the package');
  assert.equal(byCategory(f, 'pkg/helpers.py', 'file'), undefined, 'a re-exported module is not a dead file');
  // Compat shim: its imports ARE its public API.
  for (const symbol of ['json', 'socket', 'OrderedDict', 'urlparse']) {
    assert.equal(bySymbol(f, 'pkg/compat.py', symbol), undefined, `${symbol} in a compat shim is a re-export, never a dead import`);
  }
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('js-reexports: export { X } re-exports an import, and .js imports resolve to .ts files', () => {
  const f = findingsFor('js-reexports');
  // `import { helper } from './lib.js'` resolves to lib.ts (TS ESM
  // style), and `export { helper }` in reexport.ts counts as a use.
  assert.equal(bySymbol(f, 'src/reexport.ts', 'helper'), undefined, 'export { helper } is a use of the imported binding');
  assert.equal(bySymbol(f, 'src/lib.ts', 'helper'), undefined, 'helper is imported (and re-exported) through the .js specifier');
  assert.equal(bySymbol(f, 'src/runner.ts', 'run'), undefined, 'run is imported through the .js specifier');
  assert.equal(byCategory(f, 'src/runner.ts', 'file'), undefined);
  assert.equal(byCategory(f, 'src/lib.ts', 'file'), undefined);
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('js-alias: tsconfig paths aliases (@/* and exact @util) resolve to real files', () => {
  const f = findingsFor('js-alias');
  // Both the star alias and the exact alias import helper from util.ts.
  assert.equal(bySymbol(f, 'src/lib/util.ts', 'helper'), undefined, 'helper is imported through @/lib/util and @util');
  assert.equal(byCategory(f, 'src/lib/util.ts', 'file'), undefined, 'util.ts is imported through an alias');
  // An exported-but-unimported function in the same file is still REVIEW.
  assert.equal(bySymbol(f, 'src/lib/util.ts', 'unusedFn').grade, 'REVIEW');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('py-decorated: a decorated method is a method (REVIEW, never SAFE); bare annotations and TypeAlias strings and %-format placeholders are live', () => {
  const f = findingsFor('py-decorated');
  // @contextmanager def session is called from main.py via an instance
  // (the member-use rule attributes it), so it has no finding. An
  // UNCALLED decorated method must be a method (REVIEW cap), never a
  // SAFE function — before the fix its kind was 'function' because the
  // decorator wrapper hid the class-body parent.
  assert.equal(bySymbol(f, 'app.py', 'session'), undefined, 'session is called via an instance in main.py');
  assert.equal(bySymbol(f, 'app.py', 'unused_ctx').grade, 'REVIEW');
  // A bare annotation (`timeout: int`, no value) creates no binding.
  assert.equal(bySymbol(f, 'app.py', 'timeout'), undefined, 'a bare annotation is a type declaration, not a definition');
  // "Response" inside a TypeAlias value is a forward reference.
  assert.equal(bySymbol(f, 'app.py', 'Response'), undefined, 'a TypeAlias value string is a forward reference');
  // %(complete_func)s in a template string is a runtime lookup.
  assert.equal(bySymbol(f, 'app.py', 'complete_func'), undefined, 'a %-format placeholder is a use');
  // The template itself and the alias are exported but unimported: REVIEW.
  assert.equal(bySymbol(f, 'app.py', 'TEMPLATE').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'app.py', 'Hook').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'app.py', 'make_client'), undefined);
  assert.equal(bySymbol(f, 'app.py', 'run'), undefined);
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('monorepo: a private sub-package under a published root is still a library', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-monorepo-'));
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  // Root is the published package (exports); the sub-package is marked
  // private because it is published through the root (preact's compat/
  // and hooks/ layout). Its exports are public API — REVIEW, never SAFE.
  write('package.json', JSON.stringify({ name: 'root-pkg', main: 'index.js', exports: { '.': './index.js' } }));
  write('index.js', 'console.log("root");\n');
  write('packages/sub/package.json', JSON.stringify({ name: 'sub-pkg', private: true, main: 'src/index.js' }));
  write('packages/sub/src/index.js', 'export function pubFn() { return 1; }\nexport const pubVal = 1;\n');
  const f = scan(dir).findings;
  assert.equal(bySymbol(f, 'packages/sub/src/index.js', 'pubFn').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'packages/sub/src/index.js', 'pubVal').grade, 'REVIEW');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('py-pydantic: model fields, validators and overload groups are framework-invoked, never SAFE', () => {
  const f = findingsFor('py-pydantic');
  // Pydantic BaseModel fields (populated from external data) and
  // @dataclass fields: either no finding (a string hit or a call
  // proves them used) or a KEEP finding — never SAFE or REVIEW.
  for (const symbol of ['name', 'schema_', 'vocabulary', 'x', 'y', 'extra_field']) {
    const found = bySymbol(f, 'models.py', symbol);
    assert.ok(!found || found.grade === 'KEEP', `${symbol} is a model field — must be KEEP or absent, never ${found && found.grade}`);
  }
  // @model_validator is invoked by Pydantic at validation time.
  const check = bySymbol(f, 'models.py', 'check');
  assert.ok(!check || check.grade === 'KEEP', '@model_validator is framework-invoked');
  // The @overload group (2 stubs + implementation) is kept whole; the
  // implementation is called from main.py, so it may also be absent.
  const get = bySymbol(f, 'models.py', 'get');
  assert.ok(!get || get.grade === 'KEEP', 'an overload group is kept, stubs and implementation alike');
  // A genuinely unused plain function in the same library is still REVIEW.
  assert.equal(bySymbol(f, 'models.py', 'unused_fn').grade, 'REVIEW');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('py-class-attrs: framework-consumed class attributes are never SAFE', () => {
  const f = findingsFor('py-class-attrs');
  // (c) Config/theme class: a subclass of an externally-defined base
  // whose body defines only attributes is read by the framework at
  // runtime (the Pygments Style subclass shape) — KEEP, never SAFE.
  for (const symbol of ['background_color', 'default_style', 'styles']) {
    assert.equal(bySymbol(f, 'theme.py', symbol).grade, 'KEEP', `${symbol} is a config-class attribute`);
  }
  // (b) Override of an externally-defined parent attribute (the
  // Werkzeug Response.default_mimetype shape): the parent source is
  // not in the repo, so it cannot be proven dead — REVIEW, never SAFE.
  // The class defines a method, so the config-class rule does not fire.
  assert.equal(bySymbol(f, 'response.py', 'default_mimetype').grade, 'REVIEW');
  // (a) Chained-assignment aliases of a method defined in the same
  // class (the NullSession `popitem = _fail` shape): the names are one
  // object with the method, part of the class interface — KEEP.
  for (const symbol of ['clear', 'pop', 'popitem']) {
    assert.equal(bySymbol(f, 'sessions.py', symbol).grade, 'KEEP', `${symbol} is an alias of the _fail method`);
  }
  // (d) A class attribute documented with a Sphinx `#:` comment is part
  // of the class's documented public API (the pickle_based shape) —
  // REVIEW, never SAFE.
  assert.equal(bySymbol(f, 'sessions.py', 'pickle_based').grade, 'REVIEW');
  // Negatives: genuinely dead class attributes stay SAFE. A class with
  // no base, a subclass of a base defined in the same file, a chain
  // ending in an imported name (not a method of the class), and a
  // module-level chain are all ordinary candidates.
  assert.equal(bySymbol(f, 'plain.py', 'dead_attr').grade, 'SAFE');
  assert.equal(bySymbol(f, 'plain.py', 'child_dead_attr').grade, 'SAFE');
  assert.equal(bySymbol(f, 'plain.py', 'first').grade, 'SAFE');
  assert.equal(bySymbol(f, 'plain.py', 'second').grade, 'SAFE');
  assert.equal(bySymbol(f, 'plain.py', '_first').grade, 'SAFE');
  assert.equal(bySymbol(f, 'plain.py', '_second').grade, 'SAFE');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'variable:plain.py:dead_attr', 'variable:plain.py:child_dead_attr',
    'variable:plain.py:first', 'variable:plain.py:second',
    'variable:plain.py:_first', 'variable:plain.py:_second',
  ]);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('ts-ambient: declare module augmentation is declaration merging, never dead', () => {
  const f = findingsFor('ts-ambient');
  assert.equal(bySymbol(f, 'src/devtools.ts', 'StoreMutators').grade, 'KEEP');
  assert.equal(byCategory(f, 'src/devtools.ts', 'file'), undefined, 'the augmentation file is imported by the entry point');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('ts-testfile: a file literally named test.ts holds type-test functions — KEEP, never SAFE', () => {
  const f = findingsFor('ts-testfile');
  assert.equal(byCategory(f, 'src/foo/test.ts', 'file').grade, 'KEEP');
  assert.equal(bySymbol(f, 'src/foo/test.ts', '_test').grade, 'KEEP');
  assert.equal(bySymbol(f, 'src/lib.ts', 'usedFn'), undefined);
  assert.equal(bySymbol(f, 'src/lib.ts', 'unusedExport').grade, 'REVIEW');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('unreachable: code marked pragma: no cover / istanbul ignore is intentional, never flagged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-pragma-'));
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write('package.json', JSON.stringify({ name: 't', main: 'src/index.js' }));
  write('src/index.js', "const { run } = require('./lib');\nconsole.log(run());\n");
  write('src/lib.js', [
    'function run() { return 1; }',
    'function gen() {',
    '  /* istanbul ignore next */',
    '  throw new Error("never");',
    '  return 2;',
    '}',
    'module.exports = { run, gen };',
    '',
  ].join('\n'));
  write('main.py', "from mod import run\n\nif __name__ == '__main__':\n    print(run())\n");
  write('mod.py', [
    'def run():',
    '    return 1',
    '',
    '',
    'def gen():',
    '    raise RuntimeError("never")  # pragma: no cover',
    '    yield 1',
    '',
  ].join('\n'));
  const f = scan(dir).findings;
  assert.equal(byCategory(f, 'src/lib.js', 'unreachable'), undefined, 'the istanbul-ignored return is intentional');
  assert.equal(byCategory(f, 'mod.py', 'unreachable'), undefined, 'the pragma: no cover yield is intentional');
  // gen is exported but never imported: still REVIEW (the pragma only
  // covers the unreachable statement inside it, not the function).
  assert.equal(bySymbol(f, 'src/lib.js', 'gen').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'mod.py', 'gen').grade, 'REVIEW');
});

test('js-methods: a method is not used by its own declaration line; new counts as a constructor call', () => {
  const f = findingsFor('js-methods');
  // A method's own declaration line used to leak its name into the
  // file's references, so methods never got findings at all.
  assert.equal(bySymbol(f, 'src/widget.js', 'neverCalled').grade, 'REVIEW');
  assert.equal(bySymbol(f, 'src/widget.js', 'neverCalled').category, 'method');
  // The constructor is called via `new Widget()` in the entry point,
  // and used() is called on the instance — neither is flagged.
  assert.equal(bySymbol(f, 'src/widget.js', 'constructor'), undefined);
  assert.equal(bySymbol(f, 'src/widget.js', 'used'), undefined);
  assert.equal(bySymbol(f, 'src/widget.js', 'Widget'), undefined);
});

test('js-app vs js-library: exported-but-uncalled is SAFE in an app, REVIEW in a library', () => {
  const app = findingsFor('js-app');
  assert.equal(bySymbol(app, 'src/lib.js', 'usedFn'), undefined);
  assert.equal(bySymbol(app, 'src/lib.js', 'neverCalled').grade, 'SAFE', 'app-internal export with 0 callers is dead');
  assert.equal(bySymbol(app, 'src/lib.js', 'privateDead').grade, 'SAFE');
  assert.equal(bySymbol(app, 'src/lib.js', 'UNUSED_CONST').grade, 'SAFE');
  const lib = findingsFor('js-library');
  assert.equal(bySymbol(lib, 'src/lib.js', 'usedFn'), undefined);
  assert.equal(bySymbol(lib, 'src/lib.js', 'neverCalled').grade, 'REVIEW', 'published-library export is public API, never SAFE');
  assert.equal(bySymbol(lib, 'src/lib.js', 'UNUSED_CONST').grade, 'REVIEW');
  assert.equal(bySymbol(lib, 'src/lib.js', 'privateDead').grade, 'SAFE', 'unexported dead code is SAFE even in a library');
});

test('js-cascade: symbols used only by dead code are dead in the same run', () => {
  const f = findingsFor('js-cascade');
  assert.equal(byCategory(f, 'src/dead-root.js', 'file').grade, 'SAFE');
  const mid = byCategory(f, 'src/dead-mid.js', 'file');
  assert.equal(mid.grade, 'SAFE', 'dead-mid is imported only by dead-root');
  assert.ok(mid.evidence.cascade, 'dead-mid must carry cascade evidence');
  assert.deepEqual(mid.evidence.cascade.via, ['src/dead-root.js']);
  assert.equal(mid.evidence.cascade.iteration, 2);
  const leaf = byCategory(f, 'src/dead-leaf.js', 'file');
  assert.equal(leaf.grade, 'SAFE', 'dead-leaf is imported only by dead-mid');
  assert.ok(leaf.evidence.cascade, 'dead-leaf must carry cascade evidence');
  assert.deepEqual(leaf.evidence.cascade.via, ['src/dead-mid.js']);
  assert.equal(leaf.evidence.cascade.iteration, 3);
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'file:src/dead-root.js', 'file:src/dead-mid.js', 'file:src/dead-leaf.js',
  ]);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('py-typer: @app.command() / @app.callback() are CLI entry points', () => {
  const f = findingsFor('py-typer');
  assert.equal(bySymbol(f, 'app.py', 'main').grade, 'KEEP', '@app.command() is a CLI entry point');
  assert.equal(bySymbol(f, 'app.py', 'callback').grade, 'KEEP', '@app.callback() is a Typer entry point');
  assert.equal(bySymbol(f, 'app.py', 'helper').grade, 'REVIEW', 'plain exported function in a library is REVIEW, never SAFE');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('config-referenced scripts are entries, never dead files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-config-entries-'));
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write('package.json', JSON.stringify({
    name: 't', main: 'src/index.js',
    scripts: { build: 'node scripts/build.js', gen: 'tsx scripts/gen.ts' },
  }));
  write('src/index.js', "console.log('hi');\n");
  write('scripts/build.js', "console.log('build');\n");
  write('scripts/gen.ts', "console.log('gen');\n");
  write('scripts/mkdocs_hook.py', "def on_config(config):\n    return config\n");
  write('docs/js/custom.js', "console.log('docs asset');\n");
  write('mkdocs.yml', [
    'site_name: t',
    'markdown_extensions:',
    '  - scripts.mkdocs_hook:',
    'extra_javascript:',
    '  - docs/js/custom.js',
    '',
  ].join('\n'));
  const f = scan(dir).findings;
  for (const file of ['scripts/build.js', 'scripts/gen.ts', 'scripts/mkdocs_hook.py', 'docs/js/custom.js']) {
    assert.equal(byCategory(f, file, 'file'), undefined, `${file} is referenced from package.json scripts / mkdocs.yml and must not be flagged`);
  }
});

test('files under tests/ or test/ directories are test code — KEEP at most, never SAFE', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-test-dirs-'));
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write('package.json', JSON.stringify({ name: 't', main: 'src/index.js' }));
  write('src/index.js', "const { usedFn } = require('./lib');\nconsole.log(usedFn());\n");
  write('src/lib.js', 'function usedFn() { return 1; }\nmodule.exports = { usedFn };\n');
  // Type-test helper under tests/ (the axios shape) and a test util
  // under src/test/ (the umami shape): declarations ARE the test.
  write('tests/helpers/type-check.js', 'function deadHelper() { return 1; }\nmodule.exports = { deadHelper };\n');
  write('src/test/test-utils.tsx', 'export function renderAll() { return 1; }\n');
  const f = scan(dir).findings;
  assert.equal(byCategory(f, 'tests/helpers/type-check.js', 'file').grade, 'KEEP');
  assert.equal(bySymbol(f, 'tests/helpers/type-check.js', 'deadHelper').grade, 'KEEP');
  assert.equal(byCategory(f, 'src/test/test-utils.tsx', 'file').grade, 'KEEP');
  assert.equal(bySymbol(f, 'src/test/test-utils.tsx', 'renderAll').grade, 'KEEP');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});

test('js-deps: README-only deps are flagged, real imports are not', () => {
  const f = findingsFor('js-deps');
  const dep = (name) => f.find((x) => x.category === 'dependency' && x.symbol === name);
  // Mentioned only in README / .txt prose — dead dependencies.
  for (const name of ['left-pad', 'moment', 'unused-dep', '@dead/scope']) {
    assert.equal(dep(name).grade, 'REVIEW', `${name} must be flagged REVIEW`);
  }
  // Live: subpath import, plain require, scoped require, config string,
  // package.json script, scoped config string.
  for (const name of ['lodash', 'express', '@scope/pkg', 'chalk', 'rimraf', '@other/plugin']) {
    assert.equal(dep(name), undefined, `${name} must not be flagged`);
  }
  // Nothing in this fixture is SAFE.
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0);
});
