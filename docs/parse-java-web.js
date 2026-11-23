(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.DeadcodeJava = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

'use strict';

/**
 * Java parser for the web checker, built on web-tree-sitter
 * (web-tree-sitter 0.22.5) + the tree-sitter-java 0.23.5 grammar wasm.
 *
 * This file is a port of the CLI's src/parse-java.js to the web
 * binding, regenerated from it (see the port script in the batch-10
 * work notes) so the two cannot drift silently: same four passes,
 * same result shape, same grading-relevant fields. Only the parser
 * acquisition (initJava, async) and the parse call (whole-string
 * parse(src)) differ. test/web-analyzer.test.js re-runs the parse
 * differential harness against the CLI parser, so a drift fails a
 * test instead of shipping a false SAFE.
 *
 * Pinned versions: web-tree-sitter 0.22.5 (tree-sitter.js +
 * tree-sitter.wasm, vendored in docs/vendor/) and tree-sitter-java 0.23.5
 * (tree-sitter-java.wasm, vendored in docs/vendor/). Lazy-loaded only when a
 * .java file is present; on any load failure the caller degrades to
 * "Java files skipped - use the CLI", never to regex parsing.
 *
 * Java parser built on tree-sitter (tree-sitter-java 0.23.5, pinned).
 *
 * Same output shape as the JS/Python parsers: imports, exports,
 * definitions, references, calls, dynamic, strings, unreachable,
 * decorators — plus the Java-only fields the confidence engine needs:
 * visibility, annotations, arity, varargs, native, isConstructor,
 * className, classAnnotations, writeCount, stringMention, and the
 * arity channel (usesArity / topLevelUsesArity) that lets overloads
 * be told apart by (name, arity) without a type resolver.
 *
 * ERROR-node policy: a file whose parse contains ERROR or MISSING
 * nodes yields no findings at all (fail open). The result keeps only
 * its string literals — so a name mentioned in a broken file can
 * still protect the same name elsewhere — and sets hasErrors, which
 * the graph turns into a parse error for the file.
 *
 * Read vs write on fields (spike gap 1): a bare identifier or a
 * field access on the left-hand side of a plain `=` assignment is a
 * WRITE, never a read — it adds no reference and no occurrence, so a
 * write-only field is not reported live. Compound assignment (+=),
 * update expressions (++/--) and every other position are reads. A
 * same-named parameter or local shadows the field: a bare identifier
 * that resolves to an enclosing binding is a use of that binding, not
 * of the field. Qualified access (this.field) always means the field.
 */

// Web-tree-sitter acquisition (async, lazy): the browser loads the
// vendored tree-sitter.js via a <script> tag (window.TreeSitter) and
// fetches both wasm files as bytes; Node reads the vendored files from
// disk. Parser.init({ wasmBinary }) + Language.load(Uint8Array) never
// call WebAssembly.instantiateStreaming, so the application/wasm
// Content-Type of the host is irrelevant. On ANY load failure the
// caller degrades to "Java files skipped - use the CLI" and never falls
// back to regex parsing. The parser is cached for the page lifetime.
// NOTE: the vendored tree-sitter.js exports the Parser class itself
// (module.exports = TreeSitter, where TreeSitter is the Parser class
// with static init() / Language): there is no .Parser property on it,
// in Node or in the browser (window.TreeSitter is the same class).
let ParserClass = null;
let JavaLanguage = null;
let parser = null;
let initPromise = null;

function getTreeSitter() {
  if (typeof self !== 'undefined' && self.TreeSitter) return self.TreeSitter;
  if (typeof window !== 'undefined' && window.TreeSitter) return window.TreeSitter;
  if (typeof require === 'function') return require('./vendor/tree-sitter.js');
  throw new Error('web-tree-sitter loader (tree-sitter.js) is not available');
}
// The loader file exports the Parser class itself, not an object with
// a .Parser property (see the NOTE above).

function toUint8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) return new Uint8Array(bytes);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes);
}

// Load one wasm file as bytes. Precedence: explicit bytes in options,
// then a Node disk read (options.wasmDir, else docs/vendor/ next to
// this file), or a browser fetch (options.wasmDir, else 'vendor/'),
// then fetch (browser, relative to the page). options keys:
// treeSitterWasm / javaWasm (Uint8Array or Buffer), wasmDir (string).
async function loadWasmBytes(options, fileName, optionKey) {
  options = options || {};
  if (options[optionKey]) return options[optionKey];
  if (typeof require === 'function') {
    const fs = require('fs');
    const path = require('path');
    const base = options.wasmDir || (typeof __dirname !== 'undefined' ? path.join(__dirname, 'vendor') : 'vendor');
    return fs.readFileSync(path.join(base, fileName));
  }
  if (typeof fetch === 'function') {
    const prefix = options.wasmDir || 'vendor';
    const url = prefix.replace(/\/$/, '') + '/' + fileName;
    const res = await fetch(url);
    if (!res.ok) throw new Error('could not download ' + fileName + ' (HTTP ' + res.status + ')');
    return new Uint8Array(await res.arrayBuffer());
  }
  throw new Error('no way to load ' + fileName + ' in this environment');
}

async function initJava(options) {
  if (parser) return parser;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    ParserClass = getTreeSitter();
    const tsBytes = await loadWasmBytes(options, 'tree-sitter.wasm', 'treeSitterWasm');
    const javaBytes = await loadWasmBytes(options, 'tree-sitter-java.wasm', 'javaWasm');
    await ParserClass.init({ wasmBinary: toUint8(tsBytes) });
    JavaLanguage = await ParserClass.Language.load(toUint8(javaBytes));
    parser = new ParserClass();
    parser.setLanguage(JavaLanguage);
    return parser;
  })();
  try {
    await initPromise;
  } catch (e) {
    initPromise = null;
    throw e;
  }
  return parser;
}

function isJavaReady() {
  return Boolean(parser);
}

function languageVersion() {
  return JavaLanguage ? JavaLanguage.version : null;
}

function rangeOf(node) {
  return {
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

// The web binding has no 32 KiB string limit, so parse() takes the
// whole source string: no chunked callback, no surrogate-pair handling.

function text(node, src) {
  return src.slice(node.startIndex, node.endIndex);
}

function walk(node, fn) {
  fn(node);
  for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i), fn);
}

function childByField(node, field) {
  try { return node.childForFieldName(field); } catch (_) { return null; }
}

// See parse-js.js: node wrapper identity is not stable across calls in
// this tree-sitter binding, so node sameness is compared by position.
function sameNode(a, b) {
  return Boolean(a && b && a.startIndex === b.startIndex && a.endIndex === b.endIndex);
}

const CLASS_NODE_TYPES = new Set([
  'class_declaration', 'record_declaration', 'interface_declaration',
  'enum_declaration', 'annotation_type_declaration',
]);

// Framework stereotypes on an enclosing class: the framework reflects
// over the class's private members (generated accessors read fields,
// lifecycle methods run by dispatch), so members are REVIEW at most,
// never SAFE. Lombok code generation (@Data, @Getter, @Setter, ...)
// reads fields through generated accessors; Spring/JPA stereotypes
// mark container-managed classes. The check is annotation-name based,
// not a fixed framework list — any annotation on the member itself
// already keeps it (see confidence.js). This set is the fallback for
// the core stereotypes and Lombok; the wider Spring and Jackson/JPA
// lists live as data in frameworks/spring.json and
// frameworks/jackson-jpa.json (keepClassAnnotations), which
// confidence.js consults alongside this set.
const FRAMEWORK_CLASS_ANNOTATIONS = new Set([
  'Data', 'Getter', 'Setter', 'Value', 'Builder',
  'AllArgsConstructor', 'NoArgsConstructor', 'RequiredArgsConstructor',
  'EqualsAndHashCode', 'ToString',
  'Service', 'Component', 'Controller', 'RestController', 'Repository',
  'SpringBootApplication', 'Configuration', 'Entity', 'Embeddable',
  'MappedSuperclass',
]);

// Annotation simple name: `@com.foo.Bar("x")` -> `Bar`, `@Getter` -> `Getter`.
function annotationSimpleName(node, src) {
  const nameNode = childByField(node, 'name');
  if (!nameNode) return '';
  const raw = text(nameNode, src);
  return raw.split('.').pop();
}

// Simple name of a type named in a {@code} tag: the last segment of
// a dotted name, with any #member part stripped. `#method()` (a member
// of the current class) names no type and is ignored, as are targets
// that are not plain identifiers after stripping (quoted strings,
// `<a href=...>` links). Generics and call parens are stripped, so
// `{@code List<String>}` names `List`. Only a capitalized name counts:
// {@code} holds arbitrary code (variable names, keywords, literals
// such as `{@code context}` or `{@code null}`), and only a capitalized
// name can be a type resolving through an import — a lowercase token
// must never count as a use of a same-named variable.
function javadocSimpleName(raw) {
  if (!raw || raw.startsWith('#') || raw.startsWith('<') || raw.startsWith('"')) return null;
  let target = raw.split('#')[0];
  target = target.replace(/[<(\[].*$/, '');
  target = target.replace(/^@/, '');
  target = target.replace(/[^A-Za-z0-9_$]+$/, '');
  if (!target) return null;
  const simple = target.split('.').pop();
  return /^[A-Z][A-Za-z0-9_$]*$/.test(simple) ? simple : null;
}

// Types named by a {@link} / {@linkplain} / {@value} / @see target
// (or by an @throws / @exception tag): the type before any #member —
// every uppercase-initial segment of its dotted name, so a nested
// type such as TestInstance.Lifecycle names both types, while package
// segments (lowercase by convention) are ignored — and every type in
// the member's parameter list, so
// {@link JsonReader#setStrictness(Strictness)} names Strictness and
// @see TestReporter#publishFile(Path, MediaType) names Path and
// MediaType. A leading # (a member of the current class) names no
// type itself, but its parameter list still can.
function javadocTagNames(target, add) {
  if (!target) return;
  const hash = target.indexOf('#');
  const before = hash === -1 ? target : target.slice(0, hash);
  const clean = before.replace(/[<(\[].*$/, '').replace(/^@/, '').replace(/[^A-Za-z0-9_$]+$/, '');
  if (clean) {
    for (const part of clean.split('.')) {
      if (/^[A-Z]/.test(part) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) add(part);
    }
  }
  const paren = target.indexOf('(');
  if (paren !== -1) {
    const inside = target.slice(paren + 1).split(')')[0];
    for (const m of inside.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g)) {
      const simple = m[0].split('.').pop();
      if (/^[A-Z]/.test(simple)) add(simple);
    }
  }
}

// First token of a Javadoc tag's content, where whitespace inside
// parentheses does not split: a method signature may contain spaces
// after commas, as in {@link Foo#bar(String, int)}.
function javadocTagTarget(content) {
  const text = content.trimStart();
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if ((c === ' ' || c === '\t' || c === '\n' || c === '\r') && depth === 0) return text.slice(0, i);
  }
  return text;
}

// Modifiers live in a `modifiers` child; annotations may sit inside it
// or directly on the declaration. Both placements are collected.
function modifiersOf(node, src) {
  const mods = { private: false, static: false, final: false, native: false, annotations: [], decorators: [] };
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === 'modifiers') {
      // Test the modifier keyword nodes themselves, never the raw
      // text: a comment sitting between two modifiers (`public
      // /* private */ static`) or a word inside an annotation's
      // string argument (`@Anno("private")`) used to flip the flags
      // through the raw-text regexes. Modifier keywords are anonymous
      // children of the modifiers node, and their type IS the keyword;
      // comments and annotations are named children, never keywords.
      for (let j = 0; j < c.childCount; j++) {
        const m = c.child(j);
        if (m.type === 'private') mods.private = true;
        else if (m.type === 'static') mods.static = true;
        else if (m.type === 'final') mods.final = true;
        else if (m.type === 'native') mods.native = true;
        else if (m.type === 'marker_annotation' || m.type === 'annotation') {
          mods.annotations.push(annotationSimpleName(m, src));
          mods.decorators.push(`@${annotationSimpleName(m, src)}`);
        }
      }
    } else if (c.type === 'marker_annotation' || c.type === 'annotation') {
      mods.annotations.push(annotationSimpleName(c, src));
      mods.decorators.push(`@${annotationSimpleName(c, src)}`);
    }
  }
  return mods;
}

// Comments are named nodes in tree-sitter-java, so they appear as
// named children of argument_list and formal_parameters: a `//`
// comment after an argument (or between parameters) inflates
// namedChildCount, and a call's recorded arity no longer matches its
// declaration — a 3-arg call with trailing `//` comments records
// arity 7 and its private callee looks uncalled. Count only real
// nodes, never comments.
const COMMENT_NODE_TYPES = new Set(['line_comment', 'block_comment', 'comment']);
function isComment(node) {
  return Boolean(node) && COMMENT_NODE_TYPES.has(node.type);
}
function firstNonCommentChild(node) {
  if (!node) return null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!isComment(c)) return c;
  }
  return null;
}
function lastNonCommentChild(node) {
  if (!node) return null;
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const c = node.namedChild(i);
    if (!isComment(c)) return c;
  }
  return null;
}

// The class a `new` expression or `::new` reference actually
// constructs: for a generic type, the base name — never a type
// argument — and for a qualified name, the last segment. Splitting
// the raw type text on non-word characters and taking the LAST
// identifier took the last type argument instead:
// `new TypeToken<List<Tweet>>()` recorded forClass=Tweet, and
// `new java.util.ArrayList<String>()` recorded String.
function constructedClassName(node, src) {
  if (!node) return null;
  if (node.type === 'generic_type') {
    const base = node.namedChild(0);
    return base && base.type !== 'type_arguments' ? constructedClassName(base, src) : null;
  }
  if (node.type === 'scoped_type_identifier') {
    return constructedClassName(node.namedChild(node.namedChildCount - 1), src);
  }
  if (node.type === 'field_access') {
    const f = childByField(node, 'field');
    return f ? text(f, src) : null;
  }
  if (node.type === 'type_identifier' || node.type === 'identifier') return text(node, src);
  const parts = text(node, src).split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}
// Number of real arguments in an argument_list: every named child
// except comments. (Arguments are expressions; nothing else legal
// sits in the list.)
function argumentArity(args) {
  if (!args) return 0;
  let n = 0;
  for (let i = 0; i < args.namedChildCount; i++) {
    if (!isComment(args.namedChild(i))) n++;
  }
  return n;
}

// (name, arity) of a method/constructor declaration. The last
// parameter of a varargs method is a spread_parameter: it still counts
// as one parameter, and fixedArity is the count before it — a call
// site with arity >= fixedArity can match it.
function arityOf(node) {
  const params = childByField(node, 'parameters');
  if (!params) return { arity: 0, varargs: false, fixedArity: 0 };
  let arity = 0;
  let varargs = false;
  for (let i = 0; i < params.namedChildCount; i++) {
    const p = params.namedChild(i);
    if (p.type === 'spread_parameter') { varargs = true; arity++; }
    else if (p.type === 'formal_parameter') arity++;
    // Comments and receiver parameters are not parameters a caller
    // passes: a `//` comment between parameters, or an explicit
    // receiver (`Foo this`), must not inflate the arity.
  }
  return { arity, varargs, fixedArity: varargs ? arity - 1 : arity };
}

function parseJavaWeb(filePath, src) {
  if (!parser) throw new Error('parseJavaWeb called before initJava (web-tree-sitter not loaded)');
  const tree = parser.parse(src);
  const root = tree.rootNode;

  const result = {
    language: 'java',
    imports: [],
    exports: [],
    definitions: [],
    references: new Set(),
    calls: [],
    dynamic: false,
    dynamicReasons: [],
    dynamicImports: [],
    strings: [],
    unreachable: [],
    decorators: [],
    hasJsx: false,
    hasErrors: false,
  };

  // --- pass 0: ERROR / MISSING nodes fail the file open. ---
  // String literals are still collected: a name mentioned in a broken
  // file must still protect the same name elsewhere.
  let hasError = false;
  walk(root, (node) => {
    if (node.type === 'ERROR' || node.isMissing) hasError = true;
    if (node.type === 'string_literal') result.strings.push(text(node, src));
  });
  // Bare-name references (see the addRef block below): a bare
  // identifier or type-name read, never a method name. Declared here
  // so the Javadoc pass below can join it, and the error early-return
  // can report an empty set.
  const bareReferences = new Set();
  if (hasError) {
    result.hasErrors = true;
    result.topLevelUses = [];
    result.topLevelUsesArity = [];
    result.bareReferences = [];
    result.topLevelBareUses = [];
    return result;
  }

  // --- pass 0b: Javadoc references (FJ-1). ---
  // Types named in /** ... */ comments — {@link X}, {@linkplain X},
  // {@code X}, {@value X}, @see X and @throws / @exception X — resolve
  // through the file's imports, so an import used only there is live:
  // removing it breaks Javadoc compilation (javadoc fails on an
  // unresolvable {@link} target, and links @throws / @value types too).
  // Only names inside those tags count: plain prose words in a
  // comment are not references. A doc mention is a reference for the
  // import check only — it is NOT an occurrence, so it never lands in
  // a definition's uses or in topLevelUses, where it would wrongly
  // make a same-named definition a live root.
  const addDocRef = (name) => { if (name) { result.references.add(name); bareReferences.add(name); } };
  walk(root, (node) => {
    if (node.type !== 'block_comment') return;
    const comment = text(node, src);
    if (!comment.startsWith('/**')) return;
    for (const m of comment.matchAll(/\{@link(?:plain)?\s+([^}]+)\}/g)) javadocTagNames(javadocTagTarget(m[1]), addDocRef);
    for (const m of comment.matchAll(/\{@value\s+([^}]+)\}/g)) javadocTagNames(javadocTagTarget(m[1]), addDocRef);
    for (const m of comment.matchAll(/\{@code\s+([^\s}]+)/g)) addDocRef(javadocSimpleName(m[1]));
    for (const m of comment.matchAll(/@see\s+([^\n]+)/g)) javadocTagNames(javadocTagTarget(m[1]), addDocRef);
    for (const m of comment.matchAll(/@(?:throws|exception)\s+([^\s}]+)/g)) javadocTagNames(m[1], addDocRef);
  });

  const occurrences = []; // { name, startIndex } — general channel (reads + calls)
  const arityOccurrences = []; // { key, startIndex } — "name/arity" / "name/*"
  const writeCounts = new Map(); // name -> number of plain-`=` writes
  const addRef = (name, node, startIndex) => {
    if (!name) return;
    result.references.add(name);
    occurrences.push({ name, startIndex: startIndex !== undefined ? startIndex : (node ? node.startIndex : 0) });
  };
  // Bare-name references: a bare identifier or type-name read, never
  // the name of a method invocation or method reference (`foo()` calls
  // the method `foo`; it does not read a field or local of that name).
  // Same role as in parse-js.js / parse-py.js: a private field's only
  // read signal was the name-keyed same-file flag, so a same-named
  // method call kept a dead field alive. The set itself is declared
  // above the Javadoc pass; Javadoc tag names join it too, preserving
  // the old fail-open behaviour for names a doc comment mentions.
  // bareOccurrences is the positioned twin of the bare set, so pass 4
  // can attribute each bare read to the definition that contains it
  // (a bare read inside a dead method must not keep a field alive).
  const bareOccurrences = [];
  const addBareRef = (name, node, startIndex) => {
    if (!name) return;
    addRef(name, node, startIndex);
    bareReferences.add(name);
    bareOccurrences.push({ name, startIndex: startIndex !== undefined ? startIndex : (node ? node.startIndex : 0) });
  };
  const addArityOcc = (key, startIndex) => {
    if (!key) return;
    arityOccurrences.push({ key, startIndex });
  };

  // Per-class info, from the class stack: the nearest named enclosing
  // class (anonymous classes have no name and inherit the outer
  // class's annotations for the framework check).
  const classStack = [];
  // Anonymous-class depth: an anonymous class body (an
  // object_creation_expression with a class body, or an enum constant
  // with a class body) is not a class_declaration node, so the class
  // stack never sees it — without this counter every method declared
  // inside `new TypeAdapter<..>() { ... }` was attributed to the
  // outer class as a direct instance member, and anonymousClass was
  // always false. traverse() maintains it; addDef reads it.
  let anonDepth = 0;
  const currentClass = () => {
    for (let i = classStack.length - 1; i >= 0; i--) {
      if (classStack[i].name) return classStack[i];
    }
    return { name: null, annotations: [], node: null };
  };
  const isTestFile = /(^|\/)src\/test\/java\//.test(filePath.replace(/\\/g, '/'))
    || /Test\.java$/.test(filePath.replace(/\\/g, '/').split('/').pop());

  const addDef = (name, kind, node, extra) => {
    if (!name) return null;
    const cls = currentClass();
    const def = {
      name, kind, exported: false, isDefault: false,
      range: rangeOf(node), startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      decorators: [], annotations: [],
      local: false,
      visibility: 'public',
      className: cls.name,
      classAnnotations: [...cls.annotations],
      // Kind of the nearest named enclosing class ('class_declaration',
      // 'enum_declaration', ...) — the enum-constructor rule in
      // confidence.js needs it (an enum's constants invoke its
      // constructor at class-load time, with no call-graph edge).
      classKind: cls.kind || null,
      // True when the member is declared inside an anonymous class
      // body: its className is the outer named class (anonymous
      // classes have no name), so the utility-class check must not
      // count it as a direct member of that outer class, and the
      // method-conduit rule in confidence.js treats it as dispatched
      // by interface, never by name.
      anonymousClass: anonDepth > 0,
      isTestFile,
      _readCount: 0,
      _writeCount: 0,
      ...(extra || {}),
    };
    result.definitions.push(def);
    return def;
  };

  // --- pass 1: structure (classes, methods, fields, imports, locals) ---
  // A recursive traversal that tracks the enclosing class, so each
  // member is attributed to its class and visited exactly once. The
  // class stack also feeds addDef's className / classAnnotations.
  function traverse(node) {
    const isClass = CLASS_NODE_TYPES.has(node.type);
    let pushed = null;
    if (isClass) {
      const nameNode = childByField(node, 'name');
      const mods = modifiersOf(node, src);
      pushed = { name: nameNode ? text(nameNode, src) : null, annotations: mods.annotations, node, kind: node.type };
      classStack.push(pushed);
      // A public class is part of the file's public surface (its
      // members may be called from outside the repo); a
      // package-private class is not. Methods never carry exported —
      // the method-conduit rule in confidence.js decides that from
      // the enclosing class instead.
      if (nameNode) {
        const def = addDef(text(nameNode, src), 'class', node, {
          visibility: mods.private ? 'private' : (hasPublicModifier(node, src) ? 'public' : 'package'),
          annotations: mods.annotations,
          decorators: mods.decorators,
        });
        // A public class is part of the file's public surface (its
        // members may be called from outside the repo); a
        // package-private class is not. Methods never carry exported —
        // the method-conduit rule in confidence.js decides that from
        // the enclosing class instead.
        if (def) def.exported = hasPublicModifier(node, src);
      }
    }
    const anonPushed = opensAnonymousClass(node);
    if (anonPushed) anonDepth++;
    collectMember(node);
    for (let i = 0; i < node.namedChildCount; i++) traverse(node.namedChild(i));
    if (anonPushed) anonDepth--;
    if (pushed) classStack.pop();
  }

  // True when this node opens an anonymous class body: an
  // object_creation_expression with a class body (`new Foo() { ... }`)
  // or an enum constant with a class body (`A { ... }`). The body is
  // a plain `class_body` child, not a named field, so it is found by
  // scanning children. traverse() bumps anonDepth for the subtree,
  // so defs declared inside are marked anonymousClass (see addDef).
  function opensAnonymousClass(node) {
    if (node.type !== 'object_creation_expression' && node.type !== 'enum_constant') return false;
    for (let i = 0; i < node.namedChildCount; i++) {
      if (node.namedChild(i).type === 'class_body') return true;
    }
    return false;
  }

  // True when the declaration carries a real `public` modifier
  // keyword. The raw-text regex used to match the word inside a
  // comment between modifiers too (`static /* public */ final`),
  // promoting a package-private member to public.
  function hasPublicModifier(node, srcText) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type !== 'modifiers') continue;
      for (let j = 0; j < c.childCount; j++) {
        if (c.child(j).type === 'public') return true;
      }
    }
    return false;
  }

  function collectMember(node) {
    if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
      const isCtor = node.type === 'constructor_declaration';
      const nameNode = childByField(node, 'name');
      const name = isCtor ? 'constructor' : (nameNode ? text(nameNode, src) : null);
      if (!name) return;
      const mods = modifiersOf(node, src);
      const { arity, varargs, fixedArity } = arityOf(node);
      const hasBody = Boolean(childByField(node, 'body'));
      const cls = currentClass();
      const def = addDef(name, 'method', node, {
        visibility: mods.private ? 'private' : (hasPublicModifier(node, src) ? 'public' : 'package'),
        annotations: mods.annotations,
        decorators: mods.decorators,
        native: mods.native,
        static: mods.static,
        arity, varargs, fixedArity,
        isConstructor: isCtor,
        javaName: isCtor ? (nameNode ? text(nameNode, src) : cls.name) : name,
      });
      // Formal parameters are definitions only when the method has a
      // body: a native / abstract / interface method's parameters are
      // part of its signature, never deletable. Record components
      // (record_declaration parameters) are public API, not params.
      if (hasBody) {
        const params = childByField(node, 'parameters');
        if (params) {
          for (let i = 0; i < params.namedChildCount; i++) {
            const p = params.namedChild(i);
            if (p.type !== 'formal_parameter' && p.type !== 'spread_parameter') continue;
            const pName = p.type === 'spread_parameter'
              ? (() => { const v = firstNamed(p, 'variable_declarator'); return v ? childByField(v, 'name') : null; })()
              : childByField(p, 'name');
            if (!pName) continue;
            addDef(text(pName, src), 'variable', p, {
              local: true, isParameter: true, privateMethod: mods.private,
              visibility: 'private',
              annotations: [], decorators: [],
            });
          }
        }
      }
    } else if (node.type === 'field_declaration') {
      const mods = modifiersOf(node, src);
      const declarators = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        if (node.namedChild(i).type === 'variable_declarator') declarators.push(node.namedChild(i));
      }
      for (const d of declarators) {
        const nameNode = childByField(d, 'name');
        if (!nameNode) continue;
        addDef(text(nameNode, src), 'variable', declarators.length === 1 ? node : d, {
          visibility: mods.private ? 'private' : (hasPublicModifier(node, src) ? 'public' : 'package'),
          annotations: mods.annotations,
          decorators: mods.decorators,
          static: mods.static,
          multiDeclarator: declarators.length > 1,
          // The whole declaration, so --fix can delete the statement
          // when every declarator in it is dead (see fix.js).
          statementRange: declarators.length > 1 ? rangeOf(node) : null,
          // True when the initializer may run user code or change
          // state (a method call, an object creation, an assignment
          // or update inside it): deleting the declaration would
          // remove that call, so the field is load-bearing, not dead
          // (batch 11, the field analog of the FJ-3 local rule). A
          // pure initializer (a literal, a name, arithmetic) is
          // false and grades normally. Field initializers run when
          // the class loads / an instance is created, so the call
          // runs even though the field is never read.
          initHasEffect: initializerHasEffect(childByField(d, 'value')),
        });
      }
    } else if (node.type === 'local_variable_declaration') {
      // Locals are definitions scoped to their enclosing method (the
      // confidence engine grades them by binding-resolved reads, not
      // by the file-level reference set — see pass 2). A declaration
      // with one declarator deletes as a whole statement; with several,
      // each declarator deletes with its comma.
      const declarators = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        if (node.namedChild(i).type === 'variable_declarator') declarators.push(node.namedChild(i));
      }
      // The enclosing method's visibility decides whether a local is a
      // candidate at all (locals live and die with their method, so
      // they are graded on their own reads, not on the method).
      const enclosing = enclosingMethod(node);
      for (const d of declarators) {
        const nameNode = childByField(d, 'name');
        if (!nameNode) continue;
        addDef(text(nameNode, src), 'variable', declarators.length === 1 ? node : d, {
          local: true,
          visibility: 'private',
          privateMethod: enclosing ? enclosing.private : false,
          multiDeclarator: declarators.length > 1,
          statementRange: declarators.length > 1 ? rangeOf(node) : null,
          // True when the initializer may run user code or change
          // state (a method call, an object creation, an assignment
          // or update inside it): deleting the declaration would
          // remove that call, so the local is load-bearing, not dead
          // (FJ-3). A pure initializer (a literal, a name, arithmetic
          // over locals) is false and grades normally.
          initHasEffect: initializerHasEffect(childByField(d, 'value')),
        });
      }
    } else if (node.type === 'import_declaration') {
      const raw = text(node, src);
      const m = raw.match(/^import\s+(static\s+)?([\w.]+)(\.\*)?\s*;/);
      if (!m) return;
      const full = m[2];
      const onDemand = Boolean(m[3]);
      const simple = full.split('.').pop();
      result.imports.push({
        names: onDemand
          ? [{ imported: '*', local: '*', kind: 'namespace' }]
          : [{ imported: full, local: simple, kind: 'named' }],
        source: full, range: rangeOf(node), sideEffect: false, onDemand,
        staticImport: Boolean(m[1]),
      });
    } else if (node.type === 'marker_annotation' || node.type === 'annotation') {
      result.decorators.push(`@${annotationSimpleName(node, src)}`);
    }
  }

  // True when a local variable's initializer may run user code or
  // change state, so the declaration is load-bearing even when the
  // variable is never read (FJ-3): a method invocation, an object
  // creation (its constructor runs), an assignment or an update
  // expression anywhere in the initializer. The walk descends into
  // arguments and operands — they evaluate when the declaration
  // runs — but never into a lambda body or an anonymous class body:
  // that code runs later, if ever, so a call inside it is not an
  // effect of this declaration. A null value (no initializer) and a
  // pure initializer (a literal, a name, arithmetic) are false.
  function initializerHasEffect(valueNode) {
    if (!valueNode) return false;
    let effect = false;
    const visit = (n) => {
      if (!n || effect) return;
      if (n.type === 'lambda_expression') return;
      if (n.type === 'method_invocation' || n.type === 'object_creation_expression'
        || n.type === 'assignment_expression' || n.type === 'update_expression') {
        effect = true;
      }
      const anonBody = n.type === 'object_creation_expression' ? childByField(n, 'body') : null;
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (anonBody && sameNode(c, anonBody)) continue;
        visit(c);
      }
    };
    visit(valueNode);
    return effect;
  }

  function firstNamed(node, type) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === type) return c;
    }
    return null;
  }

  // Nearest enclosing method/constructor (for a local's privateMethod
  // flag): walks up past blocks and statements.
  function enclosingMethod(node) {
    let a = node.parent;
    while (a) {
      if (a.type === 'method_declaration' || a.type === 'constructor_declaration') {
        const mods = modifiersOf(a, src);
        return { private: mods.private, node: a };
      }
      if (CLASS_NODE_TYPES.has(a.type) || a.type === 'program') return null;
      a = a.parent;
    }
    return null;
  }

  traverse(root);

  // --- pass 1b: binding scopes for shadowing ---
  // Map: scope-node startIndex -> [{ name, start, end, def }]. A scope
  // is a method/constructor (its parameters), a lambda (its
  // parameters), or a block-like node (locals declared directly in it),
  // an enhanced for (its loop variable), a catch clause (its parameter).
  // A binding shadows a field use only after its declaration and inside
  // its scope — a use before the declaration still means the field.
  const scopesByStart = new Map();
  const addBinding = (scopeNode, name, start, def) => {
    if (!name || !scopeNode) return;
    const key = scopeNode.startIndex;
    if (!scopesByStart.has(key)) scopesByStart.set(key, []);
    scopesByStart.get(key).push({ name, start, end: scopeNode.endIndex, def: def || null });
  };
  const defByParamNode = new Map(); // param node start -> def object
  for (const d of result.definitions) {
    if (d.isParameter) defByParamNode.set(d.range.startIndex, d);
  }
  const defByLocalNode = new Map(); // declarator node start -> def object
  for (const d of result.definitions) {
    if (d.local && !d.isParameter) defByLocalNode.set(d.range.startIndex, d);
  }
  // Local defs created with the whole-statement range (single
  // declarator) key by the declarator, not the statement: rebuild the
  // map from the declarator positions found in pass 1 by walking again
  // for local_variable_declaration nodes.
  walk(root, (node) => {
    if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
      const params = childByField(node, 'parameters');
      if (params) {
        for (let i = 0; i < params.namedChildCount; i++) {
          const p = params.namedChild(i);
          if (p.type !== 'formal_parameter' && p.type !== 'spread_parameter') continue;
          const pName = p.type === 'spread_parameter'
            ? (() => { const v = firstNamed(p, 'variable_declarator'); return v ? childByField(v, 'name') : null; })()
            : childByField(p, 'name');
          if (!pName) continue;
          addBinding(node, text(pName, src), p.startIndex, defByParamNode.get(p.startIndex) || null);
        }
      }
    } else if (node.type === 'lambda_expression') {
      const params = childByField(node, 'parameters');
      if (params) {
        if (params.type === 'formal_parameters') {
          for (let i = 0; i < params.namedChildCount; i++) {
            const p = params.namedChild(i);
            if (p.type !== 'formal_parameter' && p.type !== 'spread_parameter') continue;
            const pName = p.type === 'spread_parameter'
              ? (() => { const v = firstNamed(p, 'variable_declarator'); return v ? childByField(v, 'name') : null; })()
              : childByField(p, 'name');
            if (pName) addBinding(node, text(pName, src), p.startIndex, null);
          }
        } else if (params.type === 'identifier') {
          addBinding(node, text(params, src), params.startIndex, null);
        }
      }
    } else if (node.type === 'block' || node.type === 'constructor_body') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const stmt = node.namedChild(i);
        if (stmt.type === 'local_variable_declaration') {
          for (let j = 0; j < stmt.namedChildCount; j++) {
            const d = stmt.namedChild(j);
            if (d.type !== 'variable_declarator') continue;
            const n = childByField(d, 'name');
            if (n) addBinding(node, text(n, src), d.startIndex, defByLocalNode.get(d.startIndex) || findLocalDef(d));
          }
        }
      }
    } else if (node.type === 'for_statement') {
      const init = childByField(node, 'init');
      if (init && init.type === 'local_variable_declaration') {
        for (let j = 0; j < init.namedChildCount; j++) {
          const d = init.namedChild(j);
          if (d.type !== 'variable_declarator') continue;
          const n = childByField(d, 'name');
          if (n) addBinding(node, text(n, src), d.startIndex, defByLocalNode.get(d.startIndex) || findLocalDef(d));
        }
      }
    } else if (node.type === 'switch_block_statement_group') {
      // A local declared in a switch case (`case 0: int x = ...`) is
      // NOT a direct child of a block — it lives in the case group —
      // so the block branch above never registers it, and its reads
      // never resolve: readCount stayed 0 and the local was flagged
      // SAFE even though live code reads it (gson's JsonReader
      // pathIndex). Scope it to the enclosing switch block, which is
      // its JLS scope (it stays visible to later cases), not just the
      // group.
      const switchBlock = node.parent && node.parent.type === 'switch_block' ? node.parent : null;
      if (switchBlock) {
        for (let i = 0; i < node.namedChildCount; i++) {
          const stmt = node.namedChild(i);
          if (stmt.type === 'local_variable_declaration') {
            for (let j = 0; j < stmt.namedChildCount; j++) {
              const d = stmt.namedChild(j);
              if (d.type !== 'variable_declarator') continue;
              const n = childByField(d, 'name');
              if (n) addBinding(switchBlock, text(n, src), d.startIndex, defByLocalNode.get(d.startIndex) || findLocalDef(d));
            }
          }
        }
      }
    } else if (node.type === 'enhanced_for_statement') {
      const n = childByField(node, 'name');
      if (n) addBinding(node, text(n, src), n.startIndex, null);
    } else if (node.type === 'catch_clause') {
      const param = firstNamed(node, 'catch_formal_parameter');
      const n = param ? childByField(param, 'name') : null;
      if (n) addBinding(node, text(n, src), n.startIndex, null);
    }
  });

  // A single-declarator local's def range is the whole statement, so
  // the declarator-start lookup above misses it: find the def whose
  // range contains the declarator and whose name matches.
  function findLocalDef(declaratorNode) {
    const n = childByField(declaratorNode, 'name');
    if (!n) return null;
    const name = text(n, src);
    for (const d of result.definitions) {
      if (d.local && !d.isParameter && d.name === name
        && d.range.startIndex <= declaratorNode.startIndex
        && declaratorNode.endIndex <= d.range.endIndex) return d;
    }
    return null;
  }

  // --- pass 2 (actual): single recursive walk, class stack + scopes ---
  const isDefinitionSite = (node) => {
    // Identifiers inside an import statement are module paths and
    // bound names, never references — without this, every imported
    // name leaked into `references` and no unused Java import was
    // ever flagged. A package statement's NAME is a path too — but
    // only the name: annotations on the package declaration
    // (package-info.java `@NullMarked`) are real uses of the imported
    // annotation type, so they must not be swallowed with it. The
    // child of the declaration on the path from this node tells which
    // part it belongs to: the package name is a scoped_identifier /
    // identifier, an annotation is a marker_annotation / annotation.
    let ancestor = node.parent;
    while (ancestor) {
      if (ancestor.type === 'import_declaration') return true;
      if (ancestor.type === 'package_declaration') {
        // Node wrappers are not stable across calls in this binding
        // (see sameNode), so the walk stops on position equality,
        // never on wrapper identity.
        let child = node;
        let a = node.parent;
        while (a && !sameNode(a, ancestor)) { child = a; a = a.parent; }
        return child.type === 'scoped_identifier' || child.type === 'identifier';
      }
      ancestor = ancestor.parent;
    }
    const p = node.parent;
    if (!p) return false;
    if (p.type === 'variable_declarator' && sameNode(childByField(p, 'name'), node)) return true;
    if ((p.type === 'formal_parameter' || p.type === 'spread_parameter') && sameNode(childByField(p, 'name'), node)) return true;
    if (CLASS_NODE_TYPES.has(p.type) && sameNode(childByField(p, 'name'), node)) return true;
    if ((p.type === 'method_declaration' || p.type === 'constructor_declaration') && sameNode(childByField(p, 'name'), node)) return true;
    // Annotation names are NOT definition sites: `@JsonProperty` is a
    // use of the imported annotation type, so an import used only by
    // an annotation is live — deleting it would break compilation.
    // (Qualified annotation names were already counted, because their
    // leaf identifier's parent is the scoped name, not the annotation;
    // only the simple `@Name` form was excluded, and it was wrongly
    // reported as an unused import at SAFE.)
    if (p.type === 'enum_constant' && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'enhanced_for_statement' && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'catch_formal_parameter' && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'instanceof_expression' && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'type_pattern' && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'labeled_statement' && sameNode(firstNonCommentChild(p), node)) return true;
    if (p.type === 'resource' && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'method_invocation' && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'method_reference') {
      // The LAST named child is the referenced method name; earlier
      // children are the object (a real read, e.g. `obj::m` reads obj).
      // A trailing comment would otherwise be picked up as the last
      // child and the name treated as a reference.
      const last = lastNonCommentChild(p);
      if (last && sameNode(last, node)) return true;
    }
    return false;
  };

  // True when the identifier node is the write target of a plain `=`
  // assignment: either the bare left-hand side, or the `field` of a
  // field_access that IS the left-hand side. The object of that access
  // (and every deeper field of a chained access) is a read.
  const plainAssignOp = (assignNode) => {
    const left = childByField(assignNode, 'left');
    const right = childByField(assignNode, 'right');
    if (!left || !right) return false;
    return src.slice(left.endIndex, right.startIndex).trim() === '=';
  };
  const isPlainAssignTarget = (node) => {
    const p = node.parent;
    if (!p) return false;
    if (p.type === 'field_access' && sameNode(childByField(p, 'field'), node)) {
      const gp = p.parent;
      return Boolean(gp && gp.type === 'assignment_expression'
        && sameNode(childByField(gp, 'left'), p)
        && plainAssignOp(gp));
    }
    if (p.type === 'assignment_expression' && sameNode(childByField(p, 'left'), node)) {
      return plainAssignOp(p);
    }
    return false;
  };

  // Scope stack for pass 2: entries { name, start, end, def }.
  const scopeStack = [];
  const resolveBinding = (name, pos) => {
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      for (const b of scopeStack[i]) {
        if (b.name === name && b.start < pos && pos < b.end) return b;
      }
    }
    return null;
  };
  const SCOPE_NODE_TYPES = new Set([
    'method_declaration', 'constructor_declaration', 'lambda_expression',
    'block', 'constructor_body', 'for_statement', 'enhanced_for_statement',
    'catch_clause', 'switch_block',
  ]);

  // visitNode handles one node (class-stack push/pop + scope push/pop +
  // the node-type cases above, inlined via handleNode) and recurses.
  // The handler is split out so the class stack stays correct while
  // visit() recurses: handleNode does the per-node work, and this walk
  // owns the recursion.
  function handleNode(node) {
    if (node.type === 'identifier') {
      if (!isDefinitionSite(node)) {
        const name = text(node, src);
        if (isPlainAssignTarget(node)) {
          writeCounts.set(name, (writeCounts.get(name) || 0) + 1);
          const b = resolveBinding(name, node.startIndex);
          if (b && b.def) b.def._writeCount += 1;
        } else {
          const b = resolveBinding(name, node.startIndex);
          if (b) {
            if (b.def) b.def._readCount += 1;
          } else {
            addBareRef(name, node);
          }
        }
      }
    } else if (node.type === 'type_identifier') {
      if (!isDefinitionSite(node)) addBareRef(text(node, src), node);
    } else if (node.type === 'method_invocation') {
      const nameNode = childByField(node, 'name');
      if (nameNode) {
        const name = text(nameNode, src);
        const args = childByField(node, 'arguments');
        const arity = argumentArity(args);
        result.calls.push({ name, full: name, line: node.startPosition.row + 1, startIndex: node.startIndex, arity });
        addRef(name, nameNode);
        addArityOcc(`${name}/${arity}`, node.startIndex);
      }
    } else if (node.type === 'method_reference') {
      // A `::new` reference constructs, and `new` is an ANONYMOUS
      // child: the last named child is the type, never 'new' — the old
      // `name === 'new'` test never fired, so `TypeToken::new`
      // recorded a phantom method call named TypeToken, and
      // `Outer.Inner::new` recorded nothing at all. Detect the
      // anonymous `new` child directly; anything else is a plain
      // method reference, whose last named child is the method name.
      // First / last named child, skipping comments: a `//` comment
      // before the type or after the name would otherwise be picked
      // up as the name or the type and the reference silently dropped.
      let isNew = false;
      for (let i = 0; i < node.childCount; i++) {
        if (node.child(i).type === 'new') { isNew = true; break; }
      }
      if (isNew) {
        const first = firstNonCommentChild(node);
        const forClass = constructedClassName(first, src);
        result.calls.push({ name: 'constructor', full: 'constructor', line: node.startPosition.row + 1, startIndex: node.startIndex, arity: null, forClass, methodRef: true });
        addArityOcc(`constructor/*@${forClass || 'super'}`, node.startIndex);
        // The class name is a real reference: the identifier child of
        // a `::new` reference is a definition site (the last named
        // child, since `new` is anonymous), so the walk never records
        // it — without this, `LinkedHashMap::new` left the import
        // looking unused and it was flagged SAFE. The old phantom
        // method call accidentally supplied this reference via addRef.
        if (forClass && first) addBareRef(forClass, first);
      } else {
        const last = lastNonCommentChild(node);
        if (last && last.type === 'identifier') {
          const name = text(last, src);
          result.calls.push({ name, full: name, line: node.startPosition.row + 1, startIndex: node.startIndex, arity: null, methodRef: true });
          addRef(name, last);
          addArityOcc(`${name}/*`, node.startIndex);
        }
      }
    } else if (node.type === 'object_creation_expression') {
      const typeNode = childByField(node, 'type');
      const args = childByField(node, 'arguments');
      if (typeNode) {
        const forClass = constructedClassName(typeNode, src);
        const arity = argumentArity(args);
        result.calls.push({ name: 'constructor', full: 'constructor', line: node.startPosition.row + 1, startIndex: node.startIndex, arity, forClass });
        addArityOcc(`constructor/${arity}@${forClass || 'super'}`, node.startIndex);
      }
    } else if (node.type === 'explicit_constructor_invocation') {
      const ctor = childByField(node, 'constructor');
      const args = childByField(node, 'arguments');
      const arity = argumentArity(args);
      const raw = ctor ? text(ctor, src) : '';
      if (raw === 'this') {
        const cls = currentClass();
        result.calls.push({ name: 'constructor', full: 'constructor', line: node.startPosition.row + 1, startIndex: node.startIndex, arity, forClass: cls.name });
        addArityOcc(`constructor/${arity}@${cls.name || 'super'}`, node.startIndex);
      } else if (raw === 'super') {
        result.calls.push({ name: 'constructor', full: 'constructor', line: node.startPosition.row + 1, startIndex: node.startIndex, arity, forClass: null });
        addArityOcc(`constructor/${arity}@super`, node.startIndex);
      }
    } else if (node.type === 'enum_constant') {
      // An enum constant invokes its enum's constructor: `FOO(1, 2)`
      // calls the 2-arg constructor, and a bare `FOO` (or one with a
      // class body but no arguments) calls the no-arg one.
      // Constructors are never called by name, so without this the
      // enum's constructor looks uncalled and is flagged SAFE.
      const args = childByField(node, 'arguments');
      const cls = currentClass();
      const arity = argumentArity(args);
      result.calls.push({ name: 'constructor', full: 'constructor', line: node.startPosition.row + 1, startIndex: node.startIndex, arity, forClass: cls.name });
      addArityOcc(`constructor/${arity}@${cls.name || 'super'}`, node.startIndex);
    }
  }

  function walk2(node) {
    const isClass = CLASS_NODE_TYPES.has(node.type);
    if (isClass) {
      const nameNode = childByField(node, 'name');
      const mods = modifiersOf(node, src);
      classStack.push({ name: nameNode ? text(nameNode, src) : null, annotations: mods.annotations, node, kind: node.type });
    }
    let pushed = false;
    if (SCOPE_NODE_TYPES.has(node.type) && scopesByStart.has(node.startIndex)) {
      scopeStack.push(scopesByStart.get(node.startIndex));
      pushed = true;
    }
    handleNode(node);
    for (let i = 0; i < node.namedChildCount; i++) walk2(node.namedChild(i));
    if (pushed) scopeStack.pop();
    if (isClass) classStack.pop();
  }
  walk2(root);

  // --- pass 3: unreachable code (statements after return/throw/break/continue) ---
  // Java's compiler rejects most unreachable code, so this fires rarely;
  // when it does (a file that does not compile), the statement is still
  // dead code. One shape DOES compile: `if (false) { ... }` is the
  // JLS conditional-compilation exception (14.21), so its consequence
  // is unreachable-but-legal and is flagged too. Only block-like
  // bodies are scanned for the after-return case.
  walk(root, (node) => {
    if (node.type === 'block' || node.type === 'constructor_body') {
      let terminated = false;
      for (let i = 0; i < node.namedChildCount; i++) {
        const stmt = node.namedChild(i);
        if (stmt.type === 'comment' || stmt.type === 'block_comment' || stmt.type === 'line_comment') continue;
        if (terminated) {
          const t = text(stmt, src).trim();
          if (t) {
            result.unreachable.push({ range: rangeOf(stmt), line: stmt.startPosition.row + 1, reason: 'code after return/throw/break/continue', snippet: t.slice(0, 120) });
          }
        }
        if (['return_statement', 'throw_statement', 'break_statement', 'continue_statement'].includes(stmt.type)) terminated = true;
      }
    }
    if (node.type === 'if_statement') {
      const cond = childByField(node, 'condition');
      // First real child of the parenthesized condition: a comment
      // before `false` would otherwise be namedChild(0) and the
      // `if (false)` branch missed.
      const firstCond = cond && cond.type === 'parenthesized_expression' ? firstNonCommentChild(cond) : null;
      const isFalse = Boolean(cond
        && ((firstCond && firstCond.type === 'false')
          || cond.type === 'false'));
      if (isFalse) {
        result.unreachable.push({ range: rangeOf(node), line: node.startPosition.row + 1, reason: 'if (false) branch is never taken', snippet: text(node, src).slice(0, 120) });
      }
    }
  });

  // Per-definition string mentions (same file): a name in any string
  // literal is a possible reflective use (getDeclaredMethod("x")).
  const allStrings = result.strings.join('\n');
  const stringMention = (name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(allStrings);
  for (const d of result.definitions) {
    d.stringMention = (d.kind === 'method' || d.kind === 'variable') ? stringMention(d.name) : false;
    d.writeCount = (d._writeCount || 0) + (writeCounts.get(d.name) || 0);
    d.readCount = d._readCount || 0;
    delete d._readCount;
    delete d._writeCount;
  }

  // --- pass 4: per-definition reference scopes (same-file cascade) ---
  // Same shape as parse-js.js / parse-py.js pass 4: a reference belongs
  // to the innermost definition whose range contains it; references
  // outside every definition are top-level uses. Calls contribute
  // their callee name the same way, and their (name, arity) key to the
  // arity channel the confidence engine uses for overloads.
  for (const c of result.calls) {
    occurrences.push({ name: c.name, startIndex: c.startIndex !== undefined ? c.startIndex : -1 });
  }
  // Variable definitions are NOT scopes — see parse-js.js pass 4: an
  // initializer runs in the enclosing scope, so references inside a
  // variable's range belong to the enclosing definition (or the top
  // level), never to the variable itself.
  const scopeDefs = result.definitions.filter((d) => d.kind !== 'variable');
  const defsByStart = [...scopeDefs].sort((a, b) => a.range.startIndex - b.range.startIndex);
  const usesByDef = new Map();
  const arityByDef = new Map();
  const topLevelUses = new Set();
  const topLevelUsesArity = new Set();
  // Attribute one occurrence to the innermost definition containing
  // it, or to the top level when no definition does.
  const attributeInto = (map, top, startIndex, name) => {
    if (startIndex < 0) {
      top.add(name);
      return;
    }
    let best = null;
    for (const d of defsByStart) {
      if (d.range.startIndex > startIndex) break;
      if (startIndex < d.range.endIndex) {
        if (!best || (d.range.endIndex - d.range.startIndex) < (best.range.endIndex - best.range.startIndex)) best = d;
      }
    }
    if (best) {
      if (!map.has(best)) map.set(best, new Set());
      map.get(best).add(name);
    } else top.add(name);
  };
  const attribute = (list, startIndex, name, isArity) => {
    attributeInto(isArity ? arityByDef : usesByDef, isArity ? topLevelUsesArity : topLevelUses, startIndex, name);
  };
  for (const occ of occurrences) attribute(occ, occ.startIndex, occ.name, false);
  for (const occ of arityOccurrences) attribute(occ, occ.startIndex, occ.key, true);
  // Bare occurrences attribute the same way, into their own channel:
  // a bare read of a field inside a dead method must not keep the
  // field alive, so the confidence engine needs bare uses per live
  // definition, not just the file-level bare set.
  const bareUsesByDef = new Map();
  const topLevelBareUses = new Set();
  for (const occ of bareOccurrences) attributeInto(bareUsesByDef, topLevelBareUses, occ.startIndex, occ.name);
  for (const d of result.definitions) {
    d.uses = [...(usesByDef.get(d) || [])].sort();
    d.usesArity = [...(arityByDef.get(d) || [])].sort();
    d.bareUses = [...(bareUsesByDef.get(d) || [])].sort();
  }
  result.topLevelUses = [...topLevelUses].sort();
  result.topLevelUsesArity = [...topLevelUsesArity].sort();
  result.bareReferences = [...bareReferences].sort();
  result.topLevelBareUses = [...topLevelBareUses].sort();

  // De-duplicate definitions (a node visited twice via two paths).
  const seen = new Set();
  result.definitions = result.definitions.filter((d) => {
    const k = `${d.name}:${d.range.startIndex}:${d.range.endIndex}:${d.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return result;
}

return { parseJavaWeb, initJava, isJavaReady, languageVersion, FRAMEWORK_CLASS_ANNOTATIONS };

});
