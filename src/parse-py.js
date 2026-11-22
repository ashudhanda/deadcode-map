'use strict';

/**
 * Python parser built on tree-sitter.
 * Same output shape as the JS parser: imports, exports (public names),
 * definitions, references, calls, dynamic, strings, unreachable, decorators.
 */

const Parser = require('tree-sitter');
const Python = require('tree-sitter-python');
const path = require('path');

let parser = null;
function getParser() {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Python);
  }
  return parser;
}

function rangeOf(node) {
  return {
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

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

const DUNDER_KEEP = new Set([
  '__init__', '__str__', '__repr__', '__len__', '__iter__', '__next__',
  '__enter__', '__exit__', '__call__', '__eq__', '__hash__', '__bool__',
  '__getitem__', '__setitem__', '__delitem__', '__contains__',
]);

function parsePy(filePath, src) {
  const tree = getParser().parse(src);
  const root = tree.rootNode;

  const result = {
    language: 'py',
    imports: [],
    exports: [],
    definitions: [],
    references: new Set(),
    calls: [],
    dynamic: false,
    dynamicReasons: [],
    strings: [],
    unreachable: [],
    decorators: [],
    hasJsx: false,
    dunder: new Set(),
  };

  const pendingDecorators = new Map();
  // Class-body inventories for the class-attribute rules (FP-6):
  // per class, the names defined directly in its body, whether the body
  // defines any method, and the class node itself (for its bases).
  const classInfos = [];
  // One split for the whole file: addDef reads the lines above a
  // definition (Sphinx `#:` attribute docs), pass 3 reuses it.
  const srcLines = src.split('\n');

  const addDef = (name, kind, node, extra) => {
    if (!name) return;
    // The enclosing scope: walk past statement wrappers (an assignment
    // sits under an expression_statement, a decorated def under a
    // decorated_definition, a chained-assignment target under its outer
    // assignment) to the real parent — module, block, or class.
    let scope = node.parent;
    while (scope && (scope.type === 'expression_statement' || scope.type === 'decorated_definition' || scope.type === 'assignment')) scope = scope.parent;
    const parentType = scope ? scope.type : 'module';
    // A function defined inside a class body is a method, not a module
    // function. The check uses the walked scope, not node.parent: a
    // decorated method (@contextmanager, @property) sits under a
    // decorated_definition, so node.parent is never the class block.
    let finalKind = kind;
    if (kind === 'function' && scope && scope.type === 'block'
      && scope.parent && scope.parent.type === 'class_definition') {
      finalKind = 'method';
    }
    // A class attribute: a variable assigned directly in a class body.
    // The enclosing class node is recorded so the post-pass below can
    // resolve which base class the attribute belongs to.
    const inClassBody = kind === 'variable' && scope && scope.type === 'block'
      && scope.parent && scope.parent.type === 'class_definition';
    const classNode = inClassBody ? scope.parent : null;
    // A Sphinx `#:` comment block directly above a class attribute
    // documents it as part of the class's public API (an
    // extension-facing flag, a mixin default): the comment is the
    // signal, so it travels on the definition; confidence.js grades it.
    let documentedAttr = false;
    if (inClassBody) {
      let row = node.startPosition.row - 1;
      while (row >= 0 && /^\s*#:/.test(srcLines[row] || '')) { documentedAttr = true; row -= 1; }
    }
    // Framework-populated model fields: a class attribute inside a
    // Pydantic BaseModel subclass or a @dataclass is populated by the
    // framework from external data (JSON, constructor kwargs) and is
    // never read by attribute in-repo — so it is KEEP, never SAFE.
    // The flag travels on the definition; confidence.js grades it.
    let frameworkField = false;
    if (inClassBody) {
      const supers = childByField(classNode, 'superclasses');
      const baseText = supers ? text(supers, src) : '';
      const decs = pendingDecorators.get(classNode.startIndex) || [];
      // A base class named BaseModel — or a subclass of one, e.g.
      // BaseModelWithConfig (fastapi's openapi/models.py) — is a model
      // class, and so is a TypedDict (its fields are populated from
      // external data, accessed by key): its attributes are
      // framework-populated fields. The match is a plain substring on
      // purpose: a base whose name merely contains "BaseModel" is a
      // model subclass in practice, and the only cost of a false match
      // is KEEP, never SAFE.
      frameworkField = /BaseModel|TypedDict/.test(baseText) || decs.some((d) => /dataclass/.test(d));
    }
    result.definitions.push({
      name, kind: finalKind, exported: false, isDefault: false,
      range: rangeOf(node), startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      decorators: pendingDecorators.get(node.startIndex) || [],
      _parentType: parentType,
      frameworkField,
      documentedAttr,
      // Internal: the enclosing class node, resolved by the post-pass
      // below into externalBase / configClassAttr / chainedAlias.
      // Deleted before the result leaves parsePy.
      _classStart: classNode ? classNode.startIndex : null,
      ...(extra || {}),
    });
    if (DUNDER_KEEP.has(name) || /^__\w+__$/.test(name)) result.dunder.add(name);
  };
  // In a package __init__.py every import is a re-export: it defines the
  // package's public namespace (pkg.utils, pkg.run), so the confidence
  // engine must never flag it as a dead import.
  const isPackageInit = path.basename(filePath) === '__init__.py';
  // A compatibility shim's imports ARE its public API: requests'
  // compat.py, fastapi's _compat/ — the names are re-exported for
  // downstream code, even when nothing in the repo imports them.
  const normRel = filePath.replace(/\\/g, '/');
  const isCompatShim = /(^|\/)(_?compat)(\.py)?$/.test(normRel) || /(^|\/)_?compat\//.test(normRel);
  // `# noqa` (usually `# noqa: F401`) on an import line marks the
  // import as intentional: a re-export the author knows is unused in
  // this file.
  const hasNoqa = (node) => {
    const stmt = text(node, src);
    const endIdx = src.indexOf('\n', node.endIndex);
    const tail = endIdx === -1 ? '' : src.slice(node.endIndex, endIdx);
    return /#\s*noqa\b/.test(stmt + tail);
  };

  // --- pass 1: structure ---
  walk(root, (node) => {
    switch (node.type) {
      case 'import_statement': {
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c.type === 'dotted_name') {
            const full = text(c, src);
            // `import a.b.c` binds the TOP-level name `a`, not `c` —
            // code uses it as a.b.c.foo(). Recording `c` made the
            // binding unfindable and hid genuinely unused dotted imports.
            const local = full.split('.')[0];
            result.imports.push({ names: [{ imported: full, local, kind: 'named' }], source: full, range: rangeOf(node), sideEffect: false, reExport: isPackageInit || isCompatShim || hasNoqa(node) });
          } else if (c.type === 'aliased_import') {
            const nameNode = childByField(c, 'name');
            const aliasNode = childByField(c, 'alias');
            const full = nameNode ? text(nameNode, src) : '';
            const local = aliasNode ? text(aliasNode, src) : full.split('.')[0];
            // `import X as X` — a redundant alias is the explicit
            // re-export idiom (the name is part of this module's public
            // API). A plain `import X` defaults local to X and is NOT
            // a re-export, so only an explicitly written alias counts.
            const redundantAlias = Boolean(aliasNode) && text(aliasNode, src) === full;
            result.imports.push({ names: [{ imported: full, local, kind: 'named' }], source: full, range: rangeOf(node), sideEffect: false, reExport: isPackageInit || isCompatShim || hasNoqa(node) || redundantAlias });
          }
        }
        break;
      }
      case 'import_from_statement': {
        const moduleNode = childByField(node, 'module_name');
        let source = moduleNode ? text(moduleNode, src) : '';
        // tree-sitter includes the leading relative dots in the module
        // name (".core", "..pkg", ".", ".."): split them into a level
        // (1 = same package, 2 = parent package, ...) and a bare module.
        const dotMatch = source.match(/^(\.+)/);
        const level = dotMatch ? dotMatch[1].length : 0;
        source = source.replace(/^\.+/, '');
        const names = [];
        // A redundant alias (`from x import Y as Y`) is the explicit
        // re-export idiom; see the import_statement case above. Only an
        // explicitly written alias counts — a plain `from x import Y`
        // defaults local to Y and is not a re-export.
        let redundantAlias = false;
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          // The module name itself is a dotted_name child too
          // ("from pkg.core import run" has module_name "pkg.core") — it is
          // not an imported name, so skip it by position.
          if (moduleNode && c.startIndex === moduleNode.startIndex && c.endIndex === moduleNode.endIndex) continue;
          if (c.type === 'dotted_name') {
            const n = text(c, src);
            names.push({ imported: n, local: n, kind: 'named' });
          } else if (c.type === 'aliased_import') {
            const nameNode = childByField(c, 'name');
            const aliasNode = childByField(c, 'alias');
            const n = nameNode ? text(nameNode, src) : '';
            const alias = aliasNode ? text(aliasNode, src) : n;
            if (aliasNode && alias === n) redundantAlias = true;
            names.push({ imported: n, local: alias, kind: 'named' });
          } else if (c.type === 'wildcard_import') {
            names.push({ imported: '*', local: '*', kind: 'namespace' });
          }
        }
        const rel = node.namedChild(0) && node.namedChild(0).type === 'relative_import';
        result.imports.push({ names, source, level, range: rangeOf(node), sideEffect: false, relative: Boolean(rel), fromImport: true, reExport: isPackageInit || isCompatShim || hasNoqa(node) || redundantAlias });
        break;
      }
      case 'decorated_definition': {
        // Python: @decorator immediately above a def/class. Attach the
        // decorator text to the wrapped definition so framework checks are
        // per-symbol, not per-file.
        const decs = [];
        let wrapped = null;
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c.type === 'decorator') decs.push(text(c, src));
          else if (c.type === 'function_definition' || c.type === 'class_definition') wrapped = c;
        }
        if (wrapped) pendingDecorators.set(wrapped.startIndex, decs);
        break;
      }
      case 'function_definition': {
        const nameNode = childByField(node, 'name');
        if (nameNode) addDef(text(nameNode, src), 'function', node);
        break;
      }
      case 'class_definition': {
        const nameNode = childByField(node, 'name');
        if (nameNode) addDef(text(nameNode, src), 'class', node);
        // Member inventory for the class-attribute rules: the names
        // defined directly in the class body (methods, chained aliases,
        // plain attributes) and whether the body defines any method at
        // all. Statements sit under expression_statement wrappers;
        // decorated defs under decorated_definition.
        const body = childByField(node, 'body');
        const members = new Set();
        let hasMethod = false;
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            let stmt = body.namedChild(i);
            if (stmt.type === 'expression_statement') stmt = stmt.namedChild(0);
            if (!stmt) continue;
            if (stmt.type === 'decorated_definition') {
              for (let j = 0; j < stmt.namedChildCount; j++) {
                const w = stmt.namedChild(j);
                if (w.type === 'function_definition' || w.type === 'class_definition') stmt = w;
              }
            }
            if (stmt.type === 'function_definition') {
              hasMethod = true;
              const n = childByField(stmt, 'name');
              if (n) members.add(text(n, src));
            } else if (stmt.type === 'class_definition') {
              const n = childByField(stmt, 'name');
              if (n) members.add(text(n, src));
            } else if (stmt.type === 'assignment') {
              let a = stmt;
              while (a && a.type === 'assignment') {
                const l = childByField(a, 'left');
                if (l && l.type === 'identifier') members.add(text(l, src));
                a = childByField(a, 'right');
              }
            }
          }
        }
        classInfos.push({ startIndex: node.startIndex, endIndex: node.endIndex, members, hasMethod, node });
        break;
      }
      case 'assignment': {
        const left = childByField(node, 'left');
        const right = childByField(node, 'right');
        // A bare annotation (`x: SomeType` with no `= value`) creates no
        // runtime binding — it is a type declaration, not a value — so
        // it is not a definition and never a finding. That is what
        // fastapi's UploadFile fields are (class annotations re-declaring
        // a parent class's attributes): flagging them SAFE was noise.
        // Annotated assignments WITH a value still define the name.
        if (left && left.type === 'identifier' && right) {
          // Chained assignment (`a = b = c = value`): tree-sitter nests
          // the assignments, so the value is at the end of the right
          // spine of the OUTERMOST assignment node. When that value is
          // a bare name, every name in the chain aliases it — the
          // post-pass below checks whether the name is defined in the
          // same class, which is what makes the alias live.
          let top = node;
          while (top.parent && top.parent.type === 'assignment') top = top.parent;
          let terminal = childByField(top, 'right');
          let chainLen = 1;
          while (terminal && terminal.type === 'assignment') { chainLen += 1; terminal = childByField(terminal, 'right'); }
          const isChain = chainLen > 1 || top !== node;
          const kind = right && (right.type === 'lambda') ? 'function' : 'variable';
          addDef(text(left, src), kind, node, (isChain && terminal && terminal.type === 'identifier') ? { chainedAliasOf: text(terminal, src) } : undefined);
        }
        break;
      }
      case 'decorator': {
        result.decorators.push(text(node, src));
        break;
      }
      default:
        break;
    }
  });

  // --- class-attribute rules (FP-6): resolve the class context of
  // each class-body variable definition. ---
  // A base counts as external when its name is imported into this file
  // by a non-relative import: the parent class is defined outside this
  // file (another package, or another module of this repo imported by
  // absolute path), so its attributes may be read by framework code the
  // repo cannot see. A relative import (`from .base import Base`) or a
  // base defined in this file is in-repo: the parent source is here, so
  // an override is provable from the graph instead.
  const externalImportLocals = new Set();
  for (const imp of result.imports) {
    if (imp.fromImport && imp.level) continue; // relative: in-repo
    for (const n of imp.names || []) externalImportLocals.add(n.local);
  }
  // Base names of a class: the leading identifier of each entry in the
  // superclasses list (`CallbackDict[str, t.Any]` -> CallbackDict,
  // `mod.Base` -> mod). Split on top-level commas only, so commas
  // inside generics do not split a base in two.
  const baseNamesOf = (classNode) => {
    const supers = childByField(classNode, 'superclasses');
    if (!supers) return [];
    const raw = text(supers, src).replace(/^\(|\)$/g, '');
    const parts = [];
    let depth = 0;
    let cur = '';
    for (const ch of raw) {
      if (ch === '[' || ch === '(') depth += 1;
      if (ch === ']' || ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts.map((p) => (p.trim().match(/^[A-Za-z_][A-Za-z0-9_]*/) || [])[0]).filter(Boolean);
  };
  for (const info of classInfos) {
    info.externalBase = baseNamesOf(info.node).some((b) => externalImportLocals.has(b));
  }
  for (const d of result.definitions) {
    // NB: a class at offset 0 has _classStart === 0, which is falsy —
    // test for null, not truthiness.
    if (d._classStart == null) { delete d._classStart; continue; }
    const info = classInfos.find((c) => c.startIndex === d._classStart);
    if (!info) { delete d._classStart; continue; }
    // A chained-assignment alias is live only when the aliased name is
    // defined in the same class (`popitem = _fail`, where _fail is the
    // class's own method): the names are one object, part of the
    // class's interface. A chain ending in any other name is an
    // ordinary alias and stays a candidate.
    if (d.chainedAliasOf && info.members.has(d.chainedAliasOf)) d.chainedAlias = true;
    d.externalBase = info.externalBase;
    // A subclass of an externally-defined base whose body defines only
    // attributes (no methods) is a framework-consumed config class (a
    // Pygments Style subclass): the framework reads the attributes at
    // runtime.
    d.configClassAttr = info.externalBase && !info.hasMethod;
    delete d._classStart;
  }

  // __all__ = [...] (or (...) — typer's _typing.py uses a tuple, and
  // either form may span lines) makes names public exports, and a name
  // listed there is USED even when it is only imported for re-export:
  // `from typing import Annotated` + `__all__ = (..., "Annotated", ...)`
  // is a live re-export, not a dead import.
  const allMatch = src.match(/__all__\s*\+?=\s*[\[(]([\s\S]*?)[\])]/);
  if (allMatch) {
    for (const m of allMatch[1].matchAll(/['"]([^'"]+)['"]/g)) {
      result.exports.push({ name: m[1], local: m[1], kind: 'named', range: rangeOf(root), isDefault: false });
      result.references.add(m[1]);
    }
  }
  // In Python every top-level public name is importable, so treat top-level
  // definitions as exports for the graph (confidence engine downgrades them).
  // Methods and nested functions are NOT module exports.
  for (const d of result.definitions) {
    const parent = d._parentType;
    if (parent === 'module' && !d.name.startsWith('_')) {
      d.exported = true;
      result.exports.push({ name: d.name, local: d.name, kind: 'named', range: d.range, isDefault: false });
    }
  }
  for (const d of result.definitions) delete d._parentType;

  // --- pass 2: references, calls, strings, dynamic ---
  // True when the node sits under a `@decorator`. A decorator's
  // attribute name (`@app.callback()` defining `def callback`) names a
  // member of the decorator object, not a local definition of the same
  // name — without this, the decorated function always looked used by
  // its own decorator. The decorator's object (`app`) still counts.
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

  // True when a string_content node is a type annotation (`ctx:
  // "Context"`, `-> "list[Buffer]"`, `y: "TypeAdapter[Any]"`) or the
  // first argument of a `cast("Context", ...)` call. Walks up the
  // ancestors: a `type` node means annotation position; a `call` node
  // is only annotation-like when it is `cast` and this string is its
  // first argument.
  const isAnnotationString = (node) => {
    let a = node.parent; // the enclosing `string` node
    let steps = 0;
    while (a && steps < 8) {
      if (a.type === 'type') return true;
      // A TypeAlias value IS a type expression: `HookType: TypeAlias =
      // Callable[["Response"], Any]` — the string "Response" is a forward
      // reference, so the TYPE_CHECKING import of Response is live.
      if (a.type === 'assignment') {
        const typeNode = childByField(a, 'type');
        if (typeNode && /TypeAlias/.test(text(typeNode, src))) return true;
      }
      if (a.type === 'call') {
        const fn = childByField(a, 'function');
        if (fn && text(fn, src) === 'cast') {
          const args = childByField(a, 'arguments');
          const first = args ? args.namedChild(0) : null;
          // The string itself is the first argument (its parent chain
          // passes through the argument_list to this call).
          if (first && node.startIndex >= first.startIndex && node.endIndex <= first.endIndex) return true;
        }
        return false;
      }
      a = a.parent;
      steps++;
    }
    return false;
  };

  const isDefinitionSite = (node) => {
    // Identifiers inside an import statement are module paths and bound
    // names, never references to other values. They sit under a
    // dotted_name / aliased_import, so the immediate parent is not the
    // import statement itself — walk up the ancestors. Without this,
    // every imported name leaked into `references` and no unused Python
    // import was ever flagged (the import always looked "used" by its
    // own statement).
    let ancestor = node.parent;
    while (ancestor) {
      if (ancestor.type === 'import_statement' || ancestor.type === 'import_from_statement') return true;
      ancestor = ancestor.parent;
    }
    const p = node.parent;
    if (!p) return false;
    if ((p.type === 'function_definition' || p.type === 'class_definition') && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'assignment' && sameNode(childByField(p, 'left'), node)) return true;
    if (p.type === 'aliased_import') return true;
    if (p.type === 'import_from_statement' || p.type === 'import_statement') return true;
    return false;
  };

  walk(root, (node) => {
    if (node.type === 'identifier') {
      if (!isDefinitionSite(node)) {
        // A decorator attribute (`@app.callback()`) is a member of the
        // decorator object, not a reference to a same-named definition.
        const p = node.parent;
        const isDecAttr = p && p.type === 'attribute' && sameNode(childByField(p, 'attribute'), node) && insideDecorator(p);
        if (!isDecAttr) result.references.add(text(node, src));
      }
    } else if (node.type === 'attribute') {
      const attr = childByField(node, 'attribute');
      if (attr && !insideDecorator(node)) result.references.add(text(attr, src));
    } else if (node.type === 'string' || node.type === 'string_content') {
      result.strings.push(text(node, src));
      // String annotations are uses: `ctx: "Context"`,
      // `-> "Context | None"`, `x: "list[Buffer]"`,
      // `cast("Context", ctx)`. A string that is a type annotation (it
      // sits under a `type` node) or the first argument of `cast(...)`
      // names real types — the identifiers inside it count as references,
      // so a TYPE_CHECKING import used only in annotations is live.
      // Plain strings (docstrings, messages, dict values) do not count.
      if (node.type === 'string_content' && isAnnotationString(node)) {
        for (const m of text(node, src).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
          result.references.add(m[0]);
        }
      }
      // %-format placeholders are uses: `"%(complete_func)s" % vars`
      // looks the name up in a mapping at runtime, so a TypedDict field
      // (or a variable) named in a placeholder is live — even in the
      // same file, where the plain string pass does not count. The
      // lookbehind skips `%%(name)s`, an escaped literal percent.
      for (const m of text(node, src).matchAll(/(?<!%)%\(([A-Za-z_][A-Za-z0-9_]*)\)[sdifr%]/g)) {
        result.references.add(m[1]);
      }
    } else if (node.type === 'call') {
      const fn = childByField(node, 'function');
      if (fn) {
        const callee = text(fn, src);
        const base = callee.split('.').pop();
        // A decorator call (`@app.command()`) is not a call to a local
        // function of the same name — see insideDecorator above.
        if (!insideDecorator(node)) {
          result.calls.push({ name: base, full: callee, line: node.startPosition.row + 1 });
          result.references.add(base);
        }
        if (['getattr', 'importlib', '__import__', 'eval', 'exec'].includes(base)) {
          result.dynamic = true;
          result.dynamicReasons.push(`dynamic ${base}() at line ${node.startPosition.row + 1}`);
        }
      }
    }
  });

  // --- pass 3: unreachable code (statements after return/raise/break/continue) ---
  // (srcLines is defined at the top of parsePy.)
  walk(root, (node) => {
    if (node.type === 'block') {
      let terminated = false;
      let terminatedLine = -1; // line of the return/raise/break/continue
      for (let i = 0; i < node.namedChildCount; i++) {
        const stmt = node.namedChild(i);
        if (stmt.type === 'comment') continue; // a trailing comment is not code
        if (terminated) {
          const t = text(stmt, src).trim();
          // Intentional unreachable code: `yield` after a raise keeps
          // a function a generator, marked `# pragma: no cover` — the
          // author knows it never runs, so it is not dead code to delete.
          // The marker sits on the terminating statement or the line
          // above it, so both lines are checked.
          const checkPragma = (row) => {
            const a = srcLines[row] || '';
            const b = row > 0 ? (srcLines[row - 1] || '') : '';
            return /pragma:\s*no cover/.test(a) || /pragma:\s*no cover/.test(b);
          };
          if (t && !checkPragma(stmt.startPosition.row) && !checkPragma(terminatedLine)) {
            result.unreachable.push({ range: rangeOf(stmt), line: stmt.startPosition.row + 1, reason: 'code after return/raise/break/continue', snippet: t.slice(0, 120) });
          }
        }
        if (['return_statement', 'raise_statement', 'break_statement', 'continue_statement'].includes(stmt.type)) { terminated = true; terminatedLine = stmt.startPosition.row; }
      }
    }
  });

  return result;
}

module.exports = { parsePy, DUNDER_KEEP };
