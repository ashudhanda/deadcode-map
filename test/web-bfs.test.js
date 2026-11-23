'use strict';

/**
 * Batch 14 item 2: the react.ts same-file BFS (umami src/lib/react.ts).
 *
 * Five symbols were ABSENT from the web checker while the CLI graded
 * them SAFE: the exported type ReactElementWithChildren plus
 * getFragmentChildren, isValidChild, mapChildren and cloneChildren —
 * a dead chain whose members only call each other
 * (getFragmentChildren <- mapChildren <- cloneChildren <-
 * renderChildren, all 0 live callers). The web treated any same-file
 * use as live (a flat `usage.sameFile` boolean), so a dead chain head
 * rescued its whole chain; the CLI computes same-file liveness as BFS
 * reachability from live roots over per-definition `uses`
 * (src/confidence.js `sameFileLiveDefs`).
 *
 * The port has three parts, all in docs/analyzer.js:
 * - parseJs records per-definition `uses` and `topLevelUses` (port of
 *   src/parse-js.js pass 4): a reference belongs to the innermost
 *   non-variable definition whose body contains it; an initializer
 *   read before a function-valued variable's function expression
 *   (`var Monitoring = Monitoring || (function () {...})`) belongs to
 *   the enclosing scope, not to the new function.
 * - buildSameFileLiveness mirrors the CLI's scopes block: live roots
 *   are top-level uses plus names with live importers or non-same-file
 *   callers; base-kept definitions (framework keeps, dunder, exported
 *   in a library / unknown-kind / re-exported file) are conduits but
 *   are themselves never rescued into liveness.
 * - The exported rule is narrowed to the CLI's per-file kind policy
 *   (port of src/discover.js fileKind): exported-but-never-imported is
 *   REVIEW only for library, unknown-kind, or re-exported files; in
 *   an app repo it falls through to SAFE. The `@/*` alias fix in
 *   resolveAlias (an empty suffix never matched) is what makes that
 *   narrowing safe: without it, `@/lib/...` importers were invisible
 *   and 164 umami exports would have flipped to false SAFEs.
 *
 * These tests use the hand-written fixture fixtures/js-same-file-bfs
 * (modeled on react.ts, not copied from any repo) and assert web/CLI
 * agreement on it, plus the same agreement on the existing
 * fixtures/js-same-file-cascade (the JS cascade shapes: dead chain,
 * live chain, top-level call, self-recursion, mutual recursion,
 * variable alias). A missed SAFE is acceptable; a web-only SAFE is
 * not — the exact-match assertions enforce that.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scan } = require('../src/index');
const { analyzeFiles } = require('../docs/analyzer');

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

function bySymbol(findings, file, symbol) {
  return findings.find((f) => f.file === file && f.symbol === symbol);
}

function findingKey(f) {
  return [f.grade, f.category, f.file, f.symbol, f.startLine].join('|');
}

// Web and CLI must agree exactly (grade, category, file, symbol,
// line) on the whole fixture: no web-only SAFE, no missed CLI SAFE.
function assertWebEqualsCli(dir) {
  const web = webFindings(dir);
  const cli = cliFindings(dir);
  const webKeys = new Set(web.map(findingKey));
  const cliKeys = new Set(cli.map(findingKey));
  const webOnly = [...webKeys].filter((k) => !cliKeys.has(k));
  const cliOnly = [...cliKeys].filter((k) => !webKeys.has(k));
  assert.deepEqual(webOnly, [], `${dir}: web-only findings (a web-only SAFE is a ship-blocker): ${JSON.stringify(webOnly)}`);
  assert.deepEqual(cliOnly, [], `${dir}: CLI-only findings (missed by the web): ${JSON.stringify(cliOnly)}`);
}

test('web bfs: exported dead chain (type + functions calling only each other) is SAFE, like the CLI', () => {
  const f = webFindings('js-same-file-bfs');
  // The react.ts-shaped chain: every member is SAFE.
  for (const symbol of ['ElementWithKids', 'getKids', 'isKid', 'mapKids', 'cloneKids', 'renderKids', 'countKids']) {
    assert.equal(bySymbol(f, 'src/lib/children.ts', symbol).grade, 'SAFE', `${symbol} is used only by dead code`);
  }
  // Self-recursion and a mutual-recursion cycle have no live root.
  assert.equal(bySymbol(f, 'src/lib/children.ts', 'deadRecursive').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/lib/children.ts', 'deadPing').grade, 'SAFE');
  assert.equal(bySymbol(f, 'src/lib/children.ts', 'deadPong').grade, 'SAFE');
  // Live controls are never flagged: called at the top level of the
  // file, and liveEntry is also imported by index.ts.
  assert.equal(bySymbol(f, 'src/lib/children.ts', 'liveHelper'), undefined, 'liveHelper is called by liveEntry');
  assert.equal(bySymbol(f, 'src/lib/children.ts', 'liveEntry'), undefined, 'liveEntry is called at the top level and imported');
  assertWebEqualsCli('js-same-file-bfs');
});

test('web bfs: the existing same-file cascade fixture agrees with the CLI', () => {
  const f = webFindings('js-same-file-cascade');
  for (const symbol of ['deadOuter', 'deadInner', 'selfOnly', 'ping', 'pong']) {
    assert.equal(bySymbol(f, 'src/cascade.js', symbol).grade, 'SAFE', `${symbol} is used only by dead code`);
  }
  for (const symbol of ['liveOuter', 'liveInner', 'topCalled', 'topHelper', 'aliased', 'alias']) {
    assert.equal(bySymbol(f, 'src/cascade.js', symbol), undefined, `${symbol} must not be flagged`);
  }
  assertWebEqualsCli('js-same-file-cascade');
});

test('web bfs: a multi-line constructor with an empty body does not swallow the rest of the file', () => {
  // A pending scope whose body turns out to be empty (`) {}` on the
  // continuation line of a multi-line signature) used to stay dangling
  // and get attached to the next block that opens — the whole rest of
  // the file landed in that constructor's `uses`, so every class the
  // file instantiates afterwards looked dead (a NestJS e2e spec's
  // `constructor(...) {}` hid CurrentUser / ConstructorHost /
  // PropertyHost / MissingAndFailingHost from the live roots). The
  // constructor's scope now ends on its own line, and the classes the
  // top-level test code instantiates are live roots.
  const spec = [
    "import { Test } from '@nestjs/testing';",
    '',
    'class CurrentUser {',
    '  constructor() {}',
    '}',
    '',
    'class Host {',
    '  constructor(',
    '    user?: CurrentUser,',
    "    missing?: unknown,",
    '  ) {}',
    '}',
    '',
    "describe('spec', () => {",
    '  it(\'works\', async () => {',
    '    const module = await Test.createTestingModule({',
    '      providers: [CurrentUser, Host],',
    '    }).compile();',
    '    return module;',
    '  });',
    '});',
    '',
  ].join('\n');
  const f = analyzeFiles([{ path: 'spec.ts', content: spec }]).findings;
  assert.equal(bySymbol(f, 'spec.ts', 'CurrentUser'), undefined, 'CurrentUser is instantiated in the providers array and must not be flagged');
  assert.equal(bySymbol(f, 'spec.ts', 'Host'), undefined, 'Host is instantiated in the providers array and must not be flagged');
});
