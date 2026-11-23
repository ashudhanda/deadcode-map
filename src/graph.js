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
const { parseJava } = require('./parse-java');

const JS_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
const PY_EXTS = ['.py'];
const JAVA_EXTS = ['.java'];

const WORD_CHAR = 'A-Za-z0-9_';
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Boundary-aware regex for a name that may start with a non-word char
 * (a scoped dependency: @scope/pkg). Plain \b fails before '@', so a
 * scoped name could never match at all. For names that start and end
 * with a word char this builds exactly \b...\b, so symbol matching is
 * unchanged. The leading boundary may consume one char; callers that
 * need exact positions must account for m[0].length - name.length.
 */
function mentionRegExp(name, flags) {
  const esc = escapeRegExp(name);
  const start = new RegExp(`^[${WORD_CHAR}]`).test(name) ? '\\b' : `(?:^|[^${WORD_CHAR}])`;
  const end = new RegExp(`[${WORD_CHAR}]$`).test(name) ? '\\b' : `(?![${WORD_CHAR}])`;
  return new RegExp(start + esc + end, flags);
}

function resolveFromBase(base, existingFiles) {
  const candidates = [];
  if (path.extname(base)) candidates.push(base);
  // TypeScript ESM style: source files import `./x.js` but the file on
  // disk is `x.ts` (tsc rewrites the extension at build time). Without
  // this, every `.js`-suffixed import in a TS repo missed its edge and
  // the target's exports looked dead (umami's seed scripts, date-fns).
  if (base.endsWith('.js')) {
    for (const ext of ['.ts', '.tsx', '.d.ts', '.mts', '.cts']) candidates.push(base.slice(0, -3) + ext);
  }
  for (const ext of [...JS_EXTS, ...PY_EXTS]) candidates.push(base + ext);
  for (const ext of [...JS_EXTS, ...PY_EXTS]) candidates.push(path.join(base, 'index' + ext));
  candidates.push(path.join(base, '__init__.py'));
  for (const c of candidates) if (existingFiles.has(c)) return c;
  return null;
}

function resolveRelative(fromFile, source, existingFiles) {
  if (!source.startsWith('.')) return null;
  return resolveFromBase(path.resolve(path.dirname(fromFile), source), existingFiles);
}

/**
 * tsconfig / jsconfig `paths` aliases (`@/*` -> `./src/*`), the
 * standard Next.js / Vite / monorepo import style. Without this, every
 * `@/lib/...` import missed its edge and the target's exports looked
 * dead (umami: most of its 196 SAFE findings were `@/` imports).
 *
 * `extends` is NOT followed yet: paths must live in the local
 * tsconfig/jsconfig. A base config that holds the paths is a known gap.
 */
function loadTsAliases(discovery) {
  const out = [];
  for (const f of discovery.textFiles || []) {
    const base = path.basename(f);
    if (base !== 'tsconfig.json' && base !== 'jsconfig.json') continue;
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
    const opts = (cfg && cfg.compilerOptions) || {};
    if (!opts.paths || typeof opts.paths !== 'object') continue;
    const dir = path.dirname(f);
    const baseUrl = opts.baseUrl ? path.resolve(dir, opts.baseUrl) : dir;
    const paths = [];
    for (const [pattern, targets] of Object.entries(opts.paths)) {
      if (!Array.isArray(targets)) continue;
      const star = pattern.indexOf('*');
      paths.push({
        prefix: star < 0 ? pattern : pattern.slice(0, star),
        suffix: star < 0 ? '' : pattern.slice(star + 1),
        hasStar: star >= 0,
        targets: targets.filter((t) => typeof t === 'string'),
      });
    }
    if (paths.length) out.push({ dir, baseUrl, paths });
  }
  return out;
}

function resolveAlias(fromFile, source, aliases, existingFiles) {
  // Nearest config to the importing file wins: monorepo packages can
  // each have their own tsconfig with their own paths.
  let best = null;
  for (const a of aliases) {
    if (fromFile === a.dir || fromFile.startsWith(a.dir + path.sep)) {
      if (!best || a.dir.length > best.dir.length) best = a;
    }
  }
  if (!best) return null;
  for (const p of best.paths) {
    let rest = null;
    if (p.hasStar) {
      if (!source.startsWith(p.prefix) || !source.endsWith(p.suffix)) continue;
      rest = source.slice(p.prefix.length, source.length - p.suffix.length);
    } else if (source === p.prefix) {
      rest = '';
    } else continue;
    for (const t of p.targets) {
      const mapped = p.hasStar ? t.replace('*', rest) : t;
      const target = resolveFromBase(path.resolve(best.baseUrl, mapped), existingFiles);
      if (target) return target;
    }
  }
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

/**
 * Workspace package self-references (FP-8): a monorepo's own packages
 * are imported by name from inside the repo (`import { createApp } from
 * 'vue'` in vuejs-core, `@vue/shared` from a sibling package,
 * `dts-built-test/src/index` as a workspace subpath). The name resolves
 * to the package's own source, not to an npm install: the package
 * directory's src/index (preferred — dist/ is build output and is
 * skipped from scans) or the manifest's main / module / types entry
 * when no src/index exists. Longest name wins, so `@vue` never shadows
 * `@vue/shared`. A name with no in-repo source returns null and falls
 * through to the alias / external-dependency handling below.
 */
function loadWorkspacePackages(discovery, existingFiles) {
  const byName = new Map(); // package name -> { dir, sourceEntry }
  for (const f of discovery.textFiles || []) {
    if (path.basename(f) !== 'package.json') continue;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
    if (!manifest || typeof manifest.name !== 'string' || !manifest.name) continue;
    if (byName.has(manifest.name)) continue; // first manifest wins; duplicates are a repo error
    const dir = path.dirname(f);
    let sourceEntry = null;
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']) {
      const cand = path.join(dir, 'src', 'index' + ext);
      if (existingFiles.has(cand)) { sourceEntry = cand; break; }
    }
    if (!sourceEntry) {
      const entries = [];
      const collect = (v) => {
        if (typeof v === 'string') entries.push(v);
        else if (v && typeof v === 'object') Object.values(v).forEach(collect);
      };
      collect(manifest.main); collect(manifest.module); collect(manifest.types); collect(manifest.typings);
      collect(manifest.exports);
      for (const e of entries) {
        const resolved = resolveFromBase(path.resolve(dir, e), existingFiles);
        if (resolved) { sourceEntry = resolved; break; }
      }
    }
    if (!sourceEntry) {
      for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']) {
        const cand = path.join(dir, 'index' + ext);
        if (existingFiles.has(cand)) { sourceEntry = cand; break; }
      }
    }
    byName.set(manifest.name, { dir, sourceEntry });
  }
  return [...byName.entries()].sort((a, b) => b[0].length - a[0].length); // longest name first
}

function resolveWorkspaceSelfRef(source, workspacePackages, existingFiles) {
  for (const [name, pkg] of workspacePackages) {
    if (source === name) return pkg.sourceEntry;
    if (source.startsWith(name + '/')) {
      return resolveFromBase(path.join(pkg.dir, source.slice(name.length + 1)), existingFiles);
    }
  }
  return null;
}

function analyze(root, discovery) {
  const existingFiles = new Set(discovery.codeFiles);
  const tsAliases = loadTsAliases(discovery);
  const workspacePackages = loadWorkspacePackages(discovery, existingFiles);
  const files = new Map(); // abs -> { rel, language, parsed, src, size }

  for (const f of discovery.codeFiles) {
    const ext = path.extname(f).toLowerCase();
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    let parsed;
    try {
      // A file whose parse contains ERROR / MISSING nodes is treated as
      // unparsed (parse-java.js sets hasErrors and returns no
      // definitions): its own findings are skipped, but its string
      // literals still protect the same names elsewhere.
      parsed = JS_EXTS.includes(ext) ? parseJsTs(f, src, ext) : JAVA_EXTS.includes(ext) ? parseJava(f, src) : parsePy(f, src);
    } catch (e) {
      // A parse failure must never kill the whole run; the file is skipped
      // with a warning and treated as live (never flagged).
      parsed = null;
    }
    files.set(f, {
      rel: path.relative(root, f), language: parsed ? parsed.language : (ext === '.py' ? 'py' : ext === '.java' ? 'java' : 'js'),
      parsed, src, size: src.length, ext, parseError: parsed ? (parsed.hasErrors ? 'parse errors' : null) : 'parse failed',
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
          edges.push({ target: t.target, source: imp.source, names: t.names, range: imp.range, reExport: Boolean(imp.reExport) });
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
      } else if (info.language !== 'py' && imp.source) {
        // Workspace self-reference first: the repo's own package name
        // resolves to its source, never to an npm install (FP-8).
        // tsconfig/jsconfig `paths` aliases (`@/lib/...`): the standard
        // Next.js / Vite / monorepo import style. A bare specifier that
        // is neither is an external dependency (npm package).
        target = resolveWorkspaceSelfRef(imp.source, workspacePackages, existingFiles);
        if (!target) target = resolveAlias(f, imp.source, tsAliases, existingFiles);
        if (!target) {
          if (!externalDeps.has(imp.source)) externalDeps.set(imp.source, new Set());
          externalDeps.get(imp.source).add(f);
        }
      }
      if (target) {
        edges.push({ target, source: imp.source, names: imp.names, range: imp.range, reExport: Boolean(imp.reExport) });
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
              edges.push({ target: sub, source: imp.source, names: [n], range: imp.range, reExport: Boolean(imp.reExport) });
              if (!importers.has(sub)) importers.set(sub, new Set());
              importers.get(sub).add(f);
            }
          }
        }
      }
    }
    // Dynamic import() targets are real edges too — a file loaded only
    // via import() is live, not dead. Aliases and workspace
    // self-references apply here as well.
    for (const dyn of info.parsed.dynamicImports || []) {
      const target = dyn.startsWith('.')
        ? resolveRelative(f, dyn, existingFiles)
        : (resolveWorkspaceSelfRef(dyn, workspacePackages, existingFiles)
          || resolveAlias(f, dyn, tsAliases, existingFiles));
      if (target) {
        edges.push({ target, source: dyn, names: [], range: null, dynamic: true });
        if (!importers.has(target)) importers.set(target, new Set());
        importers.get(target).add(f);
      }
    }
    importsByFile.set(f, edges);
  }

  // --- re-exported modules ---
  // A module bound by name through a re-export — Python
  // `from . import colors as colors` in `__init__.py`, JS
  // `export * as ns from './x'` — is public API of its package, and
  // users reach its contents through the package (`import typer` then
  // `typer.colors.RED`), not through a direct import edge to the module
  // file. reExports maps a re-exporting file to module name -> target
  // file; reExportedFiles is the set of those target files (public API,
  // REVIEW at most — see confidence.js).
  const moduleStem = (f) => {
    const base = path.basename(f, path.extname(f));
    return base === '__init__' ? path.basename(path.dirname(f)) : base;
  };
  const reExports = new Map(); // file -> Map<moduleName, targetFile>
  const reExportedFiles = new Set();
  for (const [f, edges] of importsByFile) {
    for (const e of edges) {
      if (!e.reExport) continue;
      for (const n of e.names || []) {
        // Namespace re-export binds the alias (`export * as ns`);
        // a named re-export binds the module when the imported name is
        // the module's own name (`from . import colors`).
        const modName = n.kind === 'namespace' ? n.local : (n.imported || '').split('.').pop();
        if (!modName || modName === '*') continue;
        if (n.kind !== 'namespace' && modName !== moduleStem(e.target)) continue;
        if (!reExports.has(f)) reExports.set(f, new Map());
        reExports.get(f).set(modName, e.target);
        reExportedFiles.add(e.target);
      }
    }
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
  // A mention only counts when it looks like a real dynamic reference,
  // not prose. Code files are searched inside string literals only, and
  // only when the name is the whole string or delimited by code
  // characters (/, ., :, -, _, ...): 'handlers.named' and './named'
  // count, 'a named export is nice' does not. Prose files (.md, .txt)
  // never execute, so they never count. Config / template files
  // (.json, .yaml, .html, ...) keep the raw-text match, because a value
  // there can wire a handler by name ({"handler": "stringOnlyFn"}).
  //
  // Coverage reports are tool output, not references: a Cobertura
  // coverage.xml lists every file it measured (filename="dead.py"),
  // so without this exclusion every covered file would look
  // string-referenced and the coverage demotion would never fire.
  // Same rule as src/coverage.js auto-discovery: coverage*.xml /
  // lcov*.info (and the exact names coverage.xml / lcov.info).
  const isCoverageReport = (f) => {
    const base = path.basename(f);
    return (base.startsWith('coverage') || base.startsWith('lcov')) && /\.(xml|info)$/.test(base);
  };
  const PROSE_EXTS = new Set(['.md', '.txt']);
  // Config files that wire code by name: Spring XML, MyBatis mapper
  // XML, application.properties — a member name in one of these is a
  // real reference (Java string-mention downgrade), so they match raw
  // text like .json / .yaml do. Prose files (.md, .txt) never count.
  const RAW_MATCH_EXTS = new Set(['.json', '.yaml', '.yml', '.toml', '.html', '.vue', '.css', '.xml', '.properties']);

  /** True when `name` appears in a string literal as code, not as a word in a sentence. */
  function codeLikeStringMention(literal, name) {
    const re = mentionRegExp(name, 'g');
    let m;
    while ((m = re.exec(literal)) !== null) {
      // The leading boundary may have consumed one char (scoped names
      // like @scope/pkg); the name itself starts after it.
      const start = m.index + (m[0].length - name.length);
      const end = start + name.length;
      const before = start === 0 ? '' : literal[start - 1];
      const after = end >= literal.length ? '' : literal[end];
      // A quote / string edge, or a non-space character on both sides,
      // means the name sits in code, not in a sentence.
      const beforeOk = before === '' || !/\s/.test(before);
      const afterOk = after === '' || !/\s/.test(after);
      if (beforeOk && afterOk) return true;
    }
    return false;
  }

  const textCache = new Map();
  // Inverted string index, built once per scan (lazily, on first use).
  // The old filesMentioning scanned every text file per symbol —
  // O(symbols x files) — which collapsed throughput past ~1000 files
  // (umami: 25 -> 8.7 files/s). The index maps each code-like token to
  // the files mentioning it, so a lookup is a hash hit, not a scan.
  // Tokenisation mirrors codeLikeStringMention: in code files a token
  // only counts when it sits in code (delimited by non-space characters),
  // so words inside sentences do not count; in raw config files any
  // whole-word token counts, matching the old raw-text regex. Names with
  // non-word characters (scoped deps, hyphenated names) are rare and
  // keep the old per-name scan via scanFilesMentioning below.
  let stringIndex = null; // Map<token, Set<file>> | null
  function buildStringIndex() {
    const index = new Map(); // token -> Set<abs file>
    const addToken = (token, file) => {
      if (!index.has(token)) index.set(token, new Set());
      index.get(token).add(file);
    };
    const addLiteral = (literal, file, codeLike) => {
      const re = /[A-Za-z_][A-Za-z0-9_]*/g;
      let m;
      while ((m = re.exec(literal)) !== null) {
        // A token must not start in the middle of a number: `%5c` in a
        // URL is not a reference to `c`, and `%70age` is not a reference
        // to `age` — \b in the old per-name scan agrees (a digit before
        // the name breaks the word boundary). The token regex can only
        // start a match right after a digit (a letter or `_` before it
        // would have been consumed into the token itself), so a digit
        // guard is the whole fix. (The web analyzer has the same guard.)
        if (m.index > 0 && /[0-9]/.test(literal[m.index - 1])) continue;
        if (codeLike) {
          const before = m.index === 0 ? '' : literal[m.index - 1];
          const after = m.index + m[0].length >= literal.length ? '' : literal[m.index + m[0].length];
          if ((before !== '' && /\s/.test(before)) || (after !== '' && /\s/.test(after))) continue;
        }
        addToken(m[0], file);
      }
    };
    for (const f of discovery.textFiles) {
      const ext = path.extname(f).toLowerCase();
      if (PROSE_EXTS.has(ext)) continue; // prose never executes
      if (isCoverageReport(f)) continue; // tool output, not a reference
      if (JS_EXTS.includes(ext) || PY_EXTS.includes(ext) || JAVA_EXTS.includes(ext)) {
        const info = files.get(f);
        if (info && info.parsed) {
          for (const s of info.parsed.strings || []) addLiteral(s, f, true);
          continue;
        }
        // Unparseable code file: fall back to a raw-text match rather
        // than risk hiding a real reference.
      } else if (!RAW_MATCH_EXTS.has(ext)) {
        continue; // unknown text extension — do not guess
      }
      try {
        addLiteral(fs.readFileSync(f, 'utf8'), f, false);
      } catch (_) { /* binary / unreadable */ }
    }
    stringIndex = index;
  }
  // The old per-name scan, kept for names the index cannot answer
  // (scoped / hyphenated / dotted names with non-word characters).
  function scanFilesMentioning(name) {
    const re = mentionRegExp(name);
    const hits = new Set();
    for (const f of discovery.textFiles) {
      const ext = path.extname(f).toLowerCase();
      if (PROSE_EXTS.has(ext)) continue; // prose never executes
      if (isCoverageReport(f)) continue; // tool output, not a reference
      if (JS_EXTS.includes(ext) || PY_EXTS.includes(ext) || JAVA_EXTS.includes(ext)) {
        const info = files.get(f);
        if (info && info.parsed) {
          // String literals only — comments and sentences in docstrings
          // do not count; see codeLikeStringMention.
          if ((info.parsed.strings || []).some((s) => codeLikeStringMention(s, name))) hits.add(f);
          continue;
        }
        // Unparseable code file: fall back to a raw-text match rather
        // than risk hiding a real reference.
      } else if (!RAW_MATCH_EXTS.has(ext)) {
        continue; // unknown text extension — do not guess
      }
      try {
        const content = fs.readFileSync(f, 'utf8');
        if (re.test(content)) hits.add(f);
      } catch (_) { /* binary / unreadable */ }
    }
    return hits;
  }
  function filesMentioning(name) {
    if (textCache.has(name)) return textCache.get(name);
    let hits;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      if (!stringIndex) buildStringIndex();
      hits = stringIndex.get(name) || new Set();
    } else {
      hits = scanFilesMentioning(name);
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
        // Re-exported modules: an importer that reaches a package
        // through its __init__ (`import typer`, `from typer import
        // colors`) and then uses `typer.colors.RED` touches colors.py's
        // RED, even though the import edge points at __init__.py, not
        // colors.py. Same shape for JS namespace re-exports.
        const reExp = reExports.get(e.target);
        if (reExp) {
          for (const [modName, subFile] of reExp) {
            const reachesModule = (e.names || []).some((n) => n.imported === modName || n.local === modName)
              || importerInfo.parsed.references.has(modName);
            if (!reachesModule) continue;
            const subMap = symbolUsage.get(subFile);
            if (!subMap) continue;
            for (const [name, u] of subMap) {
              if (importerInfo.parsed.references.has(name)) u.importedBy.add(f);
            }
          }
        }
      }
    }
    // Constructor calls across files: `new Client()` in an importer
    // that imports Client from another file calls that file's
    // `constructor` method. Same-file construction is already covered
    // by the same-file calls loop above.
    const importerInfo = files.get(f);
    if (importerInfo && importerInfo.parsed) {
      for (const call of importerInfo.parsed.calls || []) {
        if (call.name !== 'constructor' || !call.forClass) continue;
        for (const e of edges) {
          if (!(e.names || []).some((n) => n.local === call.forClass || n.imported === call.forClass)) continue;
          const targetMap = symbolUsage.get(e.target);
          if (targetMap && targetMap.has('constructor')) targetMap.get('constructor').calledIn.add(f);
        }
      }
    }
  }

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
  // is not a call.
  const classicScripts = new Set();
  for (const [f, info] of files) {
    if (info.language !== 'js' || !info.parsed) continue;
    if (!info.parsed.hasModuleSyntax) classicScripts.add(f);
  }
  const globalDefs = new Map(); // name -> abs file of the unique global definition
  {
    const defCounts = new Map(); // name -> top-level runtime defs with that name
    const classicDefFile = new Map(); // name -> file, when a classic script defines it
    for (const [f, info] of files) {
      if (info.language !== 'js' || !info.parsed) continue;
      for (const d of info.parsed.definitions || []) {
        if (d.local || d.kind === 'method' || d.kind === 'type') continue;
        defCounts.set(d.name, (defCounts.get(d.name) || 0) + 1);
        if (classicScripts.has(f) && !classicDefFile.has(d.name)) classicDefFile.set(d.name, f);
      }
    }
    for (const [name, f] of classicDefFile) {
      if (defCounts.get(name) === 1) globalDefs.set(name, f);
    }
  }
  for (const [g, ginfo] of files) {
    if (!classicScripts.has(g) || !ginfo.parsed) continue;
    const definedHere = new Set();
    for (const d of ginfo.parsed.definitions || []) {
      if (!d.local && d.kind !== 'method' && d.kind !== 'type') definedHere.add(d.name);
    }
    const importedHere = new Set();
    for (const imp of ginfo.parsed.imports || []) for (const n of imp.names || []) importedHere.add(n.local);
    for (const call of ginfo.parsed.calls || []) {
      // A `new X()` in a classic script constructs the global X: the
      // parser records it as a `constructor` call with the constructed
      // name in `forClass` (the member-access base — `new ns.X()`
      // builds X), so the global lookup must use forClass, not the
      // literal call name `constructor`. Without this, vuejs/vue's
      // `new MemoryStats()` in the classic script
      // benchmarks/dbmon/lib/monitor.js never rescued the global
      // MemoryStats defined in benchmarks/dbmon/lib/memory-stats.js.
      // A plain call to a function literally named `constructor` has
      // no forClass, so it still resolves under its own name.
      const name = call.name === 'constructor' && call.forClass ? call.forClass : call.name;
      if (definedHere.has(name) || importedHere.has(name)) continue;
      const defFile = globalDefs.get(name);
      if (!defFile || defFile === g) continue;
      const map = symbolUsage.get(defFile);
      const u = map && map.get(name);
      if (u) u.calledIn.add(g);
    }
  }

  return {
    files, importers, importsByFile, externalDeps, reachable,
    filesMentioning, symbolUsage, reExports, reExportedFiles, classicScripts,
  };
}

module.exports = { analyze, resolveRelative, mentionRegExp };
