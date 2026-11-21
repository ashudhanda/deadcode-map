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
  'print', 'self', 'cls',
]);

var TEST_FILE = /(\.test\.|\.spec\.|_test\.py$|test_[^/]+\.py$|conftest\.py$)/;
var CONFIG_FILE = /(\.config\.[jt]s|webpack\.config|vite\.config|jest\.config|babel\.config|tailwind\.config|\.d\.ts$)/;
var ENTRY_BASENAMES = new Set([
  'index', 'main', 'app', 'server', 'cli', 'bin', 'entry', 'setup',
  'wsgi', 'asgi', 'manage', '__main__',
]);
var ENTRY_PATTERNS = [
  /(^|\/)(pages|app|routes|views)\//,
  /\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /_test\.py$/, /test_[^/]+\.py$/,
  /\.stories\.[jt]sx?$/,
  /\.config\.[jt]s$/, /\.config\.mjs$/, /\.config\.cjs$/,
  /\/migrations\//, /\/seeds?\//,
  /setup\.py$/, /conftest\.py$/, /\/__init__\.py$/,
  /webpack\.config\./, /vite\.config\./, /rollup\.config\./,
  /tailwind\.config\./, /jest\.config\./, /babel\.config\./,
];
var ROUTE_DIR = /(^|\/)(pages|app|routes|views)\//;
var FRAMEWORK_KEEP_EXPORTS = new Set([
  'default', 'generateStaticParams', 'generateMetadata', 'getStaticProps',
  'getServerSideProps', 'getStaticPaths',
]);
var FRAMEWORK_KEEP_DECORATORS = [
  'app.route', 'app.errorhandler', 'app.before_request', 'app.after_request',
  'blueprint.route', 'pytest.fixture', 'pytest.mark.parametrize', 'pytest.mark.skip',
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

/**
 * Blank out strings and comments, keeping newlines, so structural scans
 * never mistake a string or a comment for code. Template literals keep
 * their ${...} expressions as code.
 */
function stripJs(code) {
  var out = '';
  var i = 0;
  var n = code.length;
  while (i < n) {
    var c = code[i];
    var next = code[i + 1] || '';
    if (c === '/' && next === '/') {
      while (i < n && code[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
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
        ['return', 'typeof', 'case', 'throw', 'in', 'of', 'new', 'delete', 'void', 'yield', 'await'].indexOf(prevWord) >= 0;
      if (regexStart) {
        out += ' '; i++;
        var inClass = false;
        while (i < n) {
          if (code[i] === '\\') { out += '  '; i += 2; continue; }
          if (code[i] === '[') inClass = true;
          else if (code[i] === ']') inClass = false;
          else if (code[i] === '/' && !inClass) break;
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
      out += ' '; i++;
      while (i < n && code[i] !== q) {
        if (code[i] === '\\') { out += '  '; i += 2; continue; }
        out += code[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += ' '; i++; }
    } else if (c === '`') {
      out += ' '; i++;
      while (i < n && code[i] !== '`') {
        if (code[i] === '\\') { out += '  '; i += 2; continue; }
        if (code[i] === '$' && code[i + 1] === '{') {
          // Keep the ${...} expression as code.
          out += '${'; i += 2;
          var depth = 1;
          while (i < n && depth > 0) {
            if (code[i] === '{') depth++;
            else if (code[i] === '}') depth--;
            if (depth > 0) { out += code[i]; i++; }
          }
          if (i < n) { out += '}'; i++; }
          continue;
        }
        out += code[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += ' '; i++; }
    } else {
      out += c; i++;
    }
  }
  return out;
}

function stripPy(code) {
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
        if (end === -1) { res += ' '.repeat(line.length - i); i = line.length; }
        else { res += ' '.repeat(end + 3 - i); i = end + 3; inTriple = null; }
        continue;
      }
      var ch = line[i];
      if (ch === '#') { res += ' '.repeat(line.length - i); break; }
      if (line.slice(i, i + 3) === "'''" || line.slice(i, i + 3) === '"""') {
        inTriple = line.slice(i, i + 3);
        res += '   '; i += 3;
        continue;
      }
      if (ch === "'" || ch === '"') {
        var q = ch;
        res += ' '; i++;
        while (i < line.length && line[i] !== q) {
          if (line[i] === '\\') { res += '  '; i += 2; continue; }
          res += ' '; i++;
        }
        if (i < line.length) { res += ' '; i++; }
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
  var code = stripJs(raw);
  var lines = code.split('\n');
  var parsed = {
    language: 'js', definitions: [], imports: [], references: new Set(),
    calls: new Set(), dynamic: false, dynamicReasons: [], dynamicImports: [],
    unreachable: [], decorators: [], dunder: new Set(),
  };

  var braceDepth = 0;
  var classStack = []; // {name, depth}
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

    // Class declaration.
    m = line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (m) {
      parsed.definitions.push({
        name: m[1], kind: 'class', exported: /^\s*export\b/.test(line),
        startLine: lineNo, endLine: lineNo, decorators: [],
      });
      markDeclared(lineNo, m[1]);
    } else if (classStack.length) {
      // Method inside a class body.
      var mm = line.match(/^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+)*(?:#)?([A-Za-z_$][\w$]*)\s*\(/);
      if (mm && !JS_KEYWORDS.has(mm[1]) && mm[1] !== 'if' && mm[1] !== 'for' && mm[1] !== 'while' && mm[1] !== 'switch' && mm[1] !== 'catch') {
        parsed.definitions.push({
          name: mm[1], kind: 'method', exported: false,
          startLine: lineNo, endLine: lineNo, decorators: [],
        });
        markDeclared(lineNo, mm[1]);
      }
    }

    // Function declaration.
    m = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
    if (m) {
      parsed.definitions.push({
        name: m[1], kind: 'function', exported: /^\s*export\b/.test(line),
        startLine: lineNo, endLine: lineNo, decorators: [],
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
        startLine: lineNo, endLine: lineNo, decorators: [],
      });
      markDeclared(lineNo, m[1]);
    }

    // TypeScript type / interface.
    m = line.match(/^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/);
    if (m) {
      parsed.definitions.push({
        name: m[1], kind: 'type', exported: /^\s*export\b/.test(line),
        startLine: lineNo, endLine: lineNo, decorators: [],
      });
      markDeclared(lineNo, m[1]);
    }

    // Update brace depth, tracking class bodies.
    var opens = (line.match(/\{/g) || []).length;
    var closes = (line.match(/\}/g) || []).length;
    braceDepth += opens - closes;
    if (m && false) { /* placeholder, keeps structure clear */ }
    // Re-detect class start depth: a class line opens a block at depthBefore.
    var cm = line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (cm && opens > 0) classStack.push({ name: cm[1], depth: braceDepth });
    void depthBefore;
  }

  // module.exports / exports.* / export { ... } — mark definitions exported.
  var defByName = {};
  parsed.definitions.forEach(function (d) { defByName[d.name] = d; });
  var me = raw.match(/module\.exports\s*=\s*\{([^}]*)\}/);
  if (me) {
    me[1].split(',').forEach(function (part) {
      var name = part.split(':')[0].trim();
      if (defByName[name]) defByName[name].exported = true;
    });
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
  var ex = raw.match(/export\s*\{([^}]*)\}/);
  if (ex) {
    ex[1].split(',').forEach(function (part) {
      var bits = part.trim().split(/\s+as\s+/);
      var name = bits[bits.length - 1].trim();
      if (defByName[name]) defByName[name].exported = true;
    });
  }

  // Imports, parsed line-by-line from the raw source (the stripped code
  // has no string literals left, so specifiers must come from here).
  // Comment lines are skipped: a comment such as
  // "// import x from '...'" is not an import. Multi-line import
  // statements are accumulated until the `from '...'` clause appears.
  function parseImportStatement(stmt) {
    var im = stmt.match(/import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/);
    if (!im) return null;
    var spec = (im[1] || '').trim();
    var names = [];
    if (spec) {
      var star = spec.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      if (star) names.push({ imported: '*', local: star[1], kind: 'namespace' });
      var brace = spec.match(/\{([^}]*)\}/);
      if (brace) {
        brace[1].split(',').forEach(function (part) {
          part = part.trim();
          if (!part) return;
          var bits = part.split(/\s+as\s+/);
          names.push({ imported: bits[0].trim(), local: (bits[1] || bits[0]).trim(), kind: 'named' });
        });
      }
      var defm = spec.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
      if (defm) names.push({ imported: 'default', local: defm[1], kind: 'default' });
    }
    return { source: im[2], names: names, sideEffect: !spec, reExport: false };
  }
  var rawLines = raw.split('\n');
  for (var il2 = 0; il2 < rawLines.length; il2++) {
    var rawLine = rawLines[il2];
    var trimmedRaw = rawLine.trim();
    if (/^(\/\/|\/\*|\*)/.test(trimmedRaw)) continue; // comment line
    if (/^\s*import\s+[^\(]/.test(rawLine)) {
      var stmt = rawLine;
      var guard = 0;
      while (!/from\s+['"]/.test(stmt) && !/;\s*$/.test(stmt) && guard < 10 && il2 + 1 < rawLines.length) {
        il2++; guard++;
        stmt += '\n' + rawLines[il2];
      }
      var imp = parseImportStatement(stmt);
      if (imp) parsed.imports.push(imp);
      continue;
    }
    if (/^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]/.test(rawLine)) {
      var reM = rawLine.match(/export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/);
      if (reM) parsed.imports.push({ source: reM[1], names: [], sideEffect: false, reExport: true });
      continue;
    }
    var reqM = rawLine.match(/(?:const|let|var)\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/);
    if (reqM) {
      var names2 = [];
      if (reqM[1]) {
        reqM[1].split(',').forEach(function (part) {
          part = part.trim();
          if (!part) return;
          var bits = part.split(/\s*:\s*/);
          names2.push({ imported: bits[0].trim(), local: (bits[1] || bits[0]).trim(), kind: 'named' });
        });
      } else if (reqM[2]) {
        names2.push({ imported: reqM[2], local: reqM[2], kind: 'value' });
      }
      parsed.imports.push({ source: reqM[3], names: names2, sideEffect: false, reExport: false });
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
  for (var li = 0; li < lines.length; li++) {
    var l = lines[li];
    var lineNo2 = li + 1;
    if (/^\s*import\b/.test(l)) continue;
    // Strings are blanked in `l`, so match require( without the quote.
    if (/\brequire\s*\(/.test(l) && /^\s*(const|let|var)\b/.test(l)) continue;
    if (/module\.exports\s*=/.test(l)) continue;
    var declared = declaredOnLine[lineNo2] || new Set();
    identifiers(l).forEach(function (id) {
      if (JS_KEYWORDS.has(id)) return;
      if (declared.has(id)) return; // declaration site, not a use
      parsed.references.add(id);
    });
    var callRe = /([A-Za-z_$][\w$]*)\s*\(/g;
    var cm2;
    while ((cm2 = callRe.exec(l)) !== null) {
      if (JS_KEYWORDS.has(cm2[1])) continue;
      if (declared.has(cm2[1])) continue; // `function foo(` is not a call
      parsed.calls.add(cm2[1]);
    }
  }
  // Import locals are references only when used elsewhere; the import line
  // itself was skipped above, so nothing to remove here.

  // Unreachable code: statements after return/throw/break/continue in the
  // same block, and if (false) branches.
  var depth = 0;
  var terminatedAt = null; // brace depth where the block was terminated
  var rawLinesU = raw.split('\n');
  for (var ui = 0; ui < lines.length; ui++) {
    var ul = lines[ui];
    var dBefore = depth;
    depth += (ul.match(/\{/g) || []).length - (ul.match(/\}/g) || []).length;
    if (terminatedAt !== null && depth < terminatedAt) terminatedAt = null;
    var trimmed = ul.trim();
    if (/^\s*if\s*\(\s*false\s*\)/.test(ul)) {
      parsed.unreachable.push({ line: ui + 1, reason: 'if (false) branch is never taken', snippet: trimmed.slice(0, 120) });
      continue;
    }
    // A line that closes a block opens a new one: `} catch`, `} else`,
    // `} finally`, or the end of the block itself — the code after it is
    // reachable again, and the line itself is not a statement.
    if (trimmed.startsWith('}')) { terminatedAt = null; continue; }
    // A new switch case is reachable even after a `break`.
    if (/^case\b/.test(trimmed) || /^default\s*:/.test(trimmed)) { terminatedAt = null; continue; }
    if (terminatedAt !== null && dBefore >= terminatedAt && trimmed !== '' && !trimmed.startsWith('//') && /[A-Za-z0-9_$]/.test(trimmed)) {
      parsed.unreachable.push({ line: ui + 1, reason: 'code after return/throw/break/continue', snippet: trimmed.slice(0, 120) });
      continue;
    }
    if (/^\s*(return|throw|break|continue)\b/.test(ul)) {
      // Only a complete statement terminates the block. A multi-line
      // `return { ... }` or `return foo(` keeps going on the next lines,
      // and so does a return whose value is a template literal spanning
      // lines (its `${...}` expressions look like code but are not
      // statements). Detect the unclosed backtick on the raw line.
      var opens = (ul.match(/[\{\(\[]/g) || []).length;
      var closes = (ul.match(/[\}\)\]]/g) || []).length;
      var rawLineU = rawLinesU[ui] || '';
      var bt = (rawLineU.match(/`/g) || []).length;
      if (opens <= closes && bt % 2 === 0) terminatedAt = dBefore;
    }
  }

  return parsed;
}

/* ------------------------------------------------------------------ */
/* Python parsing (regex-based)                                        */
/* ------------------------------------------------------------------ */

function parsePy(rel, raw) {
  var code = stripPy(raw);
  var lines = code.split('\n');
  var parsed = {
    language: 'py', definitions: [], imports: [], references: new Set(),
    calls: new Set(), dynamic: false, dynamicReasons: [], dynamicImports: [],
    unreachable: [], decorators: [], dunder: new Set(),
  };

  var classStack = []; // {name, indent}
  var pendingDecorators = [];
  var declaredOnLine = {};

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
    while (classStack.length && indent <= classStack[classStack.length - 1].indent) classStack.pop();

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
      pendingDecorators = [];
      continue;
    }
    var cm = line.match(/^(\s*)class\s+([A-Za-z_]\w*)/);
    if (cm) {
      parsed.definitions.push({
        name: cm[2], kind: 'class', exported: false,
        startLine: lineNo, endLine: lineNo, decorators: pendingDecorators.slice(),
      });
      markDeclared(lineNo, cm[2]);
      classStack.push({ name: cm[2], indent: indent });
      pendingDecorators = [];
      continue;
    }
    if (pendingDecorators.length) pendingDecorators = [];
  }

  // __all__ makes names public exports.
  var allMatch = raw.match(/__all__\s*=\s*\[([^\]]*)\]/);
  if (allMatch) {
    var am;
    var allRe = /['"]([^'"]+)['"]/g;
    while ((am = allRe.exec(allMatch[1])) !== null) {
      parsed.imports.push({ source: '__all__', names: [{ imported: am[1], local: am[1], kind: 'named' }], sideEffect: false, reExport: false, allExport: true });
    }
  }
  // Top-level public names are importable in Python.
  parsed.definitions.forEach(function (d) {
    var defLine = lines[d.startLine - 1] || '';
    if (indentOf(defLine) === 0 && !d.name.startsWith('_')) d.exported = true;
  });

  // Imports.
  for (var ii = 0; ii < lines.length; ii++) {
    var il = lines[ii];
    var fm = il.match(/^\s*from\s+(\.+)?([\w.]*)\s+import\s+(.+)$/);
    if (fm) {
      var level = fm[1] ? fm[1].length : 0;
      var source = fm[2] || '';
      var names = [];
      fm[3].split(',').forEach(function (part) {
        part = part.trim().replace(/[()]/g, '');
        if (!part) return;
        var bits = part.split(/\s+as\s+/);
        names.push({ imported: bits[0].trim(), local: (bits[1] || bits[0]).trim(), kind: 'named' });
      });
      parsed.imports.push({
        source: source, names: names, sideEffect: false, reExport: false,
        fromImport: true, relative: level > 0, level: level,
      });
      continue;
    }
    var im2 = il.match(/^\s*import\s+(.+)$/);
    if (im2) {
      var names3 = [];
      im2[1].split(',').forEach(function (part) {
        part = part.trim();
        if (!part) return;
        var bits = part.split(/\s+as\s+/);
        var mod = bits[0].trim();
        names3.push({ imported: mod.split('.')[0], local: (bits[1] || mod.split('.')[0]).trim(), kind: 'named', full: mod });
      });
      parsed.imports.push({
        source: names3.length ? (names3[0].full || names3[0].imported) : '',
        names: names3, sideEffect: false, reExport: false, fromImport: false, relative: false, level: 0,
      });
    }
  }

  // References and calls (skip import lines and declaration sites).
  // Parity note: the CLI's tree-sitter pass records imported names as
  // references in the importing file, so a Python import is never flagged
  // dead by the reference check. Mirror that here.
  parsed.imports.forEach(function (imp) {
    (imp.names || []).forEach(function (n) { parsed.references.add(n.local); });
  });
  for (var ri = 0; ri < lines.length; ri++) {
    var rl = lines[ri];
    var rNo = ri + 1;
    if (/^\s*(import|from)\b/.test(rl)) continue;
    var declared = declaredOnLine[rNo] || new Set();
    identifiers(rl).forEach(function (id) {
      if (PY_KEYWORDS.has(id)) return;
      if (declared.has(id)) return;
      parsed.references.add(id);
    });
    var callRe2 = /([A-Za-z_]\w*)\s*\(/g;
    var cm3;
    while ((cm3 = callRe2.exec(rl)) !== null) {
      if (PY_KEYWORDS.has(cm3[1])) continue;
      if (declared.has(cm3[1])) continue;
      parsed.calls.add(cm3[1]);
      if (['getattr', 'importlib', '__import__', 'eval', 'exec'].indexOf(cm3[1]) >= 0) {
        parsed.dynamic = true;
        parsed.dynamicReasons.push('dynamic ' + cm3[1] + '() at line ' + rNo);
      }
    }
  }
  if (/\bimportlib\b/.test(code)) {
    parsed.dynamic = true;
    parsed.dynamicReasons.push('uses importlib');
  }

  // Unreachable code: statements after return/raise/break/continue at the
  // same indent, until the block dedents.
  var terminatedIndent = null;
  for (var ui2 = 0; ui2 < lines.length; ui2++) {
    var ul2 = lines[ui2];
    var t2 = ul2.trim();
    if (t2 === '') continue;
    var ind2 = indentOf(ul2);
    if (terminatedIndent !== null && ind2 < terminatedIndent) terminatedIndent = null;
    if (terminatedIndent !== null && ind2 === terminatedIndent) {
      // A lone closing bracket belongs to the multi-line return above it.
      if (/^[\]\)}]+$/.test(t2)) continue;
      parsed.unreachable.push({ line: ui2 + 1, reason: 'code after return/raise/break/continue', snippet: t2.slice(0, 120) });
      continue;
    }
    if (/^\s*(return|raise|break|continue)\b/.test(ul2)) terminatedIndent = ind2;
  }

  return parsed;
}

/* ------------------------------------------------------------------ */
/* Import resolution                                                   */
/* ------------------------------------------------------------------ */

function resolveJsRelative(fromFile, source, existingFiles) {
  if (!source.startsWith('.')) return null;
  var base = joinPosix(dirOf(fromFile), source);
  var candidates = [];
  if (/\.[a-z]+$/i.test(base)) candidates.push(base);
  JS_EXTS.concat(PY_EXTS).forEach(function (ext) { candidates.push(base + ext); });
  JS_EXTS.concat(PY_EXTS).forEach(function (ext) { candidates.push(joinPosix(base, 'index' + ext)); });
  candidates.push(joinPosix(base, '__init__.py'));
  for (var i = 0; i < candidates.length; i++) {
    if (existingFiles.has(candidates[i])) return candidates[i];
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
  var byTarget = {};
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
  var out = {};
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
  var files = {}; // rel path -> {rel, language, parsed, raw, size}
  var existingFiles = new Set();
  var textFiles = []; // {rel, content} for the string-reference pass
  var pkg = null;
  var pkgDir = '';

  inputFiles.forEach(function (f) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') return;
    var rel = f.path.replace(/^\.\//, '').replace(/\\/g, '/');
    var parts = rel.split('/');
    if (parts.some(function (p) { return SKIP_DIRS.has(p); })) return;
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
  var entries = {}; // rel -> reason
  Object.keys(files).forEach(function (rel) {
    var info = files[rel];
    var e = looksLikeEntry(rel, rel, pkgEntries, info.raw);
    if (e.entry) entries[rel] = e.reason;
  });

  // Import edges.
  var importers = {}; // target rel -> Set of importer rels
  var importsByFile = {}; // rel -> [{target, source, names}]
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

  // Repo-wide string index.
  var stringCache = {};
  function filesMentioning(name) {
    if (stringCache[name]) return stringCache[name];
    var re = new RegExp('\\b' + escapeRegExp(name) + '\\b');
    var hits = new Set();
    textFiles.forEach(function (f) {
      try { if (re.test(f.content)) hits.add(f.rel); } catch (_) {}
    });
    stringCache[name] = hits;
    return hits;
  }

  // Per-symbol usage.
  var symbolUsage = {}; // file -> {name -> {importedBy:Set, calledIn:Set, sameFile:bool}}
  Object.keys(files).forEach(function (rel) {
    var info = files[rel];
    var map = {};
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
    });
  });

  // Grading, mirroring the CLI confidence engine.
  var findings = [];
  function add(f) {
    f.id = f.category + ':' + f.file + ':' + (f.symbol || '') + ':' + (f.startLine || 0);
    findings.push(f);
    return f;
  }

  Object.keys(files).forEach(function (rel) {
    var info = files[rel];
    if (!info.parsed) return; // never flag what we could not parse
    var parsed = info.parsed;
    var isEntry = Boolean(entries[rel]);
    var isTest = TEST_FILE.test(rel);
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
    var usageMap = symbolUsage[rel] || {};
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
      if (importedBy.length === 0 && sameFileUse) {
        if (def.exported && def.kind !== 'variable' && !isEntry) {
          add({
            category: categoryOf(def.kind), file: rel, symbol: def.name, grade: 'REVIEW',
            startLine: def.startLine, endLine: def.endLine, size: 0,
            reason: 'used only in its own file — could be unexported, not deleted',
            evidence: { importers: 0, callers: 0, stringRefs: [], exported: true },
            deleteDiff: 'remove "export" from ' + def.name + ' in ' + rel,
          });
        }
        return;
      }
      if (importedBy.length > 0) return;

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
    parsed.imports.forEach(function (imp) {
      if (imp.sideEffect || imp.reExport || imp.allExport) return;
      (imp.names || []).forEach(function (n) {
        if (n.kind === 'namespace') return;
        if (!parsed.references.has(n.local) && !parsed.calls.has(n.local)) {
          add({
            category: 'import', file: rel, symbol: n.local, grade: isTest ? 'KEEP' : 'SAFE',
            startLine: 1, endLine: null, size: 0,
            reason: isTest ? 'unused import in a test file (kept)' : 'imported "' + n.imported + '" from "' + imp.source + '" but never referenced in this file',
            evidence: { importers: 0, callers: 0, stringRefs: [], exported: false },
            deleteDiff: 'remove "' + n.local + '" from import of "' + imp.source + '" in ' + rel,
          });
        }
      });
    });

    // Unreachable code.
    (parsed.unreachable || []).forEach(function (u) {
      add({
        category: 'unreachable', file: rel, symbol: null, grade: 'SAFE',
        startLine: u.line, endLine: u.line, size: u.snippet ? u.snippet.length : 0,
        reason: u.reason,
        evidence: { importers: 0, callers: 0, stringRefs: [], exported: false },
        deleteDiff: u.snippet || '',
      });
    });
  });

  // Dead dependencies (JS only).
  if (pkg && pkg.dependencies) {
    Object.keys(pkg.dependencies).forEach(function (dep) {
      var re = new RegExp('\\b' + escapeRegExp(dep) + '\\b');
      var found = re.test(JSON.stringify(pkg.scripts || {}));
      if (!found) {
        for (var i = 0; i < textFiles.length; i++) {
          if (baseOf(textFiles[i].rel) === 'package.json') continue;
          if (re.test(textFiles[i].content)) { found = true; break; }
        }
      }
      if (!found) {
        add({
          category: 'dependency', file: 'package.json', symbol: dep, grade: 'REVIEW',
          startLine: 1, endLine: null, size: 0,
          reason: 'dependency "' + dep + '" appears nowhere (no import, require, string, or script)',
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
