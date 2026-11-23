'use strict';

/**
 * Batch 15: grade parity for NestJS + Flask + Typer (worker B) and
 * Django (research follow-up) — the web analyzer's framework keeps
 * now match the CLI's, so the 139 batch-14 grade diffs close.
 *
 * (1) Route directories keep FILES, never symbols (NestJS + Django
 * opposite-direction diffs). The CLI's entry patterns make a file
 * under pages/ / app/ / routes/ / views/ an entry FILE, but only
 * test / config / manual / framework files keep their SYMBOLS
 * (src/confidence.js: keepFile includes isEntry, keepSymbols does
 * not). The web used to put isRouteFile in keepSymbols too, so a
 * NestJS controller under src/views/ kept all its @Get methods, and
 * Django methods under django/views/ kept theirs — while the CLI
 * graded them REVIEW. Removing isRouteFile from keepSymbols closes
 * the 4 nestjs diffs and 2 of the 9 django opposite-direction
 * diffs; Next.js pages/ and app/ files still keep their symbols
 * through frameworks/next.json entryPatterns (fwKeepReason).
 *
 * (2) Raw decorator text (Flask + Typer). The CLI's tree-sitter
 * decorator node is the whole text including arguments, and its
 * frameworkKeepSymbol matches keepDecorators by substring over it.
 * The web recorded only the stripped first line — strings blanked,
 * continuation lines dropped — so two shapes were missed:
 * `@bp.route("/register", ...)` (the "register" that keeps it sits
 * in the route-path string) and a multi-line `@app.command(`
 * (the decorator was dropped at the continuation line by the
 * stale-decorator reset). parsePy now records decoratorsRaw — the
 * full raw text, strings intact, multi-line decorators joined
 * until their brackets balance — and the framework-decorator check
 * tests both texts. That closes the 3 flask-sqlalchemy diffs and
 * the 1 typer diff, without over-keeping the plain @bp.route
 * views (login / logout stay REVIEW).
 *
 * (3) Django keepDecorators port. The web's FRAMEWORK_KEEP_DECORATORS
 * had Flask / pytest / Typer / Pydantic entries only — no Django
 * entries at all — while the CLI keeps 122 django symbols through
 * frameworks/django.json keepDecorators (116 "register", 6
 * "receiver"). Porting the list closes those 122.
 *
 * (4) keepNames port for JS/Python. The CLI's frameworkKeepSymbol
 * also keeps definitions by exact NAME (django.json: __init__,
 * __str__, save, clean, get_absolute_url — plus "ready", added to
 * the pack in this batch because Django calls AppConfig.ready()
 * at app load; and admin.action / admin.display, added to the
 * pack's keepDecorators because the admin invokes them). The web
 * had that check only for Java (javaFrameworkKeepSymbol), so a
 * Python ready() graded REVIEW while the CLI kept it. The web now
 * consults the same pack-derived JAVA_PACK_KEEP_NAMES map for
 * JS/Python, in the grading loop and in the same-file-liveness
 * conduit predicate. The pack change moves the CLI too — the fresh
 * CLI run over the django clone flips exactly the 9 ready()
 * methods to KEEP and nothing else — so django closes to 0 diffs
 * against a CLI run with the same pack.
 *
 * (5) Dynamic getattr() downgrade. The remaining 7 django
 * opposite-direction diffs are methods in files that call
 * getattr() — the CLI demotes them to REVIEW ("cannot prove safe")
 * and the web already had that check (parsed.dynamic); the
 * route-file KEEP was masking it. No new rule was needed: removing
 * isRouteFile from keepSymbols unblocks the existing check.
 *
 * These tests use the fixture directories
 * fixtures/py-batch15-framework-keeps and
 * fixtures/js-batch15-route-files (hand-written, not copied from
 * any repo) and assert web/CLI agreement on them: the two analyzers
 * must produce the same findings (grade, category, file, symbol,
 * line) for every planted item.
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

function agreeExactly(web, cli, label) {
  const key = (f) => `${f.grade}|${f.category}|${f.file}|${f.symbol || ''}|${f.startLine}`;
  const webKeys = web.map(key).sort();
  const cliKeys = cli.map(key).sort();
  assert.deepEqual(webKeys, cliKeys, `${label}: web/CLI finding sets must match exactly.\nweb-only: ${JSON.stringify(webKeys.filter((k) => !cliKeys.includes(k)))}\ncli-only: ${JSON.stringify(cliKeys.filter((k) => !webKeys.includes(k)))}`);
}

// --- Django decorator keeps ------------------------------------------

test('batch15 (py): Django @register / @receiver / @admin.register items are KEEP', () => {
  const f = webFindings('py-batch15-framework-keeps');
  for (const symbol of ['ordinal', 'pagination_tag', 'result_tag', 'clear_tasks_handlers']) {
    assert.ok(bySymbol(f, 'django_tags.py', symbol, 'KEEP'), `@register/@receiver function ${symbol} must be KEEP`);
  }
  assert.ok(bySymbol(f, 'django_tags.py', 'FlatPageAdmin', 'KEEP'), '@admin.register class must be KEEP');
  assert.ok(bySymbol(f, 'django_tags.py', 'OverlapsLookup', 'KEEP'), '@Field.register_lookup class must be KEEP');
  const cli = cliFindings('py-batch15-framework-keeps');
  assert.equal(bySymbol(cli, 'django_tags.py', 'ordinal').reason, 'framework pack django.json: decorator "register"');
  assert.equal(bySymbol(cli, 'django_tags.py', 'clear_tasks_handlers').reason, 'framework pack django.json: decorator "receiver"');
});

test('batch15 (py): Django @admin.action / @admin.display items are KEEP', () => {
  const f = webFindings('py-batch15-framework-keeps');
  assert.ok(bySymbol(f, 'django_tags.py', 'make_published', 'KEEP'), '@admin.action must be KEEP');
  assert.ok(bySymbol(f, 'django_tags.py', 'status_display', 'KEEP'), '@admin.display must be KEEP');
  const cli = cliFindings('py-batch15-framework-keeps');
  assert.equal(bySymbol(cli, 'django_tags.py', 'make_published').reason, 'framework pack django.json: decorator "admin.action"');
  assert.equal(bySymbol(cli, 'django_tags.py', 'status_display').reason, 'framework pack django.json: decorator "admin.display"');
});

// --- Flask blueprint routes -------------------------------------------

test('batch15 (py): Flask @bp.route("/register") and @login_required views are KEEP, plain route views stay REVIEW', () => {
  const f = webFindings('py-batch15-framework-keeps');
  assert.ok(bySymbol(f, 'flask_views.py', 'register', 'KEEP'), 'register is KEEP — "/register" in the route path matches django.json "register"');
  assert.ok(bySymbol(f, 'flask_views.py', 'create', 'KEEP'), 'create is KEEP — @login_required matches django.json "login_required"');
  assert.ok(bySymbol(f, 'flask_views.py', 'dashboard', 'KEEP'), 'dashboard is KEEP — bare @login_required matches');
  assert.ok(bySymbol(f, 'flask_views.py', 'login', 'REVIEW'), 'login stays REVIEW — its route text matches no pack rule');
  assert.ok(bySymbol(f, 'flask_views.py', 'logout', 'REVIEW'), 'logout stays REVIEW — its route text matches no pack rule');
});

// --- Typer multi-line decorator ----------------------------------------

test('batch15 (py): a multi-line @app.command(...) keeps its function like the single-line form', () => {
  const f = webFindings('py-batch15-framework-keeps');
  assert.ok(bySymbol(f, 'typer_cmds.py', 'main', 'KEEP'), 'main is KEEP — the multi-line decorator must survive its continuation lines');
  assert.ok(bySymbol(f, 'typer_cmds.py', 'create', 'KEEP'), 'create is KEEP — single-line @app.command()');
  assert.ok(bySymbol(f, 'typer_cmds.py', 'helper', 'REVIEW'), 'helper stays REVIEW — no decorator, exported but never imported');
});

test('batch15 (py): parsePy records the raw multi-line decorator text', () => {
  const p = parsePy('cmds.py', 'import typer\n\napp = typer.Typer()\n\n\n@app.command(\n    context_settings={"allow_extra_args": True, "ignore_unknown_options": True}\n)\ndef main(ctx: typer.Context):\n    pass\n');
  const main = p.definitions.find((d) => d.name === 'main');
  assert.ok(main, 'main must be recorded');
  assert.ok((main.decoratorsRaw || []).length === 1, 'the multi-line decorator must accumulate into one raw entry');
  assert.ok(main.decoratorsRaw[0].indexOf('app.command') >= 0, 'the raw text keeps the decorator name');
  assert.ok(main.decoratorsRaw[0].indexOf('allow_extra_args') >= 0, 'the raw text keeps the continuation-line arguments');
  const q = parsePy('views.py', '@bp.route("/register", methods=("GET", "POST"))\ndef register():\n    pass\n');
  const reg = q.definitions.find((d) => d.name === 'register');
  assert.ok(reg.decoratorsRaw[0].indexOf('/register') >= 0, 'the raw text keeps the route-path string the stripper blanks');
});

// --- Framework-resolved names -------------------------------------------

test('batch15 (py): Django framework-resolved names are KEEP, an unlisted name stays REVIEW', () => {
  const f = webFindings('py-batch15-framework-keeps');
  for (const symbol of ['ready', 'clean', 'save', 'get_absolute_url']) {
    assert.ok(bySymbol(f, 'app_config.py', symbol, 'KEEP'), `${symbol} must be KEEP — framework-resolved name`);
  }
  assert.ok(bySymbol(f, 'app_config.py', 'scrub', 'REVIEW'), 'scrub stays REVIEW — no framework rule names it');
  assert.ok(bySymbol(f, 'app_config.py', 'AppConfig', 'REVIEW'), 'the AppConfig class itself is an ordinary exported class, REVIEW');
});

// --- Dynamic getattr() under a route directory ---------------------------

test('batch15 (py): methods in a getattr() file under views/ are REVIEW, not route-file KEEP', () => {
  const f = webFindings('py-batch15-framework-keeps');
  for (const symbol of ['_get_current_year', '_get_current_month']) {
    const found = bySymbol(f, 'views/dates.py', symbol, 'REVIEW');
    assert.ok(found, `${symbol} must be REVIEW`);
    assert.ok(found.reason.indexOf('dynamic getattr()') >= 0, `${symbol} must carry the dynamic-getattr reason, got: ${found.reason}`);
  }
  const getter = bySymbol(f, 'views/dates.py', '_get_attr', 'REVIEW');
  assert.ok(getter && getter.reason.indexOf('dynamic getattr()') >= 0, '_get_attr itself is REVIEW via the dynamic check, never SAFE');
});

// --- Dead controls / false-positive rate ----------------------------------

test('batch15 (py): SAFE false-positive rate is 0% on the fixture', () => {
  const f = webFindings('py-batch15-framework-keeps');
  const safe = f.filter((x) => x.grade === 'SAFE');
  const expectedSafe = new Set([
    'function:dead_controls.py:_dead_private',
    'function:dead_controls.py:_also_dead',
    'variable:dead_controls.py:_dead_value',
  ]);
  assert.equal(safe.length, expectedSafe.size, `expected ${expectedSafe.size} SAFE findings, got ${safe.length}: ${JSON.stringify(safe.map((s) => `${s.category}:${s.file}:${s.symbol || ''}`))}`);
  for (const s of safe) {
    const key = `${s.category}:${s.file}:${s.symbol || ''}`;
    assert.ok(expectedSafe.has(key), `unexpected SAFE finding (false positive): ${key}`);
  }
});

test('batch15 (py): web and CLI agree exactly on the fixture', () => {
  agreeExactly(webFindings('py-batch15-framework-keeps'), cliFindings('py-batch15-framework-keeps'), 'py-batch15-framework-keeps');
});

// --- NestJS route file / Next.js pages --------------------------------------

test('batch15 (ts): NestJS controller methods under src/views/ are REVIEW, not KEEP', () => {
  const f = webFindings('js-batch15-route-files');
  for (const symbol of ['page', 'section', 'decode', 'named']) {
    assert.ok(bySymbol(f, 'src/views/views.module.ts', symbol, 'REVIEW'), `${symbol} must be REVIEW — a route directory keeps the file, never its symbols`);
  }
  assert.ok(bySymbol(f, 'src/views/views.module.ts', 'deadHelper', 'SAFE'), 'the unexported helper in the same file is still provably dead');
});

test('batch15 (ts): Next.js pages/ exports stay KEEP after the route-file fix', () => {
  const f = webFindings('js-batch15-route-files');
  assert.ok(bySymbol(f, 'src/pages/index.js', 'HomePage', 'KEEP'), 'a pages/ default export stays KEEP via next.json entryPatterns');
  assert.ok(bySymbol(f, 'src/pages/index.js', 'getServerSideProps', 'KEEP'), 'getServerSideProps stays KEEP as a framework-resolved export');
  assert.ok(bySymbol(f, 'src/pages/index.js', 'unusedPageExport', 'KEEP'), 'an unused pages/ export stays KEEP via next.json entryPatterns');
});

test('batch15 (ts): web and CLI agree exactly on the fixture', () => {
  agreeExactly(webFindings('js-batch15-route-files'), cliFindings('js-batch15-route-files'), 'js-batch15-route-files');
});

// --- Drift guards: the web list must track the Django pack ------------------

test('batch15 (py): every django.json keepDecorator keeps a definition in the web', () => {
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'frameworks', 'django.json'), 'utf8'));
  const example = {
    receiver: '@receiver(post_save, sender=User)',
    register: '@register.filter',
    'admin.register': '@admin.register(Page)',
    login_required: '@login_required',
    permission_required: '@permission_required("app.view")',
    'admin.action': '@admin.action(description="Do it")',
    'admin.display': '@admin.display(description="Status")',
  };
  for (const d of pack.keepDecorators) {
    const deco = example[d];
    assert.ok(deco, `drift-guard example missing for keepDecorator ${d} — add one`);
    const r = analyzeFiles([{ path: 'x.py', content: `${deco}\ndef guarded():\n    return 1\n` }]);
    const found = r.findings.find((x) => x.symbol === 'guarded');
    assert.ok(found && found.grade === 'KEEP', `keepDecorator "${d}" must keep a definition (got ${found ? found.grade : 'no finding'})`);
  }
});

test('batch15 (py): every django.json keepName keeps a definition in the web', () => {
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'frameworks', 'django.json'), 'utf8'));
  for (const name of pack.keepNames) {
    const r = analyzeFiles([{ path: 'x.py', content: `class Holder:\n    def ${name}(self):\n        pass\n` }]);
    const found = r.findings.find((x) => x.symbol === name);
    assert.ok(found && found.grade === 'KEEP', `keepName "${name}" must keep a definition (got ${found ? found.grade : 'no finding'})`);
  }
});
