'use strict';

/**
 * deadcode-map web analyzer — lightweight, browser-safe.
 *
 * This is a regex-based analyzer for the web checker. It mirrors the CLI's
 * grading model (SAFE / REVIEW / KEEP with evidence) and its core rules:
 * a real import graph from entry points, a repo-wide string-reference pass,
 * framework keeps, and dynamic-import downgrades. It is NOT the full CLI:
 * the CLI parses with tree-sitter; this version parses with regular
 * expressions, so it can miss exotic syntax. The UI says so honestly.
 *
 * Deliberate parity notes (matching CLI v0.1.0 behaviour):
 * - Dynamic import() sets the dynamic flag but creates no import edge, so a
 *   file loaded only via import() is kept alive only by string references.
 * - A call only counts as use inside the file that defines the symbol;
 *   cross-file use counts only through imports (named imports, or a member
 *   reference such as utils.helper_fn() from a file that imports utils).
 * - Python top-level public names are importable, so they are "exported"
 *   (REVIEW at worst); underscore-prefixed names are private (SAFE-able).
 * - Classic-script globals: in a classic (non-module) JS file, a
 *   bare-name call resolves to the single repo-wide top-level
 *   definition of that name (Django admin JS).
 * - `__unittest` is a KEEP module attribute (unittest traceback
 *   trimming), and an import shadowed by a same-file top-level
 *   definition is a conditional definition, never a dead import.
 *
 * No browser-only APIs in this file: it runs in Node and in the browser.
 * UMD wrapper: module.exports in Node, window.DeadcodeMap in the browser.
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.DeadcodeMap = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

var JS_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
var PY_EXTS = ['.py'];
var SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next',
  'coverage', '.coverage', '__pycache__', '.venv', 'venv', '.tox',
  '.pytest_cache', '.mypy_cache', '.turbo', 'vendor', 'target',
]);
var SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

// Test-data directories: planted dead code lives here on purpose, so
// scanning them as real code is noise. Excluded at any depth by default
// (fixtures/, __fixtures__/, test/fixtures, tests/fixtures, ...);
// analyzeFiles(files, { includeFixtures: true }) opts back in.
var FIXTURE_DIRS = new Set(['fixtures', '__fixtures__']);

var JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'catch',
  'try', 'finally', 'return', 'throw', 'break', 'continue', 'new', 'typeof',
  'instanceof', 'in', 'of', 'void', 'delete', 'yield', 'await', 'function',
  'class', 'extends', 'import', 'export', 'from', 'const', 'let', 'var',
  'true', 'false', 'null', 'undefined', 'this', 'super', 'static', 'get',
  'set', 'async', 'require', 'console',
]);
var PY_KEYWORDS = new Set([
  'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with',
  'return', 'raise', 'break', 'continue', 'pass', 'import', 'from', 'as',
  'def', 'class', 'lambda', 'and', 'or', 'not', 'in', 'is', 'None', 'True',
  'False', 'global', 'nonlocal', 'assert', 'del', 'yield', 'await', 'async',
]);
// `print`, `self` and `cls` are deliberately NOT in this set: they are a
// builtin function and conventional parameter names, not keywords. With
// them here, a `from rich import print` whose `print(...)` calls were
// all skipped as "keywords" looked unused (fastapi translate.py), and
// a `from .testing import FlaskClient as cls` whose `cls(...)` call was
// skipped the same way looked unused (flask app.py). Removing them only
// adds `print` / `self` / `cls` to references — harmless, since no
// definition is ever named that way.

// JSX-pragma names: see the decision block in src/parse-js.js, kept
// identical here — in a file that contains JSX, an imported binding
// with one of these names counts as used by the JSX transform (the
// classic runtimes call React.createElement, preact's h /
// createElement, or the Fragment factory; the automatic runtimes call
// jsx / jsxs / jsxDEV), even though the name never appears in the
// source text. In a file with no JSX the same import is still
// flaggable. memo, Component, Suspense and lazy are deliberately NOT
// here: the transform never calls them, so an unused memo import in
// a JSX file is still dead.
var JSX_PRAGMA_NAMES = [
  'React', 'createElement', 'h', 'Fragment', 'jsx', 'jsxs', 'jsxDEV',
];
// Longest import / re-export / require statement the web parser will
// accumulate across lines. The 10-line bound used to cut off real
// imports (preact's src/diff/index.js has an 18-line import, its
// test/ts/preact.tsx a 19-line one): a truncated statement lost its
// import edge entirely and its continuation lines leaked into the
// references pass. 200 lines still bounds a malformed statement.
var IMPORT_STMT_MAX_LINES = 200;

var TEST_FILE = /(\.test\.|\.spec\.|\.e2e-spec\.|_test\.py$|test_[^/]+\.py$|conftest\.py$|(^|\/)test\.[jt]sx?$)/;
// `.e2e-spec.` is the NestJS / vitest end-to-end marker (each sample
// runs `e2e/**/*.e2e-spec.ts` via its own vitest.config.e2e.mts): a
// test entry point like `.spec.` / `.test.`, never a dead file —
// mirrors src/confidence.js TEST_FILE in the CLI.
// A file literally named test.ts / test.tsx (date-fns) holds type-test
// functions whose bodies ARE the assertions — the declarations are the
// test, so the file is test code: KEEP at most, never SAFE.
// A file under a tests/ (or test/, __tests__/) directory is test code:
// its declarations ARE the test, so it is KEEP at most, never SAFE —
// the CLI uses the same rule (axios type-test helpers, umami test utils).
var TEST_DIR = /(^|\/)(test|tests|__tests__)\//;
var CONFIG_FILE = /(\.config\.[jt]s|webpack\.config|vite\.config|jest\.config|babel\.config|tailwind\.config|\.d\.ts$)/;
var ENTRY_BASENAMES = new Set([
  'index', 'main', 'app', 'server', 'cli', 'bin', 'entry', 'setup',
  'wsgi', 'asgi', 'manage', '__main__',
]);
var ENTRY_PATTERNS = [
  /(^|\/)(pages|app|routes|views)\//,
  /\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /\.e2e-spec\.[jt]sx?$/, /_test\.py$/, /test_[^/]+\.py$/,
  /\.stories\.[jt]sx?$/,
  /\.config\.[jt]s$/, /\.config\.mjs$/, /\.config\.cjs$/,
  /\/migrations\//, /\/seeds?\//,
  /setup\.py$/, /conftest\.py$/, /\/__init__\.py$/,
  /webpack\.config\./, /vite\.config\./, /rollup\.config\./,
  /tailwind\.config\./, /jest\.config\./, /babel\.config\./,
  // Next.js middleware / proxy at any depth (docker/proxy.ts): the
  // framework resolves it, so it is an entry point, never dead.
  /middleware\.(js|jsx|ts|tsx)$/, /proxy\.(js|jsx|ts|tsx)$/,
  // Build-task files and example scripts are standalone entry points.
  /(^|\/)gulpfile\.(js|ts)$/, /(^|\/)gruntfile\.(js|ts)$/, /(^|\/)examples\//,
];
var ROUTE_DIR = /(^|\/)(pages|app|routes|views)\//;
var FRAMEWORK_KEEP_EXPORTS = new Set([
  'default', 'generateStaticParams', 'generateMetadata', 'getStaticProps',
  'getServerSideProps', 'getStaticPaths',
]);
var FRAMEWORK_KEEP_DECORATORS = [
  'app.route', 'app.errorhandler', 'app.before_request', 'app.after_request',
  'blueprint.route', 'pytest.fixture', 'pytest.mark.parametrize', 'pytest.mark.skip',
  // Typer / Click CLI entry points and pytest hooks.
  'app.command', 'app.callback', 'app.cli.command', 'click.command', 'click.group',
  'click.pass_context', 'typer.Typer', 'pytest.hookimpl', 'hookimpl',
  // Pydantic validators (invoked at validation time) and @overload
  // stubs (type information, never called by design).
  'model_validator', 'field_validator', 'computed_field', 'root_validator',
  'validator', 'overload',
];

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function extOf(p) {
  var i = p.lastIndexOf('.');
  return i >= 0 ? p.slice(i).toLowerCase() : '';
}
function baseOf(p) {
  var s = p.split('/');
  return s[s.length - 1];
}
function stemOf(p) {
  var b = baseOf(p);
  var i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}
function dirOf(p) {
  var i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}
function joinPosix(dir, rel) {
  var parts = (dir ? dir.split('/') : []).concat(rel.split('/'));
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function identifiers(text) {
  var out = [];
  var re = /[A-Za-z_$][\w$]*/g;
  var m;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

// Blank out // line comments and /* block comments */ in a fragment
// of import / export / require syntax. Specifier lists never hold
// string literals, so a `//` or `/*` there always starts a comment —
// without this, a comment line inside a multi-line import became a
// garbage "name" (`// the main helper\n usedFn`).
function stripComments(text) {
  return text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// Split on a separator that sits at the top level: a separator inside
// nested (), [] or {} belongs to the nested value, not to the list.
function splitTopLevel(text, sep) {
  var out = [];
  var depthParen = 0;
  var depthBracket = 0;
  var depthBrace = 0;
  var start = 0;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen--;
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket--;
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace--;
    else if (ch === sep && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

// True when the identifier at (index, index + len) in an object literal
// line is a top-level entry name: a shorthand (`A,`) or a key (`run:`).
// It must start an entry (previous non-space char is `{`, `,`, or the
// line starts here) and be followed by `,`, `}`, `:` or end of line.
// A value (`run: foo`) is preceded by `:` and is a real use, not an
// entry name.
function isExportEntryName(line, index, len) {
  var p = index - 1;
  while (p >= 0 && /\s/.test(line[p])) p--;
  if (p >= 0 && line[p] !== '{' && line[p] !== ',') return false;
  var q = index + len;
  while (q < line.length && /\s/.test(line[q])) q++;
  var next = q < line.length ? line[q] : '';
  return next === ',' || next === '}' || next === ':' || next === '';
}

/**
 * Blank out strings and comments, keeping newlines, so structural scans
 * never mistake a string or a comment for code. Template literals keep
 * their ${...} expressions as code.
 * When `collect` is given, every string literal's raw text (with quotes)
 * is pushed into it, for the string-reference pass.
 * When `spans` is given, `spans.templateLines` (a Set) is filled with
 * the 1-based lines inside multi-line template literals (interior lines
 * plus the closing line, not the opening line), for the unreachable
 * detector — those lines hold generated code, not real statements.
 */
function stripJs(code, collect, spans) {
  var out = '';
  var i = 0;
  var n = code.length;
  var curLine = 1; // 1-based line of the character about to be consumed
  // Blank out an escape sequence (`\x`, two chars). An escaped newline
  // (a line continuation inside a string or template literal) must keep
  // its newline in the output: without it the stripped code loses a
  // line, every later line number drifts from the raw source, and
  // findings point at the wrong lines.
  function blankEscape() {
    if (code[i + 1] === '\n') { out += ' \n'; curLine++; }
    else out += '  ';
    i += 2;
  }
  while (i < n) {
    var c = code[i];
    var next = code[i + 1] || '';
    if (c === '/' && next === '/') {
      while (i < n && code[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') curLine++;
        out += code[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += '  '; i += 2; }
    } else if (c === '/' && next !== '/' && next !== '*') {
      // A regex literal (not division): the previous significant token is
      // one that cannot end an expression. Without this, a regex such as
      // /['"]__main__['"]/ swallows the rest of the file as a "string".
      var j = i - 1;
      while (j >= 0 && /\s/.test(code[j])) j--;
      var prev = j >= 0 ? code[j] : '';
      var wordStart = j;
      while (wordStart >= 0 && /[A-Za-z_$]/.test(code[wordStart])) wordStart--;
      var prevWord = code.slice(wordStart + 1, j + 1);
      var regexStart = prev === '' || '([{,=:!&|?;'.indexOf(prev) >= 0 ||
        (prev === '>' && code[j - 1] === '=') || // `=> /regex/` — an arrow returning a regex literal
        ['return', 'typeof', 'case', 'throw', 'in', 'of', 'new', 'delete', 'void', 'yield', 'await'].indexOf(prevWord) >= 0;
      if (regexStart) {
        out += ' '; i++;
        var inClass = false;
        while (i < n) {
          if (code[i] === '\\') { blankEscape(); continue; }
          if (code[i] === '[') inClass = true;
          else if (code[i] === ']') inClass = false;
          else if (code[i] === '/' && !inClass) break;
          if (code[i] === '\n') curLine++;
          out += code[i] === '\n' ? '\n' : ' ';
          i++;
        }
        if (i < n) { out += ' '; i++; }
        while (i < n && /[a-z]/i.test(code[i])) { out += ' '; i++; }
        continue;
      }
      out += c; i++;
    } else if (c === "'" || c === '"') {
      var q = c;
      // A quote with no closing quote on the same line is not a string
      // delimiter — a JS single/double-quoted string cannot span lines
      // (except a backslash-newline continuation, which the scan below
      // allows). The common case is an apostrophe in JSX text (`I'm`,
      // `we're`, `don't`): without this, the `'` opened a "string" that
      // swallowed the rest of the file — every definition, reference
      // and brace after it vanished, so the file's imports looked dead
      // and reachable code looked unreachable (preact demos). A real
      // string (`return'x'`) DOES close on the same line, so it is
      // still recognised. An unterminated quote in broken code is
      // likewise treated as a plain character instead of blanking the
      // file to EOF.
      var k = i + 1;
      var closesQuote = false;
      while (k < n) {
        if (code[k] === '\\') {
          if (code[k + 1] === '\n') { k += 2; continue; } // line continuation: the string goes on
          k += 2; continue;
        }
        if (code[k] === '\n') break; // no closer on this line
        if (code[k] === q) { closesQuote = true; break; }
        k++;
      }
      if (!closesQuote) { out += c; i++; continue; }
      var start = i;
      out += ' '; i++;
      while (i < n && code[i] !== q) {
        if (code[i] === '\\') { blankEscape(); continue; }
        if (code[i] === '\n') curLine++;
        out += code[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += ' '; i++; }
      if (collect) collect.push(code.slice(start, i));
    } else if (c === '`') {
      var startT = i;
      var startLineT = curLine;
      out += ' '; i++;
      while (i < n && code[i] !== '`') {
        if (code[i] === '\\') { blankEscape(); continue; }
        if (code[i] === '$' && code[i + 1] === '{') {
          // Keep the ${...} expression as code.
          out += '${'; i += 2;
          var depth = 1;
          while (i < n && depth > 0) {
            if (code[i] === '{') depth++;
            else if (code[i] === '}') depth--;
            if (depth > 0) { if (code[i] === '\n') curLine++; out += code[i]; i++; }
          }
          if (i < n) { out += '}'; i++; }
          continue;
        }
        if (code[i] === '\n') curLine++;
        out += code[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += ' '; i++; }
      if (collect) collect.push(code.slice(startT, i));
      // A multi-line template literal's interior lines (and its closing
      // line) hold generated code, not real statements: the unreachable
      // detector must ignore them (WP-2). The opening line is NOT
      // recorded — it holds the real statement (`return `...``).
      if (spans && spans.templateLines && curLine > startLineT) {
        for (var tl = startLineT + 1; tl <= curLine; tl++) spans.templateLines.add(tl);
      }
    } else {
      if (c === '\n') curLine++;
      out += c; i++;
    }
  }
  return out;
}

function stripPy(code, collect) {
  var lines = code.split('\n');
  var out = [];
  var inTriple = null;
  for (var li = 0; li < lines.length; li++) {
    var line = lines[li];
    var res = '';
    var i = 0;
    while (i < line.length) {
      if (inTriple) {
        var end = line.indexOf(inTriple, i);
        if (collect) collect.push(line.slice(i, end === -1 ? line.length : end + 3));
        if (end === -1) { res += ' '.repeat(line.length - i); i = line.length; }
        else { res += ' '.repeat(end + 3 - i); i = end + 3; inTriple = null; }
        continue;
      }
      var ch = line[i];
      if (ch === '#') { res += ' '.repeat(line.length - i); break; }
      if (line.slice(i, i + 3) === "'''" || line.slice(i, i + 3) === '"""') {
        if (collect) collect.push(line.slice(i));
        inTriple = line.slice(i, i + 3);
        res += '   '; i += 3;
        continue;
      }
      if (ch === "'" || ch === '"') {
        var q = ch;
        var start = i;
        // F-string prefix? The quote may be preceded by f/F (alone or
        // combined with r/R/b/B/u/U, e.g. rf"..."): an f-string's {...}
        // expressions are real code — `f"{_format_default(d)}"` calls
        // _format_default — so keep them and blank only the literal
        // parts. Without this, every name used only inside an f-string
        // expression looked dead. (Triple-quoted f-strings are not
        // handled: their expressions stay blanked, a known limitation.)
        var pfx = i - 1;
        var isFString = false;
        while (pfx >= 0 && /[rRbBfFuU]/.test(line[pfx])) {
          if (line[pfx] === 'f' || line[pfx] === 'F') isFString = true;
          pfx--;
        }
        // The prefix must sit after a non-identifier char — otherwise
        // the letters are part of a longer word, not a string prefix.
        if (isFString && pfx >= 0 && /[A-Za-z0-9_]/.test(line[pfx])) isFString = false;
        res += ' '; i++;
        while (i < line.length && line[i] !== q) {
          if (line[i] === '\\') { res += '  '; i += 2; continue; }
          if (isFString && line[i] === '{') {
            if (line[i + 1] === '{') { res += '  '; i += 2; continue; } // {{ is a literal brace
            // Keep the { ... } expression as code.
            res += '{'; i++;
            var depth = 1;
            while (i < line.length && depth > 0) {
              var ec = line[i];
              if (ec === '{') { depth++; res += ec; i++; continue; }
              if (ec === '}') { depth--; res += ec; i++; continue; }
              if (ec === "'" || ec === '"') {
                // Nested string inside the expression: blank its
                // contents (its identifiers are string data, not code).
                var nq = ec;
                res += ' '; i++;
                while (i < line.length && line[i] !== nq) {
                  if (line[i] === '\\') { res += '  '; i += 2; continue; }
                  res += ' '; i++;
                }
                if (i < line.length) { res += ' '; i++; }
                continue;
              }
              res += ec; i++;
            }
            continue;
          }
          if (isFString && line[i] === '}' && line[i + 1] === '}') { res += '  '; i += 2; continue; } // }} is a literal brace
          res += ' '; i++;
        }
        if (i < line.length) { res += ' '; i++; }
        if (collect) collect.push(line.slice(start, i));
        continue;
      }
      res += ch; i++;
    }
    out.push(res);
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* JS / TS parsing (regex-based)                                       */
/* ------------------------------------------------------------------ */

function parseJs(rel, raw) {
  var strings = [];
  var templateLines = new Set();
  var code = stripJs(raw, strings, { templateLines: templateLines });
  var lines = code.split('\n');
  // A file contains JSX when the stripped code (strings and comments
  // blanked, positions preserved) has a JSX element: `<Tag ...>`,
  // `<Tag/>`, `<Tag {...spread}>`, or a fragment `<>`. The `<` must
  // not follow an identifier character, so a generic
  // (`foo<string>`, `Map<K, V>`, `x as Foo<Bar>`) or a comparison
  // (`a < b`) is not mistaken for a tag — a generic's `<` follows its
  // type name directly. A chained comparison (`a < b > c`) still
  // matches, which only keeps a pragma import alive: a missed SAFE,
  // never a false one. (The CLI sets the same flag from tree-sitter
  // jsx_element nodes; this regex is the web parser's equivalent.)
  var hasJsx = /(?:^|[^A-Za-z0-9_$.])<>/.test(code) ||
    /(?:^|[^A-Za-z0-9_$.])<[A-Za-z][\w.:-]*\s*(?:\/?>|\{|[A-Za-z_][\w-]*\s*(?:=|\/?>|\s))/.test(code);
  // A file uses module syntax when the stripped code (strings and
  // comments blanked, so a string that merely mentions `import` does
  // not count) has an import / export statement, a require() call, a
  // module.exports / exports. assignment, or a dynamic import(). A
  // file without it is a classic script: its top-level declarations
  // are page globals, callable by bare name from other classic
  // scripts (Django admin JS). `export {}` and `module.exports = {}`
  // count even though they bind no names — mirrors the CLI's
  // hasModuleSyntax flag in src/parse-js.js.
  var hasModuleSyntax = /(^|\n)\s*import\s/.test(code) || /\bimport\s*\(/.test(code)
    || /\bimport\.meta\b/.test(code)
    || /(^|\n)\s*export\b/.test(code) || /\brequire\s*\(/.test(code)
    || /\bmodule\.exports\b/.test(code) || /(^|\n)\s*exports\./.test(code);
  // A compatibility shim's imports ARE its public API (mirrors
  // src/parse-py.js): the names are re-exported for downstream code.
  var isCompatShimJs = /(^|\/)(_?compat)(\.(js|jsx|ts|tsx|mjs|cjs))?$/.test(rel) || /(^|\/)_?compat\//.test(rel);
  var parsed = {
    language: 'js', definitions: [], imports: [], references: new Set(),
    calls: new Set(), constructed: new Set(), dynamic: false, dynamicReasons: [], dynamicImports: [],
    unreachable: [], decorators: [], dunder: new Set(), strings: strings, hasJsx: hasJsx,
    hasModuleSyntax: hasModuleSyntax,
  };

  var braceDepth = 0;
  var classStack = []; // {name, depth}
  var ambientStack = []; // {depth} — declare module/global blocks
  var declaredOnLine = {}; // lineNo (1-based) -> Set of declared names

  function markDeclared(lineNo, name) {
    if (!declaredOnLine[lineNo]) declaredOnLine[lineNo] = new Set();
    declaredOnLine[lineNo].add(name);
  }

  for (var ln = 0; ln < lines.length; ln++) {
    var line = lines[ln];
    var lineNo = ln + 1;
    var depthBefore = braceDepth;
    var m;

    // Pop class contexts whose block closed.
    while (classStack.length && braceDepth < classStack[classStack.length - 1].depth) classStack.pop();
    // A definition inside a `declare module` / `declare global` block is
    // a declaration-merging augmentation, not a standalone definition.
    var inAmbient = ambientStack.length > 0;

    // Class declaration.
    m = line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (m) {
      parsed.definitions.push({
        name: m[1], kind: 'class', exported: /^\s*export\b/.test(line),
        startLine: lineNo, endLine: lineNo, decorators: [], ambient: inAmbient,
      });
      markDeclared(lineNo, m[1]);
    } else if (classStack.length) {
      // Method inside a class body — but only when the `name(` line
      // starts a definition, not a call. The signature's closing paren
      // must be followed by `{` (or a `:` return-type annotation). A
      // call line such as `handleOptionValue(val, ...);` or a nested
      // call `parseNumericPattern(x, y),` used to be recorded as a
      // phantom method — which also suppressed the real call (a
      // declaration line is not a use), so the real definition looked
      // dead (commander, date-fns MonthParser). The signature may span
      // lines, so the scan follows the parens a few lines down.
      var mm = line.match(/^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+)*(?:#)?([A-Za-z_$][\w$]*)\s*\(/);
      if (mm && !JS_KEYWORDS.has(mm[1]) && mm[1] !== 'if' && mm[1] !== 'for' && mm[1] !== 'while' && mm[1] !== 'switch' && mm[1] !== 'catch') {
        var isDef = (function () {
          var depth = 0;
          var seenOpen = false;
          for (var sli = ln; sli < Math.min(lines.length, ln + 6); sli++) {
            var sl = lines[sli];
            var from = sli === ln ? sl.indexOf('(') : 0;
            for (var sci = from; sci < sl.length; sci++) {
              var sch = sl[sci];
              if (sch === '(') { depth++; seenOpen = true; }
              else if (sch === ')') {
                depth--;
                if (seenOpen && depth === 0) {
                  // The character after the closing paren decides: `{`
                  // (or a `:` return type) starts a method body; `;`,
                  // `,`, `)`, `.` or an operator continues an
                  // expression — a call.
                  var rest = sl.slice(sci + 1).trim();
                  if (rest === '') {
                    // The `{` may sit on the next line (`) \n {`).
                    for (var nj = sli + 1; nj < Math.min(lines.length, sli + 3); nj++) {
                      var nx = lines[nj].trim();
                      if (nx === '') continue;
                      return nx.charAt(0) === '{';
                    }
                    return false;
                  }
                  return rest.charAt(0) === '{' || rest.charAt(0) === ':';
                }
              }
            }
          }
          return false;
        })();
        if (isDef) {
          parsed.definitions.push({
            name: mm[1], kind: 'method', exported: false,
            startLine: lineNo, endLine: lineNo, decorators: [], ambient: inAmbient,
          });
          markDeclared(lineNo, mm[1]);
        }
      }
    }

    // Function declaration.
    m = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
    if (m) {
      parsed.definitions.push({
        name: m[1], kind: 'function', exported: /^\s*export\b/.test(line),
        startLine: lineNo, endLine: lineNo, decorators: [], ambient: inAmbient,
      });
      markDeclared(lineNo, m[1]);
    }

    // const / let / var binding (arrow function, function, or value).
    m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m && !line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+\{/)) {
      var rhs = line.slice(m.index + m[0].length);
      var kind = /=>|function\b/.test(rhs) ? 'function' : 'variable';
      parsed.definitions.push({
        name: m[1], kind: kind, exported: /^\s*export\b/.test(line),
        startLine: lineNo, endLine: lineNo, decorators: [], ambient: inAmbient,
      });
      markDeclared(lineNo, m[1]);
    }

    // TypeScript type / interface. The name must be followed by `=`,
    // `{` or `extends` (allowing `<...>` generics): a bare name
    // followed by `,` or `}` is an item in an `import type { ... }` /
    // `export type { ... }` list, not a definition — without this, every
    // re-exported type in such a list became a phantom definition that
    // looked dead (zustand src/middleware.ts).
    m = line.match(/^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)((?:\s*<[^>]*>)?\s*(?:=|\{|extends\b))/);
    if (m) {
      parsed.definitions.push({
        name: m[1], kind: 'type', exported: /^\s*export\b/.test(line),
        startLine: lineNo, endLine: lineNo, decorators: [], ambient: inAmbient,
      });
      markDeclared(lineNo, m[1]);
    }

    // Update brace depth, tracking class bodies.
    var opens = (line.match(/\{/g) || []).length;
    var closes = (line.match(/\}/g) || []).length;
    braceDepth += opens - closes;
    if (m && false) { /* placeholder, keeps structure clear */ }
    // A `declare module` / `declare global` line opens an ambient block;
    // interfaces inside it are declaration-merging augmentations.
    if (/^\s*declare\s+(module|global)\b/.test(line) && opens > 0) ambientStack.push({ depth: braceDepth });
    while (ambientStack.length && braceDepth < ambientStack[ambientStack.length - 1].depth) ambientStack.pop();
    // Re-detect class start depth: a class line opens a block at depthBefore.
    var cm = line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (cm && opens > 0) classStack.push({ name: cm[1], depth: braceDepth });
    void depthBefore;
  }

  // module.exports / exports.* / export { ... } — mark definitions exported.
  var defByName = Object.create(null);
  parsed.definitions.forEach(function (d) { defByName[d.name] = d; });
  // A `module.exports = { ... }` object may span lines and hold nested
  // objects or function values, so a single `[^}]*` match stops at the
  // first `}` and only the first block in a file is seen. Scan every
  // assignment on the stripped code (strings blanked, so a brace inside
  // a string cannot fool the depth count), match braces, and split only
  // top-level commas — a nested property (`nested: { B }`) is not a
  // module export, so `B` is never marked exported here.
  var meRe = /module\.exports\s*=\s*\{/g;
  var meM;
  while ((meM = meRe.exec(code)) !== null) {
    var bodyStart = meM.index + meM[0].length;
    var meDepth = 1;
    var meI = bodyStart;
    while (meI < code.length && meDepth > 0) {
      if (code[meI] === '{') meDepth++;
      else if (code[meI] === '}') meDepth--;
      meI++;
    }
    if (meDepth !== 0) continue; // unterminated object: fail open, mark nothing
    splitTopLevel(code.slice(bodyStart, meI - 1), ',').forEach(function (part) {
      var name = part.split(':')[0].trim();
      if (defByName[name]) defByName[name].exported = true;
    });
  }
  // Lines belonging to a `module.exports = { ... }` object literal: the
  // names listed there are exports, not uses, so the references pass
  // scans them depth-aware (see the references loop below). The region
  // runs from the opening line until the matching close, brace-depth
  // based on the stripped code; if no close is found within the bound,
  // only the opening line is treated as an export object (fail open —
  // the rest is scanned like ordinary code).
  var exportObjLines = new Set();
  var EXPORT_OBJ_MAX_LINES = 200;
  for (var eo = 0; eo < lines.length; eo++) {
    if (!/^\s*module\.exports\s*=\s*\{/.test(lines[eo])) continue;
    var eoDepth = 0;
    var eoEnd = eo;
    var eoClosed = false;
    for (var eo2 = eo; eo2 < Math.min(lines.length, eo + EXPORT_OBJ_MAX_LINES); eo2++) {
      var eoLine = lines[eo2];
      for (var eo3 = 0; eo3 < eoLine.length; eo3++) {
        if (eoLine[eo3] === '{') eoDepth++;
        else if (eoLine[eo3] === '}') eoDepth--;
      }
      if (eoDepth === 0) { eoEnd = eo2; eoClosed = true; break; }
    }
    if (!eoClosed) eoEnd = eo; // fail open: skip the opening line only
    for (var eo4 = eo; eo4 <= eoEnd; eo4++) exportObjLines.add(eo4 + 1);
  }
  var re2 = /module\.exports\.([A-Za-z_$][\w$]*)\s*=/g;
  var m2;
  while ((m2 = re2.exec(raw)) !== null) {
    if (defByName[m2[1]]) defByName[m2[1]].exported = true;
  }
  re2 = /exports\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((m2 = re2.exec(raw)) !== null) {
    if (defByName[m2[1]]) defByName[m2[1]].exported = true;
  }
  var exRe = /export\s+(?:type\s+)?\{([^}]*)\}/g;
  var exM;
  while ((exM = exRe.exec(code)) !== null) {
    // A re-export list (`export { ... } from './x'`) names the source
    // module's symbols, not local definitions, so it marks nothing.
    var exAfter = code.slice(exM.index + exM[0].length);
    if (/^\s*from\s+['"]/.test(exAfter)) continue;
    exM[1].split(',').forEach(function (part) {
      // `export { foo as bar }` exports the LOCAL name foo under the
      // name bar: the definition to mark is foo (bits[0]), not bar —
      // taking the last part used to mark an unrelated local `bar`
      // exported and leave `foo` looking unexported (SAFE).
      // `export { type Foo }` re-exports the type Foo: strip the `type`
      // modifier before looking the name up (same rule as the import
      // specifiers below).
      var bits = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      var name = bits[0].trim();
      if (defByName[name]) defByName[name].exported = true;
    });
  }
  // `module.exports = foo` exports the whole module as `foo`: mark it
  // exported so it grades REVIEW (public surface), never SAFE. The
  // object-literal form above covers `module.exports = { foo }`; a
  // member access or call (`module.exports = foo.bar()`,
  // `module.exports = foo()`) is a real expression, not a bare export,
  // and is handled by the references pass instead.
  var meBare = raw.match(/module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*(?:;|$)/m);
  if (meBare && defByName[meBare[1]]) defByName[meBare[1]].exported = true;

  // Imports, parsed line-by-line from the raw source (the stripped code
  // has no string literals left, so specifiers must come from here).
  // Comment lines are skipped: a comment such as
  // "// import x from '...'" is not an import. Multi-line import
  // statements are accumulated until the `from '...'` clause appears.
  function parseImportStatement(stmt) {
    var im = stmt.match(/import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/);
    if (!im) return null;
    var spec = stripComments((im[1] || '').trim());
    var names = [];
    if (spec) {
      var star = spec.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      if (star) names.push({ imported: '*', local: star[1], kind: 'namespace' });
      var brace = spec.match(/\{([^}]*)\}/);
      if (brace) {
        brace[1].split(',').forEach(function (part) {
          // `import { type Foo }` / `import { type Foo as Bar }` bind
          // Foo (or Bar), not a name literally called `type Foo`: strip
          // the `type` modifier. A bare `type` with no name after it
          // (`import { type }`) is untouched — the modifier needs the
          // trailing whitespace to apply.
          part = part.trim().replace(/^type\s+/, '');
          if (!part) return;
          var bits = part.split(/\s+as\s+/);
          names.push({ imported: bits[0].trim(), local: (bits[1] || bits[0]).trim(), kind: 'named' });
        });
      }
      // A leading `type` modifier on a default import (`import type Foo
      // from '...'`): the binding is Foo, not `type`.
      var defSpec = spec.replace(/^type\s+/, '');
      var defm = defSpec.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
      if (defm) names.push({ imported: 'default', local: defm[1], kind: 'default' });
    }
    return { source: im[2], names: names, sideEffect: !spec, reExport: isCompatShimJs };
  }
  // Lines that belong to an import or re-export statement, recorded
  // while the statement is accumulated below: a multi-line import's
  // continuation lines (`  createElement,` in `import {\n
  // createElement,\n ... } from 'react'`) hold binding names, not
  // uses — without this, every name on a continuation line leaked
  // into the references pass and looked used, so no unused import
  // split across lines was ever flagged (preact
  // demo/suspense.jsx, demo/people/router.tsx). Only lines of a
  // statement that parsed successfully are recorded: a malformed
  // statement (no `from` clause within the bound) records nothing
  // and its lines are scanned like ordinary code (fail open).
  var importStmtLines = new Set();
  // Lines of a local `export { ... }` list (no `from` clause), recorded
  // while the statement is accumulated below: the names in the list are
  // exports, not uses — except when a name is an imported binding being
  // re-exported, which IS a use of the import (see the references pass).
  // Only lines of a statement that closed cleanly are recorded; a
  // malformed statement records nothing and its lines are scanned like
  // ordinary code (fail open).
  var exportListLines = new Set();
  // Multi-line require(): line number (1-based) -> binding names bound
  // on that line by a destructuring require (`const {\n a,\n b\n} =
  // require('./x')`). The references pass skips exactly those names;
  // anything else on the line — a member call after the require, a
  // default value's callee — still counts as a use.
  var requireLineBindings = Object.create(null);
  var rawLines = raw.split('\n');
  for (var il2 = 0; il2 < rawLines.length; il2++) {
    var rawLine = rawLines[il2];
    // The stripped line has strings and comments blanked (positions
    // preserved), so it is the oracle for "is this real code": an
    // import/require inside a string literal — a test file holding code
    // in a string, a doc example — is blanked there and must not create
    // a phantom import edge. Specifiers still come from the raw line,
    // because the stripped code has the string contents blanked.
    var strippedLine = lines[il2] || '';
    var trimmedRaw = rawLine.trim();
    if (/^(\/\/|\/\*|\*)/.test(trimmedRaw)) continue; // comment line
    if (/^\s*import\s+[^\(]/.test(strippedLine)) {
      var stmtStart = il2;
      var stmt = rawLine;
      var stmtStripped = strippedLine;
      var guard = 0;
      // Accumulate until the statement is complete. The stripped
      // text (comments blanked, strings blanked) is the oracle for
      // completeness: a named/default import ends with its `from`
      // clause, a side-effect import (`import './x'`) is just the
      // bare `import` keyword once its string is blanked, and a `;`
      // ends the statement. ASI code has no `;`, so the loop must not
      // run past the source string — a side-effect import with no
      // trailing `;` used to swallow the following lines (up to the
      // guard) and record them as import lines, which blanked the
      // next function's references (zustand Scene.jsx: every symbol
      // in Experience looked dead). The raw text is kept for parsing,
      // because the stripped text has the source string blanked.
      while (guard < IMPORT_STMT_MAX_LINES && il2 + 1 < rawLines.length) {
        if (/from\s*;?\s*$/.test(stmtStripped)) break;
        if (/^\s*import\s+['"]/.test(stmt) && /^\s*import\s*;?\s*$/.test(stmtStripped)) break;
        if (/;\s*$/.test(stmtStripped)) break;
        il2++; guard++;
        stmt += '\n' + rawLines[il2];
        stmtStripped += '\n' + (lines[il2] || '');
      }
      var imp = parseImportStatement(stmt);
      if (imp) {
        parsed.imports.push(imp);
        for (var sl = stmtStart; sl <= il2; sl++) importStmtLines.add(sl + 1);
      }
      continue;
    }
    if (/^\s*export\s+(?:type\s+)?(?:\*|\{)/.test(rawLine) && strippedLine.indexOf('export') >= 0) {
      // A re-export may span lines (`export {\n A,\n B,\n} from
      // './x'`): accumulate like the import branch above until the
      // `from '...'` clause appears. A local `export { ... }` list
      // that closes without a `from` is not a re-export — stop there
      // so the next statement is never swallowed (ASI code has no `;`
      // to stop on). The `export * as ns from '...'` alias form is
      // accepted too (matches the CLI).
      var reStmtStart = il2;
      var reStmt = rawLine;
      var reGuard = 0;
      while (reGuard < IMPORT_STMT_MAX_LINES && il2 + 1 < rawLines.length) {
        if (/from\s+['"]/.test(reStmt)) break;
        if (/;\s*$/.test(reStmt)) break;
        if (/^\s*export\s+(?:type\s+)?\{/.test(reStmt)) {
          var reBal = 0;
          for (var reBi = 0; reBi < reStmt.length; reBi++) {
            if (reStmt[reBi] === '{') reBal++;
            else if (reStmt[reBi] === '}') reBal--;
          }
          if (reBal === 0) break;
        }
        il2++; reGuard++;
        reStmt += '\n' + rawLines[il2];
      }
      var reM = reStmt.match(/export\s+(?:\*(?:\s+as\s+([A-Za-z_$][\w$]*))?|\{([\s\S]*?)\})\s+from\s+['"]([^'"]+)['"]/);
      if (reM) {
        // The re-exported names are the import edge's names (matches
        // the CLI): the graph marks the target's symbols as imported
        // by this file through them. With names: [] the edge kept
        // the file alive but its symbols looked unimported — the old
        // references leak (continuation lines scanned as uses) was
        // silently doing this job instead.
        var reNames = [];
        if (reM[2] !== undefined) {
          // export { A, B as C, type D } from '...' — `type` is a
          // modifier, not a name (same rule as the import branch).
          stripComments(reM[2]).split(',').forEach(function (part) {
            part = part.trim().replace(/^type\s+/, '');
            if (!part) return;
            var bits = part.split(/\s+as\s+/);
            reNames.push({ imported: bits[0].trim(), local: (bits[1] || bits[0]).trim(), kind: 'named' });
          });
        } else {
          // export * [as ns] from '...' — a namespace re-export: the
          // alias binds the namespace, or `*` marks every export.
          reNames.push({ imported: '*', local: reM[1] || '*', kind: 'namespace' });
        }
        parsed.imports.push({ source: reM[3], names: reNames, sideEffect: false, reExport: true });
        for (var rl = reStmtStart; rl <= il2; rl++) importStmtLines.add(rl + 1);
        continue;
      }
      // No `from` clause: a local `export { ... }` list, not a
      // re-export. When the braces balance, the statement closed
      // cleanly: record its lines so the references pass knows the
      // names are exports, not uses (see exportListLines above) — a
      // locally defined name in the list must not count as a
      // same-file use, or it would never be flagged REVIEW. When the
      // statement never closed (guard hit), fall through so the
      // require scan below still sees the line (fail open).
      var exClosed = false;
      if (/export\s+(?:type\s+)?\{/.test(reStmt)) {
        var exBal = 0;
        for (var exBi = 0; exBi < reStmt.length; exBi++) {
          if (reStmt[exBi] === '{') exBal++;
          else if (reStmt[exBi] === '}') exBal--;
        }
        exClosed = exBal === 0;
      }
      if (exClosed) {
        for (var el = reStmtStart; el <= il2; el++) exportListLines.add(el + 1);
        continue;
      }
    }
    var reqM = rawLine.match(/(?:const|let|var)\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/);
    if (reqM && strippedLine.indexOf('require(') === -1) reqM = null; // inside a string/comment, not real code
    var reqStmtStart = -1;
    if (!reqM && /^\s*(?:const|let|var)\b/.test(strippedLine)) {
      // A require() split across lines (`const {\n a,\n b\n} =
      // require('./x')`, or `const x =\n require('./x')`): the
      // single-line match above cannot see it, so the import edge was
      // lost and the destructured names leaked into the references
      // pass as uses. Accumulate until the braces and parens balance
      // and a require( has been seen; a `;` before any require ends a
      // different statement, so stop there instead of swallowing the
      // next statement. Balance is counted on the stripped lines, so
      // a brace inside a string cannot fool it.
      reqStmtStart = il2;
      var reqStmt = rawLine;
      var reqStripped = strippedLine;
      var reqGuard = 0;
      while (reqGuard < IMPORT_STMT_MAX_LINES && il2 + 1 < rawLines.length) {
        var reqBalBraces = 0;
        var reqBalParens = 0;
        for (var rb = 0; rb < reqStripped.length; rb++) {
          if (reqStripped[rb] === '{') reqBalBraces++;
          else if (reqStripped[rb] === '}') reqBalBraces--;
          else if (reqStripped[rb] === '(') reqBalParens++;
          else if (reqStripped[rb] === ')') reqBalParens--;
        }
        var reqSeen = /require\s*\(/.test(reqStmt);
        if (reqSeen && reqBalBraces === 0 && reqBalParens === 0) break;
        // Without a require yet, the statement is complete when its
        // braces and parens balance and it does not end with a
        // continuation (an operator, comma, or open bracket): ASI
        // code has no `;`, so a finished `const x = foo()` must stop
        // the scan here — otherwise every semicolon-less declaration
        // swallowed the following lines up to the guard (and the
        // zustand web bench went from 0.1s to 4.8s).
        if (!reqSeen && reqBalBraces === 0 && reqBalParens === 0 && !/[=,([{+\-*/%&|^?:.]$/.test(reqStripped.trim())) break;
        il2++; reqGuard++;
        reqStmt += '\n' + rawLines[il2];
        reqStripped += '\n' + (lines[il2] || '');
      }
      // `[^}]*` spans newlines (a negated class matches `\n`), so the
      // same single-line pattern parses the joined statement.
      reqM = reqStmt.match(/(?:const|let|var)\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/);
      if (reqM) {
        // The require( must be real code, not text inside a string:
        // find its line and check the stripped line still has it
        // (positions are preserved by stripping).
        var reqIdx = reqStmt.indexOf('require(');
        var reqLineNo = reqStmtStart + reqStmt.slice(0, reqIdx).split('\n').length - 1;
        if ((lines[reqLineNo] || '').indexOf('require(') === -1) reqM = null;
      }
      if (!reqM) {
        // Not a require after all: rewind, so the lines just scanned
        // are visited normally by the import scan (a require on a
        // later line still gets its bare edge below).
        il2 = reqStmtStart;
        reqStmtStart = -1;
      }
    }
    if (reqM) {
      var names2 = [];
      if (reqM[1]) {
        stripComments(reqM[1]).split(',').forEach(function (part) {
          part = part.trim();
          if (!part) return;
          var bits = part.split(/\s*:\s*/);
          names2.push({ imported: bits[0].trim(), local: (bits[1] || bits[0]).trim(), kind: 'named' });
        });
      } else if (reqM[2]) {
        names2.push({ imported: reqM[2], local: reqM[2], kind: 'value' });
      }
      parsed.imports.push({ source: reqM[3], names: names2, sideEffect: false, reExport: isCompatShimJs });
      if (reqStmtStart >= 0) {
        // Record the binding names on every line of the statement so
        // the references pass skips them (see below). A name is
        // recorded only when the statement parsed, so a failed
        // accumulation records nothing (fail open).
        var reqLocals = new Set();
        names2.forEach(function (n) { reqLocals.add(n.local); });
        for (var rbl = reqStmtStart; rbl <= il2; rbl++) requireLineBindings[rbl + 1] = reqLocals;
      }
    }
    // Inline / bare require('...') — require('./x').fn() or a bare
    // side-effect require('./x') — is an import edge too (matches the
    // CLI, which records every literal require). Names are empty, so the
    // member-use check is what keeps the called export alive: the
    // importer's references name it, so it counts as imported.
    // sideEffect so the dead-import check skips it.
    var bareRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    var bareM;
    while ((bareM = bareRe.exec(rawLine)) !== null) {
      if (reqM && bareM[1] === reqM[3]) continue; // already recorded above
      // Positions are preserved by stripping, so a real require sits at
      // the same index in the stripped line; one inside a string or
      // comment is blanked there and must not create a phantom import.
      if (strippedLine.substr(bareM.index, 8) !== 'require(') continue;
      parsed.imports.push({ source: bareM[1], names: [], sideEffect: true, reExport: false });
    }
  }
  // NOTE: strings are blanked in `code`, so literal-argument checks run on
  // the raw source. Dynamic import(): flag only, no import edge (matches
  // CLI v0.1.0 — a file loaded only via import() is kept alive only by
  // string references).
  if (/require\(\s*(?![`'"])/.test(raw)) {
    parsed.dynamic = true;
    parsed.dynamicReasons.push('dynamic require() with a non-literal argument');
  }
  var dynRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  var im;
  while ((im = dynRe.exec(raw)) !== null) {
    parsed.dynamic = true;
    parsed.dynamicReasons.push('dynamic import()');
    parsed.dynamicImports.push(im[1]);
  }
  if (/\bimport\s*\(\s*(?![`'"])/.test(raw)) {
    parsed.dynamic = true;
    parsed.dynamicReasons.push('dynamic import() with a non-literal argument');
  }

  // References and calls from the stripped code. Import lines and
  // module.exports lines are not uses; a definition's own declaration line
  // does not count as a reference to itself.
  var importLocals = new Set();
  parsed.imports.forEach(function (imp) {
    (imp.names || []).forEach(function (n) { importLocals.add(n.local); });
  });
  // JSX-pragma imports count as uses when the file contains JSX (see
  // the decision block in src/parse-js.js — the same rule, kept in
  // sync): the transform calls the pragma factory for every element,
  // so the import is used even though its name never appears in the
  // source text. Only imported bindings get the credit, and only in
  // a file with JSX; in a file with no JSX the same import is still
  // flaggable. Applied here, before the references pass, so it only
  // affects the file-level reference set the dead-import check reads.
  if (parsed.hasJsx) {
    JSX_PRAGMA_NAMES.forEach(function (name) {
      if (importLocals.has(name)) parsed.references.add(name);
    });
  }
  // Names bound by imports in this file: a local `export { ... }` list
  // re-exports them, so those names ARE uses (see exportListLines
  // below); a locally defined name in the same list is not.
  var importLocalNames = new Set();
  parsed.imports.forEach(function (imp) {
    (imp.names || []).forEach(function (n) { importLocalNames.add(n.local); });
  });
  // Names that collide with JS keywords but are real bindings in this
  // file: an imported `of` / `from` (RxJS) or a local definition named
  // `get`, `set`, `from`. `return of(...)` calls the RxJS `of` import,
  // it is not the for-of keyword, and `` `${from}` `` uses the local
  // `from` — so the keyword skip in the references pass below must not
  // drop them (WP-1). A name that is neither imported nor defined here
  // is still skipped: a bare `of` in a for-of header is not a use.
  var keywordUseNames = new Set(importLocals);
  parsed.definitions.forEach(function (d) { keywordUseNames.add(d.name); });
  // Brace depth carried across the lines of one `module.exports = {
  // ... }` region, so the references scan below can tell a top-level
  // entry name (an export) from a nested or trailing use.
  var exportObjDepth = 0;
  var exportObjPrev = false;
  for (var li = 0; li < lines.length; li++) {
    var l = lines[li];
    var lineNo2 = li + 1;
    var inExportObj = exportObjLines.has(lineNo2);
    if (inExportObj && !exportObjPrev) exportObjDepth = 0; // fresh region
    exportObjPrev = inExportObj;
    // A static import statement is not a use — but a dynamic import()
    // line IS: `import(`...v${PYODIDE_VERSION}/...`)` uses the name in
    // its template interpolation, so only skip the line when `import`
    // is not followed by `(`.
    if (/^\s*import\b(?!\s*\()/.test(l)) continue;
    // A line belonging to a multi-line import or re-export statement
    // holds binding names, not uses (see importStmtLines above) — the
    // whole line is skipped, exactly like a single-line import line.
    if (importStmtLines.has(lineNo2)) continue;
    if (exportListLines.has(lineNo2)) {
      // A local `export { ... }` line holds export names, not uses —
      // except a name that is an imported binding being re-exported,
      // which is a use of the import (matches the CLI: `export {
      // helper }` in js-reexports keeps the import alive). The local
      // name is the part before `as` (`export { helper as h }`
      // re-exports the import `helper`); a `type` modifier is not a
      // name. The line holds no calls, so nothing else is collected.
      var expBody = l.replace(/^[^{]*\{/, '').replace(/\}.*$/, '');
      expBody.split(',').forEach(function (part) {
        var bits = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
        var localName = (bits[0] || '').trim();
        if (localName && importLocalNames.has(localName)) parsed.references.add(localName);
      });
      continue;
    }
    if (inExportObj) {
      // Depth-aware scan of an export-object line: only a top-level
      // entry name is an export — a shorthand (`A,`) or a key
      // (`run:`). A value (`run: foo`), a nested name (`nested: {
      // B }`), a call (`run: foo()`), and identifiers inside a
      // function value are real uses and still count (matches the CLI,
      // which only excludes the shorthand/key names parented by the
      // export object).
      var regionDeclared = declaredOnLine[lineNo2] || new Set();
      var regionSkipIds = /module\.exports\b/.test(l) ? new Set(['module', 'exports']) : null;
      var regionDepthStart = exportObjDepth;
      var regionIdRe = /[A-Za-z_$][\w$]*/g;
      var regionIdM;
      while ((regionIdM = regionIdRe.exec(l)) !== null) {
        var regionId = regionIdM[0];
        if (JS_KEYWORDS.has(regionId) && !keywordUseNames.has(regionId)) continue;
        if (regionDeclared.has(regionId)) continue;
        if (regionSkipIds && regionSkipIds.has(regionId)) continue;
        var regionDepth = regionDepthStart;
        for (var rp = 0; rp < regionIdM.index; rp++) {
          if (l[rp] === '{') regionDepth++;
          else if (l[rp] === '}') regionDepth--;
        }
        if (regionDepth === 1 && isExportEntryName(l, regionIdM.index, regionId.length)) continue;
        parsed.references.add(regionId);
      }
      // Every call on an export-object line is a real use: a top-level
      // entry name is never followed by `(`.
      var regionCallRe = /([A-Za-z_$][\w$]*)\s*\(/g;
      var regionCm;
      while ((regionCm = regionCallRe.exec(l)) !== null) {
        if (JS_KEYWORDS.has(regionCm[1]) && !keywordUseNames.has(regionCm[1])) continue;
        if (regionDeclared.has(regionCm[1])) continue;
        if (regionSkipIds && regionSkipIds.has(regionCm[1])) continue;
        parsed.calls.add(regionCm[1]);
      }
      var regionNewRe = /\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g;
      var regionNm;
      while ((regionNm = regionNewRe.exec(l)) !== null) {
        parsed.calls.add('constructor');
        parsed.constructed.add(regionNm[1]);
      }
      for (var rd = 0; rd < l.length; rd++) {
        if (l[rd] === '{') exportObjDepth++;
        else if (l[rd] === '}') exportObjDepth--;
      }
      continue;
    }
    // A const/let/var require line binds names on that line: the binding
    // itself is not a use (otherwise no unused import could ever be
    // flagged). But a member call on the same line IS a use —
    // `const x = require('./util').helper()` uses `helper` — so collect
    // the line's identifiers except the bound names, instead of skipping
    // the whole line. For a require() split across lines, the binding
    // names per line were recorded while the statement was accumulated
    // (requireLineBindings above); a single-line require is parsed
    // here, as before.
    var boundHere = requireLineBindings[lineNo2] ? new Set(requireLineBindings[lineNo2]) : null;
    if (/\brequire\s*\(/.test(l) && /^\s*(const|let|var)\b/.test(l)) {
      if (!boundHere) boundHere = new Set();
      var bm = l.match(/^\s*(?:const|let|var)\s+\{([^}]*)\}/);
      if (bm) {
        bm[1].split(',').forEach(function (part) {
          var bits = part.trim().split(/\s*:\s*/);
          if (bits[0]) boundHere.add((bits[1] || bits[0]).trim());
        });
      } else {
        var sm = l.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
        if (sm) boundHere.add(sm[1]);
      }
    }
    // A `module.exports = ...` line is an export, not a use — but only
    // when the exported value is an object literal (`module.exports =
    // { live }`: `live` is the export name, not a use) or a bare
    // identifier (`module.exports = foo`: `foo` IS the export, and it
    // is marked exported above, so it grades REVIEW). Any other
    // right-hand side is a real expression, so the line is scanned
    // like any other, with only the `module` / `exports` identifiers
    // dropped: `module.exports = withBundleAnalyzer({...})` calls the
    // import, `module.exports = xs.filter(isExportNode)` passes the
    // import as an argument, and `module.exports = express()` calls it
    // (that last shape used to be a known gap).
    if (/^\s*module\.exports\s*=/.test(l)) {
      var rhs = l.replace(/^\s*module\.exports\s*=\s*/, '');
      if (/^\{/.test(rhs) || /^[A-Za-z_$][\w$]*\s*;?\s*$/.test(rhs)) continue;
    }
    var skipExportsIds = /module\.exports\b/.test(l) ? new Set(['module', 'exports']) : null;
    var declared = declaredOnLine[lineNo2] || new Set();
    // Decorator line (`@app.command()`, `@Component({...})`,
    // `@register(MyClass)`): the dotted member chain after the
    // decorator object is dropped — `command` in `@app.command()` is a
    // member of the decorator object, not a reference to a same-named
    // local function, so a decorated `def command` is not
    // self-referenced by its own decorator. The decorator object
    // itself and any decorator arguments (`MyClass` above) are real
    // references and are kept. (Multi-line decorators only guard their
    // first line — a known limitation.)
    var isDecLine = /^\s*@/.test(l);
    var decChain = new Set();
    if (isDecLine) {
      var chainM = l.trim().slice(1).match(/^([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)*)/);
      if (chainM) {
        (chainM[2].match(/[A-Za-z_$][\w$]*/g) || []).forEach(function (n) { decChain.add(n); });
      }
    }
    identifiers(l).forEach(function (id) {
      if (JS_KEYWORDS.has(id) && !keywordUseNames.has(id)) return;
      if (declared.has(id)) return; // declaration site, not a use
      if (boundHere && boundHere.has(id)) return; // import binding, not a use
      if (skipExportsIds && skipExportsIds.has(id)) return; // the `module.exports` tokens themselves
      if (decChain.has(id)) return;
      parsed.references.add(id);
    });
    var callRe = /([A-Za-z_$][\w$]*)\s*\(/g;
    var cm2;
    while ((cm2 = callRe.exec(l)) !== null) {
      if (JS_KEYWORDS.has(cm2[1]) && !keywordUseNames.has(cm2[1])) continue;
      if (declared.has(cm2[1])) continue; // `function foo(` is not a call
      if (boundHere && boundHere.has(cm2[1])) continue;
      if (decChain.has(cm2[1])) continue;
      parsed.calls.add(cm2[1]);
    }
    // `new Client()` invokes the class constructor: without this, a
    // constructor method was flagged REVIEW ("0 callers") even though
    // the class is constructed in-repo. The constructed class name is
    // kept so the cross-file pass can resolve it through imports.
    var newRe = /\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g;
    var nm;
    while ((nm = newRe.exec(l)) !== null) {
      parsed.calls.add('constructor');
      parsed.constructed.add(nm[1]);
    }
  }
  // Import locals are references only when used elsewhere; the import line
  // itself was skipped above, so nothing to remove here.

  // Unreachable code: statements after return/throw/break/continue in the
  // same block, and if (false) branches.
  var depth = 0;
  var terminatedAt = null; // brace depth where the block was terminated
  var terminatedLineU = -1; // line of the return/throw/break/continue
  var hoistedSkipDepth = null; // brace depth at a hoisted function declaration after a terminator (FP-12)
  var rawLinesU = raw.split('\n');
  for (var ui = 0; ui < lines.length; ui++) {
    var ul = lines[ui];
    var dBefore = depth;
    depth += (ul.match(/\{/g) || []).length - (ul.match(/\}/g) || []).length;
    // Lines inside a multi-line template literal hold generated code,
    // not real statements: a `${...}` expression line after a
    // `return `...`` is part of the return statement, never a new
    // unreachable statement (WP-2). The depth update above still runs
    // — a ${...} expression's braces are real — but the line itself
    // neither terminates a block nor counts as unreachable.
    if (templateLines.has(ui + 1)) continue;
    if (terminatedAt !== null && depth < terminatedAt) { terminatedAt = null; terminatedLineU = -1; }
    var trimmed = ul.trim();
    // FP-12: a function declaration after return/throw is hoisted, so
    // the declaration and its whole body are reachable — never flag
    // them. (A class / const / let after a terminator still never runs,
    // so those are still flagged.) Skip lines until the function's
    // closing brace brings the depth back to the declaration depth.
    if (hoistedSkipDepth !== null) {
      // The closing brace of the hoisted function is not a statement
      // and does not end the terminated outer block: clear the skip
      // and keep terminatedAt set, so later statements are still
      // flagged. (Falling through to the `}` handler below would clear
      // terminatedAt and hide genuinely unreachable code after the
      // hoisted function.)
      if (trimmed.startsWith('}') && depth <= hoistedSkipDepth) hoistedSkipDepth = null;
      continue;
    }
    if (terminatedAt !== null && dBefore >= terminatedAt
      && /^\s*(export\s+(default\s+)?)?(async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*\s*\(/.test(ul)) {
      var fnOpens = (ul.match(/\{/g) || []).length;
      var fnCloses = (ul.match(/\}/g) || []).length;
      // A multi-line function opens more braces than it closes; a
      // brace-on-the-next-line declaration opens none yet. A single-line
      // `function f() {}` opens and closes on the same line, so no skip
      // state is needed for it.
      if (fnOpens > fnCloses || fnOpens === 0) hoistedSkipDepth = dBefore;
      continue; // the declaration line itself is reachable too
    }
    if (/^\s*if\s*\(\s*false\s*\)/.test(ul)) {
      parsed.unreachable.push({ line: ui + 1, blockLine: ui + 1, reason: 'if (false) branch is never taken', snippet: trimmed.slice(0, 120) });
      continue;
    }
    // A line that closes a block opens a new one: `} catch`, `} else`,
    // `} finally`, or the end of the block itself — the code after it is
    // reachable again, and the line itself is not a statement.
    if (trimmed.startsWith('}')) { terminatedAt = null; terminatedLineU = -1; continue; }
    // A new switch case is reachable even after a `break`.
    if (/^case\b/.test(trimmed) || /^default\s*:/.test(trimmed)) { terminatedAt = null; terminatedLineU = -1; continue; }
    if (terminatedAt !== null && dBefore >= terminatedAt && trimmed !== '' && !trimmed.startsWith('//') && /[A-Za-z0-9_$]/.test(trimmed)) {
      // A continuation line of a multi-line expression (the previous line
      // ends with an operator, comma or open bracket, or this line starts
      // with one) is part of the same statement, not a new unreachable
      // statement — without this, one finding was emitted per line
      // (`return comparer ? ...` split over lines). Intentional
      // unreachable code marked `/* istanbul ignore next */` is skipped
      // too (the author knows it never runs); the marker sits on the
      // terminating statement or the line above it.
      var prevTrimmed = ui > 0 ? lines[ui - 1].trim() : '';
      var isContinuation = /^[?:,)\].&|+]/.test(trimmed) || /[({[,&|?:+\-*/%=<>!]$/.test(prevTrimmed);
      var checkIgnoredU = function (row) {
        var a = rawLinesU[row] || '';
        var b = row > 0 ? (rawLinesU[row - 1] || '') : '';
        return /istanbul ignore/.test(a) || /istanbul ignore/.test(b)
          || /pragma:\s*no cover/.test(a) || /pragma:\s*no cover/.test(b);
      };
      if (!isContinuation && !checkIgnoredU(ui) && !checkIgnoredU(terminatedLineU)) {
        // blockLine is the terminating statement's line: every line of
        // one unreachable block shares it, so the findings pass emits
        // one finding per block instead of one per line.
        parsed.unreachable.push({ line: ui + 1, blockLine: terminatedLineU + 1, reason: 'code after return/throw/break/continue', snippet: trimmed.slice(0, 120) });
      }
      continue;
    }
    if (/^\s*(return|throw|break|continue)\b/.test(ul)) {
      // Only a complete statement terminates the block. A multi-line
      // `return { ... }` or `return foo(` keeps going on the next lines,
      // and so does a return whose value is a template literal spanning
      // lines (its `${...}` expressions look like code but are not
      // statements). Detect the unclosed backtick on the raw line.
      // A return whose expression continues on the next line does not
      // terminate either: the line ends with an operator (`return a +`)
      // or the next line starts a member chain / continuation (`return
      // str` followed by `.split(...).map(...)`, `return toThenable(..)`
      // followed by `.then(...)` — commander help.js, zustand
      // persist.ts, date-fns format/index.ts).
      // And a return that is the body of a BRACELESS if/for/while (the
      // control header is the previous line, with no `{`) only exits
      // conditionally — it does not terminate the block. Without this,
      // the statement after it was flagged unreachable (commander:
      // `if (str === undefined ...) return this._description;` followed
      // by a reachable assignment). A braceless header can span lines
      // (`if (\n cond\n )`), so the header is found by walking back
      // until its parens balance (commander command.js, date-fns
      // buildMds.ts, _lib/tp/index.ts).
      var opens = (ul.match(/[\{\(\[]/g) || []).length;
      var closes = (ul.match(/[\}\)\]]/g) || []).length;
      var rawLineU = rawLinesU[ui] || '';
      // Count only unescaped backticks: `\`` inside a template literal
      // does not open or close it, so it must not flip the parity
      // check below.
      var bt = 0;
      for (var bti = 0; bti < rawLineU.length; bti++) {
        if (rawLineU[bti] === '`' && rawLineU[bti - 1] !== '\\') bt++;
      }
      var headerLines = [];
      var parenDepthU = 0;
      for (var pi = ui - 1; pi >= 0 && headerLines.length < 10; pi--) {
        var plU = lines[pi];
        if (plU.trim() === '') continue;
        headerLines.unshift(plU);
        for (var pcU = 0; pcU < plU.length; pcU++) {
          if (plU[pcU] === '(') parenDepthU++;
          else if (plU[pcU] === ')') parenDepthU--;
        }
        if (parenDepthU === 0) break;
      }
      var headerU = headerLines.join('\n');
      var braceless = /^\s*\}?\s*else\s*$/.test(headerU) || /^\s*(if|else\s+if|for|while)\b[^;{]*\)\s*$/.test(headerU);
      // A return ending in `as` continues on the next line (`return x as
      // \n Type;`) — `as` is a binary operator that needs its right-hand
      // type, so the statement is not complete (standard-schema-
      // validation.pipe.ts:199).
      var endsWithOperator = /[({[,&|?:+\-*/%=<>!]$/.test(trimmed) || /\bas$/.test(trimmed);
      var nextTrimmed = '';
      for (var ni = ui + 1; ni < lines.length; ni++) {
        if (lines[ni].trim() !== '') { nextTrimmed = lines[ni].trim(); break; }
      }
      var continuesNextLine = /^[?:,)\].&|+]/.test(nextTrimmed);
      if (opens <= closes && bt % 2 === 0 && !braceless && !endsWithOperator && !continuesNextLine) { terminatedAt = dBefore; terminatedLineU = ui; }
    }
  }

  return parsed;
}

/* ------------------------------------------------------------------ */
/* Python parsing (regex-based)                                        */
/* ------------------------------------------------------------------ */

function parsePy(rel, raw) {
  var strings = [];
  var code = stripPy(raw, strings);
  var lines = code.split('\n');
  var parsed = {
    language: 'py', definitions: [], imports: [], references: new Set(),
    calls: new Set(), dynamic: false, dynamicReasons: [], dynamicImports: [],
    unreachable: [], decorators: [], dunder: new Set(), strings: strings,
  };

  var classStack = []; // {name, indent, model}
  var funcStack = []; // {indent} — def lines, so a local inside a method is not a class field
  var pendingDecorators = [];
  var declaredOnLine = {};

  // Bracket depth at the start of each line, counted on the stripped
  // code (strings and comments are already blanked, so brackets inside
  // them cannot corrupt the count; f-string {...} expressions are kept
  // as code and their braces balance). A line inside an open bracket is
  // a continuation — a keyword argument (`replace_whitespace=False` in
  // a multi-line call), a decorator argument, a def parameter — never a
  // standalone assignment, so the definition pass skips it. It also
  // guards the scope stacks: the closing line of a multi-line def/class
  // signature (`) -> str:`) sits at the def's own indent and must not
  // pop the scope it just opened, or the whole function body would look
  // module-level. Depth never goes below 0 (a stray closer in broken
  // code just clamps); if brackets never balance, later lines stay
  // suppressed — a false negative, never a false positive.
  var depthAtLineStart = [];
  (function () {
    var depth = 0;
    for (var i = 0; i < lines.length; i++) {
      depthAtLineStart.push(depth);
      for (var j = 0; j < lines[i].length; j++) {
        var ch = lines[i][j];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
      }
    }
  })();

  function markDeclared(lineNo, name) {
    if (!declaredOnLine[lineNo]) declaredOnLine[lineNo] = new Set();
    declaredOnLine[lineNo].add(name);
  }
  function indentOf(line) {
    var m = line.match(/^ */);
    return m ? m[0].length : 0;
  }

  for (var ln = 0; ln < lines.length; ln++) {
    var line = lines[ln];
    var lineNo = ln + 1;
    var trimmed = line.trim();
    if (trimmed === '') continue;
    var indent = indentOf(line);
    // A scope never ends in the middle of a bracketed statement: the
    // suite (and its dedent) only starts after the brackets close.
    var lineDepth = depthAtLineStart[ln];
    while (lineDepth === 0 && classStack.length && indent <= classStack[classStack.length - 1].indent) classStack.pop();
    while (lineDepth === 0 && funcStack.length && indent <= funcStack[funcStack.length - 1].indent) funcStack.pop();

    if (/^@/.test(trimmed)) {
      pendingDecorators.push(trimmed);
      parsed.decorators.push(trimmed);
      continue;
    }
    var dm = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (dm) {
      var isMethod = classStack.length > 0 && indent > classStack[classStack.length - 1].indent;
      var def = {
        name: dm[2], kind: isMethod ? 'method' : 'function', exported: false,
        startLine: lineNo, endLine: lineNo, decorators: pendingDecorators.slice(),
      };
      parsed.definitions.push(def);
      if (/^__.*__$/.test(dm[2])) parsed.dunder.add(dm[2]);
      markDeclared(lineNo, dm[2]);
      funcStack.push({ indent: indent });
      pendingDecorators = [];
      continue;
    }
    var cm = line.match(/^(\s*)class\s+([A-Za-z_]\w*)/);
    if (cm) {
      // A Pydantic BaseModel subclass or a @dataclass is a model class:
      // its class attributes are framework-populated fields (see the
      // assignment branch below).
      var baseM = line.match(/\(([^)]*)\)/);
      var bases = baseM ? baseM[1] : '';
      var isModelClass = /BaseModel|TypedDict/.test(bases) || pendingDecorators.some(function (d) { return /dataclass/.test(d); });
      parsed.definitions.push({
        name: cm[2], kind: 'class', exported: false,
        startLine: lineNo, endLine: lineNo, decorators: pendingDecorators.slice(),
      });
      markDeclared(lineNo, cm[2]);
      classStack.push({ name: cm[2], indent: indent, model: isModelClass });
      pendingDecorators = [];
      continue;
    }
    // Module-level variable assignment: `NAME = ...` or an annotated
    // `NAME: type = ...`. The name is marked declared so its own line
    // does not count as a use of itself. Dunder names (`__version__`,
    // `__all__`) are packaging/protocol metadata and are kept by the
    // dunder rule. A class attribute inside a Pydantic BaseModel /
    // @dataclass is a framework-populated model field (KEEP, never
    // SAFE); other class attributes and function locals are not module
    // definitions and are skipped. A name bound inside a plain block
    // (`if TYPE_CHECKING:`, `try:`, a version guard) IS a module
    // definition at any indent — the CLI's tree-sitter parser records
    // it the same way, with the enclosing block as the parent — so it
    // is recorded here too, as an unexported variable.
    var am = line.match(/^(\s*)([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*[^=]/);
    // A field is directly in the class body (not inside a method: a
    // local inside a method sits deeper than the enclosing def).
    var inFunction = funcStack.length > 0 && indent > funcStack[funcStack.length - 1].indent;
    var inClassBody = classStack.length > 0 && indent > classStack[classStack.length - 1].indent;
    var enclosingModel = !inFunction && inClassBody && classStack[classStack.length - 1].model;
    // lineDepth === 0: a continuation line inside a call, decorator or
    // def signature (`replace_whitespace=False`, a def parameter) looks
    // like an assignment but is a keyword argument, not a binding.
    if (am && lineDepth === 0 && ((!inFunction && !inClassBody) || enclosingModel)) {
      parsed.definitions.push({
        name: am[2], kind: 'variable', exported: false,
        startLine: lineNo, endLine: lineNo, decorators: [],
        frameworkField: Boolean(enclosingModel),
      });
      if (/^__.*__$/.test(am[2])) parsed.dunder.add(am[2]);
      markDeclared(lineNo, am[2]);
      continue;
    }
    if (pendingDecorators.length) pendingDecorators = [];
  }

  // __all__ makes names public exports — and listing a name there is a
  // use of it (a re-export), so the name is added to references too.
  // List and tuple forms, multiline, and += all count (the CLI's
  // tree-sitter parser handles the same shapes).
  var allMatch = raw.match(/__all__\s*\+?=\s*[\[(]([\s\S]*?)[\])]/);
  if (allMatch) {
    var am;
    var allRe = /['"]([^'"]+)['"]/g;
    while ((am = allRe.exec(allMatch[1])) !== null) {
      parsed.imports.push({ source: '__all__', names: [{ imported: am[1], local: am[1], kind: 'named' }], sideEffect: false, reExport: false, allExport: true });
      parsed.references.add(am[1]);
    }
  }
  // Top-level public names are importable in Python.
  parsed.definitions.forEach(function (d) {
    var defLine = lines[d.startLine - 1] || '';
    if (indentOf(defLine) === 0 && !d.name.startsWith('_')) d.exported = true;
  });

  // Imports. In a package __init__.py every import is a re-export: it
  // defines the package's public namespace (pkg.utils, pkg.run), so the
  // dead-import check must never flag it — same rule as the CLI.
  // The same holds for a redundant alias (`from x import Y as Y`), a
  // `# noqa` import, and imports in a compat shim (compat.py /
  // _compat/): the names are the module's public API, not dead code.
  // (Mirrors src/parse-py.js.)
  var isPackageInit = baseOf(rel) === '__init__.py';
  var isCompatShimPy = /(^|\/)(_?compat)(\.py)?$/.test(rel) || /(^|\/)_?compat\//.test(rel);
  // Raw lines, defined here (not in the references pass below) because
  // the import loop needs them: a `# noqa` marker lives in a comment,
  // which the stripped code has blanked.
  var rawLinesPy = raw.split('\n');
  function reExportPy(stmt, redundantAlias, rawStmt) {
    // The noqa marker lives in a comment, which the stripped code has
    // blanked — so it is invisible in `stmt`. Check the raw statement
    // too: `import cryptography  # noqa: F401` and a multi-line
    // `from x import (  # noqa: F401` are intentional re-exports (the
    // CLI's tree-sitter parser sees the comment; the web parser must
    // not lose it to stripping). Without this, requests' compat
    // re-exports and flask's `cryptography` import were flagged SAFE.
    // Linters accept the marker in either case (`# NOQA` in Django),
    // so the match is case-insensitive — mirrors src/parse-py.js.
    return isPackageInit || isCompatShimPy || /#\s*noqa\b/i.test(stmt) || (rawStmt && /#\s*noqa\b/i.test(rawStmt)) || Boolean(redundantAlias);
  }
  // A re-export / backwards-compatibility comment marks ONE name, not
  // the whole statement (mirrors src/parse-py.js): requests' sessions.py
  // imports REDIRECT_STATI and should_bypass_proxies in one statement,
  // but only the latter carries the "# re-export" note. The note may sit
  // on the name's own line, or on the line above the statement: there it
  // must either name the symbol, or the import must carry a single name
  // so the note unambiguously refers to it. Returns a map local -> true
  // for the kept names. (The `# noqa` rule above stays statement-level:
  // a noqa directive is about the whole import.)
  var KEEP_COMMENT_RES = [/#\s*re-exports?\b/i, /#.*\bbackwards?[- ]compat/i];
  function keepCommentNames(rawCovered, rawAbove, names) {
    var kept = {};
    var singleName = names.length === 1;
    function scanLine(line, allowUnnamed) {
      if (!line) return;
      if (!KEEP_COMMENT_RES.some(function (re) { return re.test(line); })) return;
      names.forEach(function (n) {
        if (n.local === '*') return;
        var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
        if (allowUnnamed || new RegExp('\\b(' + esc(n.local) + '|' + esc(n.imported) + ')\\b').test(line)) kept[n.local] = true;
      });
    }
    rawCovered.forEach(function (line) { scanLine(line, false); });
    scanLine(rawAbove, singleName);
    return kept;
  }
  // Split one import record by kept names, mirroring the CLI: the kept
  // names form a re-export record, the rest keep the statement's own
  // verdict (noqa / shim / redundant alias). Without the split, one
  // noted name would whitelist genuinely dead siblings.
  function pushImportSplit(base, names, kept, stmtReExport) {
    var keptNames = names.filter(function (n) { return kept[n.local]; });
    var restNames = names.filter(function (n) { return !kept[n.local]; });
    if (keptNames.length > 0 && restNames.length > 0) {
      parsed.imports.push(Object.assign({}, base, { names: keptNames, reExport: true }));
      parsed.imports.push(Object.assign({}, base, { names: restNames, reExport: stmtReExport }));
    } else {
      parsed.imports.push(Object.assign({}, base, { names: names, reExport: stmtReExport || keptNames.length > 0 }));
    }
  }
  // Whether each line sits inside a `try:` statement (FP-13,
  // mirrors src/parse-py.js inTryExcept): an import there is often an
  // availability probe (`try: import numpy`, `try: from PIL import
  // Image`) whose purpose is the import itself. A try statement spans
  // from its `try:` line through its `except:` / `else:` / `finally:`
  // suites at the same indent — an import in an `except:` fallback is
  // a probe too, matching the CLI's ancestor check, which stops at the
  // enclosing try_statement. The stack pops on a dedent to (or past)
  // the try's indent, unless the line continues the statement
  // (`except:` / `else:` / `finally:`). A `try:` line itself counts:
  // an import on the same line (`try: import numpy`) is inside it.
  // Blank lines and bracket continuations never end a suite.
  var tryAtLine = [];
  (function () {
    var tryStack = []; // {indent}
    for (var ti = 0; ti < lines.length; ti++) {
      var tline = lines[ti];
      var ttrim = tline.trim();
      var tindent = indentOf(tline);
      if (ttrim !== '' && depthAtLineStart[ti] === 0) {
        while (tryStack.length && tindent <= tryStack[tryStack.length - 1].indent) {
          if (/^(except|else|finally)\b/.test(ttrim) && tindent === tryStack[tryStack.length - 1].indent) break;
          tryStack.pop();
        }
      }
      if (depthAtLineStart[ti] === 0 && /^try\s*:/.test(ttrim)) tryStack.push({ indent: tindent });
      tryAtLine.push(tryStack.length > 0);
    }
  })();
  // otherwise the names on continuation lines would count as references
  // to themselves and a dead multi-line import would be silently missed
  // (and a trailing backslash would be recorded as a bogus import named
  // `\`). A star import is kind 'namespace', matching the CLI — the
  // dead-import check skips it, a wildcard is not a name.
  var importLines = {}; // 1-based line numbers covered by an import statement
  function parenDepth(s) {
    var d = 0;
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '(') d++;
      else if (s[i] === ')') d--;
    }
    return d;
  }
  function accumulateImport(ii, first) {
    var stmt = first;
    var covered = [ii + 1];
    var guard = 0;
    while ((parenDepth(stmt) > 0 || /\\\s*$/.test(stmt)) && guard < 20 && ii + 1 < lines.length) {
      ii++; guard++;
      stmt += '\n' + lines[ii];
      covered.push(ii + 1);
    }
    covered.forEach(function (n) { importLines[n] = true; });
    return { stmt: stmt, next: ii, firstLine: covered[0], rawStmt: rawLinesPy.slice(covered[0] - 1, covered[covered.length - 1]).join('\n') };
  }
  function fromNames(text) {
    var names = [];
    var redundantAlias = false;
    text.replace(/[()\\]/g, ' ').split(',').forEach(function (part) {
      part = part.trim();
      if (!part) return;
      var bits = part.split(/\s+as\s+/);
      var imported = bits[0].trim();
      var local = (bits[1] || imported).trim();
      if (bits[1] && local === imported) redundantAlias = true;
      names.push({ imported: imported, local: local, kind: imported === '*' ? 'namespace' : 'named' });
    });
    return { names: names, redundantAlias: redundantAlias };
  }
  for (var ii = 0; ii < lines.length; ii++) {
    var il = lines[ii];
    var fm = il.match(/^\s*from\s+(\.+)?([\w.]*)\s+import\s+(.+)$/);
    if (fm) {
      // `from __future__ import annotations` is a compiler directive,
      // not an import — it is never dead, and the CLI does not record it
      // either. Skip it so `annotations` is never flagged.
      if (fm[2] === '__future__') continue;
      var inTryFrom = tryAtLine[ii] || false;
      var acc = accumulateImport(ii, fm[3]);
      ii = acc.next;
      var fn = fromNames(acc.stmt);
      var keptFrom = keepCommentNames(acc.rawStmt.split('\n'), rawLinesPy[acc.firstLine - 2], fn.names);
      pushImportSplit({
        source: fm[2] || '', sideEffect: false, inTryExcept: inTryFrom,
        fromImport: true, relative: Boolean(fm[1]), level: fm[1] ? fm[1].length : 0,
      }, fn.names, keptFrom, reExportPy(acc.stmt, fn.redundantAlias, acc.rawStmt));
      continue;
    }
    var im2 = il.match(/^\s*import\s+(.+)$/);
    if (im2) {
      var inTryPlain = tryAtLine[ii] || false;
      var acc2 = accumulateImport(ii, im2[1]);
      ii = acc2.next;
      var names3 = [];
      var redundantAlias2 = false;
      acc2.stmt.replace(/[()\\]/g, ' ').split(',').forEach(function (part) {
        part = part.trim();
        if (!part) return;
        var bits = part.split(/\s+as\s+/);
        var mod = bits[0].trim();
        var local2 = (bits[1] || mod.split('.')[0]).trim();
        if (bits[1] && local2 === mod) redundantAlias2 = true;
        names3.push({ imported: mod.split('.')[0], local: local2, kind: 'named', full: mod });
      });
      var keptPlain = keepCommentNames(acc2.rawStmt.split('\n'), rawLinesPy[acc2.firstLine - 2], names3);
      pushImportSplit({
        source: names3.length ? (names3[0].full || names3[0].imported) : '',
        sideEffect: false, inTryExcept: inTryPlain, fromImport: false, relative: false, level: 0,
      }, names3, keptPlain, reExportPy(acc2.stmt, redundantAlias2, acc2.rawStmt));
    }
  }

  // References and calls (skip import lines — including multi-line
  // import continuation lines, tracked in importLines — and declaration
  // sites). An import counts as used only when its bound name is actually
  // referenced elsewhere in the file — the import statement itself is
  // skipped below, so it never self-references. This matches the CLI
  // (run-2 fix): before this, every import local was added to
  // `references` here and no unused Python import was ever flagged.
  // Imports in __init__.py are re-exports (they define the package
  // namespace), so they are marked reExport below and never flagged.
  // (rawLinesPy is defined above, by the import loop — it needs the raw
  // lines for the `# noqa` check.)
  for (var ri = 0; ri < lines.length; ri++) {
    var rl = lines[ri];
    var rNo = ri + 1;
    if (importLines[rNo]) continue;
    if (/^\s*(import|from)\b/.test(rl)) continue;
    var declared = declaredOnLine[rNo] || new Set();
    // Decorator line (`@app.command()`): the dotted member chain after
    // the decorator object is dropped — `command` is a member of the
    // decorator object, not a reference to a same-named local function.
    // The decorator object and any decorator arguments are real
    // references and are kept. (Multi-line decorators only guard their
    // first line — a known limitation.)
    var decChainPy = new Set();
    if (/^\s*@/.test(rl)) {
      var chainPy = rl.trim().slice(1).match(/^([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)*)/);
      if (chainPy) {
        (chainPy[2].match(/[A-Za-z_]\w*/g) || []).forEach(function (n) { decChainPy.add(n); });
      }
    }
    identifiers(rl).forEach(function (id) {
      if (PY_KEYWORDS.has(id)) return;
      if (declared.has(id)) return;
      if (decChainPy.has(id)) return;
      parsed.references.add(id);
    });
    var callRe2 = /([A-Za-z_]\w*)\s*\(/g;
    var cm3;
    while ((cm3 = callRe2.exec(rl)) !== null) {
      if (PY_KEYWORDS.has(cm3[1])) continue;
      if (declared.has(cm3[1])) continue;
      if (decChainPy.has(cm3[1])) continue;
      parsed.calls.add(cm3[1]);
      if (['getattr', 'importlib', '__import__', 'eval', 'exec'].indexOf(cm3[1]) >= 0) {
        parsed.dynamic = true;
        parsed.dynamicReasons.push('dynamic ' + cm3[1] + '() at line ' + rNo);
      }
    }
    // String annotations: the identifiers inside a string used as a
    // type annotation are real references — `ctx: "Context"`,
    // `def f() -> "list[Buffer]"`, `cast("Context", x)`. This runs on
    // the RAW line (string contents are blanked in the stripped code).
    // The CLI's tree-sitter parser detects annotation positions
    // precisely; here a regex over `:` / `->` / cast( covers the common
    // shapes, and a type-like filter (at least one capitalised
    // identifier) keeps plain string values (`"b"`, `"hello"`) from
    // counting.
    var annRe = /(?:->|:|cast\()\s*["']([^"']+)["']/g;
    var ann;
    while ((ann = annRe.exec(rawLinesPy[ri] || '')) !== null) {
      if (!/[A-Z]/.test(ann[1])) continue;
      var annIds = ann[1].match(/[A-Za-z_]\w*/g) || [];
      annIds.forEach(function (id) {
        if (!PY_KEYWORDS.has(id)) parsed.references.add(id);
      });
    }
    // A TypeAlias value is a type expression: `HookType: TypeAlias =
    // Callable[["Response"], Any]` — "Response" is a forward reference,
    // so the TYPE_CHECKING import of Response is live.
    if (/:\s*TypeAlias\s*=/.test(rawLinesPy[ri] || '')) {
      var taRe = /["']([^"']+)["']/g;
      var ta;
      while ((ta = taRe.exec(rawLinesPy[ri] || '')) !== null) {
        if (!/[A-Z]/.test(ta[1])) continue;
        (ta[1].match(/[A-Za-z_]\w*/g) || []).forEach(function (id) {
          if (!PY_KEYWORDS.has(id)) parsed.references.add(id);
        });
      }
    }
    // %-format placeholders are uses: `"%(complete_func)s" % vars`
    // looks the name up in a mapping at runtime, so a TypedDict field
    // (or a variable) named in a placeholder is live — even in the
    // same file, where the plain string pass does not count. The
    // lookbehind skips `%%(name)s`, an escaped literal percent.
    var phRe = /(?<!%)%\(([A-Za-z_][A-Za-z0-9_]*)\)[sdifr%]/g;
    var ph;
    while ((ph = phRe.exec(rawLinesPy[ri] || '')) !== null) {
      parsed.references.add(ph[1]);
    }
  }
  if (/\bimportlib\b/.test(code)) {
    parsed.dynamic = true;
    parsed.dynamicReasons.push('uses importlib');
  }

  // Unreachable code: statements after return/raise/break/continue at the
  // same indent, until the block dedents.
  var terminatedIndent = null;
  var terminatedLinePy = -1; // line of the return/raise/break/continue
  for (var ui2 = 0; ui2 < lines.length; ui2++) {
    var ul2 = lines[ui2];
    var t2 = ul2.trim();
    if (t2 === '') continue;
    var ind2 = indentOf(ul2);
    if (terminatedIndent !== null && ind2 < terminatedIndent) { terminatedIndent = null; terminatedLinePy = -1; }
    if (terminatedIndent !== null && ind2 === terminatedIndent) {
      // A lone closing bracket belongs to the multi-line return above it.
      if (/^[\]\)}]+$/.test(t2)) continue;
      // Intentional unreachable code, marked `# pragma: no cover`
      // (`yield` after a raise keeps a function a generator): the
      // author knows it never runs, so it is not dead code to delete.
      // The marker sits on the terminating statement or the line above it.
      var checkPragmaPy = function (row) {
        var a = rawLinesPy[row] || '';
        var b = row > 0 ? (rawLinesPy[row - 1] || '') : '';
        return /pragma:\s*no cover/.test(a) || /pragma:\s*no cover/.test(b);
      };
      if (checkPragmaPy(ui2) || checkPragmaPy(terminatedLinePy)) continue;
      // blockLine is the terminating statement's line: every line of one
      // unreachable block shares it, so the findings pass emits one
      // finding per block instead of one per line.
      parsed.unreachable.push({ line: ui2 + 1, blockLine: terminatedLinePy + 1, reason: 'code after return/raise/break/continue', snippet: t2.slice(0, 120) });
      continue;
    }
    if (/^\s*(return|raise|break|continue)\b/.test(ul2)) {
      // Only a complete statement terminates the block: a multi-line
      // `raise X(\n ...\n ) from e` or `return (\n ...\n )` keeps going
      // on the next lines, and the `) from e` / `).rstrip()` line is
      // part of it, not a new unreachable statement (flask cli.py,
      // click, fastapi). A statement is complete when its brackets
      // balance and it does not end with a backslash continuation.
      var depthPy = 0;
      for (var di = 0; di < ul2.length; di++) {
        if (ul2[di] === '(' || ul2[di] === '[' || ul2[di] === '{') depthPy++;
        else if (ul2[di] === ')' || ul2[di] === ']' || ul2[di] === '}') depthPy--;
      }
      if (depthPy <= 0 && !/\\\s*$/.test(ul2)) { terminatedIndent = ind2; terminatedLinePy = ui2; }
    }
  }

  return parsed;
}

/* ------------------------------------------------------------------ */
/* Import resolution                                                   */
/* ------------------------------------------------------------------ */

function resolveFromBase(base, existingFiles) {
  var candidates = [];
  if (/\.[a-z]+$/i.test(base)) candidates.push(base);
  // TypeScript ESM style: source files import `./x.js` but the file on
  // disk is `x.ts` (tsc rewrites the extension at build time). Without
  // this, every `.js`-suffixed import in a TS repo missed its edge and
  // the target's exports looked dead. (Mirrors src/graph.js.)
  if (/\.js$/i.test(base)) {
    ['.ts', '.tsx', '.d.ts', '.mts', '.cts'].forEach(function (ext) { candidates.push(base.slice(0, -3) + ext); });
  }
  JS_EXTS.concat(PY_EXTS).forEach(function (ext) { candidates.push(base + ext); });
  JS_EXTS.concat(PY_EXTS).forEach(function (ext) { candidates.push(joinPosix(base, 'index' + ext)); });
  candidates.push(joinPosix(base, '__init__.py'));
  for (var i = 0; i < candidates.length; i++) {
    if (existingFiles.has(candidates[i])) return candidates[i];
  }
  return null;
}

function resolveJsRelative(fromFile, source, existingFiles) {
  if (!source.startsWith('.')) return null;
  return resolveFromBase(joinPosix(dirOf(fromFile), source), existingFiles);
}

/**
 * tsconfig / jsconfig `paths` aliases (`@/*` -> `./src/*`), the
 * standard Next.js / Vite / monorepo import style. `tsConfigs` is the
 * list of {dir, baseUrl, paths} built from the dropped files' tsconfig /
 * jsconfig files (see analyzeFiles). `extends` is NOT followed yet.
 * (Mirrors src/graph.js.)
 */
function loadTsAliases(textFiles) {
  var out = [];
  textFiles.forEach(function (f) {
    var base = baseOf(f.rel);
    if (base !== 'tsconfig.json' && base !== 'jsconfig.json') return;
    var cfg;
    try { cfg = JSON.parse(f.content); } catch (_) { return; }
    var opts = (cfg && cfg.compilerOptions) || {};
    if (!opts.paths || typeof opts.paths !== 'object') return;
    var dir = dirOf(f.rel);
    var baseUrl = opts.baseUrl ? joinPosix(dir, opts.baseUrl) : dir;
    var paths = [];
    Object.keys(opts.paths).forEach(function (pattern) {
      var targets = opts.paths[pattern];
      if (!Array.isArray(targets)) return;
      var star = pattern.indexOf('*');
      paths.push({
        prefix: star < 0 ? pattern : pattern.slice(0, star),
        suffix: star < 0 ? '' : pattern.slice(star + 1),
        hasStar: star >= 0,
        targets: targets.filter(function (t) { return typeof t === 'string'; }),
      });
    });
    if (paths.length) out.push({ dir: dir, baseUrl: baseUrl, paths: paths });
  });
  return out;
}

function resolveAlias(fromFile, source, aliases, existingFiles) {
  // Nearest config to the importing file wins. A root tsconfig has
  // dir '' and matches every file.
  var best = null;
  aliases.forEach(function (a) {
    if (a.dir === '' || fromFile === a.dir || fromFile.indexOf(a.dir + '/') === 0) {
      if (!best || a.dir.length > best.dir.length) best = a;
    }
  });
  if (!best) return null;
  for (var i = 0; i < best.paths.length; i++) {
    var p = best.paths[i];
    var rest = null;
    if (p.hasStar) {
      if (source.indexOf(p.prefix) !== 0 || source.slice(-p.suffix.length) !== p.suffix) continue;
      rest = source.slice(p.prefix.length, source.length - p.suffix.length);
    } else if (source === p.prefix) {
      rest = '';
    } else continue;
    for (var j = 0; j < p.targets.length; j++) {
      var mapped = p.hasStar ? p.targets[j].replace('*', rest) : p.targets[j];
      var target = resolveFromBase(joinPosix(best.baseUrl, mapped), existingFiles);
      if (target) return target;
    }
  }
  return null;
}

function pyModuleFile(dirPath, existingFiles) {
  var cands = [dirPath + '.py', joinPosix(dirPath, '__init__.py')];
  for (var i = 0; i < cands.length; i++) {
    if (existingFiles.has(cands[i])) return cands[i];
  }
  return null;
}

function resolvePyModule(fromFile, source, existingFiles) {
  var parts = source.split('.');
  var dirs = [dirOf(fromFile), ''];
  for (var d = 0; d < dirs.length; d++) {
    var base = dirs[d] ? joinPosix(dirs[d], parts.join('/')) : parts.join('/');
    var f = pyModuleFile(base, existingFiles);
    if (f) return f;
  }
  return null;
}

/**
 * Python relative import, mirroring the CLI: `from . import x`,
 * `from ..pkg import y`. Returns [{target, names}] — one edge per module
 * the import actually binds.
 */
function resolvePyRelative(fromFile, source, names, level, existingFiles, files) {
  var base = dirOf(fromFile);
  for (var i = 1; i < level; i++) base = dirOf(base);
  function defines(file, name) {
    var info = files[file];
    return Boolean(info && info.parsed && info.parsed.definitions.some(function (d) { return d.name === name; }));
  }
  var byTarget = Object.create(null);
  function addEdge(target, edgeNames) {
    if (!target) return;
    if (!byTarget[target]) byTarget[target] = [];
    edgeNames.forEach(function (n) {
      if (!byTarget[target].some(function (x) { return x.imported === n.imported && x.local === n.local; })) byTarget[target].push(n);
    });
  }
  if (source) {
    var modPath = base ? joinPosix(base, source.split('.').join('/')) : source.split('.').join('/');
    var modFile = pyModuleFile(modPath, existingFiles);
    if (modFile) {
      addEdge(modFile, names);
      (names || []).forEach(function (n) {
        if (n.imported === '*') return;
        if (defines(modFile, n.imported)) return;
        addEdge(pyModuleFile(joinPosix(modPath, n.imported), existingFiles), [n]);
      });
    }
  } else {
    var init = joinPosix(base, '__init__.py');
    (names || []).forEach(function (n) {
      if (n.imported === '*') { if (existingFiles.has(init)) addEdge(init, [n]); return; }
      if (existingFiles.has(init) && defines(init, n.imported)) { addEdge(init, [n]); return; }
      var sub = pyModuleFile(joinPosix(base, n.imported), existingFiles);
      if (sub) addEdge(sub, [n]);
      else if (existingFiles.has(init)) addEdge(init, [n]);
    });
  }
  return Object.keys(byTarget).map(function (t) { return { target: t, names: byTarget[t] }; });
}

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

function packageJsonEntries(pkg, pkgDir) {
  var out = Object.create(null);
  if (!pkg) return out;
  function add(v) {
    if (typeof v !== 'string') return;
    out[joinPosix(pkgDir, v)] = 'package.json entry point';
  }
  add(pkg.main); add(pkg.module); add(pkg.types);
  if (pkg.bin) {
    if (typeof pkg.bin === 'string') add(pkg.bin);
    else Object.keys(pkg.bin).forEach(function (k) { add(pkg.bin[k]); });
  }
  if (pkg.exports) {
    (function collect(v) {
      if (typeof v === 'string') add(v);
      else if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { collect(v[k]); });
    })(pkg.exports);
  }
  return out;
}

function looksLikeEntry(rel, abs, pkgEntries, raw) {
  if (pkgEntries[rel]) return { entry: true, reason: pkgEntries[rel] };
  var base = stemOf(rel);
  if (ENTRY_BASENAMES.has(base)) return { entry: true, reason: 'entry basename "' + base + '"' };
  for (var i = 0; i < ENTRY_PATTERNS.length; i++) {
    if (ENTRY_PATTERNS[i].test(rel)) return { entry: true, reason: 'matches entry pattern ' + ENTRY_PATTERNS[i] };
  }
  if (raw.slice(0, 200).indexOf('#!') === 0) return { entry: true, reason: 'has a shebang (CLI script)' };
  if (/__name__\s*==\s*['"]__main__['"]/.test(raw)) return { entry: true, reason: 'runnable script (if __name__ == "__main__")' };
  if (/require\.main\s*===\s*module/.test(raw)) return { entry: true, reason: 'runnable script (require.main === module)' };
  return { entry: false, reason: '' };
}

/* ------------------------------------------------------------------ */
/* Main analysis                                                       */
/* ------------------------------------------------------------------ */

function analyzeFiles(inputFiles, options) {
  options = options || {};
  // The same file must never be scanned twice: a duplicated input (the
  // browser drag-and-drop path can hand the same file twice) used to
  // duplicate every finding for it.
  var seenPaths = new Set();
  var deduped = [];
  (inputFiles || []).forEach(function (f) {
    if (!f || typeof f.path !== 'string') return;
    var rel0 = f.path.replace(/^\.\//, '').replace(/\\/g, '/');
    if (seenPaths.has(rel0)) return;
    seenPaths.add(rel0);
    deduped.push(f);
  });
  inputFiles = deduped;
  var files = Object.create(null); // rel path -> {rel, language, parsed, raw, size}
  var existingFiles = new Set();
  var textFiles = []; // {rel, content} for the string-reference pass
  var pkg = null;
  var pkgDir = '';

  inputFiles.forEach(function (f) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') return;
    var rel = f.path.replace(/^\.\//, '').replace(/\\/g, '/');
    var parts = rel.split('/');
    if (parts.some(function (p) { return SKIP_DIRS.has(p); })) return;
    if (!options.includeFixtures && parts.some(function (p) { return FIXTURE_DIRS.has(p); })) return;
    if (SKIP_FILES.has(baseOf(rel))) return;
    textFiles.push({ rel: rel, content: f.content });
    if (baseOf(rel) === 'package.json' && !pkg) {
      try { pkg = JSON.parse(f.content); pkgDir = dirOf(rel); } catch (_) { pkg = null; }
    }
    var ext = extOf(rel);
    if (JS_EXTS.indexOf(ext) < 0 && PY_EXTS.indexOf(ext) < 0) return;
    existingFiles.add(rel);
    var parsed = null;
    try {
      parsed = ext === '.py' ? parsePy(rel, f.content) : parseJs(rel, f.content);
    } catch (_) { parsed = null; }
    files[rel] = { rel: rel, language: ext === '.py' ? 'py' : 'js', parsed: parsed, raw: f.content, size: f.content.length, parseError: parsed ? null : 'parse failed' };
  });

  var pkgEntries = packageJsonEntries(pkg, pkgDir);
  // Published-library detection (matches the CLI's fileKind): a repo
  // with a package.json that has `exports` (and is not private), or a
  // pyproject.toml / setup.py / setup.cfg with a project name, is a
  // published library — its unimported files are public surface, so a
  // dead file is REVIEW, never SAFE.
  var isLibrary = false;
  textFiles.forEach(function (f) {
    var base = baseOf(f.rel);
    if (base === 'package.json') {
      try {
        var p = JSON.parse(f.content);
        if (p && p.exports && !p.private) isLibrary = true;
      } catch (_) {}
    } else if (base === 'pyproject.toml') {
      if (/\[project\]/.test(f.content) && /^\s*name\s*=/m.test(f.content)) isLibrary = true;
    } else if (base === 'setup.py' || base === 'setup.cfg') {
      isLibrary = true;
    }
  });
  var entries = Object.create(null); // rel -> reason
  Object.keys(files).forEach(function (rel) {
    var info = files[rel];
    var e = looksLikeEntry(rel, rel, pkgEntries, info.raw);
    if (e.entry) entries[rel] = e.reason;
  });

  // tsconfig / jsconfig `paths` aliases (`@/*` -> `./src/*`): without
  // these, every `@/lib/...` import misses its edge and the target's
  // exports look dead (umami's dominant false-positive family).
  var tsAliases = loadTsAliases(textFiles);

  // Import edges.
  var importers = Object.create(null); // target rel -> Set of importer rels
  var importsByFile = Object.create(null); // rel -> [{target, source, names}]
  function addImporter(target, importer) {
    if (!importers[target]) importers[target] = new Set();
    importers[target].add(importer);
  }
  Object.keys(files).forEach(function (rel) {
    var info = files[rel];
    var edges = [];
    if (!info.parsed) { importsByFile[rel] = edges; return; }
    info.parsed.imports.forEach(function (imp) {
      if (imp.allExport) return;
      if (imp.fromImport && imp.relative) {
        resolvePyRelative(rel, imp.source, imp.names, imp.level || 1, existingFiles, files).forEach(function (t) {
          edges.push({ target: t.target, source: imp.source, names: t.names });
          addImporter(t.target, rel);
        });
        return;
      }
      var target = null;
      if (imp.source && imp.source.charAt(0) === '.') {
        target = resolveJsRelative(rel, imp.source, existingFiles);
      } else if (info.language !== 'py' && imp.source) {
        // tsconfig/jsconfig `paths` aliases (`@/lib/...`): the standard
        // Next.js / Vite / monorepo import style. A bare specifier that
        // is not an alias is an external dependency.
        target = resolveAlias(rel, imp.source, tsAliases, existingFiles);
      } else if (info.language === 'py' && imp.source) {
        target = resolvePyModule(rel, imp.source, existingFiles);
        if (target && imp.fromImport) {
          // `from pkg import sub` binds the submodule pkg/sub, unless the
          // package defines the name itself.
          var targetInfo = files[target];
          var defined = new Set((targetInfo && targetInfo.parsed ? targetInfo.parsed.definitions : []).map(function (d) { return d.name; }));
          var targetDir = dirOf(target);
          (imp.names || []).forEach(function (n) {
            if (n.imported === '*' || defined.has(n.imported)) return;
            var sub = pyModuleFile(joinPosix(targetDir, n.imported), existingFiles);
            if (sub && sub !== target) {
              edges.push({ target: sub, source: imp.source, names: [n] });
              addImporter(sub, rel);
            }
          });
        }
      }
      if (target) {
        edges.push({ target: target, source: imp.source, names: imp.names });
        addImporter(target, rel);
      }
    });
    importsByFile[rel] = edges;
  });

  // Reachability from entry points.
  var reachable = new Set(Object.keys(entries));
  var queue = Object.keys(entries);
  while (queue.length) {
    var cur = queue.pop();
    (importsByFile[cur] || []).forEach(function (e) {
      if (!reachable.has(e.target)) { reachable.add(e.target); queue.push(e.target); }
    });
  }

  // Repo-wide string index. A mention only counts when it looks like a
  // real dynamic reference, not prose — same rule as the CLI (src/graph.js):
  // code files are searched inside string literals only, and only when
  // the name is the whole string or delimited by code characters
  // ('handlers.named' counts, 'a named export is nice' does not).
  // Prose files (.md, .txt) never execute, so they never count. Config /
  // template files (.json, .yaml, .html, ...) keep the raw-text match.
  var PROSE_EXTS = { '.md': true, '.txt': true };
  var RAW_MATCH_EXTS = { '.json': true, '.yaml': true, '.yml': true, '.toml': true, '.html': true, '.vue': true, '.css': true };
  // Boundary-aware regex for a name that may start with a non-word char
  // (a scoped dependency: @scope/pkg). Plain \b fails before '@', so a
  // scoped name could never match at all. For names that start and end
  // with a word char this builds exactly \b...\b, so symbol matching is
  // unchanged. The leading boundary may consume one char; callers that
  // need exact positions must account for m[0].length - name.length.
  function mentionRegExp(name, flags) {
    var esc = escapeRegExp(name);
    var start = /^[A-Za-z0-9_]/.test(name) ? '\\b' : '(?:^|[^A-Za-z0-9_])';
    var end = /[A-Za-z0-9_]$/.test(name) ? '\\b' : '(?![A-Za-z0-9_])';
    return new RegExp(start + esc + end, flags);
  }
  function codeLikeStringMention(literal, name) {
    var re = mentionRegExp(name, 'g');
    var m;
    while ((m = re.exec(literal)) !== null) {
      // The leading boundary may have consumed one char (scoped names
      // like @scope/pkg); the name itself starts after it.
      var start = m.index + (m[0].length - name.length);
      var afterIdx = start + name.length;
      var before = start === 0 ? '' : literal[start - 1];
      var after = afterIdx >= literal.length ? '' : literal[afterIdx];
      var beforeOk = before === '' || !/\s/.test(before);
      var afterOk = after === '' || !/\s/.test(after);
      if (beforeOk && afterOk) return true;
    }
    return false;
  }
  // Null-prototype cache: symbol names come from user code, so a plain {}
  // would return inherited members for names like "constructor" or
  // "toString" (e.g. stringCache["constructor"] === Object) and crash the
  // .forEach call below with "stringHits.forEach is not a function".
  // The CLI uses a Map for the same cache and never had this bug.
  var stringCache = Object.create(null);
  // Inverted string index, built once per scan (lazily, on first use) —
  // mirrors src/graph.js. The old filesMentioning scanned every text
  // file per symbol — O(symbols x files) — which collapsed throughput
  // on large repos (fastapi: 236s web vs 12.9s CLI). The index maps
  // each code-like token to the files mentioning it, so a lookup is a
  // hash hit, not a scan. Tokenisation mirrors codeLikeStringMention:
  // in code files a token only counts when it sits in code (delimited
  // by non-space characters), so words inside sentences do not count;
  // in raw config files any whole-word token counts, matching the old
  // raw-text regex. The index itself is a null-prototype object for
  // the same reason as stringCache above: token keys are untrusted
  // symbol names, so a plain {} would return inherited members for
  // tokens like "constructor" or "toString".
  var stringIndex = null; // Object.create(null): token -> Set of rels | null
  function buildStringIndex() {
    var index = Object.create(null);
    function addToken(token, rel) {
      if (!index[token]) index[token] = new Set();
      index[token].add(rel);
    }
    function addLiteral(literal, rel, codeLike) {
      var re = /[A-Za-z_][A-Za-z0-9_]*/g;
      var m;
      while ((m = re.exec(literal)) !== null) {
        // A token must not start in the middle of a number: `%5c` in a
        // URL is not a reference to `c`, and `%70age` is not a reference
        // to `age` — \b in the old per-name scan agrees (a digit before
        // the name breaks the word boundary). The token regex can only
        // start a match right after a digit (a letter or `_` before it
        // would have been consumed into the token itself), so a digit
        // guard is the whole fix.
        if (m.index > 0 && /[0-9]/.test(literal[m.index - 1])) continue;
        if (codeLike) {
          var before = m.index === 0 ? '' : literal[m.index - 1];
          var after = m.index + m[0].length >= literal.length ? '' : literal[m.index + m[0].length];
          if ((before !== '' && /\s/.test(before)) || (after !== '' && /\s/.test(after))) continue;
        }
        addToken(m[0], rel);
      }
    }
    textFiles.forEach(function (f) {
      var ext = extOf(f.rel);
      if (PROSE_EXTS[ext]) return; // prose never executes
      var info = files[f.rel];
      if (info && (JS_EXTS.indexOf(ext) >= 0 || PY_EXTS.indexOf(ext) >= 0)) {
        if (info.parsed) {
          (info.parsed.strings || []).forEach(function (s) { addLiteral(s, f.rel, true); });
          return;
        }
        // Unparseable code file: fall back to a raw-text match rather
        // than risk hiding a real reference.
      } else if (!RAW_MATCH_EXTS[ext]) {
        return; // unknown text extension — do not guess
      }
      addLiteral(f.content, f.rel, false);
    });
    stringIndex = index;
  }
  // The old per-name scan, kept for names the index cannot answer
  // (scoped / hyphenated / dotted names with non-word characters).
  function scanFilesMentioning(name) {
    var re = mentionRegExp(name);
    var hits = new Set();
    textFiles.forEach(function (f) {
      var ext = extOf(f.rel);
      if (PROSE_EXTS[ext]) return; // prose never executes
      var info = files[f.rel];
      if (info && (JS_EXTS.indexOf(ext) >= 0 || PY_EXTS.indexOf(ext) >= 0)) {
        if (info.parsed && info.parsed.strings) {
          // String literals only — comments and sentences in docstrings
          // do not count; see codeLikeStringMention.
          if (info.parsed.strings.some(function (s) { return codeLikeStringMention(s, name); })) hits.add(f.rel);
          return;
        }
        // Unparseable code file: fall back to a raw-text match rather
        // than risk hiding a real reference.
      } else if (!RAW_MATCH_EXTS[ext]) {
        return; // unknown text extension — do not guess
      }
      try { if (re.test(f.content)) hits.add(f.rel); } catch (_) {}
    });
    return hits;
  }
  function filesMentioning(name) {
    if (stringCache[name]) return stringCache[name];
    var hits;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      if (!stringIndex) buildStringIndex();
      hits = stringIndex[name] || new Set();
    } else {
      hits = scanFilesMentioning(name);
    }
    stringCache[name] = hits;
    return hits;
  }

  // Per-symbol usage.
  var symbolUsage = Object.create(null); // file -> {name -> {importedBy:Set, calledIn:Set, sameFile:bool}}
  Object.keys(files).forEach(function (rel) {
    var info = files[rel];
    var map = Object.create(null);
    if (info.parsed) {
      info.parsed.definitions.forEach(function (d) {
        map[d.name] = { importedBy: new Set(), calledIn: new Set(), sameFile: false };
      });
    }
    symbolUsage[rel] = map;
  });
  Object.keys(files).forEach(function (rel) {
    var info = files[rel];
    if (!info.parsed) return;
    var map = symbolUsage[rel];
    info.parsed.references.forEach(function (ref) {
      if (map[ref]) map[ref].sameFile = true;
    });
    info.parsed.calls.forEach(function (call) {
      if (map[call]) map[call].calledIn.add(rel);
    });
  });
  Object.keys(importsByFile).forEach(function (rel) {
    var importerInfo = files[rel];
    if (!importerInfo || !importerInfo.parsed) return;
    importsByFile[rel].forEach(function (e) {
      var targetMap = symbolUsage[e.target];
      if (!targetMap) return;
      (e.names || []).forEach(function (n) {
        if (n.kind === 'namespace') {
          Object.keys(targetMap).forEach(function (k) { targetMap[k].importedBy.add(rel); });
        } else if (targetMap[n.imported]) {
          targetMap[n.imported].importedBy.add(rel);
        } else if (n.imported === 'default') {
          Object.keys(targetMap).forEach(function (k) {
            var def = files[e.target].parsed.definitions.find(function (d) { return d.name === k; });
            if (def && def.isDefault) targetMap[k].importedBy.add(rel);
          });
        }
      });
      // Member use: require('./x').fn() or utils.fn() from an importer.
      Object.keys(targetMap).forEach(function (name) {
        if (importerInfo.parsed.references.has(name)) targetMap[name].importedBy.add(rel);
      });
      // Re-exported modules: an importer that reaches a package through
      // its __init__ (`import typer`, `from typer import colors`) and
      // then uses `typer.colors.RED` touches colors.py's RED, even
      // though the import edge points at __init__.py, not colors.py.
      // (Mirrors the CLI's reExports map in src/graph.js.)
      if (baseOf(e.target) === '__init__.py') {
        var initInfo = files[e.target];
        var initEdges = importsByFile[e.target] || [];
        if (initInfo && initInfo.parsed) {
          initInfo.parsed.imports.forEach(function (rimp) {
            if (!rimp.reExport) return;
            (rimp.names || []).forEach(function (rn) {
              var modName = rn.local || rn.imported;
              if (!modName) return;
              var reachesModule = (e.names || []).some(function (n) { return n.imported === modName || n.local === modName; })
                || importerInfo.parsed.references.has(modName);
              if (!reachesModule) return;
              initEdges.forEach(function (ie) {
                if (!(ie.names || []).some(function (n) { return n.local === modName || n.imported === modName; })) return;
                var subMap = symbolUsage[ie.target];
                if (!subMap) return;
                Object.keys(subMap).forEach(function (name) {
                  if (importerInfo.parsed.references.has(name)) subMap[name].importedBy.add(rel);
                });
              });
            });
          });
        }
      }
      // Constructor calls across files: `new Client()` in an importer
      // that imports Client from another file calls that file's
      // `constructor` method. Same-file construction is already covered
      // by the same-file calls pass above.
      if (importerInfo.parsed.constructed) {
        importerInfo.parsed.constructed.forEach(function (cls) {
          if ((e.names || []).some(function (n) { return n.local === cls || n.imported === cls; })) {
            if (targetMap['constructor']) targetMap['constructor'].calledIn.add(rel);
          }
        });
      }
    });
  });

  // --- classic scripts and global-scope calls (Django admin JS) ---
  // A classic (non-module) script has no module syntax: `module.exports`
  // counts even when it binds no names (`module.exports = {}`), and so
  // does `export {}`, so the flag comes from the parser, not from the
  // import/export lists. Top-level declarations of a classic script are
  // globals of the page they load on — callable by bare name from any
  // other script loaded with them. A bare-name call in one classic
  // script resolves to the global definition of that name when exactly
  // one top-level definition of it exists repo-wide: the calling file
  // neither defines nor imports the name (a local binding would win),
  // and the definition sits in another classic script. Names defined
  // more than once are ambiguous and resolve to nothing; a global with
  // no in-repo caller is still graded on its own evidence (a plain
  // script's unreferenced function is SAFE — a classic script is not a
  // free pass, only its observed cross-script calls are).
  // Calls only, not bare references: a member access (`obj.foo()`)
  // records the same base name as a global call, and a bare reference
  // is not a call. Mirrors src/graph.js in the CLI.
  var classicScripts = new Set();
  Object.keys(files).forEach(function (rel) {
    var info = files[rel];
    if (info.language !== 'js' || !info.parsed) return;
    if (!info.parsed.hasModuleSyntax) classicScripts.add(rel);
  });
  var globalDefs = Object.create(null); // name -> rel of the unique global definition
  (function () {
    var defCounts = Object.create(null); // name -> top-level runtime defs with that name
    var classicDefFile = Object.create(null); // name -> rel, when a classic script defines it
    Object.keys(files).forEach(function (rel) {
      var info = files[rel];
      if (info.language !== 'js' || !info.parsed) return;
      info.parsed.definitions.forEach(function (d) {
        if (d.kind === 'method' || d.kind === 'type') return;
        defCounts[d.name] = (defCounts[d.name] || 0) + 1;
        if (classicScripts.has(rel) && !classicDefFile[d.name]) classicDefFile[d.name] = rel;
      });
    });
    Object.keys(classicDefFile).forEach(function (name) {
      if (defCounts[name] === 1) globalDefs[name] = classicDefFile[name];
    });
  })();
  Object.keys(files).forEach(function (rel) {
    if (!classicScripts.has(rel)) return;
    var info = files[rel];
    if (!info.parsed) return;
    var definedHere = new Set();
    info.parsed.definitions.forEach(function (d) {
      if (d.kind !== 'method' && d.kind !== 'type') definedHere.add(d.name);
    });
    var importedHere = new Set();
    info.parsed.imports.forEach(function (imp) {
      (imp.names || []).forEach(function (n) { importedHere.add(n.local); });
    });
    info.parsed.calls.forEach(function (name) {
      if (definedHere.has(name) || importedHere.has(name)) return;
      var defFile = globalDefs[name];
      if (!defFile || defFile === rel) return;
      var map = symbolUsage[defFile];
      var u = map && map[name];
      if (u) u.calledIn.add(rel);
    });
  });

  // Grading, mirroring the CLI confidence engine.
  var findings = [];
  var seenFindings = new Set();
  // One finding per key: the same name can be defined many times in one
  // file (Django's 114 `Meta` classes, 52 `http_options` variables),
  // and each definition used to emit its own finding. Unreachable
  // findings dedupe per block instead (see blockLine): a hoisted-
  // function block after a return fires once per line without this.
  var seenKeys = new Set();
  function add(f) {
    f.id = f.category + ':' + f.file + ':' + (f.symbol || '') + ':' + (f.startLine || 0);
    // The same finding must never repeat: a symbol can be reached by
    // several passes (file loop, symbol loop, dependency loop), and a
    // duplicated finding used to repeat up to 444x on real repos.
    if (seenFindings.has(f.id)) return null;
    seenFindings.add(f.id);
    var key = f.category === 'unreachable'
      ? 'unreachable:' + f.file + ':' + (f.blockLine || f.startLine || 0)
      : f.category + ':' + f.file + ':' + (f.symbol || '');
    if (seenKeys.has(key)) return null;
    seenKeys.add(key);
    findings.push(f);
    return f;
  }

  Object.keys(files).forEach(function (rel) {
    var info = files[rel];
    if (!info.parsed) return; // never flag what we could not parse
    var parsed = info.parsed;
    var isEntry = Boolean(entries[rel]);
    var isTest = TEST_FILE.test(rel) || TEST_DIR.test(rel);
    var isConfig = CONFIG_FILE.test(rel);
    var isRouteFile = ROUTE_DIR.test(rel);
    var keepFile = isEntry || isTest || isConfig || isRouteFile;
    var keepSymbols = isTest || isConfig || isRouteFile;
    var importerCount = (importers[rel] || new Set()).size;

    // Dead file.
    if (!reachable.has(rel) && importerCount === 0) {
      if (keepFile) {
        add({
          category: 'file', file: rel, symbol: null, grade: 'KEEP',
          startLine: 1, endLine: null, size: info.size,
          reason: isEntry ? 'entry point: ' + (entries[rel] || '') : isTest ? 'test file' : isConfig ? 'config file' : 'framework route file',
          evidence: { importers: 0, reachable: false, stringRefs: [] },
        });
      } else {
        var stringRefs = [];
        var baseHits = filesMentioning(stemOf(rel));
        baseHits.forEach(function (f) { if (f !== rel) stringRefs.push(f); });
        parsed.definitions.forEach(function (d) {
          filesMentioning(d.name).forEach(function (f) {
            if (f !== rel && stringRefs.indexOf(f) < 0) stringRefs.push(f);
          });
        });
        if (stringRefs.length > 0) {
          add({
            category: 'file', file: rel, symbol: null, grade: 'REVIEW',
            startLine: 1, endLine: null, size: info.size,
            reason: 'no importers, but referenced by name as a string elsewhere',
            evidence: { importers: 0, reachable: false, stringRefs: stringRefs },
          });
        } else if (isLibrary) {
          add({
            category: 'file', file: rel, symbol: null, grade: 'REVIEW',
            startLine: 1, endLine: null, size: info.size,
            reason: 'no importers, but this is a published library — public surface, review before deleting',
            evidence: { importers: 0, reachable: false, stringRefs: [] },
          });
        } else {
          add({
            category: 'file', file: rel, symbol: null, grade: 'SAFE',
            startLine: 1, endLine: null, size: info.size,
            reason: 'no importers, not an entry point, not referenced by name anywhere',
            evidence: { importers: 0, reachable: false, stringRefs: [] },
            deleteDiff: 'delete ' + rel + ' (' + info.size + ' bytes)',
          });
        }
      }
    }

    // Dead symbols.
    var usageMap = symbolUsage[rel] || Object.create(null);
    // Names with at least one @overload-decorated definition form an
    // overload group: the stubs are type information and the
    // implementation is invoked through the overloaded name.
    var overloadedNames = new Set();
    parsed.definitions.forEach(function (d) {
      (d.decorators || []).forEach(function (dec) {
        if (/(^|[@.])overload\b/.test(dec)) overloadedNames.add(d.name);
      });
    });
    var importLocals = new Set();
    parsed.imports.forEach(function (imp) {
      (imp.names || []).forEach(function (n) { importLocals.add(n.local); });
    });
    var categoryOf = function (kind) {
      return { 'function': 'function', 'class': 'class', type: 'type', variable: 'variable', method: 'method' }[kind] || 'function';
    };
    parsed.definitions.forEach(function (def) {
      if (importLocals.has(def.name)) return;
      if (def.kind === 'method' && /^__.*__$/.test(def.name)) {
        add({
          category: 'method', file: rel, symbol: def.name, grade: 'KEEP',
          startLine: def.startLine, endLine: def.endLine, size: 0,
          reason: 'dunder / protocol method ' + def.name,
          evidence: { importers: 0, callers: 0, stringRefs: [], exported: false },
        });
        return;
      }
      var usage = usageMap[def.name] || { importedBy: new Set(), calledIn: new Set(), sameFile: false };
      var importedBy = Array.from(usage.importedBy);
      var sameFileUse = usage.sameFile || usage.calledIn.has(rel);
      // Same-file use is real use: a symbol called or referenced in its
      // own file is alive, full stop — never a finding. (It used to be
      // flagged REVIEW as "unexport-to-local", which turned every
      // module's own helpers into noise.)
      if (importedBy.length === 0 && sameFileUse) {
        return;
      }
      if (importedBy.length > 0) return;
      // A method called anywhere in-repo is alive. Cross-file method
      // calls do not count as imports, so they need this branch — the
      // same-file check above only covers calls from the defining file,
      // and without it a constructor called via `new Client()` from an
      // importer was still REVIEW.
      if (def.kind === 'method' && usage.calledIn.size > 0) {
        return;
      }
      // A call from another file is a real caller too: the classic-script
      // global pass above records bare-name calls from other classic
      // scripts against the unique repo-wide definition (Django admin
      // JS), so a definition with any cross-file caller is live. The
      // same-file case already returned above, so reaching here with a
      // non-empty calledIn means the caller is in another file.
      if (usage.calledIn.size > 0) {
        return;
      }

      var stringHits = filesMentioning(def.name);
      var stringElsewhere = [];
      stringHits.forEach(function (f) { if (f !== rel) stringElsewhere.push(f); });
      var common = {
        category: categoryOf(def.kind), file: rel, symbol: def.name, grade: 'REVIEW',
        startLine: def.startLine, endLine: def.endLine, size: 0,
        evidence: {
          importers: importedBy.length, callers: 0,
          stringRefs: stringElsewhere, exported: def.exported,
        },
      };
      // Framework keeps.
      if (FRAMEWORK_KEEP_EXPORTS.has(def.name)) {
        add(Object.assign({}, common, { grade: 'KEEP', reason: 'framework-resolved export "' + def.name + '"' }));
        return;
      }
      // Pydantic / dataclass model fields are populated by the framework
      // from external data, never read by attribute in-repo.
      if (def.frameworkField) {
        add(Object.assign({}, common, { grade: 'KEEP', reason: 'Pydantic/dataclass model field — populated by the framework, never read by attribute in-repo' }));
        return;
      }
      // `declare module` / `declare global` augmentation is declaration
      // merging: the declaration IS the use.
      if (def.ambient) {
        add(Object.assign({}, common, { grade: 'KEEP', reason: 'declare module/global augmentation — declaration merging, the declaration IS the use' }));
        return;
      }
      // An @overload group: the stubs are type information and the
      // implementation is invoked through the overloaded name.
      if (overloadedNames.has(def.name)) {
        add(Object.assign({}, common, { grade: 'KEEP', reason: '@overload group — stubs are type information and the implementation is invoked through the overloaded name' }));
        return;
      }
      // `__unittest = True` in a module tells unittest to trim that
      // module's frames from tracebacks: the test runner reads the
      // module attribute, so it is never dead code (Django's
      // contrib/messages/test.py sets it for its test-mixin module).
      if (def.name === '__unittest') {
        add(Object.assign({}, common, { grade: 'KEEP', reason: '__unittest module attribute — unittest trims this module\'s frames from tracebacks, the runner reads it' }));
        return;
      }
      // Next.js middleware / proxy exports are framework-resolved, but
      // only in middleware.ts / proxy.ts files — a `config` or
      // `middleware` export elsewhere is ordinary code.
      if ((def.name === 'middleware' || def.name === 'config') &&
          (/middleware\.(js|jsx|ts|tsx)$/.test(rel) || /proxy\.(js|jsx|ts|tsx)$/.test(rel))) {
        add(Object.assign({}, common, { grade: 'KEEP', reason: 'Next.js middleware/proxy export "' + def.name + '"' }));
        return;
      }
      if ((def.decorators || []).some(function (d) {
        return FRAMEWORK_KEEP_DECORATORS.some(function (kd) { return d.indexOf(kd) >= 0; });
      })) {
        add(Object.assign({}, common, { grade: 'KEEP', reason: 'framework decorator on ' + def.name }));
        return;
      }
      if (parsed.dunder && parsed.dunder.has(def.name)) {
        add(Object.assign({}, common, { grade: 'KEEP', reason: 'dunder / protocol method ' + def.name }));
        return;
      }
      if (keepSymbols) {
        add(Object.assign({}, common, { grade: 'KEEP', reason: isTest ? 'in a test file' : isConfig ? 'in a config file' : 'in a framework route file' }));
        return;
      }
      if (parsed.dynamic) {
        add(Object.assign({}, common, { grade: 'REVIEW', reason: '0 callers, but file uses dynamic imports/reflection (' + (parsed.dynamicReasons[0] || 'dynamic') + ') — cannot prove safe' }));
        return;
      }
      if (stringElsewhere.length > 0) {
        add(Object.assign({}, common, { grade: 'REVIEW', reason: '0 callers, but referenced by name as a string elsewhere' }));
        return;
      }
      if (def.exported) {
        add(Object.assign({}, common, { grade: 'REVIEW', reason: 'exported but never imported by any file in the repo' }));
        return;
      }
      if (def.kind === 'method') {
        add(Object.assign({}, common, { grade: 'REVIEW', reason: 'method with 0 in-repo callers — could be called via an object or framework' }));
        return;
      }
      add(Object.assign({}, common, { grade: 'SAFE', reason: 'unexported, 0 callers, 0 references, 0 string mentions' }));
    });

    // Dead imports.
    // A name the file ALSO defines at top level is a conditional
    // definition, not a dead import: `if PY313: from copy import
    // replace / else: def replace(...)` (Django's utils/copy.py)
    // provides the same public name under every version, and the import
    // IS the public API on the branch where it runs. Deleting the
    // import would remove the name on that branch. An unconditional
    // shadowing (`from x import y` then a later `def y()`) looks the
    // same and is missed instead — a false negative, never a false SAFE.
    var topLevelDefNames = new Set();
    var fileLines = info.raw.split('\n');
    parsed.definitions.forEach(function (d) {
      // A `const foo = require('./foo')` binding is the import itself,
      // not a second definition of the name: the definition sits on the
      // require line, so it must not shield the import. A genuine
      // shadowing definition (`def replace` under `else:` in Django's
      // utils/copy.py) sits on its own line.
      var defLine = fileLines[d.startLine - 1] || '';
      if (/require\s*\(/.test(defLine) || /^\s*import\b/.test(defLine)) return;
      topLevelDefNames.add(d.name);
    });
    parsed.imports.forEach(function (imp) {
      if (imp.sideEffect || imp.reExport || imp.allExport) return;
      (imp.names || []).forEach(function (n) {
        if (n.kind === 'namespace') return;
        if (topLevelDefNames.has(n.local)) return; // conditional definition of the same name
        if (!parsed.references.has(n.local) && !parsed.calls.has(n.local)) {
          // For a plain `import a, b` the record's source is only the
          // first module — use the name's own module (n.full) so the
          // reason names the real source.
          var fromSource = imp.fromImport ? imp.source : (n.full || imp.source);
          // Import-as-probe (FP-13, mirrors src/confidence.js): an
          // unused import inside try/except exists to test whether the
          // dependency is installed (Django's `try: import numpy`
          // flag, `try: from PIL import Image`); the import IS the
          // use. REVIEW, never SAFE — a leftover optional import in a
          // try block looks identical, so a human checks.
          var impGrade = isTest ? 'KEEP' : imp.inTryExcept ? 'REVIEW' : 'SAFE';
          add({
            category: 'import', file: rel, symbol: n.local, grade: impGrade,
            startLine: 1, endLine: null, size: 0,
            reason: isTest ? 'unused import in a test file (kept)' : imp.inTryExcept ? 'imported "' + n.imported + '" from "' + fromSource + '" inside try/except but never referenced — the import itself may be the availability probe' : 'imported "' + n.imported + '" from "' + fromSource + '" but never referenced in this file',
            evidence: { importers: 0, callers: 0, stringRefs: [], exported: false },
            deleteDiff: 'remove "' + n.local + '" from import of "' + fromSource + '" in ' + rel,
          });
        }
      });
    });

    // Unreachable code. Test files are KEEP at most: a test's
    // unreachable branch is the test's business, never a SAFE delete.
    (parsed.unreachable || []).forEach(function (u) {
      add({
        category: 'unreachable', file: rel, symbol: null, grade: isTest ? 'KEEP' : 'SAFE',
        startLine: u.line, endLine: u.line, blockLine: u.blockLine, size: u.snippet ? u.snippet.length : 0,
        reason: isTest ? 'unreachable code in a test file (kept)' : u.reason,
        evidence: { importers: 0, callers: 0, stringRefs: [], exported: false },
        deleteDiff: u.snippet || '',
      });
    });
  });

  // Dead dependencies (JS only). A dependency is used when a real
  // import/require names it (exact or subpath: lodash/fp, @scope/pkg/sub),
  // when a package.json script names it, or when a code/config string
  // names it (the strict string-reference pass — prose in a README never
  // counts). The old check scanned every text file for the bare name, so
  // a README mention counted as usage, and a scoped name (@scope/pkg)
  // could never match at all (\b fails before '@').
  if (pkg && pkg.dependencies) {
    Object.keys(pkg.dependencies).forEach(function (dep) {
      var found = false;
      Object.keys(files).forEach(function (rel) {
        if (found) return;
        var info = files[rel];
        if (info.language !== 'js' || !info.parsed) return;
        (info.parsed.imports || []).forEach(function (imp) {
          if (imp.source && (imp.source === dep || imp.source.indexOf(dep + '/') === 0)) found = true;
        });
      });
      // package.json scripts count as usage (but not the dependencies
      // block itself — a dep must not count as used by its own entry).
      if (!found && mentionRegExp(dep).test(JSON.stringify(pkg.scripts || {}))) found = true;
      if (!found) {
        filesMentioning(dep).forEach(function (f) {
          if (baseOf(f) !== 'package.json') found = true;
        });
      }
      if (!found) {
        add({
          category: 'dependency', file: 'package.json', symbol: dep, grade: 'REVIEW',
          startLine: 1, endLine: null, size: 0,
          reason: 'dependency "' + dep + '" is never imported, required, named in a script, or referenced by a code/config string',
          evidence: { importers: 0, callers: 0, stringRefs: [], exported: false },
          deleteDiff: 'npm uninstall ' + dep,
        });
      }
    });
  }

  var summary = { total: findings.length, safe: 0, review: 0, keep: 0, byCategory: {}, filesScanned: Object.keys(files).length };
  findings.forEach(function (f) {
    if (f.grade === 'SAFE') summary.safe++;
    else if (f.grade === 'REVIEW') summary.review++;
    else summary.keep++;
    summary.byCategory[f.category] = (summary.byCategory[f.category] || 0) + 1;
  });

  return {
    findings: findings,
    summary: summary,
    filesScanned: Object.keys(files).length,
    entryPoints: Object.keys(entries),
  };
}

return { analyzeFiles: analyzeFiles, parseJs: parseJs, parsePy: parsePy };

});
