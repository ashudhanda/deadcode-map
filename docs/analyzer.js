'use strict';

/**
 * deadcode-map web analyzer — lightweight, browser-safe.
 *
 * JS / Python are parsed with regular expressions; Java is parsed with
 * tree-sitter (docs/parse-java-web.js, web-tree-sitter 0.22.5 +
 * tree-sitter-java 0.23.5 wasm, vendored in docs/vendor/ and lazy-loaded only
 * when a .java file is present). The Java grading below ports the CLI's
 * Java branch from src/confidence.js — private-only SAFE, arity-aware
 * liveness — so a web SAFE is a SAFE the CLI would emit too (the web
 * IS the opted-in surface: there is no --java-safe gate here). When the
 * wasm parser cannot load, Java files are skipped, never regex-parsed.
 *
 * It mirrors the CLI's grading model (SAFE / REVIEW / KEEP with
 * evidence) and its core rules: a real import graph from entry points,
 * a repo-wide string-reference pass, framework keeps, and dynamic-import
 * downgrades. It is NOT the full CLI: the regex JS/Python parsers can
 * miss exotic syntax. The UI says so honestly.
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
 * The Java parser is loaded lazily (see analyzeFilesAsync): in Node via
 * require('./parse-java-web'), in the browser via window.DeadcodeJava
 * (docs/parse-java-web.js, loaded by a <script> tag in index.html).
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
var JAVA_EXTS = ['.java'];
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

var TEST_FILE = /(\.test\.|\.spec\.|\.e2e-spec\.|_test\.py$|test_[^/]+\.py$|conftest\.py$|(^|\/)test\.[jt]sx?$|Test\.java$)/;
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
  // Manually-run tools (scripts/ or tools/ at any depth): invoked by
  // the operator, never imported — mirrors isManualScriptPath in
  // src/discover.js. They are entry points (never dead files) and
  // their symbols are kept (see keepSymbols below).
  /(^|\/)(scripts|tools)\//,
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

// Java framework stereotypes on an enclosing class: the framework
// reflects over the class's private members, so members are REVIEW at
// most, never SAFE. The union of three sources, kept in sync by the
// 'web java: framework stereotype lists match the packs' test:
// - the hardcoded fallback in src/parse-java.js
//   FRAMEWORK_CLASS_ANNOTATIONS (core stereotypes + Lombok),
// - frameworks/spring.json keepClassAnnotations,
// - frameworks/jackson-jpa.json keepClassAnnotations.
// A pack-only stereotype such as @ControllerAdvice or
// @JsonIgnoreProperties keeps members at REVIEW too, with no
// annotation list hardcoded here for the new packs beyond this union.
var JAVA_FRAMEWORK_CLASS_ANNOTATIONS = new Set([
  // src/parse-java.js FRAMEWORK_CLASS_ANNOTATIONS (core + Lombok).
  'Data', 'Getter', 'Setter', 'Value', 'Builder',
  'AllArgsConstructor', 'NoArgsConstructor', 'RequiredArgsConstructor',
  'EqualsAndHashCode', 'ToString',
  'Service', 'Component', 'Controller', 'RestController', 'Repository',
  'SpringBootApplication', 'Configuration', 'Entity', 'Embeddable',
  'MappedSuperclass',
  // frameworks/spring.json keepClassAnnotations (beyond the core set).
  'ControllerAdvice', 'RestControllerAdvice', 'SpringBootConfiguration',
  'EnableAutoConfiguration', 'ComponentScan', 'ConfigurationProperties',
  'FeignClient', 'EnableFeignClients', 'EnableWebMvc', 'EnableScheduling',
  'EnableAsync', 'EnableCaching', 'EnableTransactionManagement',
  // frameworks/jackson-jpa.json keepClassAnnotations (beyond the core set).
  'Table', 'JsonIgnoreProperties', 'JsonTypeInfo', 'JsonPropertyOrder',
  'Inheritance', 'DiscriminatorColumn',
]);

// Java serialization callbacks (FJ-4, mirrors src/confidence.js
// JAVA_SERIALIZATION_CALLBACKS): private methods the serialization
// runtime invokes by reflection. The (name, arity) pair IS the
// contract: readObject / writeObject take the stream (1),
// readObjectNoData / readResolve / writeReplace take none (0).
var JAVA_SERIALIZATION_CALLBACKS = {
  readObject: 1, writeObject: 1,
  readObjectNoData: 0, readResolve: 0, writeReplace: 0,
};

// Generated from frameworks/*.json by the batch-10 Java web
// integration (see the pack-data test, which rebuilds these maps
// from the packs and fails on drift). First pack in filename
// order wins a key, matching the CLI's first-reason rule in
// frameworkKeepSymbol (src/confidence.js).
var JAVA_PACK_KEEP_EXPORTS_LIST = [['config', 'next.json'], ['default', 'next.json'], ['generateMetadata', 'next.json'], ['generateStaticParams', 'next.json'], ['getServerSideProps', 'next.json'], ['getStaticPaths', 'next.json'], ['getStaticProps', 'next.json'], ['middleware', 'next.json']];
var JAVA_PACK_KEEP_NAMES_LIST = [['__call__', 'fastapi.json'], ['__init__', 'django.json'], ['__str__', 'django.json'], ['clean', 'django.json'], ['get_absolute_url', 'django.json'], ['save', 'django.json']];
var JAVA_PACK_KEEP_DECORATORS_LIST = [['receiver', 'django.json'], ['register', 'django.json'], ['admin.register', 'django.json'], ['login_required', 'django.json'], ['permission_required', 'django.json'], ['app.get', 'fastapi.json'], ['app.post', 'fastapi.json'], ['app.put', 'fastapi.json'], ['app.delete', 'fastapi.json'], ['app.patch', 'fastapi.json'], ['app.route', 'fastapi.json'], ['router.get', 'fastapi.json'], ['router.post', 'fastapi.json'], ['router.put', 'fastapi.json'], ['router.delete', 'fastapi.json'], ['router.patch', 'fastapi.json'], ['router.route', 'fastapi.json'], ['app.on_event', 'fastapi.json'], ['app.middleware', 'fastapi.json'], ['app.errorhandler', 'flask.json'], ['app.before_request', 'flask.json'], ['app.after_request', 'flask.json'], ['blueprint.route', 'flask.json'], ['JsonProperty', 'jackson-jpa.json'], ['JsonIgnore', 'jackson-jpa.json'], ['JsonIgnoreProperties', 'jackson-jpa.json'], ['JsonCreator', 'jackson-jpa.json'], ['JsonValue', 'jackson-jpa.json'], ['JsonGetter', 'jackson-jpa.json'], ['JsonSetter', 'jackson-jpa.json'], ['JsonSerialize', 'jackson-jpa.json'], ['JsonDeserialize', 'jackson-jpa.json'], ['JsonInclude', 'jackson-jpa.json'], ['JsonFormat', 'jackson-jpa.json'], ['JsonTypeInfo', 'jackson-jpa.json'], ['JsonSubTypes', 'jackson-jpa.json'], ['JsonTypeName', 'jackson-jpa.json'], ['JsonAnyGetter', 'jackson-jpa.json'], ['JsonAnySetter', 'jackson-jpa.json'], ['JsonAlias', 'jackson-jpa.json'], ['JsonView', 'jackson-jpa.json'], ['JsonPropertyOrder', 'jackson-jpa.json'], ['JsonUnwrapped', 'jackson-jpa.json'], ['JsonRawValue', 'jackson-jpa.json'], ['JsonManagedReference', 'jackson-jpa.json'], ['JsonBackReference', 'jackson-jpa.json'], ['JsonIdentityInfo', 'jackson-jpa.json'], ['Entity', 'jackson-jpa.json'], ['Table', 'jackson-jpa.json'], ['Column', 'jackson-jpa.json'], ['Id', 'jackson-jpa.json'], ['GeneratedValue', 'jackson-jpa.json'], ['Embeddable', 'jackson-jpa.json'], ['Embedded', 'jackson-jpa.json'], ['EmbeddedId', 'jackson-jpa.json'], ['MappedSuperclass', 'jackson-jpa.json'], ['OneToMany', 'jackson-jpa.json'], ['ManyToOne', 'jackson-jpa.json'], ['OneToOne', 'jackson-jpa.json'], ['ManyToMany', 'jackson-jpa.json'], ['JoinColumn', 'jackson-jpa.json'], ['JoinTable', 'jackson-jpa.json'], ['PrePersist', 'jackson-jpa.json'], ['PreUpdate', 'jackson-jpa.json'], ['PostLoad', 'jackson-jpa.json'], ['PostPersist', 'jackson-jpa.json'], ['PostRemove', 'jackson-jpa.json'], ['PostUpdate', 'jackson-jpa.json'], ['Enumerated', 'jackson-jpa.json'], ['Temporal', 'jackson-jpa.json'], ['Transient', 'jackson-jpa.json'], ['Lob', 'jackson-jpa.json'], ['Version', 'jackson-jpa.json'], ['ElementCollection', 'jackson-jpa.json'], ['CollectionTable', 'jackson-jpa.json'], ['OrderBy', 'jackson-jpa.json'], ['DiscriminatorColumn', 'jackson-jpa.json'], ['Inheritance', 'jackson-jpa.json'], ['NamedQuery', 'jackson-jpa.json'], ['NamedQueries', 'jackson-jpa.json'], ['SequenceGenerator', 'jackson-jpa.json'], ['TableGenerator', 'jackson-jpa.json'], ['model_validator', 'pydantic.json'], ['field_validator', 'pydantic.json'], ['computed_field', 'pydantic.json'], ['root_validator', 'pydantic.json'], ['validator', 'pydantic.json'], ['pytest.fixture', 'pytest.json'], ['pytest.mark.parametrize', 'pytest.json'], ['pytest.mark.skip', 'pytest.json'], ['pytest.hookimpl', 'pytest.json'], ['hookimpl', 'pytest.json'], ['Component', 'spring.json'], ['Service', 'spring.json'], ['Repository', 'spring.json'], ['Controller', 'spring.json'], ['RestController', 'spring.json'], ['ControllerAdvice', 'spring.json'], ['RestControllerAdvice', 'spring.json'], ['Configuration', 'spring.json'], ['SpringBootApplication', 'spring.json'], ['SpringBootConfiguration', 'spring.json'], ['EnableAutoConfiguration', 'spring.json'], ['ComponentScan', 'spring.json'], ['EnableFeignClients', 'spring.json'], ['EnableWebMvc', 'spring.json'], ['EnableScheduling', 'spring.json'], ['EnableAsync', 'spring.json'], ['EnableCaching', 'spring.json'], ['EnableTransactionManagement', 'spring.json'], ['Autowired', 'spring.json'], ['Qualifier', 'spring.json'], ['Value', 'spring.json'], ['Bean', 'spring.json'], ['PostConstruct', 'spring.json'], ['PreDestroy', 'spring.json'], ['Primary', 'spring.json'], ['Lazy', 'spring.json'], ['Scope', 'spring.json'], ['Profile', 'spring.json'], ['Conditional', 'spring.json'], ['Import', 'spring.json'], ['PropertySource', 'spring.json'], ['ConfigurationProperties', 'spring.json'], ['EnableConfigurationProperties', 'spring.json'], ['RequestMapping', 'spring.json'], ['GetMapping', 'spring.json'], ['PostMapping', 'spring.json'], ['PutMapping', 'spring.json'], ['DeleteMapping', 'spring.json'], ['PatchMapping', 'spring.json'], ['RequestParam', 'spring.json'], ['PathVariable', 'spring.json'], ['RequestBody', 'spring.json'], ['ResponseBody', 'spring.json'], ['ResponseStatus', 'spring.json'], ['ExceptionHandler', 'spring.json'], ['ModelAttribute', 'spring.json'], ['CrossOrigin', 'spring.json'], ['RequestHeader', 'spring.json'], ['CookieValue', 'spring.json'], ['Scheduled', 'spring.json'], ['Async', 'spring.json'], ['EventListener', 'spring.json'], ['Transactional', 'spring.json'], ['Cacheable', 'spring.json'], ['CacheEvict', 'spring.json'], ['CachePut', 'spring.json'], ['Retryable', 'spring.json'], ['Secured', 'spring.json'], ['PreAuthorize', 'spring.json'], ['PostAuthorize', 'spring.json'], ['FeignClient', 'spring.json'], ['app.command', 'typer.json'], ['app.callback', 'typer.json'], ['app.cli.command', 'typer.json'], ['click.command', 'typer.json'], ['click.group', 'typer.json'], ['click.pass_context', 'typer.json'], ['typer.Typer', 'typer.json'], ['overload', 'typing.json']];

// Null-prototype lookup maps built from the lists above: symbol names
// come from user code, so a plain {} would return inherited members
// for names like "constructor" or "toString".
function javaPackMap(list) {
  var m = Object.create(null);
  list.forEach(function (pair) { if (!m[pair[0]]) m[pair[0]] = pair[1]; });
  return m;
}
var JAVA_PACK_KEEP_EXPORTS = javaPackMap(JAVA_PACK_KEEP_EXPORTS_LIST);
var JAVA_PACK_KEEP_NAMES = javaPackMap(JAVA_PACK_KEEP_NAMES_LIST);

// Framework-pack keep for one definition (port of frameworkKeepSymbol
// in src/confidence.js, Java scope): the CLI consults every pack for
// every definition — keepExports / keepNames by exact name, and
// keepDecorators by substring on the '@Name' decorator. Returns the
// CLI-style reason, or '' when no pack keeps this definition. The
// decorator loop iterates the pack list in sorted order (deterministic);
// the CLI iterates readdir order and takes the first reason, so the
// named pack can differ when two packs match — the grade is the same.
function javaFrameworkKeepSymbol(name, decorators) {
  if (name && JAVA_PACK_KEEP_EXPORTS[name]) return 'framework pack ' + JAVA_PACK_KEEP_EXPORTS[name] + ': export "' + name + '" is framework-resolved';
  if (name && JAVA_PACK_KEEP_NAMES[name]) return 'framework pack ' + JAVA_PACK_KEEP_NAMES[name] + ': name "' + name + '" is framework-resolved';
  for (var i = 0; i < (decorators || []).length; i++) {
    var d = decorators[i];
    for (var j = 0; j < JAVA_PACK_KEEP_DECORATORS_LIST.length; j++) {
      var kd = JAVA_PACK_KEEP_DECORATORS_LIST[j][0];
      if (d.indexOf(kd) >= 0) return 'framework pack ' + JAVA_PACK_KEEP_DECORATORS_LIST[j][1] + ': decorator "' + kd + '"';
    }
  }
  return '';
}

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
// Every identifier in a line of stripped code, with each name's start
// index, so the bare-reference pass can tell a member name (`obj.foo`)
// from a bare read (`foo`): the characters around the name decide.
function identifiersWithPos(text) {
  var out = [];
  var re = /[A-Za-z_$][\w$]*/g;
  var m;
  while ((m = re.exec(text)) !== null) out.push({ name: m[0], index: m.index });
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
    // Bare-name channel (batch 12, port of src/parse-js.js): bare
    // identifier reads only — never a member/property name
    // (`obj.foo` names the member, not a variable `foo`) and never a
    // property definition site (`{ foo: 1 }`). The flat `references`
    // set keeps every name (methods must stay live through
    // `obj.method()`), but a LOCAL definition can only be read by its
    // bare name. `bareCalls` is the same distinction for calls: a bare
    // call `foo()` only, never a member call `obj.foo()`. Both are
    // Sets of names, like `calls`; the grading loop reads them
    // fail-open (a parse without them falls back to the old flag).
    bareReferences: new Set(), bareCalls: new Set(),
  };
  // Absolute offset of each line in the stripped code, so the
  // bare-reference pass can look at the characters around a name even
  // across a line break (`obj\n.foo()` is still a member name).
  var lineOffsets = [];
  (function () {
    var off = 0;
    for (var loi = 0; loi < lines.length; loi++) { lineOffsets.push(off); off += lines[loi].length + 1; }
  })();
  // True when the identifier at absolute index `idx` (length `len`) in
  // the stripped code is a bare read: not a member/property name and
  // not a property definition site. The nearest non-space characters
  // around the name decide. A spread (`...foo`) IS a bare read — the
  // dots are three, not one — and a member chain split across lines
  // still counts (`obj\n.foo()`). Anything the check cannot classify
  // is bare (fail open): a false negative keeps a local alive, while
  // a false exclusion would flag it SAFE.
  function isBareAt(idx, len) {
    var p = idx - 1;
    while (p >= 0 && /\s/.test(code[p])) p--;
    if (p >= 0 && code[p] === '.') {
      // A member name (`obj.foo`, `a?.foo`, `this.foo`) — unless the
      // dot is the third of a spread (`...foo` reads `foo`).
      if (p - 1 < 0 || code[p - 1] !== '.') return false;
    }
    var prev = p >= 0 ? code[p] : '';
    var q = idx + len;
    while (q < code.length && /\s/.test(code[q])) q++;
    // A property definition site: an object key or a label
    // (`{ foo: 1 }`, `{ foo: bar }`, a block label `foo:`) names the
    // property or the label, not a variable of that name. A ternary
    // operand (`cond ? a : b`) has `?` or `:` before it, never `{`
    // or `,`, so it stays a bare read.
    if ((prev === '{' || prev === ',') && code[q] === ':') return false;
    return true;
  }
  // True when the identifier at absolute index `idx` (length `len`)
  // starts a method definition (`foo() {`, `foo(): Type {` in an
  // object literal or a class body): the identifier opens an object
  // entry (previous non-space char `{` or `,`, past an optional
  // `async` / `get` / `set` modifier or a `*` generator mark) and the
  // signature's closing paren is followed by `{` (or a `:` return
  // type). A call in the same spot (`{ foo(); }` — a block holding a
  // call statement) has `;` after its paren, so it stays a bare call.
  // The check is positional, so a later occurrence on the same line
  // is still a use (`foo() { return foo(); }` — the recursive call
  // reads `foo`). Class methods need no check here: the definition
  // loop records them, so `declared` already skips their name.
  function isMethodDefAt(idx, len, li) {
    var p = idx - 1;
    while (p >= 0 && /\s/.test(code[p])) p--;
    if (p < 0) return false;
    if (code[p] === '*') {
      // Generator method: `*foo() {`.
      p--;
      while (p >= 0 && /\s/.test(code[p])) p--;
    } else if (/[\w$]/.test(code[p])) {
      // Maybe a modifier word (`async` / `get` / `set`) before the name.
      var wEnd = p;
      while (p >= 0 && /[\w$]/.test(code[p])) p--;
      var word = code.slice(p + 1, wEnd + 1);
      if (word === 'async' || word === 'get' || word === 'set') {
        while (p >= 0 && /\s/.test(code[p])) p--;
      } else {
        // Not a modifier: the char before the name is a word char, so
        // this is not an entry position at all.
        return false;
      }
    }
    if (p < 0 || (code[p] !== '{' && code[p] !== ',')) return false;
    var q = idx + len;
    while (q < code.length && /\s/.test(code[q])) q++;
    if (code[q] !== '(') return false;
    // Scan the signature's parens (up to 6 lines ahead, like
    // methodDefFollows): the body `{` — or a `:` return type — must
    // follow the closing paren. Whitespace skipped here spans lines,
    // so a `)` with its `{` on the next line still counts.
    var scanEnd = (li + 6 < lineOffsets.length) ? lineOffsets[li + 6] : code.length;
    var depth = 0;
    var seenOpen = false;
    for (var s = q; s < scanEnd; s++) {
      var ch = code[s];
      if (ch === '(') { depth++; seenOpen = true; }
      else if (ch === ')') {
        depth--;
        if (seenOpen && depth === 0) {
          var r = s + 1;
          while (r < scanEnd && /\s/.test(code[r])) r++;
          return code[r] === '{' || code[r] === ':';
        }
      }
    }
    return false;
  }
  // Where the signature starting at `parenIdx` (the index of its
  // opening paren) on `line` opens its body: 'same' when the
  // signature closes on this line and a `{` follows it on this line
  // (the body `{`, or a return-type object `{` — either way the depth
  // after the line is the body depth), 'pending' when the signature
  // runs past the line (the body `{` lands on a later line), 'none'
  // when the signature closes with no `{` after it (an overload
  // signature with no body).
  function bodyOpensOnLine(line, parenIdx) {
    var depth = 0;
    for (var bi = parenIdx; bi < line.length; bi++) {
      if (line[bi] === '(') depth++;
      else if (line[bi] === ')') {
        depth--;
        if (depth === 0) {
          return line.slice(bi + 1).indexOf('{') >= 0 ? 'same' : 'none';
        }
      }
    }
    return 'pending';
  }

  var braceDepth = 0;
  var classStack = []; // {name, depth}
  var ambientStack = []; // {depth} — declare module/global blocks
  var declaredOnLine = {}; // lineNo (1-based) -> Set of declared names
  // Top of the bracket stack at the start of each line, counted on
  // the stripped code (strings, comments and regex literals are
  // already blanked, so a bracket inside them cannot corrupt the
  // count; `${...}` template expressions are kept as code and their
  // brackets balance). The innermost unclosed bracket decides
  // whether a `function name(` line is a declaration or an
  // expression: inside `(` or `[` it is an argument, an array
  // element, or a grouped expression — never a declaration. Inside
  // `{` (or at the top level) it is a statement — a declaration,
  // even when the brace belongs to a callback body whose call paren
  // is still open (`describe('...', () => {\n function install()
  // {}`, vue2 types/test/v3/define-component-test.tsx). A plain
  // paren-depth count misread every declaration inside a callback
  // body as an expression, because the call's paren never closes
  // until the body ends; only the stack top separates the two. A
  // closer that does not match the stack top is ignored (broken
  // code); if brackets never balance, later lines keep the stuck
  // top — a false negative, never a false positive (same trade as
  // parsePy's depthAtLineStart).
  var bracketTopAtLineStart = [];
  (function () {
    var stack = [];
    var pairs = { ')': '(', ']': '[', '}': '{' };
    for (var i = 0; i < lines.length; i++) {
      bracketTopAtLineStart.push(stack.length ? stack[stack.length - 1] : null);
      for (var j = 0; j < lines[i].length; j++) {
        var ch = lines[i][j];
        if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
        else if (pairs[ch] && stack.length && stack[stack.length - 1] === pairs[ch]) stack.pop();
      }
    }
  })();
  // Raw lines, parallel to the stripped `lines` (stripJs preserves
  // newlines, so the two arrays line up 1:1). The previous-line
  // check below reads the RAW line: blanking a string or regex
  // literal leaves a dangling operator in the stripped line (`const
  // whitespaceRE = /\s+/` strips to `const whitespaceRE =`, and a
  // semicolonless `const x = 'foo'` strips to `const x =`), which
  // misread a complete assignment as a continuation and hid the
  // declaration after it (vue2 class-util.ts `export function
  // addClass`). The raw line ends with the literal itself, never
  // with a dangling operator.
  var rawLines = raw.split('\n');
  // True when the previous non-empty line ends with a token that
  // continues an expression onto this line: an open bracket, comma,
  // `=`, `:` (an object value, a ternary else-branch — a case label
  // or a block label ends with `:` too, and a declaration after one
  // is skipped by this rule: fail-open, a missed finding, never a
  // false positive), `?`, `=>`, a binary/unary operator, a unary
  // keyword (`return` / `typeof` / `delete` / `await` / `yield` —
  // `return` and `yield` would end the statement by ASI, so skipping
  // a definition after them is fail-open, never a false positive),
  // or `={` opening a JSX expression container. `void` is NOT in
  // the keyword set: a unary `void` spanning lines is negligible,
  // while a TypeScript return type (`): void`) ends lines all over
  // .d.ts files. Neither is `/` in the operator set (a regex
  // literal ends with one) nor `!` (a TypeScript non-null assertion
  // ends with one: `foo!`), nor a doubled `++` / `--` (a complete
  // increment statement). A bare `{`-ending line is NOT a signal: a
  // declaration is the common first statement of a block (`if (x)
  // {\n function foo() {}`). A bare `>` is not one either: a JSX
  // element close (`/>`) can precede a real declaration.
  function prevLineContinuesExpr(ln) {
    for (var pi = ln - 1; pi >= 0; pi--) {
      var pt = rawLines[pi].trim();
      if (pt === '') continue;
      if (/[(\[,=?:]$/.test(pt)) return true;
      if (/=>\s*$/.test(pt)) return true;
      if (/(\+\+|--)$/.test(pt)) return false;
      if (/[+\-*%&|^~<]$/.test(pt)) return true;
      if (/\b(return|typeof|delete|await|yield)$/.test(pt)) return true;
      if (/=\s*\{$/.test(pt)) return true;
      return false;
    }
    return false;
  }
  // Function/class scopes, for the `local` flag on definitions (port
  // of the ancestor walk in src/parse-js.js): a definition nested
  // inside a function body is a local of that function. Each entry
  // holds the brace depth inside the scope; it pops when the depth
  // drops below it. `pendingScopeKind` is a declaration whose body
  // `{` lands on a later line (a signature split across lines) — the
  // first line after it that opens a brace is the body.
  var scopeStack = []; // {kind: 'function'|'class', depth}
  var pendingScopeKind = null;
  // True when a definition on the current line sits inside a function
  // body: walk the scope stack from the innermost scope out — the
  // first function or class entry decides (a bare block pushes
  // nothing, so the walk passes through it to the enclosing function,
  // like the CLI's walk past statement wrappers; a class boundary
  // ends the walk, so a method is never a local).
  function isLocalHere() {
    for (var si = scopeStack.length - 1; si >= 0; si--) {
      if (scopeStack[si].kind === 'function') return true;
      if (scopeStack[si].kind === 'class') return false;
    }
    return false;
  }
  // True when the `name(` line at `lines[ln]` starts a method
  // definition, not a call: the signature's closing paren must be
  // followed by `{` (or a `:` return-type annotation). A call line
  // such as `handleOptionValue(val, ...);` or a nested call
  // `parseNumericPattern(x, y),` used to be recorded as a phantom
  // method — which also suppressed the real call, so the real
  // definition looked dead (commander, date-fns MonthParser). The
  // signature may span lines, so the scan follows the parens a few
  // lines down. Shared by the class-method branch below and the
  // references pass (an object-literal method's name is a definition
  // site, not a bare read, exactly like a class method's).
  function methodDefFollows(ln) {
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
            // (or a `:` return type) starts a method body; `;`, `,`,
            // `)`, `.` or an operator continues an expression — a call.
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
  }

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
    // Pop function/class scopes whose block closed on an earlier line.
    while (scopeStack.length && braceDepth < scopeStack[scopeStack.length - 1].depth) scopeStack.pop();
    // A definition inside a `declare module` / `declare global` block is
    // a declaration-merging augmentation, not a standalone definition.
    var inAmbient = ambientStack.length > 0;
    // Where the body of a function/method declared on this line opens
    // ('same' / 'pending' / 'none', see bodyOpensOnLine): the scope
    // push at the end of the line reads these.
    var fnBodyHere = null;
    var methodBodyHere = null;

    // Class declaration.
    m = line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (m) {
      parsed.definitions.push({
        name: m[1], kind: 'class', exported: /^\s*export\b/.test(line),
        startLine: lineNo, endLine: lineNo, decorators: [], ambient: inAmbient,
        local: isLocalHere(),
      });
      markDeclared(lineNo, m[1]);
    } else if (classStack.length) {
      // Method inside a class body — but only when the `name(` line
      // starts a definition, not a call (see methodDefFollows).
      var mm = line.match(/^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+)*(?:#)?([A-Za-z_$][\w$]*)\s*\(/);
      // A method may legally be named like a keyword (`get`, `set`,
      // `async`, `static` are property names, not reserved words in
      // this position), so the name is excluded only for the shapes
      // that are statements, not methods: the control headers
      // if/for/while/switch/catch, a `case (x):` label, and a
      // `super()` call inside a constructor. The old
      // !JS_KEYWORDS check also dropped every method named `get` /
      // `set` / `async` — and with it, the isGetter flag for a
      // getter named `get`. methodDefFollows (the `{` after the
      // closing paren) is what separates a definition from a call.
      if (mm && mm[1] !== 'if' && mm[1] !== 'for' && mm[1] !== 'while' && mm[1] !== 'switch' && mm[1] !== 'catch' && mm[1] !== 'case' && mm[1] !== 'super') {
        var isDef = methodDefFollows(ln);
        if (isDef) {
          // A getter/setter is invoked by property access, not by a
          // call: `ctx.slots` runs `get slots()`. The modifier before
          // the name decides (a method literally named `get` has no
          // modifier — the text before its name is blank). Mirrors
          // src/parse-js.js, which reads the first child of the
          // method_definition node.
          var modPart = mm[0].slice(0, mm[0].length - mm[1].length - 1);
          var methodDef = {
            name: mm[1], kind: 'method', exported: false,
            startLine: lineNo, endLine: lineNo, decorators: [], ambient: inAmbient,
            local: isLocalHere(),
          };
          if (/\bget\s*$/.test(modPart)) methodDef.isGetter = true;
          if (/\bset\s*$/.test(modPart)) methodDef.isSetter = true;
          parsed.definitions.push(methodDef);
          markDeclared(lineNo, mm[1]);
          methodBodyHere = bodyOpensOnLine(line, mm.index + mm[0].length - 1);
        }
      }
    }

    // Function declaration — but only a declaration. A named
    // function EXPRESSION on its own line (`settle(\n function
    // _resolve(value) {`, axios lib/adapters/xhr.js) matches the same
    // regex, and the CLI's tree-sitter parser never records one: it
    // records function_declaration nodes only, never
    // function_expression (src/parse-js.js). The name of a named
    // function expression is visible only inside itself, so it can
    // never be referenced from outside — recording it as a definition
    // that needs external references graded all four axios callbacks
    // SAFE. The two grammar signals above separate them: the
    // innermost unclosed bracket at the line start is `(` or `[`
    // (an argument list, an array element, a grouped expression),
    // or the previous non-empty line ends with a token that
    // continues an expression. Either signal only ever SKIPS a
    // definition — a missed declaration is a false negative, never a
    // false positive. The name is still marked declared on its line,
    // so the references pass does not read the `name(` signature as
    // a call; the body scope is still pushed below, so locals inside
    // the callback keep their `local` flag.
    m = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
    if (m) {
      var bracketTop = bracketTopAtLineStart[ln];
      if (bracketTop !== '(' && bracketTop !== '[' && !prevLineContinuesExpr(ln)) {
        parsed.definitions.push({
          name: m[1], kind: 'function', exported: /^\s*export\b/.test(line),
          startLine: lineNo, endLine: lineNo, decorators: [], ambient: inAmbient,
          local: isLocalHere(),
        });
      }
      markDeclared(lineNo, m[1]);
      fnBodyHere = bodyOpensOnLine(line, m.index + m[0].length - 1);
    }

    // const / let / var binding (arrow function, function, or value).
    m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m && !line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+\{/)) {
      var rhs = line.slice(m.index + m[0].length);
      var kind = /=>|function\b/.test(rhs) ? 'function' : 'variable';
      parsed.definitions.push({
        name: m[1], kind: kind, exported: /^\s*export\b/.test(line),
        startLine: lineNo, endLine: lineNo, decorators: [], ambient: inAmbient,
        local: isLocalHere(),
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
        local: isLocalHere(),
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
    // Function/class scope tracking for `local` (see isLocalHere): a
    // scope opens on the line whose `{` starts its body, at the depth
    // after that line, and pops when the depth drops below it. A push
    // at the post-line depth can only pop early, never late — a body
    // that opens mid-line sits at or below that depth — so a missed
    // or early-popped scope costs a missed local (fail open), never a
    // top-level definition misread as local.
    var netOpens = opens - closes;
    if (cm && netOpens > 0) scopeStack.push({ kind: 'class', depth: braceDepth });
    else if (cm && !pendingScopeKind && line.indexOf('{', cm.index + cm[0].length) === -1) pendingScopeKind = 'class';
    var pushedFnScope = false;
    var pushFnScope = function () {
      if (pushedFnScope || netOpens <= 0) return;
      pushedFnScope = true;
      scopeStack.push({ kind: 'function', depth: braceDepth });
    };
    if (fnBodyHere === 'same' || methodBodyHere === 'same') pushFnScope();
    else if ((fnBodyHere === 'pending' || methodBodyHere === 'pending') && !pendingScopeKind) pendingScopeKind = 'function';
    if (!pushedFnScope && /=>\s*\{/.test(line)) pushFnScope();
    if (!pushedFnScope) {
      // An anonymous function expression (`setTimeout(function () {`,
      // `.then(function (x) {`): same signature scan as a declaration.
      var fnex = /function\s*[A-Za-z_$]*\s*\(/.exec(line);
      if (fnex) {
        var fnexBody = bodyOpensOnLine(line, fnex.index + fnex[0].length - 1);
        if (fnexBody === 'same') pushFnScope();
        else if (fnexBody === 'pending' && !pendingScopeKind) pendingScopeKind = 'function';
      }
    }
    if (pendingScopeKind && netOpens > 0) {
      scopeStack.push({ kind: pendingScopeKind, depth: braceDepth });
      pendingScopeKind = null;
    }
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
  // Range of an import statement in the CLI's shape
  // { startIndex, endIndex, startLine, endLine }: the web parsers never
  // recorded one, so every import finding fell back to startLine 1 and
  // web/CLI ids disagreed for the same import (vue2
  // types/v3-define-component.d.ts: Data reported at line 1 by the web,
  // line 19 by the CLI). startLine is the line the statement starts on —
  // a multi-line import reports its first line, matching the CLI's
  // tree-sitter node range. Offsets come from lineOffsets, which the
  // stripper keeps aligned with the raw source.
  function importRange(firstLine0, lastLine0) {
    return {
      startIndex: lineOffsets[firstLine0] || 0,
      endIndex: (lineOffsets[lastLine0] || 0) + (rawLines[lastLine0] || '').length,
      startLine: firstLine0 + 1,
      endLine: lastLine0 + 1,
    };
  }
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
        imp.range = importRange(stmtStart, il2);
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
        parsed.imports.push({ source: reM[3], names: reNames, sideEffect: false, reExport: true, range: importRange(reStmtStart, il2) });
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
      var reqImp = { source: reqM[3], names: names2, sideEffect: false, reExport: isCompatShimJs };
      parsed.imports.push(reqImp);
      if (reqStmtStart >= 0) {
        // Record the binding names only on the lines the require
        // binding itself spans, so the references pass skips them
        // (see below). A name is recorded only when the statement
        // parsed, so a failed accumulation records nothing (fail
        // open). The old code marked every line of the accumulated
        // statement: a `const f = () => {` line opens a brace, so
        // the accumulator swallowed the whole function body, found
        // the require nested inside it, and marked the body's lines
        // as binding lines — the require's real uses on later lines
        // (`nodeSass.renderSync(...)`) were skipped as "import
        // binding, not a use" and the import looked dead (vuejs/vue
        // stylePreprocessors.ts: nodeSass / nodeLess / nodeStylus).
        // The binding names only ever occur inside the match text
        // (`const { a, b } = require('./x')` spans its declaration
        // lines exactly), so the match span is the right range.
        var reqLocals = new Set();
        names2.forEach(function (n) { reqLocals.add(n.local); });
        var matchStartLine = reqStmtStart + reqStmt.slice(0, reqM.index).split('\n').length - 1;
        var matchEndLine = reqStmtStart + reqStmt.slice(0, reqM.index + reqM[0].length).split('\n').length - 1;
        for (var rbl = matchStartLine; rbl <= matchEndLine; rbl++) requireLineBindings[rbl + 1] = reqLocals;
        reqImp.range = importRange(matchStartLine, matchEndLine);
      } else {
        // Single-line require: the statement is the current line.
        reqImp.range = importRange(il2, il2);
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
      parsed.imports.push({ source: bareM[1], names: [], sideEffect: true, reExport: false, range: importRange(il2, il2) });
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
  // JSDoc {@link X} / {@linkcode X} / {@linkplain X} is a real
  // reference to X: TypeScript resolves the link target, so an import
  // used only in a doc link is used, not dead (vuejs/vue
  // types/options.d.ts imports ObjectDirective / FunctionDirective
  // only for `@deprecated use {@link FunctionDirective} instead`).
  // Only imported bindings get the credit (same rule as the
  // JSX-pragma credit above): a doc mention of a local name must not
  // resurrect a dead local definition. Scanned on the raw source: the
  // references pass below runs on stripped code with comments
  // blanked, so a link inside a comment never reaches it. A bare word
  // in prose is not a link — only the {@link...} form counts, so a
  // type merely mentioned in a comment sentence stays flaggable.
  // Mirrors src/parse-js.js.
  var linkRe = /\{@link(?:code|plain)?\s+([A-Za-z_$][\w$]*)/g;
  var lm;
  while ((lm = linkRe.exec(raw)) !== null) {
    if (importLocals.has(lm[1])) parsed.references.add(lm[1]);
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
        // A method's own definition name is not a bare read (see
        // isMethodDefAt); a value or shorthand in the export object is.
        if (!isMethodDefAt(lineOffsets[li] + regionIdM.index, regionId.length, li)
          && isBareAt(lineOffsets[li] + regionIdM.index, regionId.length)) parsed.bareReferences.add(regionId);
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
        if (!isMethodDefAt(lineOffsets[li] + regionCm.index, regionCm[1].length, li)
          && isBareAt(lineOffsets[li] + regionCm.index, regionCm[1].length)) parsed.bareCalls.add(regionCm[1]);
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
    // A declaration line names its binding once: `var Monitoring =
    // Monitoring || (function () {...})` reads the pre-existing
    // global of the same name on its right-hand side, and that read
    // is a real use — the CLI's tree-sitter parse counts it (the
    // declaration site is one node, the read is another), while the
    // old skip dropped every occurrence of the name on the line, so
    // the global looked unreferenced (vuejs/vue dbmon monitor.js).
    // Skip only the first occurrence of each declared name per line;
    // later occurrences are uses.
    var skippedDecl = new Set();
    identifiersWithPos(l).forEach(function (hit) {
      var id = hit.name;
      if (JS_KEYWORDS.has(id) && !keywordUseNames.has(id)) return;
      if (declared.has(id)) {
        if (skippedDecl.has(id)) { /* later occurrence: a real use, fall through */ }
        else { skippedDecl.add(id); return; } // declaration site, not a use
      }
      if (boundHere && boundHere.has(id)) return; // import binding, not a use
      if (skipExportsIds && skipExportsIds.has(id)) return; // the `module.exports` tokens themselves
      if (decChain.has(id)) return;
      parsed.references.add(id);
      // A bare read keeps a same-named local alive; a member name, a
      // property key, or a method's own definition name does not (see
      // isBareAt and isMethodDefAt).
      if (!isMethodDefAt(lineOffsets[li] + hit.index, id.length, li)
        && isBareAt(lineOffsets[li] + hit.index, id.length)) parsed.bareReferences.add(id);
    });
    var callRe = /([A-Za-z_$][\w$]*)\s*\(/g;
    var cm2;
    while ((cm2 = callRe.exec(l)) !== null) {
      if (JS_KEYWORDS.has(cm2[1]) && !keywordUseNames.has(cm2[1])) continue;
      if (declared.has(cm2[1])) continue; // `function foo(` is not a call
      if (boundHere && boundHere.has(cm2[1])) continue;
      if (decChain.has(cm2[1])) continue;
      parsed.calls.add(cm2[1]);
      // A bare call `foo()` reads the local `foo`; a member call
      // `obj.foo()` names the member, never the local — and a
      // method's own definition line is not a call at all.
      if (!isMethodDefAt(lineOffsets[li] + cm2.index, cm2[1].length, li)
        && isBareAt(lineOffsets[li] + cm2.index, cm2[1].length)) parsed.bareCalls.add(cm2[1]);
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
      var isContinuation = /^[?:,)\].&|+]/.test(trimmed) || /[({[,&|?:+\-*/%=<>!]$/.test(prevTrimmed)
        // A `[` continuation line is a computed member access on the
        // expression above (`return colord(x)` followed by
        // `[theme ...](...)` — umami WorldMap.tsx: the `[` line is
        // part of the return value, not a new statement). Unlike `.`,
        // a `[` can also start a fresh array-literal statement, but
        // only after a `;` ends the previous one — without it, ASI
        // does not fire and the `[` binds to the expression above. So
        // `[` counts as a continuation only when the previous line
        // does not end with `;`. (A `[` line after a block-closing
        // `}` is still read as a continuation: fail-open, the same
        // trade the `.` rule already makes.)
        || (trimmed.charAt(0) === '[' && !/;$/.test(prevTrimmed));
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
      // A next line starting with `[` continues the return value as a
      // computed member access (`return colord(x)` / `[theme
      // ...](...)`, umami WorldMap.tsx) — unless the return line ends
      // with `;`, which ends the statement and makes the `[` a fresh
      // array literal (genuinely unreachable after the return).
      var continuesNextLine = /^[?:,)\].&|+]/.test(nextTrimmed)
        || (nextTrimmed.charAt(0) === '[' && !/;$/.test(trimmed));
      if (opens <= closes && bt % 2 === 0 && !braceless && !endsWithOperator && !continuesNextLine) { terminatedAt = dBefore; terminatedLineU = ui; }
    }
  }

  // Bare references serialize as a sorted array, like the CLI
  // (src/parse-js.js); bareCalls stays a Set, like `calls`.
  parsed.bareReferences = [...parsed.bareReferences].sort();

  return parsed;
}

/* ------------------------------------------------------------------ */
/* Python parsing (regex-based)                                        */
/* ------------------------------------------------------------------ */

function parsePy(rel, raw) {
  var strings = [];
  var code = stripPy(raw, strings);
  var lines = code.split('\n');
  // Absolute offset of each stripped line: the stripper blanks strings
  // and comments in place, so offsets match the raw source.
  var lineOffsetsPy = [];
  (function () {
    var off = 0;
    for (var loi = 0; loi < lines.length; loi++) { lineOffsetsPy.push(off); off += lines[loi].length + 1; }
  })();
  // Range of an import statement in the CLI's shape (see parseJs
  // importRange): the web Python parser never recorded one, so every
  // import finding fell back to startLine 1. firstLine/lastLine are
  // 1-based; startLine is the line the statement starts on — a
  // multi-line import reports its first line, matching the CLI's
  // tree-sitter node range.
  function importRangePy(firstLine1, lastLine1) {
    return {
      startIndex: lineOffsetsPy[firstLine1 - 1] || 0,
      endIndex: (lineOffsetsPy[lastLine1 - 1] || 0) + (lines[lastLine1 - 1] || '').length,
      startLine: firstLine1,
      endLine: lastLine1,
    };
  }
  var parsed = {
    language: 'py', definitions: [], imports: [], references: new Set(),
    calls: new Set(), dynamic: false, dynamicReasons: [], dynamicImports: [],
    unreachable: [], decorators: [], dunder: new Set(), strings: strings,
  };

  var classStack = []; // {name, indent, model}
  var funcStack = []; // {indent} — def lines, so a local inside a method is not a class field
  var pendingDecorators = [];
  var declaredOnLine = {};
  // Class-attribute assignment lines that are NOT recorded as
  // definitions (a plain class attribute, or one in a class nested in
  // a function): the assigned name is still a definition site, not a
  // read, so it must not count as a bare reference — the CLI's
  // tree-sitter parser excludes definition sites. Only the bare
  // channel consults this; the flat references pass is unchanged.
  var bareDeclaredOnLine = {};

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
  // A name that is a definition site for the bare channel only (the
  // flat references pass is unchanged): a class-attribute target, a
  // chained-assignment target, a value-less annotation.
  function noteBareDecl(lineNo, name) {
    if (!bareDeclaredOnLine[lineNo]) bareDeclaredOnLine[lineNo] = new Set();
    bareDeclaredOnLine[lineNo].add(name);
  }
  function indentOf(line) {
    var m = line.match(/^ */);
    return m ? m[0].length : 0;
  }
  // Whether the innermost enclosing scope is a function body: scopes
  // nest by indent, so the deeper of the innermost open def / class
  // is the innermost scope. A definition whose innermost scope is a
  // function is a local of that function (a nested function, a class
  // defined in a function, a variable assigned in a body); a
  // definition directly in a class body is not — the class boundary
  // is found first. Mirrors the CLI parsers' walk to the nearest
  // function / class boundary (src/parse-py.js, src/parse-js.js).
  function innermostIsFunction() {
    if (funcStack.length === 0) return false;
    if (classStack.length === 0) return true;
    return funcStack[funcStack.length - 1].indent > classStack[classStack.length - 1].indent;
  }
  // Bare-name references: bare identifier reads only — never an
  // attribute name (`obj.foo` names the member `foo`, not a variable
  // `foo`) and never the member name of a member call. The object of
  // a member call (`obj` in `obj.foo()`) IS a bare read: the object
  // is read. The flat `references` set keeps every name (a method
  // stays live through `obj.method()`), but a LOCAL definition can
  // only be read by its bare name. Serialized as a sorted array, like
  // the CLI (src/parse-py.js). bareCalls is the parallel record for
  // calls: names called bare (`foo()`), as opposed to the name-only
  // `calls` set, which cannot tell `foo()` from `obj.foo()`.
  var bareReferences = new Set();
  var bareCalls = new Set();

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
      // A method is a def whose innermost enclosing scope is the class:
      // a function nested inside a method (`def nested()` in a method
      // body) is a local function, not a method of the class — the
      // CLI's tree-sitter parser records it the same way.
      var isMethod = classStack.length > 0 && indent > classStack[classStack.length - 1].indent && !innermostIsFunction();
      var def = {
        name: dm[2], kind: isMethod ? 'method' : 'function', exported: false,
        startLine: lineNo, endLine: lineNo, decorators: pendingDecorators.slice(),
        local: innermostIsFunction(),
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
        local: innermostIsFunction(),
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
    // SAFE); other class attributes are not module definitions and are
    // skipped. A variable assigned in a function body IS recorded, as
    // a local variable definition (the CLI's tree-sitter parser
    // records it the same way): only then can the bare-reference
    // grading rule tell a dead local from a live one. A name bound
    // inside a plain block (`if TYPE_CHECKING:`, `try:`, a version
    // guard) IS a module definition at any indent — the CLI's
    // tree-sitter parser records it the same way, with the enclosing
    // block as the parent — so it is recorded here too, as an
    // unexported variable.
    var am = line.match(/^(\s*)([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*[^=]/);
    // A field is directly in the class body (not inside a method: a
    // local inside a method sits deeper than the enclosing def).
    var inFunction = funcStack.length > 0 && indent > funcStack[funcStack.length - 1].indent;
    var inClassBody = classStack.length > 0 && indent > classStack[classStack.length - 1].indent;
    var enclosingModel = !inFunction && inClassBody && classStack[classStack.length - 1].model;
    // A local variable is an assignment whose innermost enclosing
    // scope is a function — not merely any assignment inside a
    // function: an assignment directly in a class body nested in a
    // function (`def outer(): class Inner: x = 1`) is a class
    // attribute of Inner, not a local of outer.
    var inFunctionScope = innermostIsFunction();
    // lineDepth === 0: a continuation line inside a call, decorator or
    // def signature (`replace_whitespace=False`, a def parameter) looks
    // like an assignment but is a keyword argument, not a binding.
    // Chained assignment targets (`first = second = make_default`)
    // are definition sites too, not reads: the CLI's tree-sitter
    // parser records every chain target as a definition. The web
    // records only the first chain target as a definition — that model
    // is unchanged — but the bare channel must not count the later
    // targets as reads, or a dead local sharing the name would look
    // live. Only the bare channel consults this; the flat references
    // pass is unchanged. A chain target follows the first `=` at
    // bracket depth 0 (`a = b.c = 1` and `a = b[0] = 1` assign an
    // attribute / an item, so `b` is a read, not a target;
    // `a = b == c` is a comparison, not a chain). This scan runs
    // before the recording below, because a recorded line continues
    // past everything after it.
    if (am && lineDepth === 0) {
      var chainPos = line.indexOf('=') + 1;
      var chainDepth = 0;
      while (chainPos < line.length) {
        while (chainPos < line.length && (line[chainPos] === ' ' || line[chainPos] === '\t')) chainPos++;
        if (chainPos >= line.length) break;
        var chainCh = line[chainPos];
        if (chainCh === '(' || chainCh === '[' || chainCh === '{') { chainDepth++; chainPos++; continue; }
        if (chainCh === ')' || chainCh === ']' || chainCh === '}') { chainDepth = Math.max(0, chainDepth - 1); chainPos++; continue; }
        if (chainDepth !== 0) { chainPos++; continue; }
        var chainM = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(line.slice(chainPos));
        if (!chainM) break;
        noteBareDecl(lineNo, chainM[1]);
        chainPos += chainM[0].length;
      }
    }
    if (am && lineDepth === 0 && ((!inFunction && !inClassBody) || enclosingModel || inFunctionScope)) {
      // A TypeVar definition (`GrpType = TypeVar("GrpType", bound=...)`,
      // or `typing.TypeVar(...)`): a generic type variable is part of
      // the module's typing surface — it is declared to be named in
      // annotations elsewhere, and its own name string inside the
      // TypeVar(...) call is not a use of it. The grading rule below
      // holds TypeVars at REVIEW, never SAFE (batch 13: typer's
      // _click/decorators.py GrpType was flagged SAFE by the web
      // checker while the CLI grades it REVIEW).
      var rhsPy = line.slice(line.indexOf('=') + 1).trim();
      var isTypeVarPy = /^(?:typing\.)?TypeVar\s*\(/.test(rhsPy);
      parsed.definitions.push({
        name: am[2], kind: 'variable', exported: false,
        startLine: lineNo, endLine: lineNo, decorators: [],
        frameworkField: Boolean(enclosingModel),
        local: inFunctionScope,
        typeVar: isTypeVarPy,
      });
      if (/^__.*__$/.test(am[2])) parsed.dunder.add(am[2]);
      markDeclared(lineNo, am[2]);
      continue;
    }
    // A class attribute that is not recorded as a definition is still
    // a definition site: record its line so the bare channel (below)
    // does not count the assigned name as a read. A model field is
    // recorded above, so it never reaches here; a method-body local
    // is recorded above too (its innermost scope is the method).
    if (am && lineDepth === 0 && inClassBody && !inFunctionScope && !enclosingModel) {
      noteBareDecl(lineNo, am[2]);
    }
    // A value-less annotation (`timeout: int` in a class body) is a
    // definition site, not a read: the CLI's tree-sitter parser
    // excludes an annotation-only name from references entirely. The
    // web records no annotation-only name as a definition — that model
    // is unchanged — but the bare channel must not count the name as a
    // read. Only the bare channel consults this; the flat references
    // pass is unchanged. The line has no `=` at all, and it must sit
    // at bracket depth 0 — a dict key line (`x: y` inside `{...}`) is
    // a read, not a declaration.
    if (lineDepth === 0 && !am) {
      var annOnly = line.match(/^(\s*)([A-Za-z_]\w*)\s*:/);
      if (annOnly && line.indexOf('=') === -1) noteBareDecl(lineNo, annOnly[2]);
    }
    if (pendingDecorators.length) pendingDecorators = [];
  }

  // __all__ makes names public exports — and listing a name there is a
  // use of it (a re-export), so the name is added to references too.
  // List and tuple forms, multiline, and += all count (the CLI's
  // tree-sitter parser handles the same shapes).
  var allMatch = raw.match(/__all__\s*\+?=\s*[\[(]([\s\S]*?)[\])]/);
  if (allMatch) {
    var allLine = raw.slice(0, allMatch.index).split('\n').length;
    var am;
    var allRe = /['"]([^'"]+)['"]/g;
    while ((am = allRe.exec(allMatch[1])) !== null) {
      parsed.imports.push({ source: '__all__', names: [{ imported: am[1], local: am[1], kind: 'named' }], sideEffect: false, reExport: false, allExport: true, range: importRangePy(allLine, allLine) });
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
        range: importRangePy(acc.firstLine, acc.next + 1),
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
        range: importRangePy(acc2.firstLine, acc2.next + 1),
      }, names3, keptPlain, reExportPy(acc2.stmt, redundantAlias2, acc2.rawStmt));
    }
  }

  // --- string annotations in nested / multi-line positions (batch 13) ---
  // The per-line annRe in the references loop below only sees a string
  // directly after `:` or `->` (`x: "Context"`). Real code nests the
  // string inside a generic (`ctx: Union["Context", None]`,
  // `cls: type["TyperCommand"] | None`) or spreads a def signature over
  // several lines, so the string sits on a continuation line with no
  // `:` before it at all — typer's _click/parser.py, models.py and
  // params.py all had imports flagged SAFE that way. This pass recovers
  // those: it walks def signatures (joined across lines) and annotated
  // assignments, and counts only the string literals inside an
  // annotation span — the text after the annotation `:` up to the
  // default-value `=` at bracket depth 0. A string in a default value
  // (`def f(mode="Dead")`), a docstring, or an error message is never
  // in an annotation span, so it never counts. Strings inside a call
  // inside the annotation (`Annotated[str, Doc("...")]`,
  // `Option(envvar="ME")`) are skipped too: that text is prose or a
  // keyword value, not a type — the CLI's tree-sitter walk stops at a
  // `call` node unless it is `cast`, and `cast("T", x)` is already
  // handled by annRe. Structure (parens, colons, `=`) is read from
  // the stripped lines, where strings and comments are blanked but
  // positions are preserved, so the same offsets read the string
  // contents from the raw lines; raw lines are comment-blanked
  // (length-preserving) first, so a `#` note never leaks a quoted
  // word into the pass.
  function annBlankComment(rawLine) {
    var out = '';
    var i = 0;
    while (i < rawLine.length) {
      var ch = rawLine[i];
      if (ch === '#') { out += ' '.repeat(rawLine.length - i); break; }
      if (ch === "'" || ch === '"') {
        var q = ch;
        if (rawLine.slice(i, i + 3) === q + q + q) {
          var tripleEnd = rawLine.indexOf(q + q + q, i + 3);
          if (tripleEnd === -1) { out += rawLine.slice(i); break; }
          out += rawLine.slice(i, tripleEnd + 3); i = tripleEnd + 3; continue;
        }
        out += ch; i++;
        while (i < rawLine.length && rawLine[i] !== q) {
          if (rawLine[i] === '\\' && i + 1 < rawLine.length) { out += rawLine.slice(i, i + 2); i += 2; continue; }
          out += rawLine[i]; i++;
        }
        if (i < rawLine.length) { out += rawLine[i]; i++; }
        continue;
      }
      out += ch; i++;
    }
    return out;
  }
  function annAddIds(inner) {
    // The type-like filter mirrors annRe below: a string with no
    // capitalised identifier (`"b"`, `"hello"`) is a plain value,
    // not a type name.
    if (!/[A-Z]/.test(inner)) return;
    var ids = inner.match(/[A-Za-z_]\w*/g) || [];
    ids.forEach(function (id) {
      if (PY_KEYWORDS.has(id)) return;
      parsed.references.add(id);
      bareReferences.add(id);
    });
  }
  // The identifiers inside the string literals of one annotation span
  // (raw text, comments blanked). A string counts unless it sits
  // inside a call's argument list — the call frame is tracked from
  // the code characters around it. Brackets that are not calls
  // (`list["T"]`, `Union["T"]`) impose no frame, so their strings
  // count; `cast("T", x)` counts its first argument only.
  function annExtractStrings(rawSpan) {
    var i = 0;
    var n = rawSpan.length;
    var frames = []; // { callee, depth, commas }
    var depth = 0;
    while (i < n) {
      var ch = rawSpan[i];
      if (ch === "'" || ch === '"') {
        var q = ch;
        var inner;
        if (rawSpan.slice(i, i + 3) === q + q + q) {
          var close = rawSpan.indexOf(q + q + q, i + 3);
          if (close === -1) { inner = rawSpan.slice(i + 3); i = n; }
          else { inner = rawSpan.slice(i + 3, close); i = close + 3; }
        } else {
          i++;
          var buf = '';
          while (i < n && rawSpan[i] !== q) {
            if (rawSpan[i] === '\\' && i + 1 < n) { buf += rawSpan[i + 1]; i += 2; continue; }
            buf += rawSpan[i]; i++;
          }
          inner = buf;
          if (i < n) i++; // closing quote
        }
        var frame = frames.length ? frames[frames.length - 1] : null;
        var countIt = !frame || (frame.callee === 'cast' && frame.commas === 0);
        if (countIt) annAddIds(inner);
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        var word = /^[A-Za-z_]\w*/.exec(rawSpan.slice(i))[0];
        var k = i + word.length;
        while (k < n && (rawSpan[k] === ' ' || rawSpan[k] === '\t' || rawSpan[k] === '\n')) k++;
        if (k < n && rawSpan[k] === '(') {
          frames.push({ callee: word, depth: depth, commas: 0 });
          depth++;
          i = k + 1;
          continue;
        }
        i += word.length;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth = Math.max(0, depth - 1);
        while (frames.length && frames[frames.length - 1].depth >= depth) frames.pop();
        i++; continue;
      }
      if (ch === ',' && frames.length && depth === frames[frames.length - 1].depth + 1) {
        frames[frames.length - 1].commas++;
      }
      i++;
    }
  }
  function annNetDepth(s) {
    var d = 0;
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '(' || s[i] === '[' || s[i] === '{') d++;
      else if (s[i] === ')' || s[i] === ']' || s[i] === '}') d = Math.max(0, d - 1);
    }
    return d;
  }
  // First `=` at bracket depth 0 in stripped text, or -1. A `==`
  // comparison is not an assignment boundary.
  function annEqAtDepth0(s) {
    var d = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') d = Math.max(0, d - 1);
      else if (c === '=' && d === 0 && s[i + 1] !== '=') return i;
    }
    return -1;
  }
  // First `:` at bracket depth 0 in stripped text, or -1. A `::`
  // slice or `:=` walrus is not an annotation colon.
  function annColonAtDepth0(s) {
    var d = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') d = Math.max(0, d - 1);
      else if (c === ':' && d === 0 && s[i + 1] !== ':' && s[i + 1] !== '=') return i;
    }
    return -1;
  }
  function annMatchingParen(s, openIdx) {
    var d = 0;
    for (var i = openIdx; i < s.length; i++) {
      if (s[i] === '(') d++;
      else if (s[i] === ')') { d--; if (d === 0) return i; }
    }
    return -1;
  }
  // One def signature (stripped and raw text joined across lines, same
  // length): the annotation span of every parameter, plus the return
  // annotation after `->`.
  function annProcessDefSignature(stripped, raw) {
    var openIdx = stripped.indexOf('(');
    if (openIdx === -1) return;
    var closeIdx = annMatchingParen(stripped, openIdx);
    if (closeIdx === -1) return;
    var paramsS = stripped.slice(openIdx + 1, closeIdx);
    var paramsR = raw.slice(openIdx + 1, closeIdx);
    var parts = [];
    var d = 0;
    var start = 0;
    for (var i = 0; i <= paramsS.length; i++) {
      var c = paramsS[i];
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') d = Math.max(0, d - 1);
      else if ((c === ',' && d === 0) || i === paramsS.length) {
        parts.push({ s: paramsS.slice(start, i), r: paramsR.slice(start, i) });
        start = i + 1;
      }
    }
    parts.forEach(function (part) {
      var colon = annColonAtDepth0(part.s);
      if (colon === -1) return;
      var restS = part.s.slice(colon + 1);
      var eq = annEqAtDepth0(restS);
      var annR = eq === -1 ? part.r.slice(colon + 1) : part.r.slice(colon + 1, colon + 1 + eq);
      annExtractStrings(annR);
    });
    var afterS = stripped.slice(closeIdx + 1);
    var afterR = raw.slice(closeIdx + 1);
    var arrow = afterS.indexOf('->');
    if (arrow !== -1) {
      var retS = afterS.slice(arrow + 2);
      var retR = afterR.slice(arrow + 2);
      var rd = 0;
      var end = retS.length;
      for (var ri2 = 0; ri2 < retS.length; ri2++) {
        var rc = retS[ri2];
        if (rc === '(' || rc === '[' || rc === '{') rd++;
        else if (rc === ')' || rc === ']' || rc === '}') rd = Math.max(0, rd - 1);
        else if (rc === ':' && rd === 0) { end = ri2; break; }
      }
      annExtractStrings(retR.slice(0, end));
    }
  }
  // Lines covered by a def signature (the signature's own line and its
  // continuation lines): the annotated-assignment pass below skips
  // them, since the signature pass already read their annotations.
  var annDefSigLines = {};
  for (var annLi = 0; annLi < lines.length; annLi++) {
    if (!/^\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/.test(lines[annLi])) continue;
    var accS = lines[annLi];
    var accR = annBlankComment(rawLinesPy[annLi] || '');
    var annJ = annLi;
    var annDone = false;
    // A def signature can be very long: typer's Option() / Argument()
    // signatures run to ~1,000 lines (every parameter carries an
    // Annotated[..., Doc("""...""")] block), and the string annotation
    // that keeps an import alive can sit hundreds of lines in — a
    // small cap would stop before it. 2,000 lines still bounds a
    // malformed header.
    while (!annDone && annJ - annLi < 2000) {
      var oi = accS.indexOf('(');
      var ci = oi === -1 ? -1 : annMatchingParen(accS, oi);
      if (ci !== -1) {
        var tail = accS.slice(ci + 1);
        var td = 0;
        var foundColon = false;
        for (var tk = 0; tk < tail.length; tk++) {
          var tc = tail[tk];
          if (tc === '(' || tc === '[' || tc === '{') td++;
          else if (tc === ')' || tc === ']' || tc === '}') td = Math.max(0, td - 1);
          else if (tc === ':' && td === 0) { foundColon = true; break; }
        }
        if (foundColon) annDone = true;
      }
      if (!annDone) {
        annJ++;
        if (annJ >= lines.length) break;
        accS += '\n' + lines[annJ];
        accR += '\n' + annBlankComment(rawLinesPy[annJ] || '');
        annDefSigLines[annJ] = true;
      }
    }
    annDefSigLines[annLi] = true;
    annProcessDefSignature(accS, accR);
    annLi = annJ;
  }
  // Annotated assignments outside def signatures (`x: list["T"]`,
  // `x: Optional["T"] = None`, in a class body or a function body).
  // A line inside open brackets is a dict key or a continuation, never
  // a standalone annotation. The annotation span runs to the default
  // `=` at depth 0, or to the end of the (possibly multi-line) span
  // when the brackets never close on this line.
  for (var annVi = 0; annVi < lines.length; annVi++) {
    if (annDefSigLines[annVi]) continue;
    if (depthAtLineStart[annVi] !== 0) continue;
    var annLine = lines[annVi];
    var annM = /^(\s*)([A-Za-z_]\w*)\s*:/.exec(annLine);
    if (!annM) continue;
    if (PY_KEYWORDS.has(annM[2]) || annM[2] === 'case') continue;
    var annColon = annM[0].length - 1;
    var annAfter = annLine.slice(annColon + 1).trim();
    if (annAfter === '' || annAfter[0] === '=' || annAfter[0] === ':') continue;
    var spanS = annLine.slice(annColon + 1);
    var spanR = annBlankComment(rawLinesPy[annVi] || '').slice(annColon + 1);
    var annVj = annVi;
    while (true) {
      var annEq = annEqAtDepth0(spanS);
      if (annEq !== -1) { annExtractStrings(spanR.slice(0, annEq)); break; }
      if (annNetDepth(spanS) === 0) { annExtractStrings(spanR); break; }
      if (annVj - annVi >= 30 || annVj + 1 >= lines.length) { annExtractStrings(spanR); break; }
      annVj++;
      spanS += '\n' + lines[annVj];
      spanR += '\n' + annBlankComment(rawLinesPy[annVj] || '');
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
    var bareDeclared = bareDeclaredOnLine[rNo] || new Set();
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
    // Position-aware identifier scan: the flat `references` set keeps
    // the old behaviour exactly (every non-keyword identifier except
    // declaration-site and decorator-member names), and the same scan
    // records the bare channel. An identifier is a bare read unless
    // the nearest non-space character before it is a dot — an
    // attribute name (`obj.foo`, or a multi-line member access whose
    // dot closes the previous line inside brackets, `obj.\nfoo`). A
    // name declared on this line is dropped only at its first
    // occurrence (the declaration itself: `foo = ...`, `def foo(...)`);
    // a later occurrence on the same line is a read (`foo = foo()`, a
    // def default `def f(x=foo)`), so it counts as bare. The flat
    // references pass keeps its old whole-line skip for declared
    // names. A bare call is a bare read whose next non-space character
    // is `(` — `foo()` reads foo, `obj.foo()` does not.
    var declaredSeenPy = Object.create(null);
    var bareDeclaredSeenPy = Object.create(null);
    var firstIdOnLine = true;
    var idRePy = /[A-Za-z_]\w*/g;
    var idmPy;
    while ((idmPy = idRePy.exec(rl)) !== null) {
      var idPy = idmPy[0];
      var idIdxPy = idmPy.index;
      var isFirstPy = firstIdOnLine;
      firstIdOnLine = false;
      if (PY_KEYWORDS.has(idPy)) continue;
      var isAttrPy = false;
      var kb = idIdxPy - 1;
      while (kb >= 0 && (rl[kb] === ' ' || rl[kb] === '\t')) kb--;
      if (kb >= 0 && rl[kb] === '.') isAttrPy = true;
      else if (isFirstPy && kb < 0 && ri > 0) {
        // The dot may close the previous line (`obj.\nfoo` inside
        // brackets). It is a member-access dot only when it follows
        // an identifier, `]` or `)` — a line ending in a float
        // literal (`x = 1.`) ends a statement, it does not continue
        // a member access, so the next line starts a new statement
        // and its first identifier is a bare read.
        var prevPy = lines[ri - 1] || '';
        var pk = prevPy.length - 1;
        while (pk >= 0 && (prevPy[pk] === ' ' || prevPy[pk] === '\t')) pk--;
        if (pk >= 0 && prevPy[pk] === '.') {
          var pq = pk - 1;
          while (pq >= 0 && (prevPy[pq] === ' ' || prevPy[pq] === '\t')) pq--;
          if (pq >= 0 && (prevPy[pq] === ']' || prevPy[pq] === ')')) isAttrPy = true;
          else if (pq >= 0 && /[A-Za-z0-9_]/.test(prevPy[pq])) {
            var ps = pq;
            while (ps >= 0 && /[A-Za-z0-9_]/.test(prevPy[ps])) ps--;
            if (/[A-Za-z_]/.test(prevPy[ps + 1])) isAttrPy = true;
          }
        }
      }
      var isCallPy = false;
      var ke = idRePy.lastIndex;
      while (ke < rl.length && (rl[ke] === ' ' || rl[ke] === '\t')) ke++;
      if (ke < rl.length && rl[ke] === '(') isCallPy = true;
      // A string prefix (`f` in f"...", `rf` in rf"...") is part of
      // the string literal, not a read of a same-named variable: the
      // raw line has a quote immediately after it (positions are
      // preserved by stripping). The flat references pass keeps its
      // old behaviour (the prefix stays a reference); only the bare
      // channel excludes it — without this, any f-string in a file
      // kept a dead local named `f` alive.
      var isStringPrefixPy = false;
      var rawPy = rawLinesPy[ri] || '';
      var afterPy = rawPy[idIdxPy + idPy.length];
      if (afterPy === "'" || afterPy === '"') isStringPrefixPy = true;
      // A class-attribute definition site: the first occurrence of
      // the assigned name is the definition, not a read — it stays a
      // flat reference (old behaviour) but is not a bare read. Later
      // occurrences on the same line (`x = x + 1`) are reads.
      var isBareDeclFirstPy = false;
      if (bareDeclared.has(idPy) && !bareDeclaredSeenPy[idPy]) {
        bareDeclaredSeenPy[idPy] = true;
        isBareDeclFirstPy = true;
      }
      if (declared.has(idPy)) {
        if (!declaredSeenPy[idPy]) { declaredSeenPy[idPy] = true; continue; }
        if (!isAttrPy && !decChainPy.has(idPy) && !isStringPrefixPy && !isBareDeclFirstPy) {
          bareReferences.add(idPy);
          if (isCallPy) bareCalls.add(idPy);
        }
        continue;
      }
      if (decChainPy.has(idPy)) continue;
      parsed.references.add(idPy);
      if (!isAttrPy && !isStringPrefixPy && !isBareDeclFirstPy) {
        bareReferences.add(idPy);
        if (isCallPy) bareCalls.add(idPy);
      }
    }
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
        if (PY_KEYWORDS.has(id)) return;
        parsed.references.add(id);
        // A string annotation is a use of the type it names (the CLI
        // records annotation-string identifiers as bare references),
        // so it keeps a same-named local alive too.
        bareReferences.add(id);
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
          if (PY_KEYWORDS.has(id)) return;
          parsed.references.add(id);
          // A TypeAlias value is a type expression (see the annotation
          // pass above), so its identifiers are bare references too.
          bareReferences.add(id);
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

  // Bare references serialize as a sorted array, like the CLI
  // (src/parse-py.js); bareCalls stays a Set, like `calls`.
  parsed.bareReferences = [...bareReferences].sort();
  parsed.bareCalls = bareCalls;

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
  // Java: a public static void main(String[]) method is the entry
  // point (mirrors src/discover.js in the CLI).
  if (/public\s+static\s+void\s+main\s*\(\s*String\s*\[/.test(raw)) return { entry: true, reason: 'has a main() method (Java entry point)' };
  return { entry: false, reason: '' };
}

/* ------------------------------------------------------------------ */
/* Java liveness (port of the scopes block in src/confidence.js)       */
/* ------------------------------------------------------------------ */

// Java same-file liveness: the Java parser records, per definition, the
// names referenced inside its body (`uses`) plus the names referenced by
// top-level code (`topLevelUses`, which runs on import). Liveness is
// reachability from live roots over that definition graph, plus the
// arity channel (usesArity / topLevelUsesArity) that tells overloads
// apart by (name, arity). Returns null when the parse predates scopes
// (no topLevelUses) — the caller then falls back to REVIEW, never SAFE.
// The shape mirrors the CLI block so a diff of the two stays readable:
// liveRootDefs (top-level uses + non-private methods + classes),
// baseKeepDef conduits, the live-class fixpoint, sameFileLiveDefs,
// javaUsedByLive (assumed-live roots live code actually uses),
// javaArityIsLive (the (name, arity) liveness test), and
// javaUtilityClasses (FJ-2).
function buildJavaLiveness(parsed, keepSymbols, isLibrary, overloadedNames) {
  if (!Array.isArray(parsed.topLevelUses) || !Array.isArray(parsed.topLevelUsesArity)) return null;
  var defsByName = Object.create(null);
  parsed.definitions.forEach(function (d) {
    if (!defsByName[d.name]) defsByName[d.name] = [];
    defsByName[d.name].push(d);
  });
  var defUses = new Map();
  parsed.definitions.forEach(function (d) { defUses.set(d, new Set(d.uses || [])); });
  // Bare-use channel (parse-java-web.js pass 4): definition -> Set<names
  // it reads by bare identifier>. Null when the parse predates the
  // channel — the field rule below then keeps the old scope-based flag.
  var defBareUses = null;
  if (Array.isArray(parsed.topLevelBareUses)) {
    defBareUses = new Map();
    parsed.definitions.forEach(function (d) { defBareUses.set(d, new Set(d.bareUses || [])); });
  }
  // Live roots: top-level code (runs on import). Java has no import
  // resolution, so there are no cross-file callers to add; the seeding
  // below supplies the rest.
  var liveRootNames = new Set(parsed.topLevelUses || []);
  var liveRootDefs = new Set();
  liveRootNames.forEach(function (name) {
    (defsByName[name] || []).forEach(function (d) { liveRootDefs.add(d); });
  });
  // Java: seed the live roots with the file's own non-private methods.
  // A non-private method is reachable from outside this file, so its
  // callees are live. Constructors count too: a non-private constructor
  // really runs from outside. Seeded per DEFINITION, not per name: a
  // private overload sharing a public method's name must not become a
  // root — its liveness is decided by the arity check. A class's field
  // initializers and static blocks run when the class loads, and the
  // tool never proves a class dead, so the class definition is a live
  // root too, and the helpers its initializers call are live through it.
  parsed.definitions.forEach(function (d) {
    if (d.kind === 'method' && d.visibility !== 'private') liveRootDefs.add(d);
    if (d.kind === 'class') liveRootDefs.add(d);
  });
  // A kept definition is a CONDUIT, not a live root: it still gets its
  // own KEEP / REVIEW finding, but the names it uses stay alive through
  // it (a framework-dispatched handler really runs, and a public-API
  // function may be called by downstream code).
  var baseKeepDef = function (d) {
    return keepSymbols
      || (d.frameworkField ? true : false)
      || (d.ambient ? true : false)
      || overloadedNames.has(d.name)
      || (parsed.dunder && parsed.dunder.has(d.name))
      || (d.kind === 'method' && d.name.indexOf('__') === 0)
      // Java: a method with any annotation (@PostConstruct, @Scheduled,
      // ...) runs by framework dispatch, an @Override method runs when
      // the supertype method is invoked, and a method of an anonymous
      // class (Runnable.run, ActionListener.actionPerformed) runs by
      // interface dispatch, never by name — all three are conduits.
      // (The framework packs' keepDecorators are subsumed here: a
      // pack-listed annotation IS an annotation on the member, and the
      // packs carry no keepNames / keepExports for Java.)
      || (d.kind === 'method' && (((d.annotations || []).length > 0) || d.anonymousClass === true))
      // Exported public API of a published library. (The CLI also
      // base-keeps exported defs of an 'unknown'-kind file; for Java
      // only classes carry exported, and classes are already live
      // roots above, so the library case is the only live one here.)
      || (d.exported && isLibrary);
  };
  var baseKeepDefs = new Set();
  parsed.definitions.forEach(function (d) { if (baseKeepDef(d)) baseKeepDefs.add(d); });
  var bfsDefs = function (seeds) {
    var seen = new Set();
    var queue = [];
    seeds.forEach(function (d) { queue.push(d); });
    while (queue.length) {
      var cur = queue.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      (defUses.get(cur) || new Set()).forEach(function (used) {
        (defsByName[used] || []).forEach(function (nxt) { if (!seen.has(nxt)) queue.push(nxt); });
      });
    }
    return seen;
  };
  var liveDefs = bfsDefs(liveRootDefs);
  var viaBaseKeptDefs = bfsDefs(baseKeepDefs);
  var classDefs = parsed.definitions.filter(function (d) { return d.kind === 'class'; });
  var liveClassNames = new Set();
  classDefs.forEach(function (d) {
    if (liveDefs.has(d) || baseKeepDefs.has(d) || viaBaseKeptDefs.has(d)) liveClassNames.add(d.name);
  });
  var enclosingClassName = function (def) {
    var best = null;
    for (var i = 0; i < classDefs.length; i++) {
      var c = classDefs[i];
      if (!c.range || !def.range) continue;
      if (c.range.startIndex <= def.range.startIndex && def.range.endIndex <= c.range.endIndex) {
        if (!best || (c.range.endIndex - c.range.startIndex) < (best.range.endIndex - best.range.startIndex)) best = c;
      }
    }
    return best ? best.name : null;
  };
  var keepDef = function (d) {
    return baseKeepDef(d)
      || (d.kind === 'method' && (enclosingClassName(d) === null || liveClassNames.has(enclosingClassName(d)))
        // Java private methods are NOT conduits: a helper called only
        // by a dead private method is dead too. An annotated private
        // method is already base-kept above, so only unannotated
        // private methods lose conduit status here.
        && !(d.visibility === 'private' && !(d.annotations || []).length));
  };
  // Fixpoint: a class reached only through a kept method's callees is
  // live too — its methods are conduits, and the names they use are
  // reachable. The loop only grows liveClassNames, bounded by the
  // number of classes in the file, so it always terminates; each round
  // can only add liveness, never a new SAFE.
  var keepDefs = new Set();
  var viaKeptDefs = new Set();
  for (;;) {
    keepDefs = new Set();
    parsed.definitions.forEach(function (d) { if (keepDef(d)) keepDefs.add(d); });
    viaKeptDefs = bfsDefs(keepDefs);
    var grew = false;
    viaKeptDefs.forEach(function (d) {
      if (d.kind === 'class' && !liveClassNames.has(d.name)) { liveClassNames.add(d.name); grew = true; }
    });
    if (!grew) break;
  }
  var sameFileLiveDefs = new Set();
  liveDefs.forEach(function (d) { sameFileLiveDefs.add(d); });
  viaKeptDefs.forEach(function (d) { sameFileLiveDefs.add(d); });
  keepDefs.forEach(function (d) { if (!liveDefs.has(d)) sameFileLiveDefs.delete(d); });
  // Java assumed-live roots (a non-private method, a class definition)
  // are live by assumption, not by use — but a root that live code
  // actually uses is used, not merely assumed: it keeps the old
  // no-finding behaviour instead of gaining a REVIEW finding.
  // javaUsedByLive is the defs some OTHER live def uses by name (a def
  // never counts as used by itself, so a self-recursive public method
  // still gets its REVIEW).
  var javaUsedByLive = new Set();
  var liveAndKept = [];
  liveDefs.forEach(function (d) { liveAndKept.push(d); });
  viaKeptDefs.forEach(function (d) { liveAndKept.push(d); });
  liveAndKept.forEach(function (e) {
    (defUses.get(e) || new Set()).forEach(function (used) {
      // 'constructor' is one shared name for every constructor in the
      // file: a this() chain and a `new` construction are
      // indistinguishable by name, so it cannot tell a chained-to
      // constructor from a constructed one — and the contract is that
      // public constructors stay REVIEW.
      if (used === 'constructor') return;
      (defsByName[used] || []).forEach(function (d) { if (d !== e) javaUsedByLive.add(d); });
    });
  });
  // Java: a private method is live only when live code calls it with a
  // matching (name, arity). The name-based sameFileLive cannot tell
  // format/1 from format/2, so private methods get their own
  // arity-aware test over the same live-scope names: calls from a
  // definition whose name is reachable from a live root or a kept
  // definition, plus top-level (class-level) calls. A method reference
  // has no visible arity and counts for every overload of the name; a
  // varargs method matches any call with arity >= its fixed arity; a
  // call from the candidate itself (pure recursion) never rescues it —
  // the exclusion is by definition identity, not by (name, arity) key,
  // so a call between two distinct overloads that share a name and an
  // arity still counts. Constructors match by (name, arity, class):
  // `new Foo()` and `this()` carry the class, `super()` carries none
  // and matches nothing in this file.
  var javaLiveScopeNames = new Set();
  liveDefs.forEach(function (d) { javaLiveScopeNames.add(d.name); });
  viaKeptDefs.forEach(function (d) { javaLiveScopeNames.add(d.name); });
  var javaArityIsLive = function (def) {
    var key = def.isConstructor
      ? 'constructor/' + def.arity + '@' + (def.className || 'super')
      : def.name + '/' + def.arity;
    var calls = new Set(parsed.topLevelUsesArity || []);
    for (var i = 0; i < parsed.definitions.length; i++) {
      var d = parsed.definitions[i];
      if (!javaLiveScopeNames.has(d.name)) continue;
      if (d === def) continue;
      (d.usesArity || []).forEach(function (u) { calls.add(u); });
    }
    if (def.isConstructor) {
      return calls.has(key) || calls.has('constructor/*@' + (def.className || 'super'));
    }
    if (calls.has(def.name + '/*')) return true;
    if (calls.has(def.name + '/' + def.arity)) return true;
    if (def.varargs) {
      var found = false;
      calls.forEach(function (c) {
        var m = c.match(/^(.+)\/(\d+)$/);
        if (m && m[1] === def.name && parseInt(m[2], 10) >= (def.fixedArity || 0)) found = true;
      });
      if (found) return true;
    }
    return false;
  };
  // Java utility classes (FJ-2): a class whose direct members are all
  // static — no instance fields, no instance methods. Members of nested
  // or anonymous classes do not count, and constructors do not count
  // (they are never static). A stale parse without the `static` /
  // `anonymousClass` fields fails open: undefined static reads as an
  // instance member, so the class is not treated as a utility class.
  var hasInstanceMember = new Map();
  parsed.definitions.forEach(function (d) {
    if (!d.className || d.anonymousClass) return;
    if (d.kind === 'method' && !d.isConstructor && d.static !== true) hasInstanceMember.set(d.className, true);
    if (d.kind === 'variable' && !d.local && d.static !== true) hasInstanceMember.set(d.className, true);
    if (!hasInstanceMember.has(d.className)) hasInstanceMember.set(d.className, false);
  });
  var javaUtilityClasses = new Set();
  hasInstanceMember.forEach(function (v, k) { if (!v) javaUtilityClasses.add(k); });
  return {
    sameFileLiveDefs: sameFileLiveDefs,
    javaUsedByLive: javaUsedByLive,
    javaArityIsLive: javaArityIsLive,
    javaUtilityClasses: javaUtilityClasses,
    defBareUses: defBareUses,
    topLevelBareUses: parsed.topLevelBareUses || null,
  };
}

// Normalize a docs/parse-java-web.js result into the shape the
// analyzer's grading loop expects: `calls` is a Set of names (like
// parseJs), `dunder` is a Set (Java has no dunder methods). The raw
// arity channel (uses / usesArity / topLevelUses / topLevelUsesArity),
// the bare channel (bareUses / topLevelBareUses / bareReferences),
// and the grading fields (readCount, writeCount, stringMention,
// annotations, classAnnotations, arity, varargs, fixedArity,
// isConstructor, className, classKind, anonymousClass, initHasEffect,
// static, native, isTestFile) pass through untouched.
function adaptJavaParsed(p) {
  if (!p) return null;
  var calls = new Set();
  (p.calls || []).forEach(function (c) { if (c && c.name) calls.add(c.name); });
  p.calls = calls;
  if (!p.dunder) p.dunder = new Set();
  if (!p.constructed) p.constructed = new Set();
  return p;
}

// Resolve the Java parser module: Node requires docs/parse-java-web.js
// (next to this file); the browser uses window.DeadcodeJava (loaded by
// a <script> tag in index.html). Returns null when neither is available.
function loadJavaModule() {
  if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
    try { return require('./parse-java-web'); } catch (_) { return null; }
  }
  if (typeof self !== 'undefined' && self.DeadcodeJava) return self.DeadcodeJava;
  return null;
}

/* ------------------------------------------------------------------ */
/* Main analysis                                                       */
/* ------------------------------------------------------------------ */

function analyzeFiles(inputFiles, options) {
  var report = analyzeFilesCore(inputFiles, options, undefined);
  // Sync path: Java files are skipped entirely (back-compat with the
  // regex-only analyzer). javaSkipped reports that honestly.
  var hasJava = false;
  (inputFiles || []).forEach(function (f) {
    if (f && typeof f.path === 'string' && /\.java$/i.test(f.path)) hasJava = true;
  });
  report.javaSkipped = hasJava;
  report.javaSkipReason = hasJava
    ? 'Java files need analyzeFilesAsync (tree-sitter WASM) — files skipped, use the CLI'
    : '';
  return report;
}

/**
 * Async entry point: analyzeFiles plus Java support. The wasm parser is
 * lazy-loaded only when a .java file is present; when it cannot load
 * (or options.javaInit === false, the test hook for "no wasm"), Java
 * files are skipped with javaSkipped set on the report — never parsed
 * with regex. analyzeFiles stays synchronous for JS/Python back-compat
 * and skips Java files entirely.
 */
async function analyzeFilesAsync(inputFiles, options) {
  options = options || {};
  var hasJava = false;
  (inputFiles || []).forEach(function (f) {
    if (f && typeof f.path === 'string' && /\.java$/i.test(f.path)) hasJava = true;
  });
  if (!hasJava) {
    var syncReport = analyzeFiles(inputFiles, options);
    syncReport.javaSkipped = false;
    syncReport.javaSkipReason = '';
    return syncReport;
  }
  var javaModule = null;
  var javaSkipReason = '';
  if (options.javaInit === false) {
    javaSkipReason = 'Java parser disabled for this run — Java files were skipped, use the CLI';
  } else {
    javaModule = loadJavaModule();
    if (!javaModule) {
      javaSkipReason = 'Java parser module not available — Java files were skipped, use the CLI';
    } else {
      try {
        var initOptions = {};
        if (options.treeSitterWasm) initOptions.treeSitterWasm = options.treeSitterWasm;
        if (options.javaWasm) initOptions.javaWasm = options.javaWasm;
        if (options.wasmDir) initOptions.wasmDir = options.wasmDir;
        await javaModule.initJava(initOptions);
      } catch (e) {
        javaModule = null;
        javaSkipReason = 'Java parser failed to load (' + (e && e.message ? e.message : String(e)) + ') — Java files were skipped, use the CLI';
      }
    }
  }
  // javaModule === null means "async, wasm unavailable": Java files are
  // still listed (parsed null) so the string index raw-falls-back on
  // them — fail-open, like the CLI does for unparseable code files —
  // and the grading loop skips them (parseError set).
  var report = analyzeFilesCore(inputFiles, options, javaModule);
  report.javaSkipped = !javaModule;
  report.javaSkipReason = javaModule ? '' : javaSkipReason;
  return report;
}

function analyzeFilesCore(inputFiles, options, javaModule) {
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
    var isJava = JAVA_EXTS.indexOf(ext) >= 0;
    if (JS_EXTS.indexOf(ext) < 0 && PY_EXTS.indexOf(ext) < 0 && !isJava) return;
    // Sync path (javaModule === undefined): Java files are skipped
    // entirely, exactly as before this change. Async path with the wasm
    // parser unavailable (javaModule === null): the file is listed with
    // parsed null, so the string index raw-falls-back on it — fail-open,
    // like the CLI does for unparseable code files — and the grading
    // loop skips it (parseError set below).
    if (isJava && javaModule === undefined) return;
    existingFiles.add(rel);
    var parsed = null;
    var parseError = null;
    try {
      if (ext === '.py') parsed = parsePy(rel, f.content);
      else if (isJava) {
        if (javaModule) {
          parsed = adaptJavaParsed(javaModule.parseJavaWeb(rel, f.content));
          if (parsed && parsed.hasErrors) parseError = 'Java parse errors (ERROR/MISSING nodes) — no findings for this file';
        } else {
          parseError = 'Java parser unavailable — file skipped, use the CLI';
        }
      } else parsed = parseJs(rel, f.content);
    } catch (_) { parsed = null; }
    files[rel] = { rel: rel, language: isJava ? 'java' : ext === '.py' ? 'py' : 'js', parsed: parsed, raw: f.content, size: f.content.length, parseError: parsed ? parseError : (parseError || 'parse failed') };
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
  // Config files that wire code by name: Spring XML, MyBatis mapper XML,
  // application.properties — a member name in one of these is a real
  // reference (Java string-mention downgrade), so they match raw text
  // like .json / .yaml do (mirrors src/graph.js RAW_MATCH_EXTS).
  var RAW_MATCH_EXTS = { '.json': true, '.yaml': true, '.yml': true, '.toml': true, '.html': true, '.vue': true, '.css': true, '.xml': true, '.properties': true };
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
      if (info && (JS_EXTS.indexOf(ext) >= 0 || PY_EXTS.indexOf(ext) >= 0 || JAVA_EXTS.indexOf(ext) >= 0)) {
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
      if (info && (JS_EXTS.indexOf(ext) >= 0 || PY_EXTS.indexOf(ext) >= 0 || JAVA_EXTS.indexOf(ext) >= 0)) {
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
      // Java: the same symbol can legitimately carry several findings
      // at different lines with different grades (two constructors, a
      // serialization callback and its wrong-arity namesake) — the CLI
      // dedupes by category:file:symbol:startLine, so the web does the
      // same for .java files. Without this, the first constructor
      // finding would swallow the SAFE one.
      : /\.java$/.test(f.file)
        ? f.category + ':' + f.file + ':' + (f.symbol || '') + ':' + (f.startLine || 0)
        : f.category + ':' + f.file + ':' + (f.symbol || '');
    if (seenKeys.has(key)) return null;
    seenKeys.add(key);
    findings.push(f);
    return f;
  }

  Object.keys(files).forEach(function (rel) {
    var info = files[rel];
    if (!info.parsed || info.parseError) return; // never flag what we could not parse
    var parsed = info.parsed;
    var isEntry = Boolean(entries[rel]);
    var isTest = TEST_FILE.test(rel) || TEST_DIR.test(rel);
    var isConfig = CONFIG_FILE.test(rel);
    var isManualScript = /(^|\/)(scripts|tools)\//.test(rel);
    var isRouteFile = ROUTE_DIR.test(rel);
    var keepFile = isEntry || isTest || isConfig || isRouteFile;
    var keepSymbols = isTest || isConfig || isManualScript || isRouteFile;
    var importerCount = (importers[rel] || new Set()).size;

    // Dead file. Java files are never dead-file candidates in this
    // landing (mirrors the CLI): there is no Java import resolution
    // yet, so no file can be proven unimported. Symbol findings inside
    // Java files still apply.
    if (info.language !== 'java' && !reachable.has(rel) && importerCount === 0) {
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
    // Java liveness, computed once per file (see buildJavaLiveness):
    // the live-scope BFS over the definition graph plus the arity
    // channel. Null when the parse predates scopes — the Java branch
    // below then falls back to REVIEW, never SAFE.
    var javaCtx = info.language === 'java'
      ? buildJavaLiveness(parsed, keepSymbols, isLibrary, overloadedNames)
      : null;
    // Bare-name channel for locals (batch 12): the parsers record
    // `bareReferences` (bare identifier reads only — never a member
    // name or a property key) and `bareCalls` (bare calls only —
    // `foo()`, never `obj.foo()`). Keyed on the channel being present,
    // not on language, so the Python parse layer plugs in with no
    // further grading change. A parse without them (stale cache, or a
    // language whose parser has not ported the channel yet) leaves
    // the sets null, and the grading below falls back to the old
    // name-based flag — fail open, never a new SAFE.
    var bareRefSet = Array.isArray(parsed.bareReferences) ? new Set(parsed.bareReferences) : null;
    var bareCallSet = parsed.bareCalls instanceof Set ? parsed.bareCalls : null;
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
      // A call from another file is a real caller too: the classic-script
      // global pass above records bare-name calls from other classic
      // scripts against the unique repo-wide definition (Django admin
      // JS), so a definition with any cross-file caller is live. A call
      // from the symbol's own file is same-file use, not an external
      // caller.
      var calledElsewhere = [];
      usage.calledIn.forEach(function (f) { if (f !== rel) calledElsewhere.push(f); });
      // A local definition can only be read by its bare name (port of
      // src/confidence.js, batch 11): a member call `obj.foo()` names
      // the member, not the local, so the old name-keyed flag — any
      // reference or call in the file — swallowed a dead local
      // whenever the file also called a same-named method. A bare
      // call `foo()` still counts, via the bare-call channel (or the
      // old flag when the parse predates it). A getter/setter is
      // invoked by property access, not by a call — `ctx.slots` runs
      // `get slots()` — so an accessor keeps the old flag: a
      // same-file reference by that name, a property read or write,
      // is a use. A local is still part of its enclosing function's
      // implementation — the cascade must not flag it merely because
      // its enclosing function is dead — only the use channel is
      // bare-name now. Java locals skip this entirely: the Java
      // branch below grades them on binding-resolved reads
      // (readCount), so a same-named method call must not keep a dead
      // Java local alive.
      var isJavaLocal = info.language === 'java' && def.local;
      var bareCallInFile = !isJavaLocal && (bareCallSet ? bareCallSet.has(def.name) : usage.calledIn.has(rel));
      var isAccessor = def.kind === 'method' && (def.isGetter || def.isSetter);
      var localSameFileUse = isJavaLocal
        ? false
        : isAccessor
          ? usage.sameFile
          : (bareRefSet ? bareRefSet.has(def.name) : usage.sameFile) || bareCallInFile;
      var sameFileUse = def.local ? localSameFileUse : (usage.sameFile || usage.calledIn.has(rel));
      // Java: name-based same-file use cannot tell overloads apart, and
      // assumed-live roots (non-private methods, classes) must not be
      // rescued by their own same-file callers — the CLI computes both
      // from the arity-aware live-scope BFS instead (buildJavaLiveness
      // above). Private methods get sameFileUse false here; the Java
      // branch below decides them with javaArityIsLive. With no
      // liveness data (stale parse), sameFileUse is false too: the Java
      // branch then falls back to REVIEW, never SAFE.
      var javaPrivateMethod = info.language === 'java' && def.kind === 'method' && def.visibility === 'private';
      var javaAssumedLive = info.language === 'java'
        && (def.kind === 'class' || (def.kind === 'method' && def.visibility !== 'private'));
      var sameFileUseEffective = sameFileUse;
      if (info.language === 'java') {
        if (def.local) {
          // Java locals grade on binding-resolved reads (readCount) in
          // the Java branch below, never on the name-based flag.
          sameFileUseEffective = false;
        } else if (javaCtx) {
          sameFileUseEffective = javaCtx.sameFileLiveDefs.has(def);
          if (javaPrivateMethod) sameFileUseEffective = false;
          else if (javaAssumedLive) sameFileUseEffective = javaCtx.javaUsedByLive.has(def);
          else if (def.kind === 'variable' && def.visibility === 'private' && javaCtx.defBareUses) {
            // A private field is live only on a bare read from live
            // code: a bare read inside a dead method (FJ-9) does not
            // count, and neither does a same-named method call from
            // live code (`foo()` calls the method, it does not read
            // the field). Top-level bare reads count too — a field
            // initializer runs at class load, and the class is a live
            // root.
            var topBare = javaCtx.topLevelBareUses || [];
            var bareLive = topBare.indexOf(def.name) >= 0;
            if (!bareLive) {
              javaCtx.sameFileLiveDefs.forEach(function (d) {
                if (d !== def && (javaCtx.defBareUses.get(d) || new Set()).has(def.name)) bareLive = true;
              });
            }
            sameFileUseEffective = bareLive;
          }
        } else {
          sameFileUseEffective = false;
        }
      }
      // Same-file use is real use: a symbol called or referenced in its
      // own file is alive, full stop — never a finding. (It used to be
      // flagged REVIEW as "unexport-to-local", which turned every
      // module's own helpers into noise.)
      //
      // Cross-file credit never belongs to a non-exported VARIABLE
      // local (port of src/confidence.js): a nested variable cannot be
      // imported or called by name from another file, so an importer
      // or caller under the same name is using a same-named top-level
      // symbol instead (or the namespace-import over-approximation,
      // which credits every definition of the target file). Function
      // and method locals are different: they CAN escape — a factory
      // that returns an object of helpers — so they keep their
      // cross-file credit. (An exported local keeps it too:
      // `export { localFn }` names it as public surface, so it is
      // graded as an export.)
      var isNonExportedVariableLocal = def.local && !def.exported && def.kind === 'variable';
      var crossFileImporters = isNonExportedVariableLocal ? [] : importedBy;
      var crossFileCallers = isNonExportedVariableLocal ? [] : calledElsewhere;
      if (crossFileImporters.length === 0 && crossFileCallers.length === 0 && sameFileUseEffective) {
        return;
      }
      if (crossFileImporters.length > 0 || crossFileCallers.length > 0) {
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
      // Java: the CLI's frameworkKeepSymbol consults every framework
      // pack for every definition (keepExports / keepNames /
      // keepDecorators) — a Java method named `save` is KEEP via
      // django.json, a @Service class via spring.json. The pack check
      // runs first, exactly as in the CLI, so its reason wins.
      if (info.language === 'java') {
        var javaFwSym = javaFrameworkKeepSymbol(def.name, def.decorators);
        if (javaFwSym) {
          add(Object.assign({}, common, { grade: 'KEEP', reason: javaFwSym }));
          return;
        }
      }
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
        add(Object.assign({}, common, { grade: 'KEEP', reason: isTest ? 'in a test file' : isConfig ? 'in a config file' : isManualScript ? 'in a manually-run script (scripts/ or tools/) — invoked by the operator, not by imports' : 'in a framework route file' }));
        return;
      }
      if (parsed.dynamic) {
        add(Object.assign({}, common, { grade: 'REVIEW', reason: '0 callers, but file uses dynamic imports/reflection (' + (parsed.dynamicReasons[0] || 'dynamic') + ') — cannot prove safe' }));
        return;
      }
      // ---- Java: private-only SAFE scope (port of src/confidence.js) ----
      // Public / protected / package-private Java members can be
      // reached from outside this file, and whole dead classes are out
      // of scope: REVIEW at most, never SAFE. Private members are
      // provable in-file, and only they can be SAFE. This branch sits
      // BEFORE the generic string-mention check below on purpose: a
      // local or parameter cannot be invoked by name from another file,
      // so a string that happens to contain its name must not demote
      // it — locals grade on binding-resolved reads alone. Non-local
      // members still get the string check, inside the branch, after
      // the more specific annotation / framework reasons. The web IS
      // the opted-in surface, so there is no --java-safe gate here:
      // a Java SAFE below is a real SAFE.
      if (info.language === 'java') {
        var javaSize = def.range ? def.range.endIndex - def.range.startIndex : 0;
        var javaCommon = function (grade, reason) {
          return Object.assign({}, common, { grade: grade, reason: reason, size: javaSize });
        };
        // Locals and parameters grade on binding-resolved reads, not
        // on the file-level reference set.
        if (def.local) {
          if ((def.readCount || 0) > 0) return; // read somewhere: live, no finding
          if (def.isParameter) {
            add(javaCommon('REVIEW', def.privateMethod ? 'unused parameter of a private method — removing it requires updating its call sites' : 'unused parameter of a non-private method — changing a public/protected signature is an API break, and removing it requires updating its call sites'));
            return;
          }
          if ((def.writeCount || 0) > 0) {
            add(javaCommon('REVIEW', 'local variable assigned but never read — deleting the declaration would leave the assignments behind'));
            return;
          }
          // A load-bearing unused local (FJ-3): the initializer calls
          // a method or creates an object, so the declaration does
          // work even though the value is never read. REVIEW, never
          // SAFE. A pure initializer stays SAFE below.
          if (def.initHasEffect) {
            add(javaCommon('REVIEW', 'unused local variable, but its initializer calls a method or creates an object — the call may have side effects, so deleting the declaration would remove the call'));
            return;
          }
          add(javaCommon('SAFE', 'unused local variable — never read or written'));
          return;
        }
        if (def.kind === 'class') {
          add(javaCommon('REVIEW', 'Java class — whole dead classes are out of scope for this tool'));
          return;
        }
        if (def.kind !== 'method' && def.kind !== 'variable') {
          add(javaCommon('REVIEW', 'Java member — REVIEW at most, never SAFE'));
          return;
        }
        if (def.visibility !== 'private') {
          add(javaCommon('REVIEW', (def.visibility === 'package' ? 'package-private' : def.visibility) + ' Java ' + (def.isConstructor ? 'constructor' : def.kind === 'method' ? 'method' : 'field') + ' — reachable from outside this file'));
          return;
        }
        // Private member from here on.
        if ((def.annotations || []).length > 0) {
          add(javaCommon('KEEP', 'annotated @' + def.annotations[0] + ' — framework-invoked, never auto-deleted'));
          return;
        }
        if (def.native) {
          add(javaCommon('KEEP', 'native method — implemented outside Java, never called from Java source'));
          return;
        }
        if (def.name === 'serialVersionUID') {
          add(javaCommon('KEEP', 'serialVersionUID — read by Java serialization, never auto-deleted'));
          return;
        }
        // Java serialization callbacks (FJ-4): private methods the
        // serialization runtime invokes by reflection. The (name,
        // arity) pair is the contract.
        if (def.kind === 'method' && !def.isConstructor && JAVA_SERIALIZATION_CALLBACKS[def.name] === def.arity) {
          add(javaCommon('KEEP', 'private ' + def.name + ' — Java serialization callback, invoked by the serialization runtime via reflection, never called from source'));
          return;
        }
        // Private enum constructor (FJ-2b): an enum's constants invoke
        // its constructor at class-load time, and the call graph
        // records that, so an invoked constructor is live and gets no
        // finding — this rule only fires for a constructor no constant
        // invokes, and even then it is KEEP, never SAFE: the
        // constructor is the wrong deletion unit for an enum.
        if (def.isConstructor && def.classKind === 'enum_declaration'
          && (!javaCtx || !javaCtx.javaArityIsLive || !javaCtx.javaArityIsLive(def))) {
          add(javaCommon('KEEP', 'private enum constructor — no enum constant invokes this constructor, but the constructor is the wrong deletion unit for an enum; delete the constant, or the enum, instead'));
          return;
        }
        // Private constructor of a utility class (FJ-2): every member
        // of the class is static, so the constructor is an
        // instantiation guard, not dead code. A constructor actually
        // called from live code is live and gets no finding — this rule
        // only fires for uncalled ones.
        if (def.isConstructor && def.className && javaCtx && javaCtx.javaUtilityClasses && javaCtx.javaUtilityClasses.has(def.className)
          && (!javaCtx.javaArityIsLive || !javaCtx.javaArityIsLive(def))) {
          add(javaCommon('KEEP', 'private constructor of utility class ' + def.className + ' — every member is static, so the constructor is an instantiation guard, not dead code; deleting it would expose a public default constructor'));
          return;
        }
        // Enclosing-class framework stereotype: the hardcoded core set
        // plus the Spring and Jackson/JPA pack lists (see
        // JAVA_FRAMEWORK_CLASS_ANNOTATIONS above).
        var fwClassAnn = null;
        (def.classAnnotations || []).forEach(function (a) {
          if (!fwClassAnn && JAVA_FRAMEWORK_CLASS_ANNOTATIONS.has(a)) fwClassAnn = a;
        });
        if (fwClassAnn) {
          add(javaCommon('REVIEW', 'enclosing class is annotated @' + fwClassAnn + ' — the framework may invoke this member'));
          return;
        }
        if (def.stringMention) {
          add(javaCommon('REVIEW', 'referenced by name in a string literal in this file — possible reflective use'));
          return;
        }
        if (stringElsewhere.length > 0) {
          add(javaCommon('REVIEW', '0 callers, but referenced by name as a string elsewhere'));
          return;
        }
        if (def.kind === 'variable') {
          if ((def.writeCount || 0) > 0) {
            add(javaCommon('REVIEW', 'private field written but never read — deleting the declaration would leave the assignments behind'));
            return;
          }
          // A load-bearing unused field (batch 11, the field analog
          // of FJ-3 for locals): the initializer calls a method or
          // creates an object, so the declaration does work even
          // though the field is never read. REVIEW, never SAFE. A
          // pure initializer stays SAFE below.
          if (def.initHasEffect) {
            add(javaCommon('REVIEW', 'unused private field, but its initializer calls a method or creates an object — the call may have side effects, so deleting the declaration would remove the call'));
            return;
          }
          add(javaCommon('SAFE', 'private field, never read or written, 0 string mentions'));
          return;
        }
        // Private method / constructor: arity-aware liveness.
        if (!javaCtx || !javaCtx.javaArityIsLive) {
          add(javaCommon('REVIEW', 'private method with 0 name-based callers, but arity data is unavailable (stale parse) — cannot prove safe'));
          return;
        }
        if (javaCtx.javaArityIsLive(def)) return; // called from live code: no finding
        add(javaCommon('SAFE', def.isConstructor ? 'private constructor, never called with this arity, 0 string mentions' : 'private method, no live callers by (name, arity), 0 string mentions'));
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
      // A TypeVar definition is REVIEW, never SAFE (see the parsePy
      // note above): a generic type variable is typing surface, and
      // deleting it would break every annotation that names it — in
      // another file, under a string annotation, or through a
      // re-export the web checker cannot see.
      if (def.kind === 'variable' && def.typeVar) {
        add(Object.assign({}, common, { grade: 'REVIEW', reason: 'TypeVar definition — a generic type variable, part of the module\'s typing surface; never auto-deleted' }));
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
            startLine: imp.range ? imp.range.startLine : 1,
            endLine: imp.range ? imp.range.endLine : null,
            size: imp.range ? imp.range.endIndex - imp.range.startIndex : 0,
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

return { analyzeFiles: analyzeFiles, analyzeFilesAsync: analyzeFilesAsync, parseJs: parseJs, parsePy: parsePy, javaFrameworkClassAnnotations: JAVA_FRAMEWORK_CLASS_ANNOTATIONS, javaSerializationCallbacks: JAVA_SERIALIZATION_CALLBACKS, javaPackKeepExports: JAVA_PACK_KEEP_EXPORTS, javaPackKeepNames: JAVA_PACK_KEEP_NAMES, javaPackKeepDecoratorsList: JAVA_PACK_KEEP_DECORATORS_LIST };

});
