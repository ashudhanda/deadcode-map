'use strict';

/**
 * JS / TS parser built on tree-sitter.
 *
 * Produces, per file:
 *   imports     [{ names: [{imported, local, kind}], source, range, sideEffect }]
 *   exports     [{ name, local, kind, range }]
 *   definitions [{ name, kind, exported, range, startLine, endLine, isDefault }]
 *   references  Set<string>  — identifier / member / JSX names used in the file
 *   calls       [{ name, line }] — callee names (identifier or member property)
 *   dynamic     boolean — dynamic import() / require(variable) / lazy loading
 *   strings     string[] — string literal contents (for the string-reference pass)
 *   unreachable [{ range, line, reason }]
 *   decorators  string[] — decorator names (Angular / Nest / etc.)
 */

const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const TypeScript = require('tree-sitter-typescript');

const parsers = new Map();

function parserFor(ext) {
  if (!parsers.has(ext)) {
    const p = new Parser();
    if (ext === '.ts') p.setLanguage(TypeScript.typescript);
    else if (ext === '.tsx') p.setLanguage(TypeScript.tsx);
    else p.setLanguage(JavaScript);
    parsers.set(ext, p);
  }
  return parsers.get(ext);
}

function rangeOf(node) {
  return {
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

// tree-sitter 0.21's node binding rejects string inputs of 32 KiB or
// more (parse() throws "Invalid argument" at exactly 32768 bytes), so
// a large file failed to parse at all and was silently treated as live:
// fastapi's 271 KiB routing.py was invisible, none of its imports
// existed, and everything it alone used looked dead. Parse through the
// callback form instead, which has no size limit: tree-sitter asks for
// slices by offset. The callback receives UTF-16 code-unit offsets
// (the binding works in JS string units throughout — node positions
// are UTF-16 offsets too), so slices come from the JS string, NOT from
// a UTF-8 buffer: slicing the buffer by those offsets misaligns the
// stream after any multi-byte character and corrupts the parse. The
// callback must return chunks under 32 KiB (the same limit applies to
// returned strings), hence 8 KiB slices; a chunk end that would split
// a surrogate pair is pulled back by one unit. The callback form is
// used for every file, small or large, so the behaviour is uniform.
const PARSE_CHUNK = 8192;
function parseSource(parser, src) {
  return parser.parse((index) => {
    let end = Math.min(index + PARSE_CHUNK, src.length);
    if (end > index && end < src.length) {
      const prev = src.charCodeAt(end - 1);
      if (prev >= 0xD800 && prev <= 0xDBFF) end -= 1;
    }
    return src.slice(index, end);
  });
}

function text(node, src) {
  return src.slice(node.startIndex, node.endIndex);
}

function walk(node, fn) {
  fn(node);
  for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i), fn);
}

function firstNamed(node, type) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === type) return c;
  }
  return null;
}

function childByField(node, field) {
  try { return node.childForFieldName(field); } catch (_) { return null; }
}

// Node wrapper identity is NOT stable across calls in this tree-sitter
// binding: childForFieldName('name') can return a different object for
// the same underlying node on different parses, so `===` on nodes is
// non-deterministic. Compare positions instead — two nodes are the same
// node only when they start and end at the same byte offsets.
function sameNode(a, b) {
  return Boolean(a && b && a.startIndex === b.startIndex && a.endIndex === b.endIndex);
}

function parseJsTs(filePath, src, ext) {
  const parser = parserFor(ext);
  const tree = parseSource(parser, src);
  const root = tree.rootNode;

  // --- JSX-pragma decision (kept identical in src/parse-js.js and
  // docs/analyzer.js — the CLI tree-sitter parser and the web regex
  // parser must agree, or the web checker and the CLI disagree about
  // the same file).
  //
  // Rule: in a file that contains JSX, an imported name that is a
  // known JSX-pragma binding counts as used, even though its name
  // never appears in the source text. In a file with no JSX, the same
  // import is flaggable as usual.
  //
  // Why: the classic JSX transform calls the pragma factory for every
  // element — React.createElement, preact's h / createElement, the
  // fragment factory Fragment — and the automatic runtime calls
  // jsx / jsxs / jsxDEV. The factory is chosen at build level
  // (tsconfig "jsx" / "jsxFactory" / "jsxFragmentFactory", a babel
  // preset, or a per-file @jsx comment), which a per-file parser
  // cannot see: nothing in one file says whether its JSX compiles to
  // h() calls (pragma import required in scope) or to jsx-runtime
  // calls (no pragma import needed). Treating a pragma binding as
  // transform-used whenever the file has JSX is the only
  // false-positive-safe rule — deleting a pragma import the classic
  // transform needs breaks the build, while keeping a genuinely dead
  // one in an automatic-runtime project only misses a finding, never
  // a wrong delete. That matches this project's rule that SAFE false
  // positives must stay at 0%.
  //
  // What counts as a pragma name: React (React.createElement),
  // createElement (preact / jsxFactory), h (preact classic pragma),
  // Fragment (jsxFragmentFactory, <>...</> fragments), jsx, jsxs,
  // jsxDEV (automatic runtimes). What does NOT count: memo,
  // Component, Suspense, lazy — a higher-order component, a base
  // class and lazy-loading helpers are never called by the transform,
  // so an unused memo import is still flaggable in a JSX file.
  //
  // Only imported bindings get the credit: the name is added to the
  // file's references only when it is actually an import local. A
  // top-level local definition cannot share the name (an import
  // binding and a top-level definition of the same name is a
  // redeclaration), but a nested local of the same name shares the
  // file-level reference set and would look used — a missed finding,
  // never a false SAFE.
  const JSX_PRAGMA_NAMES = new Set([
    'React', 'createElement', 'h', 'Fragment', 'jsx', 'jsxs', 'jsxDEV',
  ]);

  const result = {
    language: 'js',
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
    // True when the file uses module syntax (import / export / require /
    // module.exports / dynamic import). A file without it is a classic
    // script: its top-level declarations are page globals, callable by
    // bare name from other classic scripts (Django admin JS). `export {}`
    // and `module.exports = {}` count even though they bind no names.
    hasModuleSyntax: false,
  };

  const definedNames = new Set();
  const addDef = (name, kind, node, extra) => {
    if (!name) return;
    definedNames.add(name);
    const decs = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === 'decorator') decs.push(text(c, src));
    }
    // `declare module '../x' { interface StoreMutators ... }` is
    // declaration merging: the interface augments another module's type,
    // so the declaration IS the use — it is KEEP, never SAFE.
    let ambient = false;
    let a = node.parent;
    let steps = 0;
    while (a && steps < 8) {
      if (a.type === 'ambient_declaration') { ambient = true; break; }
      a = a.parent;
      steps++;
    }
    // A definition nested inside a function body is a local of that
    // function (a nested function, a variable assigned in a body): it
    // is scoped to its enclosing function, not to the module. The
    // cascade must not flag it merely because its enclosing function
    // is dead — the local is part of that function's implementation,
    // and deleting the function deletes the local with it. Walk up
    // past statement wrappers to the nearest function-like ancestor;
    // a class boundary or the program ends the walk (a method's
    // locals are still locals — the method itself is found first).
    let enclosing = node.parent;
    let isLocal = false;
    while (enclosing) {
      if (['function_declaration', 'function_expression', 'arrow_function', 'method_definition'].includes(enclosing.type)) { isLocal = true; break; }
      if (['program', 'class_declaration', 'abstract_class_declaration', 'export_statement'].includes(enclosing.type)) break;
      enclosing = enclosing.parent;
    }
    result.definitions.push({
      name, kind, exported: false, isDefault: false,
      range: rangeOf(node), startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1, decorators: decs, ambient, local: isLocal, ...(extra || {}),
    });
  };

  // --- pass 1: structure (imports / exports / definitions / decorators) ---
  walk(root, (node) => {
    switch (node.type) {
      case 'import_statement': {
        result.hasModuleSyntax = true;
        const sourceNode = firstNamed(node, 'string');
        const source = sourceNode ? text(sourceNode, src).replace(/^['"`]|['"`]$/g, '') : '';
        const names = [];
        let sideEffect = true;
        walk(node, (n) => {
          if (n.type === 'import_clause') {
            sideEffect = false;
            for (let i = 0; i < n.namedChildCount; i++) {
              const c = n.namedChild(i);
              if (c.type === 'identifier') names.push({ imported: 'default', local: text(c, src), kind: 'default' });
              else if (c.type === 'namespace_import') {
                const id = firstNamed(c, 'identifier');
                if (id) names.push({ imported: '*', local: text(id, src), kind: 'namespace' });
              } else if (c.type === 'named_imports') {
                for (let j = 0; j < c.namedChildCount; j++) {
                  const s = c.namedChild(j);
                  if (s.type !== 'import_specifier') continue;
                  const nameNode = childByField(s, 'name');
                  const aliasNode = childByField(s, 'alias');
                  const imported = nameNode ? text(nameNode, src) : '';
                  const local = aliasNode ? text(aliasNode, src) : imported;
                  names.push({ imported, local, kind: 'named' });
                }
              }
            }
          }
        });
        result.imports.push({ names, source, range: rangeOf(node), sideEffect });
        break;
      }
      case 'export_statement': {
        result.hasModuleSyntax = true;
        const decl = firstNamed(node, 'lexical_declaration')
          || firstNamed(node, 'function_declaration')
          || firstNamed(node, 'class_declaration')
          || firstNamed(node, 'variable_declaration')
          || firstNamed(node, 'type_alias_declaration')
          || firstNamed(node, 'interface_declaration')
          || firstNamed(node, 'abstract_class_declaration')
          || firstNamed(node, 'enum_declaration');
        const clause = firstNamed(node, 'export_clause');
        const isDefault = /\bdefault\b/.test(text(node, src).slice(0, 20));
        // `export * from './x'` / `export * as ns from './x'` — a barrel
        // re-export: the target's exports are live through this file, so
        // record it as a (namespace) import edge. Without this the whole
        // barrel subtree looked dead.
        const starMatch = text(node, src).match(/^\s*export\s+\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s*)?from\s*['"]([^'"]+)['"]/);
        if (starMatch) {
          const alias = starMatch[1];
          result.imports.push({
            names: [{ imported: '*', local: alias || '*', kind: 'namespace' }],
            source: starMatch[2], range: rangeOf(node), sideEffect: false, reExport: true,
          });
          if (alias) result.exports.push({ name: alias, local: alias, kind: 'namespace', range: rangeOf(node), isDefault: false });
          break;
        }
        if (clause) {
          for (let i = 0; i < clause.namedChildCount; i++) {
            const s = clause.namedChild(i);
            if (s.type !== 'export_specifier') continue;
            const nameNode = childByField(s, 'name');
            const aliasNode = childByField(s, 'alias');
            const local = nameNode ? text(nameNode, src) : '';
            const exported = aliasNode ? text(aliasNode, src) : local;
            result.exports.push({ name: exported, local, kind: 'named', range: rangeOf(node), isDefault: false });
          }
          const srcNode = firstNamed(node, 'string');
          if (srcNode) {
            // export ... from './x' — a re-export, not a local definition.
            result.imports.push({
              names: result.exports.slice(-clause.namedChildCount).map((e) => ({ imported: e.local, local: e.name, kind: 'named' })),
              source: text(srcNode, src).replace(/^['"`]|['"`]$/g, ''),
              range: rangeOf(node), sideEffect: false, reExport: true,
            });
          }
        } else if (decl) {
          // export function foo / export const foo / export class Foo
          const nameNode = childByField(decl, 'name')
            || (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration'
              ? (() => { const d = firstNamed(decl, 'variable_declarator'); return d ? childByField(d, 'name') : null; })()
              : null);
          const name = nameNode ? text(nameNode, src) : (isDefault ? 'default' : '');
          if (name) {
            result.exports.push({ name, local: name, kind: isDefault ? 'default' : 'named', range: rangeOf(node), isDefault });
          }
        } else if (isDefault) {
          result.exports.push({ name: 'default', local: 'default', kind: 'default', range: rangeOf(node), isDefault: true });
        }
        break;
      }
      case 'function_declaration': {
        const nameNode = childByField(node, 'name');
        if (nameNode) addDef(text(nameNode, src), 'function', node);
        break;
      }
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const nameNode = childByField(node, 'name');
        if (nameNode) addDef(text(nameNode, src), 'class', node);
        break;
      }
      case 'type_alias_declaration':
      case 'interface_declaration':
      case 'enum_declaration': {
        const nameNode = childByField(node, 'name');
        if (nameNode) addDef(text(nameNode, src), 'type', node);
        break;
      }
      case 'variable_declarator': {
        const nameNode = childByField(node, 'name');
        const valueNode = childByField(node, 'value');
        if (nameNode && nameNode.type === 'identifier') {
          const vtype = valueNode ? valueNode.type : '';
          let kind = 'variable';
          if (vtype === 'arrow_function' || vtype === 'function_expression') kind = 'function';
          else if (vtype === 'class_expression') kind = 'class';
          addDef(text(nameNode, src), kind, node.parent && node.parent.type === 'lexical_declaration' ? node.parent : node);
        }
        break;
      }
      case 'method_definition':
      case 'method_signature': {
        const nameNode = childByField(node, 'name');
        if (nameNode) {
          // A getter/setter is invoked by property access, not by a
          // call: `get slots()` runs when code reads `ctx.slots`. The
          // first child of a getter/setter definition is the anonymous
          // `get`/`set` keyword; a plain method has none. The flag
          // lets the grader credit a same-file property access as a
          // use (a plain method needs a bare read or a bare call).
          const first = node.child(0);
          const accessor = first && (first.type === 'get' || first.type === 'set') ? first.type : null;
          addDef(text(nameNode, src), 'method', node, accessor === 'get' ? { isGetter: true } : accessor === 'set' ? { isSetter: true } : undefined);
        }
        break;
      }
      case 'decorator': {
        result.decorators.push(text(node, src));
        break;
      }
      case 'jsx_element':
      case 'jsx_self_closing_element':
        result.hasJsx = true;
        break;
      default:
        break;
    }
  });

  // --- CommonJS: require() imports + module.exports ---
  walk(root, (node) => {
    if (node.type === 'call_expression') {
      const fn = childByField(node, 'function');
      if (fn && text(fn, src) === 'require') {
        result.hasModuleSyntax = true;
        const args = firstNamed(node, 'arguments');
        const firstArg = args ? args.namedChild(0) : null;
        if (firstArg && firstArg.type === 'string') {
          const source = text(firstArg, src).replace(/^['"`]|['"`]$/g, '');
          const names = [];
          const declarator = node.parent && node.parent.type === 'variable_declarator' ? node.parent : null;
          if (declarator) {
            const nameNode = childByField(declarator, 'name');
            if (nameNode) {
              if (nameNode.type === 'identifier') names.push({ imported: 'default', local: text(nameNode, src), kind: 'default' });
              else if (nameNode.type === 'object_pattern') {
                for (let i = 0; i < nameNode.namedChildCount; i++) {
                  const p = nameNode.namedChild(i);
                  if (p.type === 'shorthand_property_identifier_pattern') names.push({ imported: text(p, src), local: text(p, src), kind: 'named' });
                  else if (p.type === 'pair_pattern') {
                    const key = childByField(p, 'key');
                    const val = childByField(p, 'value');
                    if (key && val) names.push({ imported: text(key, src), local: text(val, src), kind: 'named' });
                  }
                }
              }
            }
          }
          result.imports.push({ names, source, range: rangeOf(node.parent || node), sideEffect: names.length === 0 });
        }
      }
    }
    if (node.type === 'assignment_expression') {
      const left = childByField(node, 'left');
      const right = childByField(node, 'right');
      if (left && /^module\.exports|^exports\./.test(text(left, src))) result.hasModuleSyntax = true;
      if (left && right && text(left, src) === 'module.exports' && right.type === 'object') {
        for (let i = 0; i < right.namedChildCount; i++) {
          const p = right.namedChild(i);
          if (p.type === 'shorthand_property_identifier') {
            result.exports.push({ name: text(p, src), local: text(p, src), kind: 'named', range: rangeOf(node), isDefault: false });
          } else if (p.type === 'pair') {
            const key = childByField(p, 'key');
            const val = childByField(p, 'value');
            if (key) result.exports.push({ name: text(key, src), local: val ? text(val, src) : text(key, src), kind: 'named', range: rangeOf(node), isDefault: false });
          }
        }
      }
    }
  });

  // Mark exported definitions.
  const exportNames = new Map(); // local name -> export entry
  for (const e of result.exports) exportNames.set(e.local, e);
  for (const d of result.definitions) {
    if (exportNames.has(d.name)) {
      d.exported = true;
      d.isDefault = Boolean(exportNames.get(d.name).isDefault);
    }
  }
  // `export default function foo()` — the function_declaration is a child of
  // export_statement, so it was already collected; the default flag above covers it.

  // --- pass 2: references, calls, strings, dynamic imports ---
  // Reference occurrences with positions, for per-definition scopes
  // (same-file cascade): which definition body each reference sits in.
  // `references` stays the flat file-level set; occurrences are the
  // positioned twin used to build each definition's `uses` list.
  const occurrences = [];
  // Bare-name references: identifiers read as values, type names, JSX
  // component names and shorthand properties — never a member/property
  // name (`obj.foo` names the member `foo`, not a variable `foo`) and
  // never the base of a member call. The flat `references` set keeps
  // every name (methods must stay live through `obj.method()`), but a
  // LOCAL definition can only be read by its bare name: the old
  // name-keyed same-file flag swallowed a dead local `foo` whenever
  // the file also called a same-named method. Serialised as a sorted
  // array, like topLevelUses, so the parse cache round-trips it.
  const bareReferences = new Set();
  const addRef = (name, node, startIndex) => {
    if (!name) return;
    result.references.add(name);
    occurrences.push({ name, startIndex: startIndex !== undefined ? startIndex : (node ? node.startIndex : 0) });
  };
  const addBareRef = (name, node, startIndex) => {
    if (!name) return;
    addRef(name, node, startIndex);
    bareReferences.add(name);
  };
  // Names bound by imports, for the export_specifier rule below.
  const importLocals = new Set();
  for (const imp of result.imports) {
    for (const n of imp.names || []) importLocals.add(n.local);
  }
  // True when the node sits under a `@decorator`. A decorator's member
  // name (`@app.command()` in TS, `@Component({...})` in Angular) names
  // a member of the decorator object, not a local definition of the same
  // name — without this, a decorated definition always looked used by
  // its own decorator. The decorator's object itself still counts.
  const insideDecorator = (node) => {
    let a = node.parent;
    let steps = 0;
    while (a && steps < 6) {
      if (a.type === 'decorator') return true;
      a = a.parent;
      steps++;
    }
    return false;
  };

  const isPropertyDefinitionSite = (node) => {
    const p = node.parent;
    if (!p) return false;
    if (['method_definition', 'method_signature', 'abstract_method_signature', 'field_definition', 'property_signature'].includes(p.type)) {
      return sameNode(childByField(p, 'name'), node);
    }
    return false;
  };

  const isDefinitionSite = (node) => {
    const p = node.parent;
    if (!p) return false;
    if (p.type === 'variable_declarator' && sameNode(childByField(p, 'name'), node)) return true;
    if ((p.type === 'function_declaration' || p.type === 'class_declaration' || p.type === 'abstract_class_declaration' || p.type === 'type_alias_declaration' || p.type === 'interface_declaration' || p.type === 'enum_declaration') && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'import_specifier' || p.type === 'export_specifier') return true;
    if (p.type === 'import_clause') return true;
    if (p.type === 'namespace_import') return true;
    if (p.type === 'property_signature' && sameNode(childByField(p, 'name'), node)) return true;
    return false;
  };

  walk(root, (node) => {
    if (node.type === 'identifier') {
      if (!isDefinitionSite(node)) addBareRef(text(node, src), node);
      else if (node.parent && node.parent.type === 'export_specifier'
        && sameNode(childByField(node.parent, 'name'), node)
        && importLocals.has(text(node, src))) {
        // `export { RequestOptions }` re-exports an import: the name is
        // a use of the imported binding, not a definition. (A plain
        // `export { localFn }` is NOT added — the local definition stays
        // REVIEW as a public export instead of going invisible.)
        addRef(text(node, src), node);
      }
    } else if (node.type === 'type_identifier') {
      // Type positions are uses, not declarations: `declare const client:
      // AxiosInstance`, `expectType<Promise<AxiosResponse<User>>>`,
      // `request<User, CustomResponse>()`, `interface P { x: Foo }`.
      // The declaration's own name (`type A = ...`, `interface I {}`)
      // is a type_identifier too — isDefinitionSite excludes it.
      if (!isDefinitionSite(node)) addBareRef(text(node, src), node);
    } else if (node.type === 'property_identifier') {
      // A method/field/property declaration's own name is a definition,
      // not a use: without this, every method looked used by its own
      // declaration line and methods never got findings at all (e.g. a
      // class's neverCalled() was invisible). Object-literal keys and
      // member-access names still count as references.
      if (!isPropertyDefinitionSite(node)) addRef(text(node, src), node);
    } else if (node.type === 'jsx_identifier' || node.type === 'jsx_namespace_name') {
      addBareRef(text(node, src), node);
    } else if (node.type === 'comment') {
      // JSDoc {@link X} / {@linkcode X} / {@linkplain X} is a real
      // reference to X: TypeScript resolves the link target, so an
      // import used only in a doc link is used, not dead (vuejs/vue
      // types/options.d.ts imports ObjectDirective / FunctionDirective
      // only for `@deprecated use {@link FunctionDirective} instead`).
      // Only imported bindings get the credit (same rule as the
      // JSX-pragma credit below): a doc mention of a local name must
      // not resurrect a dead local definition, and a {@link} to a
      // name this file never imports changes nothing. A bare word in
      // prose is not a link — only the {@link...} form counts, so a
      // type merely mentioned in a comment sentence stays flaggable.
      for (const m of text(node, src).matchAll(/\{@link(?:code|plain)?\s+([A-Za-z_$][\w$]*)/g)) {
        if (importLocals.has(m[1])) addRef(m[1], node);
      }
    } else if (node.type === 'shorthand_property_identifier') {
      // { graph, findings } in an object literal IS a use of those variables.
      // Except in `module.exports = { foo }`, where it is an export, not a use.
      const obj = node.parent;
      const assign = obj && obj.parent;
      const isModuleExports = assign && assign.type === 'assignment_expression'
        && (() => { const left = childByField(assign, 'left'); return left && /^module\.exports|^exports\./.test(text(left, src)); })();
      if (!isModuleExports) addBareRef(text(node, src), node);
    } else if (node.type === 'string' || node.type === 'template_string') {
      result.strings.push(text(node, src));
    } else if (node.type === 'new_expression') {
      // `new Client()` invokes the class constructor: without this, a
      // constructor method was flagged REVIEW ("0 callers") even though
      // the class is constructed in-repo. Record it as a call to
      // `constructor`, keeping the constructed class name so the graph
      // can resolve it across files (importer constructs Client from
      // another file -> that file's constructor method is called).
      // Methods are REVIEW at most, so this only removes REVIEW noise —
      // it can never create a SAFE finding.
      const ctor = node.namedChild(0);
      const forClass = ctor ? text(ctor, src).split('.').pop() : null;
      result.calls.push({ name: 'constructor', full: 'constructor', line: node.startPosition.row + 1, startIndex: node.startIndex, forClass });
    } else if (node.type === 'call_expression') {
      const fn = childByField(node, 'function');
      if (fn && fn.type === 'import') {
        // Dynamic import(): in this tree-sitter grammar it parses as a
        // call_expression whose function is an `import` node, not as an
        // import_expression. A static-string target is a real import edge
        // (graph.js), so record it — without this, a file loaded only via
        // import() was kept alive only by the string-reference pass.
        result.hasModuleSyntax = true;
        result.dynamic = true;
        result.dynamicReasons.push(`dynamic import() at line ${node.startPosition.row + 1}`);
        const args = firstNamed(node, 'arguments');
        const firstArg = args ? args.namedChild(0) : null;
        if (firstArg && firstArg.type === 'string') {
          result.dynamicImports.push(text(firstArg, src).replace(/^['"`]|['"`]$/g, ''));
        }
      } else if (fn) {
        const callee = text(fn, src);
        const base = callee.split('.').pop();
        // A decorator call (`@app.command()`) is not a call to a local
        // function of the same name — see insideDecorator above.
        // A bare call `foo()` reads the local `foo`; a member call
        // `obj.foo()` names the member, never the local.
        if (!insideDecorator(node)) {
          result.calls.push({ name: base, full: callee, line: node.startPosition.row + 1, startIndex: node.startIndex });
          if (fn.type === 'identifier') addBareRef(base, fn);
          else addRef(base, fn);
        }
        if (base === 'require') {
          const args = firstNamed(node, 'arguments');
          const firstArg = args ? args.namedChild(0) : null;
          if (!firstArg || firstArg.type !== 'string') {
            result.dynamic = true;
            result.dynamicReasons.push(`dynamic require() at line ${node.startPosition.row + 1}`);
          }
        }
      }
    } else if (node.type === 'import_expression') {
      result.hasModuleSyntax = true;
      result.dynamic = true;
      result.dynamicReasons.push(`dynamic import() at line ${node.startPosition.row + 1}`);
      const args = firstNamed(node, 'arguments');
      const firstArg = args ? args.namedChild(0) : null;
      if (firstArg && firstArg.type === 'string') {
        result.dynamicImports.push(text(firstArg, src).replace(/^['"`]|['"`]$/g, ''));
      }
    }
  });

  // --- pass 3: unreachable code ---
  const srcLinesJs = src.split('\n');
  walk(root, (node) => {
    if (node.type === 'statement_block' || node.type === 'program') {
      let terminated = false;
      let terminatedLine = -1; // line of the return/throw/break/continue
      for (let i = 0; i < node.namedChildCount; i++) {
        const stmt = node.namedChild(i);
        if (stmt.type === 'comment') continue; // a trailing comment is not code
        if (terminated) {
          const t = text(stmt, src).trim();
          // Function declarations hoist to the top of their enclosing
          // function (or block), so a helper declared textually after
          // a `return` is still callable before it — SvelteKit's
          // `get_data_type` / `apply_handle` / `create_*_loader`
          // helpers are declared this way and called above the return.
          // Async functions share the `function_declaration` node;
          // generators are `generator_function_declaration`. Other
          // declarations do not hoist into usable code (a class sits
          // in the temporal dead zone, a const initializer never runs),
          // so they stay unreachable.
          const isHoistedFn = stmt.type === 'function_declaration' || stmt.type === 'generator_function_declaration';
          // Intentional unreachable code, marked `/* istanbul ignore
          // next */` (or a `# pragma: no cover` in embedded code): the
          // author knows it never runs, so it is not dead code to delete.
          // The marker sits on the terminating statement or the line
          // above it (`/* istanbul ignore next */` above a `throw`), so
          // both the statement's and the terminator's lines are checked.
          const checkIgnored = (row) => {
            const a = srcLinesJs[row] || '';
            const b = row > 0 ? (srcLinesJs[row - 1] || '') : '';
            return /istanbul ignore/.test(a) || /istanbul ignore/.test(b)
              || /pragma:\s*no cover/.test(a) || /pragma:\s*no cover/.test(b);
          };
          if (!isHoistedFn && t && t !== '}' && t.length > 0 && !checkIgnored(stmt.startPosition.row) && !checkIgnored(terminatedLine)) {
            result.unreachable.push({ range: rangeOf(stmt), line: stmt.startPosition.row + 1, reason: 'code after return/throw/break/continue', snippet: t.slice(0, 120) });
          }
        }
        if (['return_statement', 'throw_statement', 'break_statement', 'continue_statement'].includes(stmt.type)) { terminated = true; terminatedLine = stmt.startPosition.row; }
      }
    }
    if (node.type === 'if_statement') {
      const cond = childByField(node, 'condition');
      if (cond) {
        const parenthesized = firstNamed(cond, 'parenthesized_expression');
        const inner = parenthesized ? parenthesized.namedChild(0) : cond.namedChild(0);
        if (inner && inner.type === 'false') {
          result.unreachable.push({ range: rangeOf(node), line: node.startPosition.row + 1, reason: 'if (false) branch is never taken', snippet: text(node, src).slice(0, 120) });
        }
      }
    }
  });

  // De-duplicate definitions (a node visited twice via export + declaration).
  const seen = new Set();
  result.definitions = result.definitions.filter((d) => {
    const k = `${d.name}:${d.range.startIndex}:${d.range.endIndex}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // --- pass 4: per-definition reference scopes (same-file cascade) ---
  // A reference belongs to the innermost definition whose range
  // contains it (a method body beats its class, a nested function beats
  // its outer function); references outside every definition are
  // top-level uses — module code that runs on import. Calls contribute
  // their callee name the same way (a `new Foo()` inside a function is
  // a use of Foo and of `constructor` by that function, not by the
  // file). A call without a recorded position is treated as top-level
  // (fail-open: it keeps the name alive). The confidence engine uses
  // these scopes to decide whether a same-file use comes from live
  // code: a name used only inside a dead definition is dead too, and a
  // name used only by itself (pure recursion) has no live user at all.
  // `uses` and `topLevelUses` are plain sorted arrays, so the parse
  // cache serialises them unchanged.
  for (const c of result.calls) {
    occurrences.push({ name: c.name, startIndex: c.startIndex !== undefined ? c.startIndex : -1 });
  }
  // Variable definitions are NOT scopes: an initializer runs in the
  // enclosing scope, not when the variable is read (`const x =
  // helper()` at module level calls helper() on import, and
  // `_first = _second = _helper` aliases _helper at import). So
  // references inside a variable's range belong to the enclosing
  // definition (or the top level), never to the variable itself — a
  // dead variable must not take its initializer's references down with
  // it. Function-valued variables are kind 'function', not 'variable',
  // so their bodies still scope to them.
  const scopeDefs = result.definitions.filter((d) => d.kind !== 'variable');
  const defsByStart = [...scopeDefs].sort((a, b) => a.range.startIndex - b.range.startIndex);
  const usesByDef = new Map();
  const topLevelUses = new Set();
  for (const occ of occurrences) {
    if (occ.startIndex < 0) { topLevelUses.add(occ.name); continue; }
    let best = null;
    for (const d of defsByStart) {
      if (d.range.startIndex > occ.startIndex) break; // sorted: no later def can contain it
      if (occ.startIndex < d.range.endIndex) {
        if (!best || (d.range.endIndex - d.range.startIndex) < (best.range.endIndex - best.range.startIndex)) best = d;
      }
    }
    if (best) {
      if (!usesByDef.has(best)) usesByDef.set(best, new Set());
      usesByDef.get(best).add(occ.name);
    } else topLevelUses.add(occ.name);
  }
  for (const d of result.definitions) d.uses = [...(usesByDef.get(d) || [])].sort();
  result.topLevelUses = [...topLevelUses].sort();
  result.bareReferences = [...bareReferences].sort();

  // JSX-pragma imports count as uses when the file contains JSX (see
  // the decision block above): the transform calls the pragma factory
  // for every element, so the import is used even though its name
  // never appears in the source text. Applied here, after the
  // reference passes, so it only affects the file-level reference set
  // the dead-import check reads — never the per-definition scopes.
  if (result.hasJsx) {
    const importLocals = new Set();
    for (const imp of result.imports) {
      for (const n of imp.names || []) importLocals.add(n.local);
    }
    for (const name of JSX_PRAGMA_NAMES) {
      if (importLocals.has(name)) result.references.add(name);
    }
  }

  return result;
}

module.exports = { parseJsTs };
