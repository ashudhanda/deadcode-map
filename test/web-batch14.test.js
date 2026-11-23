'use strict';

/**
 * Batch 14: port the CLI's dead-file cascade (fixpoint) to the web
 * analyzer (docs/analyzer.js) for JS/TS, so the web stops missing
 * dead files and the symbols inside them.
 *
 * (1) Dead-file fixpoint. The web's dead-file block was a single pass:
 * `importerCount` counted ALL importers, including dead ones, and
 * string refs from dead files still kept a file alive. The CLI
 * (src/confidence.js) computes `liveImporters` (importers NOT in
 * deadFiles), iterates to a fixpoint (at most 6 passes), counts
 * string refs only from LIVE files, and counts only TOP-LEVEL symbols
 * for file string refs. Findings that appear only in a later pass
 * carry evidence.cascade = { iteration, via: [dead files] }.
 *
 * (2) Per-file library / app kind (port of fileKind in
 * src/discover.js). The web's `isLibrary` was repo-global: one
 * sub-package with `exports` made EVERY file look like published
 * library surface, so dead files in the app part (umami's src/,
 * nestjs' integration/ and sample/ trees) graded REVIEW instead of
 * SAFE. The kind now comes from the nearest manifest above the file.
 * An exported-but-uncalled symbol in an app repo is SAFE (the CLI
 * rule); in a library, or a repo with no manifest signal, it stays
 * REVIEW. A symbol in a re-exported file stays REVIEW even in an app.
 *
 * (3) Workspace self-references (FP-8, port of src/graph.js). A
 * monorepo package imported by its own name (`@scope/a` from a
 * sibling package) resolves to the package's own source. Without
 * this, every export of a self-imported package looked unimported —
 * and the app-kind exported rule would have graded those live
 * exports SAFE.
 *
 * (4) `.test-d.` files are test files AND entry points (the CLI's
 * TEST_FILE and discover.js entry patterns both list them; the web
 * had neither). Without this a type-test file graded SAFE-dead
 * poisoned its imports: its only importer looked dead, so the
 * imported helper file went SAFE too.
 *
 * These tests use the fixture directory
 * fixtures/js-batch14-deadfile (hand-written, not copied from any
 * repo) and assert web/CLI agreement on it: the two analyzers must
 * produce the same findings (grade, category, file, symbol, line)
 * for every planted item, with the same cascade evidence.
 */

/**
 * Batch 14: fix three missed CLI SAFE variable findings in the web
 * analyzer (docs/analyzer.js) — typer's `command_class` /
 * `group_class` (typer/core.py:1102-1103) and Django's
 * `handles_files` (django/contrib/staticfiles/handlers.py:22).
 *
 * Root cause: parsePy never recorded a plain (non-model) class-body
 * assignment as a definition at all — it only noted the line so the
 * bare-reference channel would not count the assigned name as a read.
 * The CLI's tree-sitter parser records every class-body assignment
 * as a variable definition carrying its class name, and grades it
 * SAFE when nothing reads it. The web therefore emitted no finding
 * for any of the three, while the CLI graded all three SAFE
 * ("unexported, 0 callers, 0 references, 0 string mentions"). Both
 * files are live files, so this is purely a variable-recording gap,
 * not a dead-file cascade.
 *
 * The fix records class-body assignments as definitions (with
 * className) and ports the CLI's class-attribute rules (FP-6) so the
 * new definitions cannot become web-only SAFEs: a same-class method
 * alias and a config-class attribute are KEEP; an override (either
 * direction), a cross-file attribute read, a Sphinx-documented
 * attribute (docs or a `#:` comment), and an externally-defined base
 * are REVIEW. A class-body `x = lambda: ...` is recorded as a method,
 * as in the CLI, never SAFE.
 *
 * These tests use the fixture directory
 * fixtures/py-batch14-class-attrs (hand-written, not copied from any
 * repo) and assert web/CLI agreement on it: the two analyzers must
 * produce the same findings (grade, category, file, symbol, line)
 * for every planted item. A second test pins the older
 * fixtures/py-class-attrs fixture: the web now agrees with the CLI
 * there too, except for the known pre-existing gap that the web
 * records only the first target of a chained assignment (so the
 * later chain targets are CLI-only, never web-only SAFE).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scan } = require('../src/index');
const { analyzeFiles, parsePy } = require('../docs/analyzer');

const ROOT = path.join(__dirname, '..');

function loadFixture(dir) {
  const base = path.join(ROOT, 'fixtures', dir);
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push({ path: path.relative(base, full).split(path.sep).join('/'), content: fs.readFileSync(full, 'utf8') });
    }
  })(base);
  return analyzeFiles(files);
}

function webFindings(dir) {
  return loadFixture(dir).findings;
}

function cliFindings(dir) {
  return scan(path.join(ROOT, 'fixtures', dir)).findings;
}

function bySymbol(findings, file, symbol, grade) {
  return findings.find((f) => f.file.endsWith(file) && f.symbol === symbol && (!grade || f.grade === grade));
}

function byCategory(findings, file, category, grade) {
  return findings.find((f) => f.file.endsWith(file) && f.category === category && !f.symbol && (!grade || f.grade === grade));
}

// --- scan level: dead-file chain --------------------------------------

test('deadfile (js): the dead chain is SAFE, each link with its cascade evidence', () => {
  const f = webFindings('js-batch14-deadfile');
  const root = byCategory(f, 'src/dead-root.js', 'file', 'SAFE');
  assert.ok(root, 'dead-root.js is SAFE');
  assert.equal(root.evidence.cascade, undefined, 'the dead root carries no cascade evidence (pass 1)');
  const mid = byCategory(f, 'src/dead-mid.js', 'file', 'SAFE');
  assert.ok(mid, 'dead-mid.js is SAFE — imported only by dead-root.js');
  assert.deepEqual(mid.evidence.cascade, { iteration: 2, via: ['src/dead-root.js'] }, 'dead-mid.js carries iteration-2 cascade evidence via dead-root.js');
  const leaf = byCategory(f, 'src/dead-leaf.js', 'file', 'SAFE');
  assert.ok(leaf, 'dead-leaf.js is SAFE — imported only by dead-mid.js');
  assert.deepEqual(leaf.evidence.cascade, { iteration: 3, via: ['src/dead-mid.js'] }, 'dead-leaf.js carries iteration-3 cascade evidence via dead-mid.js');
});

test('deadfile (js): a file string-mentioned only by a dead file is SAFE once its mentioner is dead', () => {
  const f = webFindings('js-batch14-deadfile');
  const deadString = byCategory(f, 'src/deadString.js', 'file', 'SAFE');
  assert.ok(deadString, 'deadString.js is SAFE — its only string mention sits in dead-mid.js');
  assert.deepEqual(deadString.evidence.cascade, { iteration: 3, via: ['src/dead-mid.js'] }, 'deadString.js carries iteration-3 cascade evidence via dead-mid.js');
  // The live control: a file string-mentioned by a LIVE file stays REVIEW.
  const kept = byCategory(f, 'src/stringKept.js', 'file', 'REVIEW');
  assert.ok(kept, 'stringKept.js stays REVIEW — the live file mentions it by name as a string');
  assert.deepEqual(kept.evidence.stringRefs, ['src/live.js'], 'the live mention is recorded as a string ref');
});

test('deadfile (js): a local name matching strings elsewhere does not keep its file alive', () => {
  const f = webFindings('js-batch14-deadfile');
  const root = byCategory(f, 'src/dead-root.js', 'file', 'SAFE');
  assert.ok(root, 'dead-root.js is SAFE even though its local `url` matches the string in live.js');
  assert.deepEqual(root.evidence.stringRefs, [], 'no live string refs are recorded for the dead root');
});

test('deadfile (js): symbols in dead files grade SAFE, with cascade evidence past pass 1', () => {
  const f = webFindings('js-batch14-deadfile');
  const rootFn = bySymbol(f, 'src/dead-root.js', 'deadRootFn', 'SAFE');
  assert.ok(rootFn, 'deadRootFn is SAFE (exported in an app repo, 0 callers)');
  assert.equal(rootFn.evidence.cascade, undefined, 'deadRootFn carries no cascade evidence (pass 1)');
  const midFn = bySymbol(f, 'src/dead-mid.js', 'deadMidFn', 'SAFE');
  assert.ok(midFn, 'deadMidFn is SAFE — its only caller sits in dead-root.js');
  assert.deepEqual(midFn.evidence.cascade, { iteration: 2, via: ['src/dead-root.js'] }, 'deadMidFn carries iteration-2 cascade evidence via dead-root.js');
  const leafFn = bySymbol(f, 'src/dead-leaf.js', 'deadLeafFn', 'SAFE');
  assert.ok(leafFn, 'deadLeafFn is SAFE — its only caller sits in dead-mid.js');
  assert.deepEqual(leafFn.evidence.cascade, { iteration: 3, via: ['src/dead-mid.js'] }, 'deadLeafFn carries iteration-3 cascade evidence via dead-mid.js');
  const stringFn = bySymbol(f, 'src/deadString.js', 'deadStringFn', 'SAFE');
  assert.ok(stringFn, 'deadStringFn is SAFE (exported in an app repo, 0 callers)');
});

test('deadfile (js): an exported-but-uncalled symbol in a live app file is SAFE too', () => {
  const f = webFindings('js-batch14-deadfile');
  assert.ok(bySymbol(f, 'src/live.js', 'liveUnusedExport', 'SAFE'), 'liveUnusedExport is SAFE — an app-internal export with 0 callers is dead');
});

test('deadfile (js): live files and live symbols are never flagged', () => {
  const f = webFindings('js-batch14-deadfile');
  for (const file of ['src/index.js', 'src/live.js', 'src/shared.js']) {
    assert.equal(byCategory(f, file, 'file'), undefined, `${file} must have no file finding`);
  }
  for (const symbol of ['liveFn', 'sharedFn']) {
    assert.equal(bySymbol(f, 'src/live.js', symbol), undefined, `${symbol} must not be flagged`);
    assert.equal(bySymbol(f, 'src/shared.js', symbol), undefined, `${symbol} must not be flagged`);
  }
  // The local `url` inside deadRootFn is used by its own function: no finding.
  assert.equal(bySymbol(f, 'src/dead-root.js', 'url'), undefined, 'the local url is read by its own function, never flagged');
});

test('deadfile (js): SAFE false-positive rate is 0% on the fixture', () => {
  const f = webFindings('js-batch14-deadfile');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'file:src/dead-root.js', 'file:src/dead-mid.js', 'file:src/dead-leaf.js', 'file:src/deadString.js',
    'function:src/dead-root.js:deadRootFn', 'function:src/dead-mid.js:deadMidFn',
    'function:src/dead-leaf.js:deadLeafFn', 'function:src/deadString.js:deadStringFn',
    'function:src/live.js:liveUnusedExport', 'function:src/stringKept.js:stringKeptFn',
  ]);
  assert.equal(safe.length, expectedSafe.size, `expected ${expectedSafe.size} SAFE findings, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.file}:${s.symbol || ''}`))}`);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

// --- per-file kind, inline (no fixture directory needed) --------------

function analyzeInline(files) {
  return analyzeFiles(files.map(([p, c]) => ({ path: p, content: c }))).findings;
}

test('deadfile (js): a dead file in a library package is REVIEW, never SAFE', () => {
  const f = analyzeInline([
    ['package.json', JSON.stringify({ name: 'lib-pkg', version: '1.0.0', main: 'src/index.js', exports: { '.': './src/index.js' } })],
    ['src/index.js', "console.log('entry');"],
    ['src/dead.js', 'export function deadFn() { return 1; }'],
  ]);
  assert.equal(byCategory(f, 'src/dead.js', 'file', 'REVIEW').grade, 'REVIEW', 'a no-importer file in a published library is public surface, REVIEW at most');
  assert.equal(bySymbol(f, 'src/dead.js', 'deadFn', 'REVIEW').grade, 'REVIEW', 'a library export is public API, REVIEW at most');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0, 'no SAFE findings in a library package');
});

test('deadfile (js): a dead file with no manifest signal is SAFE, its export REVIEW', () => {
  const f = analyzeInline([
    ['package.json', JSON.stringify({ name: 'plain-pkg', version: '1.0.0', main: 'src/index.js' })],
    ['src/index.js', "console.log('entry');"],
    ['src/dead.js', 'export function deadFn() { return 1; }'],
  ]);
  assert.equal(byCategory(f, 'src/dead.js', 'file', 'SAFE').grade, 'SAFE', 'a no-importer file with unknown kind is SAFE (only library kind demotes it)');
  assert.equal(bySymbol(f, 'src/dead.js', 'deadFn', 'REVIEW').grade, 'REVIEW', 'an export in an unknown-kind repo stays REVIEW — only app kind makes it SAFE');
});

test('deadfile (js): a symbol in a re-exported file stays REVIEW even in an app repo', () => {
  // The barrel re-exports `helper`, and the entry point imports it
  // through the barrel: helper is live, no finding. The barrel does
  // NOT name `other`, so the re-export edge gives it no credit — but
  // its file is public API through the barrel, so it stays REVIEW,
  // never SAFE (port of src/confidence.js reExportedFiles). Without
  // the guard the app-kind rule below would grade it SAFE.
  const f = analyzeInline([
    ['package.json', JSON.stringify({ name: 'app-pkg', version: '1.0.0', private: true, main: 'src/index.js' })],
    ['src/index.js', "import { helper } from './barrel.js';\nconsole.log(helper());"],
    ['src/barrel.js', "export { helper } from './helper.js';"],
    ['src/helper.js', 'export function helper() { return 1; }\nexport function other() { return 2; }'],
  ]);
  assert.equal(byCategory(f, 'src/helper.js', 'file'), undefined, 'a re-exported module is not a dead file');
  assert.equal(bySymbol(f, 'src/helper.js', 'helper'), undefined, 'a re-exported symbol that is imported through the barrel is live');
  assert.equal(bySymbol(f, 'src/helper.js', 'other', 'REVIEW').grade, 'REVIEW', 'an unnamed sibling export of a re-exported file is public API, REVIEW at most, never SAFE');
  assert.equal(f.filter((x) => x.grade === 'SAFE').length, 0, 'no SAFE findings in the re-export case');
});

// --- web / CLI agreement ----------------------------------------------

test('deadfile (js): web and CLI agree exactly on the fixture', () => {
  const web = webFindings('js-batch14-deadfile');
  const cli = cliFindings('js-batch14-deadfile');
  const key = (f) => `${f.grade}|${f.category}|${f.file}|${f.symbol || ''}|${f.startLine}`;
  const webKeys = web.map(key).sort();
  const cliKeys = cli.map(key).sort();
  assert.deepEqual(webKeys, cliKeys, `web/CLI finding sets must match exactly.\nweb-only: ${JSON.stringify(webKeys.filter((k) => !cliKeys.includes(k)))}\ncli-only: ${JSON.stringify(cliKeys.filter((k) => !webKeys.includes(k)))}`);
});

test('deadfile (js): web and CLI agree on cascade evidence for the fixture', () => {
  const web = webFindings('js-batch14-deadfile');
  const cli = cliFindings('js-batch14-deadfile');
  const key = (f) => `${f.category}|${f.file}|${f.symbol || ''}`;
  const webCascade = new Map(web.filter((f) => f.evidence && f.evidence.cascade).map((f) => [key(f), f.evidence.cascade]));
  const cliCascade = new Map(cli.filter((f) => f.evidence && f.evidence.cascade).map((f) => [key(f), f.evidence.cascade]));
  assert.deepEqual([...webCascade.keys()].sort(), [...cliCascade.keys()].sort(), 'the same findings carry cascade evidence in web and CLI');
  for (const [k, v] of webCascade) {
    assert.deepEqual(v, cliCascade.get(k), `cascade evidence must match for ${k}`);
  }
});

// --- parity fixes found by the bench (batch 14) ------------------------
// The app-kind rule only stays sound when the import graph resolves
// every import the CLI resolves. The bench caught four gaps the old
// exported-REVIEW rule had been hiding; each is covered by the
// js-batch14-parity fixture (web and CLI agree exactly on it).

test('parity (js): a `@/` alias import keeps the target live', () => {
  const f = webFindings('js-batch14-parity');
  assert.equal(bySymbol(f, 'src/lib/constants.js', 'used'), undefined, 'used is imported through the @/ alias, so it is live');
  assert.ok(bySymbol(f, 'src/lib/constants.js', 'unused', 'SAFE'), 'unused is exported in an app repo with 0 callers, so it is SAFE');
});

test('parity (js): Gruntfile.js is an entry even with a capital G', () => {
  const f = webFindings('js-batch14-parity');
  assert.equal(byCategory(f, 'Gruntfile.js', 'file'), undefined, 'entry basenames are case-insensitive — the grunt CLI runs Gruntfile.js exactly like gruntfile.js');
});

test('parity (js): hidden directories are never scanned', () => {
  const f = webFindings('js-batch14-parity');
  assert.equal(f.filter((x) => x.file.includes('.changeset')).length, 0, 'the CLI walk skips dot-directories except .github, so .changeset/changelog.js has no findings at all');
});

test('parity (js): a Next.js instrumentation file and its register() are KEEP', () => {
  const f = webFindings('js-batch14-parity');
  assert.ok(byCategory(f, 'src/instrumentation.ts', 'file', 'KEEP'), 'instrumentation.ts is a next.json keepFiles file, never a dead file');
  assert.ok(bySymbol(f, 'src/instrumentation.ts', 'register', 'KEEP'), 'register() is called by Next.js at server startup, so it is KEEP');
});

test('parity (js): web and CLI agree exactly on the fixture', () => {
  const web = webFindings('js-batch14-parity');
  const cli = cliFindings('js-batch14-parity');
  const key = (f) => `${f.grade}|${f.category}|${f.file}|${f.symbol || ''}|${f.startLine}`;
  const webKeys = web.map(key).sort();
  const cliKeys = cli.map(key).sort();
  assert.deepEqual(webKeys, cliKeys, `web/CLI finding sets must match exactly.\nweb-only: ${JSON.stringify(webKeys.filter((k) => !cliKeys.includes(k)))}\ncli-only: ${JSON.stringify(cliKeys.filter((k) => !webKeys.includes(k)))}`);
});

// --- parser level: class attributes are definitions -------------------

test('class-attrs (py): a plain class attribute is recorded with its class name', () => {
  const parsed = parsePy('probe.py', [
    'class HandlerMixin:',
    '    handles_files = True',
    '',
    '    def load(self):',
    '        return True',
    '',
    '',
    'class Plain:',
    '    dead_attr = 1',
  ].join('\n'));
  const handles = parsed.definitions.find((d) => d.name === 'handles_files');
  assert.ok(handles, 'handles_files is recorded as a definition');
  assert.equal(handles.kind, 'variable');
  assert.equal(handles.className, 'HandlerMixin');
  assert.equal(handles.startLine, 2);
  assert.equal(handles.local, false, 'a class attribute is not a local');
  assert.equal(handles.exported, false, 'a class attribute is not a module export');
  const dead = parsed.definitions.find((d) => d.name === 'dead_attr');
  assert.ok(dead, 'dead_attr is recorded as a definition');
  assert.equal(dead.className, 'Plain');
});

test('class-attrs (py): an annotated class attribute with a value is recorded', () => {
  const parsed = parsePy('probe.py', [
    'class CommandGroup:',
    '    command_class: type | None = None',
    '    group_class: type["CommandGroup"] | None = None',
  ].join('\n'));
  for (const name of ['command_class', 'group_class']) {
    const d = parsed.definitions.find((x) => x.name === name);
    assert.ok(d, `${name} is recorded as a definition`);
    assert.equal(d.kind, 'variable');
    assert.equal(d.className, 'CommandGroup');
  }
  // An annotation-only line (`timeout: int`, no value) creates no
  // runtime binding and is still not a definition, as in the CLI.
  const annOnly = parsePy('probe.py', [
    'class Holder:',
    '    timeout: int',
    '',
    '    def get(self):',
    '        return 1',
  ].join('\n'));
  assert.equal(annOnly.definitions.find((d) => d.name === 'timeout'), undefined, 'an annotation-only name is not a definition');
});

test('class-attrs (py): a class-body lambda is recorded as a method, never a variable', () => {
  const parsed = parsePy('probe.py', [
    'class Actions:',
    '    run = lambda: 1',
  ].join('\n'));
  const d = parsed.definitions.find((x) => x.name === 'run');
  assert.ok(d, 'run is recorded as a definition');
  assert.equal(d.kind, 'method', 'the CLI records a class-body lambda as a method of the class');
  assert.equal(d.className, 'Actions');
});

test('class-attrs (py): external base, config class, alias, and #: doc flags travel on the definition', () => {
  const parsed = parsePy('probe.py', [
    'from elsewhere import RemoteBase',
    'from themekit import Style',
    '',
    '',
    'class Service(RemoteBase):',
    '    mode = "off"',
    '',
    '    def start(self):',
    '        return True',
    '',
    '',
    'class Theme(Style):',
    '    background = "#ffffff"',
    '',
    '',
    'class Mapping:',
    '    def _fail(self):',
    '        raise RuntimeError("unavailable")',
    '',
    '    fallback = _fail',
    '',
    '',
    'class Session:',
    '    #: Whether this session stores data on disk.',
    '    persistent = False',
  ].join('\n'));
  const mode = parsed.definitions.find((d) => d.name === 'mode');
  assert.equal(mode.externalBase, true, 'a base imported by a non-relative import is external');
  assert.equal(mode.configClassAttr, false, 'the class defines a method, so it is not a config class');
  const background = parsed.definitions.find((d) => d.name === 'background');
  assert.equal(background.externalBase, true);
  assert.equal(background.configClassAttr, true, 'an external-base subclass with only attributes is a config class');
  const fallback = parsed.definitions.find((d) => d.name === 'fallback');
  assert.equal(fallback.chainedAlias, true, 'fallback aliases the _fail method of the same class');
  assert.equal(fallback.chainedAliasOf, '_fail');
  const persistent = parsed.definitions.find((d) => d.name === 'persistent');
  assert.equal(persistent.documentedAttr, true, 'a #: comment directly above documents the attribute');
  // A relative import is in-repo, so it is never an external base.
  const relative = parsePy('probe.py', [
    'from .base import LocalBase',
    '',
    '',
    'class Child(LocalBase):',
    '    child_attr = 1',
  ].join('\n'));
  assert.equal(relative.definitions.find((d) => d.name === 'child_attr').externalBase, false, 'a relatively-imported base is in-repo');
});

test('class-attrs (py): the class inventory and attribute references are recorded', () => {
  const parsed = parsePy('probe.py', [
    'from base import Base',
    '',
    '',
    'class Child(Base):',
    '    timeout = 60',
    '',
    '    def run(self):',
    '        return self.timeout',
  ].join('\n'));
  assert.deepEqual(parsed.classes, [{ name: 'Child', bases: ['Base'], startLine: 4 }]);
  assert.ok(parsed.attributeRefs.includes('timeout'), 'self.timeout is recorded as an attribute read');
  // A multi-line base list resolves too.
  const multi = parsePy('probe.py', [
    'class Multi(',
    '    FirstBase,',
    '    SecondBase,',
    '):',
    '    attr = 1',
  ].join('\n'));
  assert.deepEqual(multi.classes, [{ name: 'Multi', bases: ['FirstBase', 'SecondBase'], startLine: 1 }]);
  assert.equal(multi.definitions.find((d) => d.name === 'attr').externalBase, false);
});

// --- scan level: the batch-14 fixture ----------------------------------

test('class-attrs (py): the three missed mechanisms are SAFE in the web, as in the CLI', () => {
  const f = webFindings('py-batch14-class-attrs');
  // Annotated class attributes with a value (typer command_class /
  // group_class shape).
  assert.equal(bySymbol(f, 'plain.py', 'command_class', 'SAFE').grade, 'SAFE');
  assert.equal(bySymbol(f, 'plain.py', 'group_class', 'SAFE').grade, 'SAFE');
  // A plain class attribute (Django handles_files shape).
  assert.equal(bySymbol(f, 'plain.py', 'handles_files', 'SAFE').grade, 'SAFE');
  // A class attribute read via self in the same file is live: no finding.
  assert.equal(bySymbol(f, 'plain.py', 'limit'), undefined, 'self.limit keeps the attribute alive');
  // A class-body lambda is a method: REVIEW, never SAFE.
  assert.equal(bySymbol(f, 'plain.py', 'run', 'REVIEW').grade, 'REVIEW');
});

test('class-attrs (py): the FP-6 guardrails demote to REVIEW or KEEP, never SAFE', () => {
  const f = webFindings('py-batch14-class-attrs');
  // Override family, both directions.
  assert.equal(bySymbol(f, 'base.py', 'timeout', 'REVIEW').grade, 'REVIEW', 'overridden by a subclass');
  assert.equal(bySymbol(f, 'override.py', 'timeout', 'REVIEW').grade, 'REVIEW', 'overrides an ancestor attribute');
  // Cross-file attribute read with no import edge.
  assert.equal(bySymbol(f, 'watched.py', 'watched', 'REVIEW').grade, 'REVIEW', 'read as .watched in another file');
  // Externally-defined base (parent source not in the repo).
  assert.equal(bySymbol(f, 'external.py', 'mode', 'REVIEW').grade, 'REVIEW', 'subclass of an externally-defined base');
  // Config class: external base, attributes only.
  for (const symbol of ['background', 'foreground']) {
    assert.equal(bySymbol(f, 'config.py', symbol, 'KEEP').grade, 'KEEP', `${symbol} is a config-class attribute`);
  }
  // Alias of a method of the same class.
  assert.equal(bySymbol(f, 'alias.py', 'fallback', 'KEEP').grade, 'KEEP', 'fallback aliases the _fail method');
  // Documented attributes: a #: comment, and a Sphinx directive in api.txt.
  assert.equal(bySymbol(f, 'documented.py', 'persistent', 'REVIEW').grade, 'REVIEW', '#: documented attribute');
  assert.equal(bySymbol(f, 'documented.py', 'label', 'REVIEW').grade, 'REVIEW', '.. attribute:: documented in api.txt');
});

test('class-attrs (py): SAFE false-positive rate is 0% on the fixture', () => {
  const f = webFindings('py-batch14-class-attrs');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'variable:plain.py:command_class',
    'variable:plain.py:group_class',
    'variable:plain.py:handles_files',
  ]);
  assert.equal(safe.length, expectedSafe.size, `expected ${expectedSafe.size} SAFE findings, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.file}:${s.symbol || ''}`))}`);
  for (const s of safe) {
    const key = `${s.category}:${s.file}${s.symbol ? ':' + s.symbol : ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('class-attrs (py): web and CLI agree exactly on the fixture', () => {
  const web = webFindings('py-batch14-class-attrs');
  const cli = cliFindings('py-batch14-class-attrs');
  const key = (f) => `${f.grade}|${f.category}|${f.file}|${f.symbol || ''}|${f.startLine}`;
  const webKeys = web.map(key).sort();
  const cliKeys = cli.map(key).sort();
  assert.deepEqual(webKeys, cliKeys, `web/CLI finding sets must match exactly.\nweb-only: ${JSON.stringify(webKeys.filter((k) => !cliKeys.includes(k)))}\ncli-only: ${JSON.stringify(cliKeys.filter((k) => !webKeys.includes(k)))}`);
});

// --- scan level: the older py-class-attrs fixture ----------------------

test('class-attrs (py): the binding = must sit at bracket depth 0 (web == CLI)', () => {
  // The old `(?::[^=]+)?=` regex matched the `=` inside an
  // annotation's call arguments, so a value-less annotation such as
  // `age: Annotated[int, Field(ge=0)]` — which the CLI's tree-sitter
  // parser records as no definition at all — became a phantom web
  // definition. Pydantic test models are full of that shape. Every
  // shape below must agree with the CLI exactly, except the known
  // chain-target gap (the web records only the first chain target).
  const { parsePy: parsePyCli } = require('../src/parse-py');
  const cases = {
    annCallNoVal: 'from pydantic import BaseModel\nfrom typing import Annotated\nfrom pydantic import Field\ndef test_it():\n    class Person(BaseModel):\n        age: Annotated[int, Field(ge=0, le=120)]\n        name: str = "x"\n',
    annCallWithVal: 'x: Annotated[int, Field(ge=0)] = 5\n',
    annSimpleVal: 'x: int = 1\n',
    annSimpleNoVal: 'x: int\n',
    strAnn: 'x: "Annotated[int, Field(ge=0)]"\n',
    commentEq: 'x: int  # a=b\n',
    plain: 'x = 1\n',
    strVal: 'x = "s"\n',
    classStr: 'class C:\n    x = "s"\n',
    walrus: 'x := 1\n',
    eq: 'x == 1\n',
    aug: 'x += 1\n',
    attr: 'x.y = 1\n',
    sub: 'x[0] = 1\n',
    dictVal: 'x = {"a": 1}\n',
    annDict: 'x: dict = {"a": 1}\n',
    bareEq: 'x =\n',
  };
  for (const [label, src] of Object.entries(cases)) {
    const webNames = parsePy('t.py', src).definitions.map((d) => d.name);
    const cliNames = parsePyCli('t.py', src).definitions.map((d) => d.name);
    assert.deepEqual(webNames, cliNames, label + ': web and CLI definitions must match');
  }
  // The chained case keeps the known gap only: the web records the
  // first target, the CLI records every target.
  const webChain = parsePy('t.py', 'a = b = 1\n').definitions.map((d) => d.name);
  const cliChain = parsePyCli('t.py', 'a = b = 1\n').definitions.map((d) => d.name);
  assert.deepEqual(webChain, ['a'], 'web records only the first chain target');
  assert.deepEqual(cliChain, ['a', 'b'], 'CLI records every chain target');
});

test('class-attrs (py): framework entry-pattern files keep their symbols (CLI frameworkKeepFile)', () => {
  // The CLI's frameworkKeepFile (src/confidence.js, packs in
  // frameworks/*.json) keeps every symbol in a file matching a pack's
  // entryPatterns/keepFiles. The web had no such term, so symbols the
  // class-attribute recording now surfaces in Django migrations and
  // management commands graded REVIEW where the CLI grades KEEP.
  // The reason text matches the CLI's verbatim.
  const files = [
    { path: 'django/contrib/auth/migrations/0001_initial.py', content: [
      'from django.db import migrations',
      '',
      'class Migration(migrations.Migration):',
      '    dependencies = []',
      '    operations = []',
    ].join('\n') },
    { path: 'myapp/management/commands/cleanup.py', content: [
      'from django.core.management.base import BaseCommand',
      '',
      'class Command(BaseCommand):',
      '    help = "cleanup"',
    ].join('\n') },
  ];
  const f = analyzeFiles(files).findings;
  const byId = (file, symbol) => f.find((x) => x.file === file && x.symbol === symbol);
  assert.equal(byId('django/contrib/auth/migrations/0001_initial.py', 'Migration').grade, 'KEEP');
  assert.equal(byId('django/contrib/auth/migrations/0001_initial.py', 'Migration').reason, 'framework pack django.json: matches (^|/)migrations/');
  assert.equal(byId('django/contrib/auth/migrations/0001_initial.py', 'dependencies').grade, 'KEEP');
  assert.equal(byId('myapp/management/commands/cleanup.py', 'Command').reason, 'framework pack django.json: matches (^|/)management/commands/');
  assert.equal(byId('myapp/management/commands/cleanup.py', 'help').grade, 'KEEP');
  // The file finding is kept too (CLI keepFile takes fwReasons as
  // well): a management command with no importers is KEEP, not a
  // dead-file finding, via the same reason.
  const cmdFile = f.find((x) => x.file === 'myapp/management/commands/cleanup.py' && x.category === 'file');
  assert.equal(cmdFile.grade, 'KEEP');
  assert.equal(cmdFile.reason, 'framework pack django.json: matches (^|/)management/commands/');
  // A symbol in a plain file is untouched by the port.
  const plain = analyzeFiles([{ path: 'plain.py', content: 'x = 1\n' }]).findings;
  assert.equal(plain.find((x) => x.symbol === 'x').grade, 'REVIEW');
});

test('class-attrs (py): a self-referential assignment reads the name (CLI reference semantics)', () => {  // The CLI's tree-sitter walk excludes only the definition site
  // itself: a later occurrence on the declaration line is a read.
  // `x = x + 1` reads x, and a property alias reads the attribute it
  // names (`encoding = property(lambda self: self.file.encoding)`
  // is Django's FileProxyMixin shape). Both stay live in the CLI.
  const parsed = parsePy('probe.py', [
    'x = 1',
    'x = x + 1',
    '',
    'class Mixin:',
    '    encoding = property(lambda self: self.file.encoding)',
    '    plain = 5',
  ].join('\n'));
  assert.ok(parsed.references.has('x'), 'x = x + 1 reads x');
  assert.ok(parsed.references.has('encoding'), 'the property lambda reads the encoding attribute');
  const f = analyzeFiles([{ path: 'probe.py', content: [
    'x = 1',
    'x = x + 1',
    '',
    'class Mixin:',
    '    encoding = property(lambda self: self.file.encoding)',
    '    plain = 5',
  ].join('\n') }]).findings;
  assert.equal(f.find((x) => x.symbol === 'x'), undefined, 'a self-read variable is live, never flagged');
  assert.equal(f.find((x) => x.symbol === 'encoding'), undefined, 'a property alias that reads its own attribute is live');
  assert.equal(f.find((x) => x.symbol === 'plain').grade, 'SAFE', 'a genuinely unreferenced class attribute is still SAFE');
  // A keyword-argument name is not a read: `x = f(x=1)` names the
  // parameter, it does not read the module variable x.
  const kw = parsePy('probe.py', ['x = 1', 'x = f(x=1)'].join('\n'));
  assert.equal(kw.references.has('x'), false, 'a kwarg name must not rescue x');
});

test('class-attrs (py): web agrees with the CLI on py-class-attrs except the known chain-target gap', () => {
  const web = webFindings('py-class-attrs');
  const cli = cliFindings('py-class-attrs');
  const key = (f) => `${f.grade}|${f.category}|${f.file}|${f.symbol || ''}|${f.startLine}`;
  const webKeys = web.map(key).sort();
  const cliKeys = cli.map(key).sort();
  // The web records only the first target of a chained assignment, so
  // the later targets are CLI-only (a missed SAFE/KEEP, never a
  // web-only SAFE). Everything else must match exactly.
  const knownCliOnly = new Set([
    'SAFE|variable|plain.py|second|19',
    'SAFE|variable|plain.py|_second|26',
    'KEEP|variable|sessions.py|__delitem__|7',
    'KEEP|variable|sessions.py|clear|7',
    'KEEP|variable|sessions.py|pop|7',
    'KEEP|variable|sessions.py|popitem|7',
  ]);
  const webOnly = webKeys.filter((k) => !cliKeys.includes(k));
  const cliOnly = cliKeys.filter((k) => !webKeys.includes(k));
  assert.deepEqual(webOnly, [], `no web-only findings allowed: ${JSON.stringify(webOnly)}`);
  assert.deepEqual(cliOnly.sort(), [...knownCliOnly].sort(), `CLI-only findings must be exactly the known chain-target gap: ${JSON.stringify(cliOnly)}`);
  const webSafe = web.filter((x) => x.grade === 'SAFE').map(key).sort();
  const cliSafe = cli.filter((x) => x.grade === 'SAFE').map(key).sort();
  assert.ok(webSafe.every((k) => cliSafe.includes(k)), 'every web SAFE is a CLI SAFE (no new false SAFE)');
  // Spot-check the guardrails on the older fixture.
  assert.equal(bySymbol(web, 'plain.py', 'dead_attr', 'SAFE').grade, 'SAFE');
  assert.equal(bySymbol(web, 'plain.py', 'child_dead_attr', 'SAFE').grade, 'SAFE');
  assert.equal(bySymbol(web, 'response.py', 'default_mimetype', 'REVIEW').grade, 'REVIEW');
  assert.equal(bySymbol(web, 'sessions.py', 'pickle_based', 'REVIEW').grade, 'REVIEW');
  assert.equal(bySymbol(web, 'theme.py', 'background_color', 'KEEP').grade, 'KEEP');
});
