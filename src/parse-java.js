'use strict';

/**
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

const Parser = require('tree-sitter');
const Java = require('tree-sitter-java');
const path = require('path');

let parser = null;
function getParser() {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Java);
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
// already keeps it (see confidence.js).
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

// Modifiers live in a `modifiers` child; annotations may sit inside it
// or directly on the declaration. Both placements are collected.
function modifiersOf(node, src) {
  const mods = { private: false, static: false, final: false, native: false, annotations: [], decorators: [] };
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === 'modifiers') {
      const raw = text(c, src);
      if (/\bprivate\b/.test(raw)) mods.private = true;
      if (/\bstatic\b/.test(raw)) mods.static = true;
      if (/\bfinal\b/.test(raw)) mods.final = true;
      if (/\bnative\b/.test(raw)) mods.native = true;
      for (let j = 0; j < c.namedChildCount; j++) {
        const m = c.namedChild(j);
        if (m.type === 'marker_annotation' || m.type === 'annotation') {
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

// (name, arity) of a method/constructor declaration. The last
// parameter of a varargs method is a spread_parameter: it still counts
// as one parameter, and fixedArity is the count before it — a call
// site with arity >= fixedArity can match it.
function arityOf(node) {
  const params = childByField(node, 'parameters');
  if (!params) return { arity: 0, varargs: false, fixedArity: 0 };
  let varargs = false;
  for (let i = 0; i < params.namedChildCount; i++) {
    if (params.namedChild(i).type === 'spread_parameter') varargs = true;
  }
  const arity = params.namedChildCount;
  return { arity, varargs, fixedArity: varargs ? arity - 1 : arity };
}

function parseJava(filePath, src) {
  const tree = parseSource(getParser(), src);
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
  if (hasError) {
    result.hasErrors = true;
    result.topLevelUses = [];
    result.topLevelUsesArity = [];
    return result;
  }

  const occurrences = []; // { name, startIndex } — general channel (reads + calls)
  const arityOccurrences = []; // { key, startIndex } — "name/arity" / "name/*"
  const writeCounts = new Map(); // name -> number of plain-`=` writes
  const addRef = (name, node, startIndex) => {
    if (!name) return;
    result.references.add(name);
    occurrences.push({ name, startIndex: startIndex !== undefined ? startIndex : (node ? node.startIndex : 0) });
  };
  const addArityOcc = (key, startIndex) => {
    if (!key) return;
    arityOccurrences.push({ key, startIndex });
  };

  // Per-class info, from the class stack: the nearest named enclosing
  // class (anonymous classes have no name and inherit the outer
  // class's annotations for the framework check).
  const classStack = [];
  const currentClass = () => {
    for (let i = classStack.length - 1; i >= 0; i--) {
      if (classStack[i].name) return classStack[i];
    }
    return { name: null, annotations: [], node: null };
  };
  const isTestFile = /(^|\/)src\/test\/java\//.test(filePath.replace(/\\/g, '/'))
    || /Test\.java$/.test(path.basename(filePath));

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
      pushed = { name: nameNode ? text(nameNode, src) : null, annotations: mods.annotations, node };
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
    collectMember(node);
    for (let i = 0; i < node.namedChildCount; i++) traverse(node.namedChild(i));
    if (pushed) classStack.pop();
  }

  // True when the declaration carries a `public` modifier (the
  // modifiers child may be absent for package-private declarations).
  function hasPublicModifier(node, srcText) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === 'modifiers' && /\bpublic\b/.test(text(c, srcText))) return true;
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
        arity, varargs, fixedArity,
        isConstructor: isCtor,
        javaName: isCtor ? (nameNode ? text(nameNode, src) : cls.name) : name,
        anonymousClass: classStack.length > 0 && classStack[classStack.length - 1].name === null,
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
          multiDeclarator: declarators.length > 1,
          // The whole declaration, so --fix can delete the statement
          // when every declarator in it is dead (see fix.js).
          statementRange: declarators.length > 1 ? rangeOf(node) : null,
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
    // Identifiers inside an import or package statement are module
    // paths and bound names, never references — without this, every
    // imported name leaked into `references` and no unused Java import
    // was ever flagged.
    let ancestor = node.parent;
    while (ancestor) {
      if (ancestor.type === 'import_declaration' || ancestor.type === 'package_declaration') return true;
      ancestor = ancestor.parent;
    }
    const p = node.parent;
    if (!p) return false;
    if (p.type === 'variable_declarator' && sameNode(childByField(p, 'name'), node)) return true;
    if ((p.type === 'formal_parameter' || p.type === 'spread_parameter') && sameNode(childByField(p, 'name'), node)) return true;
    if (CLASS_NODE_TYPES.has(p.type) && sameNode(childByField(p, 'name'), node)) return true;
    if ((p.type === 'method_declaration' || p.type === 'constructor_declaration') && sameNode(childByField(p, 'name'), node)) return true;
    if ((p.type === 'marker_annotation' || p.type === 'annotation') && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'enum_constant' && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'enhanced_for_statement' && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'catch_formal_parameter' && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'instanceof_expression' && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'type_pattern' && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'labeled_statement' && sameNode(p.namedChild(0), node)) return true;
    if (p.type === 'resource' && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'method_invocation' && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'method_reference') {
      // The LAST named child is the referenced method name; earlier
      // children are the object (a real read, e.g. `obj::m` reads obj).
      const last = p.namedChild(p.namedChildCount - 1);
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
    'catch_clause',
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
            addRef(name, node);
          }
        }
      }
    } else if (node.type === 'type_identifier') {
      if (!isDefinitionSite(node)) addRef(text(node, src), node);
    } else if (node.type === 'method_invocation') {
      const nameNode = childByField(node, 'name');
      if (nameNode) {
        const name = text(nameNode, src);
        const args = childByField(node, 'arguments');
        const arity = args ? args.namedChildCount : 0;
        result.calls.push({ name, full: name, line: node.startPosition.row + 1, startIndex: node.startIndex, arity });
        addRef(name, nameNode);
        addArityOcc(`${name}/${arity}`, node.startIndex);
      }
    } else if (node.type === 'method_reference') {
      const last = node.namedChild(node.namedChildCount - 1);
      if (last && last.type === 'identifier') {
        const name = text(last, src);
        if (name === 'new') {
          const first = node.namedChild(0);
          const forClass = first ? text(first, src).split(/[^A-Za-z0-9_$]/).filter(Boolean).pop() : null;
          result.calls.push({ name: 'constructor', full: 'constructor', line: node.startPosition.row + 1, startIndex: node.startIndex, arity: null, forClass, methodRef: true });
          addArityOcc(`constructor/*@${forClass || 'super'}`, node.startIndex);
        } else {
          result.calls.push({ name, full: name, line: node.startPosition.row + 1, startIndex: node.startIndex, arity: null, methodRef: true });
          addRef(name, last);
          addArityOcc(`${name}/*`, node.startIndex);
        }
      }
    } else if (node.type === 'object_creation_expression') {
      const typeNode = childByField(node, 'type');
      const args = childByField(node, 'arguments');
      if (typeNode) {
        const rawType = text(typeNode, src);
        const forClass = rawType.split(/[^A-Za-z0-9_$]/).filter(Boolean).pop();
        const arity = args ? args.namedChildCount : 0;
        result.calls.push({ name: 'constructor', full: 'constructor', line: node.startPosition.row + 1, startIndex: node.startIndex, arity, forClass });
        addArityOcc(`constructor/${arity}@${forClass || 'super'}`, node.startIndex);
      }
    } else if (node.type === 'explicit_constructor_invocation') {
      const ctor = childByField(node, 'constructor');
      const args = childByField(node, 'arguments');
      const arity = args ? args.namedChildCount : 0;
      const raw = ctor ? text(ctor, src) : '';
      if (raw === 'this') {
        const cls = currentClass();
        result.calls.push({ name: 'constructor', full: 'constructor', line: node.startPosition.row + 1, startIndex: node.startIndex, arity, forClass: cls.name });
        addArityOcc(`constructor/${arity}@${cls.name || 'super'}`, node.startIndex);
      } else if (raw === 'super') {
        result.calls.push({ name: 'constructor', full: 'constructor', line: node.startPosition.row + 1, startIndex: node.startIndex, arity, forClass: null });
        addArityOcc(`constructor/${arity}@super`, node.startIndex);
      }
    }
  }

  function walk2(node) {
    const isClass = CLASS_NODE_TYPES.has(node.type);
    if (isClass) {
      const nameNode = childByField(node, 'name');
      const mods = modifiersOf(node, src);
      classStack.push({ name: nameNode ? text(nameNode, src) : null, annotations: mods.annotations, node });
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
      const isFalse = Boolean(cond
        && ((cond.type === 'parenthesized_expression' && cond.namedChildCount > 0 && cond.namedChild(0).type === 'false')
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
  const attribute = (list, startIndex, name, isArity) => {
    if (startIndex < 0) {
      if (isArity) topLevelUsesArity.add(name); else topLevelUses.add(name);
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
      const map = isArity ? arityByDef : usesByDef;
      if (!map.has(best)) map.set(best, new Set());
      map.get(best).add(name);
    } else if (isArity) topLevelUsesArity.add(name);
    else topLevelUses.add(name);
  };
  for (const occ of occurrences) attribute(occ, occ.startIndex, occ.name, false);
  for (const occ of arityOccurrences) attribute(occ, occ.startIndex, occ.key, true);
  for (const d of result.definitions) {
    d.uses = [...(usesByDef.get(d) || [])].sort();
    d.usesArity = [...(arityByDef.get(d) || [])].sort();
  }
  result.topLevelUses = [...topLevelUses].sort();
  result.topLevelUsesArity = [...topLevelUsesArity].sort();

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

module.exports = { parseJava, FRAMEWORK_CLASS_ANNOTATIONS };
