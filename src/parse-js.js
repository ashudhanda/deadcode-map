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
  const tree = parser.parse(src);
  const root = tree.rootNode;

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
    result.definitions.push({
      name, kind, exported: false, isDefault: false,
      range: rangeOf(node), startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1, decorators: decs, ...(extra || {}),
    });
  };

  // --- pass 1: structure (imports / exports / definitions / decorators) ---
  walk(root, (node) => {
    switch (node.type) {
      case 'import_statement': {
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
        if (nameNode) addDef(text(nameNode, src), 'method', node);
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
  const isDefinitionSite = (node) => {
    const p = node.parent;
    if (!p) return false;
    if (p.type === 'variable_declarator' && sameNode(childByField(p, 'name'), node)) return true;
    if ((p.type === 'function_declaration' || p.type === 'class_declaration' || p.type === 'type_alias_declaration' || p.type === 'interface_declaration') && sameNode(childByField(p, 'name'), node)) return true;
    if (p.type === 'import_specifier' || p.type === 'export_specifier') return true;
    if (p.type === 'import_clause') return true;
    if (p.type === 'namespace_import') return true;
    if (p.type === 'property_signature' && sameNode(childByField(p, 'name'), node)) return true;
    return false;
  };

  walk(root, (node) => {
    if (node.type === 'identifier') {
      if (!isDefinitionSite(node)) result.references.add(text(node, src));
    } else if (node.type === 'property_identifier') {
      result.references.add(text(node, src));
    } else if (node.type === 'jsx_identifier' || node.type === 'jsx_namespace_name') {
      result.references.add(text(node, src));
    } else if (node.type === 'shorthand_property_identifier') {
      // { graph, findings } in an object literal IS a use of those variables.
      // Except in `module.exports = { foo }`, where it is an export, not a use.
      const obj = node.parent;
      const assign = obj && obj.parent;
      const isModuleExports = assign && assign.type === 'assignment_expression'
        && (() => { const left = childByField(assign, 'left'); return left && /^module\.exports|^exports\./.test(text(left, src)); })();
      if (!isModuleExports) result.references.add(text(node, src));
    } else if (node.type === 'string' || node.type === 'template_string') {
      result.strings.push(text(node, src));
    } else if (node.type === 'call_expression') {
      const fn = childByField(node, 'function');
      if (fn) {
        const callee = text(fn, src);
        const base = callee.split('.').pop();
        result.calls.push({ name: base, full: callee, line: node.startPosition.row + 1 });
        result.references.add(base);
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
  walk(root, (node) => {
    if (node.type === 'statement_block' || node.type === 'program') {
      let terminated = false;
      for (let i = 0; i < node.namedChildCount; i++) {
        const stmt = node.namedChild(i);
        if (stmt.type === 'comment') continue; // a trailing comment is not code
        if (terminated) {
          const t = text(stmt, src).trim();
          if (t && t !== '}' && t.length > 0) {
            result.unreachable.push({ range: rangeOf(stmt), line: stmt.startPosition.row + 1, reason: 'code after return/throw/break/continue', snippet: t.slice(0, 120) });
          }
        }
        if (['return_statement', 'throw_statement', 'break_statement', 'continue_statement'].includes(stmt.type)) terminated = true;
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

  return result;
}

module.exports = { parseJsTs };
