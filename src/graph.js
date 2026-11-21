'use strict';

/**
 * Import graph + symbol usage + string-reference pass.
 *
 * This is the part that must be right: flat name-matching is the Vulture
 * mistake. A symbol is used only when a real import, call, reference, or
 * string mention reaches it.
 */

const fs = require('fs');
const path = require('path');
const { parseJsTs } = require('./parse-js');
const { parsePy } = require('./parse-py');

const JS_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
const PY_EXTS = ['.py'];

function resolveRelative(fromFile, source, existingFiles) {
  if (!source.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), source);
  const candidates = [];
  if (path.extname(base)) candidates.push(base);
  for (const ext of [...JS_EXTS, ...PY_EXTS]) candidates.push(base + ext);
  for (const ext of [...JS_EXTS, ...PY_EXTS]) candidates.push(path.join(base, 'index' + ext));
  candidates.push(path.join(base, '__init__.py'));
  for (const c of candidates) if (existingFiles.has(c)) return c;
  return null;
}

/** A Python module path without an extension: try `<path>.py`, then `<path>/__init__.py`. */
function pyModuleFile(dir, existingFiles) {
  for (const cand of [dir + '.py', path.join(dir, '__init__.py')]) {
    if (existingFiles.has(cand)) return cand;
  }
  return null;
}

/**
 * Python relative import: `from . import x`, `from ..utils import y`.
 *
 * Returns a list of { target, names } edges — one per module the import
 * actually binds — because `from . import a, b` imports two separate
 * modules, and `from .pkg import sub` may bind the submodule pkg/sub
 * rather than an attribute of pkg.
 *
 * `level` is the leading-dot count (1 = current package, 2 = parent, ...).
 * A name that the target package defines itself is an attribute of that
 * package, not a submodule — so it gets an edge to the package, never a
 * spurious edge to a same-named file.
 */
function resolvePyRelative(fromFile, source, names, level, existingFiles, files) {
  let base = path.dirname(fromFile);
  for (let i = 1; i < level; i++) base = path.dirname(base); // level 1 = current directory
  const defines = (file, name) => {
    const info = files.get(file);
    return Boolean(info && info.parsed && info.parsed.definitions.some((d) => d.name === name));
  };
  const byTarget = new Map(); // target -> merged names
  const addEdge = (target, edgeNames) => {
    if (!target) return;
    if (!byTarget.has(target)) byTarget.set(target, []);
    for (const n of edgeNames) {
      if (!byTarget.get(target).some((x) => x.imported === n.imported && x.local === n.local)) byTarget.get(target).push(n);
    }
  };
  if (source) {
    const modPath = path.join(base, ...source.split('.'));
    const modFile = pyModuleFile(modPath, existingFiles);
    if (modFile) {
      addEdge(modFile, names);
      for (const n of names || []) {
        if (n.imported === '*') continue;
        if (defines(modFile, n.imported)) continue;
        addEdge(pyModuleFile(path.join(modPath, n.imported), existingFiles), [n]);
      }
    }
  } else {
    // `from . import a, b` — each name is a module in the base directory.
    const init = path.join(base, '__init__.py');
    for (const n of names || []) {
      if (n.imported === '*') {
        if (existingFiles.has(init)) addEdge(init, [n]);
        continue;
      }
      if (existingFiles.has(init) && defines(init, n.imported)) { addEdge(init, [n]); continue; }
      const sub = pyModuleFile(path.join(base, n.imported), existingFiles);
      if (sub) addEdge(sub, [n]);
      else if (existingFiles.has(init)) addEdge(init, [n]);
    }
  }
  return [...byTarget.entries()].map(([target, edgeNames]) => ({ target, names: edgeNames }));
}

/** Python bare import: `from utils import x` in the same directory or at the root. */
function resolvePyModule(fromFile, source, existingFiles, root) {
  const parts = source.split('.');
  const dirs = [path.dirname(fromFile), root];
  for (const dir of dirs) {
    const base = path.join(dir, ...parts);
    for (const cand of [base + '.py', path.join(base, '__init__.py')]) {
      if (existingFiles.has(cand)) return cand;
    }
  }
  return null;
}

function analyze(root, discovery) {
  const existingFiles = new Set(discovery.codeFiles);
  const files = new Map(); // abs -> { rel, language, parsed, src, size }

  for (const f of discovery.codeFiles) {
    const ext = path.extname(f).toLowerCase();
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    let parsed;
    try {
      parsed = JS_EXTS.includes(ext) ? parseJsTs(f, src, ext) : parsePy(f, src);
    } catch (e) {
      // A parse failure must never kill the whole run; the file is skipped
      // with a warning and treated as live (never flagged).
      parsed = null;
    }
    files.set(f, {
      rel: path.relative(root, f), language: parsed ? parsed.language : (ext === '.py' ? 'py' : 'js'),
      parsed, src, size: src.length, ext, parseError: parsed ? null : 'parse failed',
    });
  }

  // --- import edges ---
  const importers = new Map(); // file -> Set<file> that import it
  const importsByFile = new Map(); // file -> [{ target, source, names }]
  const externalDeps = new Map(); // bare specifier -> Set<file>
  for (const [f, info] of files) {
    if (!info.parsed) continue;
    const edges = [];
    for (const imp of info.parsed.imports) {
      // Python relative imports resolve to one edge per module they bind
      // (see resolvePyRelative). They must be handled before the
      // startsWith('.') branch below: a relative source like ".core"
      // is not a JS-style relative path.
      if (imp.fromImport && imp.relative) {
        for (const t of resolvePyRelative(f, imp.source, imp.names, imp.level || 1, existingFiles, files)) {
          edges.push({ target: t.target, source: imp.source, names: t.names, range: imp.range });
          if (!importers.has(t.target)) importers.set(t.target, new Set());
          importers.get(t.target).add(f);
        }
        continue;
      }
      let target = null;
      if (imp.source.startsWith('.')) {
        target = resolveRelative(f, imp.source, existingFiles);
      } else if (info.language === 'py' && imp.source) {
        // Python: a bare module name usually means a sibling file.
        target = resolvePyModule(f, imp.source, existingFiles, root);
        if (!target) {
          if (!externalDeps.has(imp.source)) externalDeps.set(imp.source, new Set());
          externalDeps.get(imp.source).add(f);
        }
      } else if (imp.source) {
        // Bare specifier: external dependency (JS) or stdlib/third-party (Python).
        if (!externalDeps.has(imp.source)) externalDeps.set(imp.source, new Set());
        externalDeps.get(imp.source).add(f);
      }
      if (target) {
        edges.push({ target, source: imp.source, names: imp.names, range: imp.range });
        if (!importers.has(target)) importers.set(target, new Set());
        importers.get(target).add(f);
        if (info.language === 'py' && imp.fromImport) {
          // `from pkg import sub` binds the submodule pkg/sub, not an
          // attribute of pkg/__init__.py — unless the package defines
          // the name itself. Without this edge the submodule looks dead.
          const targetInfo = files.get(target);
          const defined = new Set((targetInfo && targetInfo.parsed ? targetInfo.parsed.definitions : []).map((d) => d.name));
          const targetDir = path.dirname(target);
          for (const n of imp.names || []) {
            if (n.imported === '*' || defined.has(n.imported)) continue;
            const sub = pyModuleFile(path.join(targetDir, n.imported), existingFiles);
            if (sub && sub !== target) {
              edges.push({ target: sub, source: imp.source, names: [n], range: imp.range });
              if (!importers.has(sub)) importers.set(sub, new Set());
              importers.get(sub).add(f);
            }
          }
        }
      }
    }
    // Dynamic import() targets are real edges too — a file loaded only
    // via import() is live, not dead.
    for (const dyn of info.parsed.dynamicImports || []) {
      const target = resolveRelative(f, dyn, existingFiles);
      if (target) {
        edges.push({ target, source: dyn, names: [], range: null, dynamic: true });
        if (!importers.has(target)) importers.set(target, new Set());
        importers.get(target).add(f);
      }
    }
    importsByFile.set(f, edges);
  }

  // --- reachability from entry points ---
  const reachable = new Set(discovery.entries.keys());
  const queue = [...reachable];
  while (queue.length) {
    const cur = queue.pop();
    for (const e of importsByFile.get(cur) || []) {
      if (!reachable.has(e.target)) { reachable.add(e.target); queue.push(e.target); }
    }
  }

  // --- repo-wide string index (for the string-reference pass) ---
  // For each symbol name, the set of files whose raw text mentions it.
  // Built lazily per name via a scan of text files (cheap enough at this scale).
  const textCache = new Map();
  function filesMentioning(name) {
    if (textCache.has(name)) return textCache.get(name);
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const hits = new Set();
    for (const f of discovery.textFiles) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        if (re.test(content)) hits.add(f);
      } catch (_) { /* binary / unreadable */ }
    }
    textCache.set(name, hits);
    return hits;
  }

  // --- per-symbol usage ---
  // usage: Map<file, Map<symbolName, { importedBy:Set, calledIn:Set, stringIn:Set, sameFile:boolean }>>
  const symbolUsage = new Map();
  for (const [f, info] of files) {
    if (!info.parsed) continue;
    const map = new Map();
    for (const d of info.parsed.definitions) {
      map.set(d.name, { importedBy: new Set(), calledIn: new Set(), stringIn: new Set(), sameFile: false });
    }
    symbolUsage.set(f, map);
  }

  // Same-file references + calls.
  for (const [f, info] of files) {
    if (!info.parsed) continue;
    const map = symbolUsage.get(f);
    for (const ref of info.parsed.references) {
      if (map.has(ref)) map.get(ref).sameFile = true;
    }
    for (const call of info.parsed.calls) {
      if (map.has(call.name)) map.get(call.name).calledIn.add(f);
    }
  }

  // Cross-file: importers of a file that name a symbol.
  for (const [f, edges] of importsByFile) {
    for (const e of edges) {
      const targetMap = symbolUsage.get(e.target);
      if (!targetMap) continue;
      for (const n of e.names || []) {
        if (n.kind === 'namespace') {
          // import * as ns — every export of the target is potentially used.
          for (const u of targetMap.values()) u.importedBy.add(f);
        } else if (targetMap.has(n.imported)) {
          targetMap.get(n.imported).importedBy.add(f);
        } else if (n.imported === 'default') {
          for (const [name, u] of targetMap) {
            const def = files.get(e.target).parsed.definitions.find((d) => d.name === name);
            if (def && def.isDefault) u.importedBy.add(f);
          }
        }
      }
      // Member use via a required module object: require('./x').fn() or
      // const x = require('./x'); x.fn(). The import names are empty, but
      // the export name appears as a property reference in the importer.
      const importerInfo = files.get(f);
      if (importerInfo && importerInfo.parsed) {
        for (const [name, u] of targetMap) {
          if (importerInfo.parsed.references.has(name)) u.importedBy.add(f);
        }
      }
    }
  }

  return {
    files, importers, importsByFile, externalDeps, reachable,
    filesMentioning, symbolUsage,
  };
}

module.exports = { analyze, resolveRelative };
