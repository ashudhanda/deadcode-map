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

// See parse-js.js parseSource/text: the 32 KiB string limit, the
// callback form for every file, UTF-16 offsets throughout, and the
// surrogate-pair-safe chunk end.
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
  const tree = parseSource(getParser(), src);
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
  // Attribute-lookup names (`obj.name`, `self.name`), recorded
  // separately from bare references: the confidence engine's cross-file
  // attribute rule (FP-6) credits a class attribute when another file
  // reads it as an attribute. Kept as a Set here and converted to a
  // sorted array before the result leaves parsePy, so the cache (plain
  // JSON) round-trips it unchanged.
  const attributeRefSet = new Set();
  // Reference occurrences with positions, for per-definition scopes
  // (same-file cascade) — see parse-js.js pass 4. `references` stays
  // the flat file-level set; occurrences are the positioned twin used
  // to build each definition's `uses` list.
  const occurrences = [];
  const addRef = (name, node, startIndex) => {
    if (!name) return;
    result.references.add(name);
    occurrences.push({ name, startIndex: startIndex !== undefined ? startIndex : (node ? node.startIndex : 0) });
  };
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
    // The enclosing class, if any: walk up past statement wrappers and
    // grouping statements (`if` / `try` / `with` / `for` blocks inside a
    // class body — Django's psycopg3-only `adapt_integerfield_value`
    // and `integerfield_type_map` sit under `if is_psycopg3:` in the
    // class body, and are still a method / an attribute of that class).
    // The walk stops at a function boundary (a nested function is not a
    // method of the outer class) or the module, and starts at
    // node.parent so a definition never counts as its own enclosing
    // class. A decorated method (@contextmanager, @property) sits under
    // a decorated_definition, so node.parent is never the class block —
    // the walk handles that too.
    let enclosingClass = null;
    {
      let a = node.parent;
      while (a) {
        if (a.type === 'class_definition') { enclosingClass = a; break; }
        if (a.type === 'function_definition' || a.type === 'module') break;
        a = a.parent;
      }
    }
    // A function defined inside a class body is a method, not a module
    // function.
    let finalKind = kind;
    if (kind === 'function' && enclosingClass) {
      finalKind = 'method';
    }
    // A class attribute: a variable assigned in a class body. The
    // enclosing class node is recorded so the post-pass below can
    // resolve which base class the attribute belongs to.
    const inClassBody = kind === 'variable' && Boolean(enclosingClass);
    const classNode = inClassBody ? enclosingClass : null;
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
    // A definition inside a function body is a local of that function
    // (a nested function, a variable assigned in a body): it is scoped
    // to its enclosing function, not to the module — see parse-js.js
    // addDef. Walk up to the nearest function or class boundary; a
    // class body is not a function scope (class attributes are
    // module-level findings), and the walk starts at node.parent so a
    // definition never counts as its own enclosing function.
    let isLocal = false;
    {
      let a = node.parent;
      while (a) {
        if (a.type === 'function_definition') { isLocal = true; break; }
        if (a.type === 'class_definition' || a.type === 'module') break;
        a = a.parent;
      }
    }
    result.definitions.push({
      name, kind: finalKind, exported: false, isDefault: false,
      range: rangeOf(node), startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      decorators: pendingDecorators.get(node.startIndex) || [],
      _parentType: parentType,
      local: isLocal,
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
  // this file. The comment may sit on any line of a multi-line import,
  // so check the whole span plus the line above. Line-based, so it
  // does not depend on position units. Linters accept the marker in
  // either case (`# NOQA` in Django), so the match is case-insensitive.
  const hasNoqa = (node) => {
    const lines = srcLines.slice(Math.max(0, node.startPosition.row - 1), node.endPosition.row + 1);
    return lines.some((line) => /#\s*noqa\b/i.test(line));
  };
  // A re-export / backwards-compatibility comment marks ONE name, not
  // the whole statement: requests' sessions.py imports REDIRECT_STATI
  // and should_bypass_proxies in one statement, but only the latter
  // carries the "# re-export" note — the former is genuinely dead.
  // The note may sit on the name's own line, or on the line above the
  // statement: there it must either name the symbol (utils.py: "#
  // to_native_string is unused here, but imported here for backwards
  // compatibility") or the import must carry a single name, so the note
  // unambiguously refers to it. Candidates are the local name plus the
  // imported name when they differ (an alias may be mentioned by either).
  const KEEP_COMMENT_RES = [/#\s*re-exports?\b/i, /#.*\bbackwards?[- ]compat/i];
  const nameHasKeepComment = (stmtNode, childNode, candidates, singleName) => {
    const ownLine = srcLines[childNode.endPosition.row] || '';
    if (KEEP_COMMENT_RES.some((re) => re.test(ownLine))) return true;
    const above = srcLines[stmtNode.startPosition.row - 1] || '';
    if (!above || !KEEP_COMMENT_RES.some((re) => re.test(above))) return false;
    if (singleName) return true;
    return candidates.some((name) => name !== '*'
      && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(above));
  };

  // True when the statement sits inside a `try:` block: an import
  // there is often an availability probe (`try: import numpy`,
  // `try: from PIL import Image`) whose purpose is the import itself.
  // The flag travels on the import record; confidence.js grades it.
  const inTryExcept = (node) => {
    let a = node.parent;
    while (a) {
      if (a.type === 'try_statement') return true;
      if (a.type === 'module') return false;
      a = a.parent;
    }
    return false;
  };

  // --- pass 1: structure ---
  walk(root, (node) => {
    switch (node.type) {
      case 'import_statement': {
        const inTry = inTryExcept(node);
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c.type === 'dotted_name') {
            const full = text(c, src);
            // `import a.b.c` binds the TOP-level name `a`, not `c` —
            // code uses it as a.b.c.foo(). Recording `c` made the
            // binding unfindable and hid genuinely unused dotted imports.
            const local = full.split('.')[0];
            result.imports.push({ names: [{ imported: full, local, kind: 'named' }], source: full, range: rangeOf(node), sideEffect: false, inTryExcept: inTry, reExport: isPackageInit || isCompatShim || hasNoqa(node) || nameHasKeepComment(node, c, [local, full], true) });
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
            result.imports.push({ names: [{ imported: full, local, kind: 'named' }], source: full, range: rangeOf(node), sideEffect: false, inTryExcept: inTry, reExport: isPackageInit || isCompatShim || hasNoqa(node) || nameHasKeepComment(node, c, [local, full], true) || redundantAlias });
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
            names.push({ imported: n, local: n, kind: 'named', child: c, candidates: [n] });
          } else if (c.type === 'aliased_import') {
            const nameNode = childByField(c, 'name');
            const aliasNode = childByField(c, 'alias');
            const n = nameNode ? text(nameNode, src) : '';
            const alias = aliasNode ? text(aliasNode, src) : n;
            if (aliasNode && alias === n) redundantAlias = true;
            names.push({ imported: n, local: alias, kind: 'named', child: c, candidates: [alias, n] });
          } else if (c.type === 'wildcard_import') {
            names.push({ imported: '*', local: '*', kind: 'namespace', child: c, candidates: ['*'] });
          }
        }
        const rel = node.namedChild(0) && node.namedChild(0).type === 'relative_import';
        // A keep comment marks individual names, so a mixed import is
        // split: the kept names form a re-export record, the rest keep
        // the statement's own verdict (noqa / shim / redundant alias).
        // Without the split, one noted name would whitelist genuinely
        // dead siblings in the same statement (REDIRECT_STATI).
        const stmtReExport = isPackageInit || isCompatShim || hasNoqa(node) || redundantAlias;
        const strip = (n) => ({ imported: n.imported, local: n.local, kind: n.kind });
        const singleName = names.length === 1;
        for (const n of names) n.kept = nameHasKeepComment(node, n.child, n.candidates, singleName);
        const keptNames = names.filter((n) => n.kept).map(strip);
        const restNames = names.filter((n) => !n.kept).map(strip);
        const base = { source, level, range: rangeOf(node), sideEffect: false, relative: Boolean(rel), fromImport: true, inTryExcept: inTryExcept(node) };
        if (keptNames.length > 0 && restNames.length > 0) {
          result.imports.push({ ...base, names: keptNames, reExport: true });
          result.imports.push({ ...base, names: restNames, reExport: stmtReExport });
        } else {
          result.imports.push({ ...base, names: names.map(strip), reExport: stmtReExport || keptNames.length > 0 });
        }
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
          while (terminal && terminal.type === 'assignment') terminal = childByField(terminal, 'right');
          const kind = right && (right.type === 'lambda') ? 'function' : 'variable';
          // The right-hand side, when it is a bare name: a class-body
          // assignment `x = method` — or a chain `a = b = method`
          // ending in one — aliases a method of the same class. The
          // post-pass below keeps it only when the name really is one
          // of the enclosing class's own methods, so `x = imported_fn`
          // and `x = module_global` stay ordinary candidates.
          addDef(text(left, src), kind, node, (terminal && terminal.type === 'identifier') ? { chainedAliasOf: text(terminal, src) } : undefined);
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
    const nameNode = childByField(info.node, 'name');
    info.name = nameNode ? text(nameNode, src) : null;
    info.bases = baseNamesOf(info.node);
    info.externalBase = info.bases.some((b) => externalImportLocals.has(b));
    // Methods of this class, by range containment: a method defined
    // under `if` / `try` in the class body is still a method of the
    // class (the member inventory above only sees direct body
    // statements, so it would miss it). A method belongs to its
    // innermost containing class, so a method of a nested class never
    // counts as a method of the outer class.
    info.methods = new Set();
  }
  for (const d of result.definitions) {
    if (d.kind !== 'method') continue;
    let best = null;
    for (const info of classInfos) {
      if (d.range.startIndex >= info.startIndex && d.range.endIndex <= info.endIndex) {
        if (!best || (info.endIndex - info.startIndex) < (best.endIndex - best.startIndex)) best = info;
      }
    }
    if (best) best.methods.add(d.name);
  }
  for (const info of classInfos) {
    // A class with only `if`-nested methods still has methods: the
    // direct inventory above misses them, the range pass does not.
    if (info.methods.size > 0) info.hasMethod = true;
  }
  for (const d of result.definitions) {
    // NB: a class at offset 0 has _classStart === 0, which is falsy —
    // test for null, not truthiness.
    if (d._classStart == null) { delete d._classStart; continue; }
    const info = classInfos.find((c) => c.startIndex === d._classStart);
    if (!info) { delete d._classStart; continue; }
    // An assignment whose value is a method of the same class (`x =
    // method`, or a chain ending in one: `popitem = _fail`, where _fail
    // is the class's own method) aliases that method: the names are one
    // object, part of the class's interface. An assignment ending in
    // any other name is an ordinary alias and stays a candidate.
    if (d.chainedAliasOf && info.methods.has(d.chainedAliasOf)) d.chainedAlias = true;
    d.externalBase = info.externalBase;
    // The enclosing class name travels on the definition: the
    // confidence engine's override rules (FP-6) resolve the class
    // hierarchy from it.
    d.className = info.name;
    // A subclass of an externally-defined base whose body defines only
    // attributes (no methods) is a framework-consumed config class (a
    // Pygments Style subclass): the framework reads the attributes at
    // runtime.
    d.configClassAttr = info.externalBase && !info.hasMethod;
    delete d._classStart;
  }
  // Class inventory for the confidence engine's override rules (FP-6):
  // per class, its name, direct bases (bare names as written), and
  // range. Plain JSON, so the cache round-trips it unchanged.
  result.classes = classInfos.map((info) => ({
    name: info.name, bases: info.bases || [], range: rangeOf(info.node),
  }));

  // __all__ = [...] (or (...) — typer's _typing.py uses a tuple, and
  // either form may span lines) makes names public exports, and a name
  // listed there is USED even when it is only imported for re-export:
  // `from typing import Annotated` + `__all__ = (..., "Annotated", ...)`
  // is a live re-export, not a dead import.
  const allMatch = src.match(/__all__\s*\+?=\s*[\[(]([\s\S]*?)[\])]/);
  if (allMatch) {
    // Positions are module-level by construction (__all__ is a
    // top-level assignment), but record them like any other reference
    // so the scope pass attributes them to the top level, not to a
    // definition that happens to follow.
    const groupStart = src.indexOf(allMatch[1], allMatch.index);
    for (const m of allMatch[1].matchAll(/['"]([^'"]+)['"]/g)) {
      result.exports.push({ name: m[1], local: m[1], kind: 'named', range: rangeOf(root), isDefault: false });
      addRef(m[1], null, groupStart + m.index);
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
        if (!isDecAttr) addRef(text(node, src), node);
      }
    } else if (node.type === 'attribute') {
      const attr = childByField(node, 'attribute');
      // Attribute-lookup names (`obj.name`, `self.name`) are recorded
      // separately from bare references: the confidence engine's
      // cross-file attribute rule (FP-6) credits a class attribute
      // when another file reads it as an attribute — a bare-name match
      // elsewhere is not the same evidence. A decorator argument IS an
      // attribute read (`@register(Tags.async_support)` evaluates
      // Tags.async_support), so it counts for that rule — but never as
      // a bare reference, because a decorator's own attribute is a
      // member of the decorator object, not a same-named local.
      if (attr) {
        if (!insideDecorator(node)) addRef(text(attr, src), attr);
        attributeRefSet.add(text(attr, src));
      }
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
        const s = text(node, src);
        for (const m of s.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
          addRef(m[0], node, node.startIndex + m.index);
        }
      }
      // %-format placeholders are uses: `"%(complete_func)s" % vars`
      // looks the name up in a mapping at runtime, so a TypedDict field
      // (or a variable) named in a placeholder is live — even in the
      // same file, where the plain string pass does not count. The
      // lookbehind skips `%%(name)s`, an escaped literal percent.
      const fmt = text(node, src);
      for (const m of fmt.matchAll(/(?<!%)%\(([A-Za-z_][A-Za-z0-9_]*)\)[sdifr%]/g)) {
        addRef(m[1], node, node.startIndex + m.index);
      }
    } else if (node.type === 'call') {
      const fn = childByField(node, 'function');
      if (fn) {
        const callee = text(fn, src);
        const base = callee.split('.').pop();
        // A decorator call (`@app.command()`) is not a call to a local
        // function of the same name — see insideDecorator above.
        if (!insideDecorator(node)) {
          result.calls.push({ name: base, full: callee, line: node.startPosition.row + 1, startIndex: node.startIndex });
          addRef(base, fn);
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

  // --- pass 4: per-definition reference scopes (same-file cascade) ---
  // Same shape as parse-js.js pass 4: a reference belongs to the
  // innermost definition whose range contains it; references outside
  // every definition are top-level uses. Calls contribute their callee
  // name the same way; a call without a recorded position is treated
  // as top-level (fail-open). See parse-js.js for the full rationale.
  for (const c of result.calls) {
    occurrences.push({ name: c.name, startIndex: c.startIndex !== undefined ? c.startIndex : -1 });
  }
  // Variable definitions are NOT scopes — see parse-js.js pass 4:
  // an initializer runs in the enclosing scope, so references inside
  // a variable's range belong to the enclosing definition (or the top
  // level), never to the variable itself.
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
  result.attributeRefs = [...attributeRefSet].sort();

  return result;
}

module.exports = { parsePy, DUNDER_KEEP };
