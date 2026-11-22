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

  const addDef = (name, kind, node, extra) => {
    if (!name) return;
    // A function defined inside a class body is a method, not a module function.
    let finalKind = kind;
    if (kind === 'function' && node.parent && node.parent.type === 'block'
      && node.parent.parent && node.parent.parent.type === 'class_definition') {
      finalKind = 'method';
    }
    const parentType = node.parent && node.parent.type === 'decorated_definition'
      ? (node.parent.parent ? node.parent.parent.type : 'module')
      : (node.parent ? node.parent.type : 'module');
    result.definitions.push({
      name, kind: finalKind, exported: false, isDefault: false,
      range: rangeOf(node), startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      decorators: pendingDecorators.get(node.startIndex) || [],
      _parentType: parentType,
      ...(extra || {}),
    });
    if (DUNDER_KEEP.has(name) || /^__\w+__$/.test(name)) result.dunder.add(name);
  };
  // In a package __init__.py every import is a re-export: it defines the
  // package's public namespace (pkg.utils, pkg.run), so the confidence
  // engine must never flag it as a dead import.
  const isPackageInit = path.basename(filePath) === '__init__.py';

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
            result.imports.push({ names: [{ imported: full, local, kind: 'named' }], source: full, range: rangeOf(node), sideEffect: false, reExport: isPackageInit });
          } else if (c.type === 'aliased_import') {
            const nameNode = childByField(c, 'name');
            const aliasNode = childByField(c, 'alias');
            const full = nameNode ? text(nameNode, src) : '';
            const local = aliasNode ? text(aliasNode, src) : full.split('.')[0];
            result.imports.push({ names: [{ imported: full, local, kind: 'named' }], source: full, range: rangeOf(node), sideEffect: false, reExport: isPackageInit });
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
            names.push({ imported: n, local: aliasNode ? text(aliasNode, src) : n, kind: 'named' });
          } else if (c.type === 'wildcard_import') {
            names.push({ imported: '*', local: '*', kind: 'namespace' });
          }
        }
        const rel = node.namedChild(0) && node.namedChild(0).type === 'relative_import';
        result.imports.push({ names, source, level, range: rangeOf(node), sideEffect: false, relative: Boolean(rel), fromImport: true, reExport: isPackageInit });
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
        // Methods are function_definitions inside the class body; they are
        // collected by the function_definition case above.
        break;
      }
      case 'assignment': {
        const left = childByField(node, 'left');
        if (left && left.type === 'identifier') {
          const right = childByField(node, 'right');
          const kind = right && (right.type === 'lambda') ? 'function' : 'variable';
          addDef(text(left, src), kind, node);
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

  // __all__ = [...] makes names public exports.
  const allMatch = src.match(/__all__\s*=\s*\[([^\]]*)\]/);
  if (allMatch) {
    for (const m of allMatch[1].matchAll(/['"]([^'"]+)['"]/g)) {
      result.exports.push({ name: m[1], local: m[1], kind: 'named', range: rangeOf(root), isDefault: false });
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
      if (!isDefinitionSite(node)) result.references.add(text(node, src));
    } else if (node.type === 'attribute') {
      const attr = childByField(node, 'attribute');
      if (attr) result.references.add(text(attr, src));
    } else if (node.type === 'string' || node.type === 'string_content') {
      result.strings.push(text(node, src));
    } else if (node.type === 'call') {
      const fn = childByField(node, 'function');
      if (fn) {
        const callee = text(fn, src);
        const base = callee.split('.').pop();
        result.calls.push({ name: base, full: callee, line: node.startPosition.row + 1 });
        result.references.add(base);
        if (['getattr', 'importlib', '__import__', 'eval', 'exec'].includes(base)) {
          result.dynamic = true;
          result.dynamicReasons.push(`dynamic ${base}() at line ${node.startPosition.row + 1}`);
        }
      }
    }
  });

  // --- pass 3: unreachable code (statements after return/raise/break/continue) ---
  walk(root, (node) => {
    if (node.type === 'block') {
      let terminated = false;
      for (let i = 0; i < node.namedChildCount; i++) {
        const stmt = node.namedChild(i);
        if (stmt.type === 'comment') continue; // a trailing comment is not code
        if (terminated) {
          const t = text(stmt, src).trim();
          if (t) {
            result.unreachable.push({ range: rangeOf(stmt), line: stmt.startPosition.row + 1, reason: 'code after return/raise/break/continue', snippet: t.slice(0, 120) });
          }
        }
        if (['return_statement', 'raise_statement', 'break_statement', 'continue_statement'].includes(stmt.type)) terminated = true;
      }
    }
  });

  return result;
}

module.exports = { parsePy, DUNDER_KEEP };
