'use strict';

/**
 * Confidence + evidence engine.
 *
 * Grades: SAFE (provable — delete it), REVIEW (human eye needed),
 * KEEP (never flag). Default output shows SAFE + REVIEW, hides KEEP.
 *
 * Rules, in order:
 *  - Entry points, tests, stories, config, migrations, framework magic,
 *    dunder / protocol methods, decorated handlers: KEEP.
 *  - Dynamic imports / reflection nearby: never SAFE.
 *  - Public API of a published library: REVIEW at best, never SAFE.
 *  - Same-file use: alive — a symbol called in its own file is never flagged.
 *  - String reference anywhere else: REVIEW, never SAFE.
 *  - Everything else with 0 importers / 0 callers / 0 string refs: SAFE.
 */

const fs = require('fs');
const path = require('path');
const { mentionRegExp } = require('./graph');
const { coverageForSymbol, coverageForSymbolBody } = require('./coverage');
const { isManualScriptPath } = require('./discover');
const { FRAMEWORK_CLASS_ANNOTATIONS } = require('./parse-java');

function loadFrameworks(dir) {
  const packs = [];
  if (!fs.existsSync(dir)) return packs;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const pack = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      pack._file = f;
      packs.push(pack);
    } catch (_) { /* bad pack — skip, do not crash */ }
  }
  return packs;
}

function frameworkKeepFile(rel, packs) {
  const reasons = [];
  for (const pack of packs) {
    for (const pat of pack.entryPatterns || []) {
      try { if (new RegExp(pat).test(rel)) reasons.push(`framework pack ${pack._file}: matches ${pat}`); } catch (_) {}
    }
    for (const pat of pack.keepFiles || []) {
      try { if (new RegExp(pat).test(rel)) reasons.push(`framework pack ${pack._file}: matches ${pat}`); } catch (_) {}
    }
  }
  return reasons;
}

function frameworkKeepSymbol(rel, name, decorators, packs) {
  const reasons = [];
  for (const pack of packs) {
    if (name && (pack.keepExports || []).includes(name)) reasons.push(`framework pack ${pack._file}: export "${name}" is framework-resolved`);
    if (name && (pack.keepNames || []).includes(name)) reasons.push(`framework pack ${pack._file}: name "${name}" is framework-resolved`);
    for (const d of decorators || []) {
      for (const kd of pack.keepDecorators || []) {
        if (d.includes(kd)) reasons.push(`framework pack ${pack._file}: decorator "${kd}"`);
      }
    }
  }
  return reasons;
}

// `.e2e-spec.` is the NestJS / vitest end-to-end marker (each sample
// runs `e2e/**/*.e2e-spec.ts` via its own vitest.config.e2e.mts): a
// test entry point like `.spec.` / `.test.`, never a dead file.
const TEST_FILE = /(\.test\.|\.spec\.|\.test-d\.|\.e2e-spec\.|_test\.py$|test_[^/]+\.py$|conftest\.py$|(^|\/)test\.[jt]sx?$|Test\.java$)/;
// A file literally named test.ts / test.tsx (date-fns) holds type-test
// functions whose bodies ARE the assertions — the declarations are the
// test, so the file is test code: KEEP at most, never SAFE.
// Files under a tests/ / test/ / __tests__/ directory are test code even
// when their names do not match TEST_FILE (axios `tests/module/...`
// type-test helpers, umami `src/test/test-utils.tsx`): KEEP at most,
// never SAFE. Their declarations ARE the test.
const TEST_DIR = /(^|\/)(tests?|test|__tests__)\//;
const CONFIG_FILE = /(\.config\.[jt]s|webpack\.config|vite\.config|jest\.config|babel\.config|tailwind\.config|\.d\.ts$)/;

function gradeFindings(ctx) {
  const { root, discovery, graph, git, coverage, packs, isLibrary } = ctx;
  const { files, importers, reachable, filesMentioning, symbolUsage, reExportedFiles } = graph;

  const findingsById = new Map();
  const add = (f) => {
    f.id = `${f.category}:${f.file}:${f.symbol || ''}:${f.startLine || 0}`;
    const prev = findingsById.get(f.id);
    // A finding re-graded in a later cascade pass keeps its FIRST
    // evidence (and grade): re-stamping it would overwrite an
    // iteration-1 finding with iteration-3 cascade metadata. The one
    // exception is a grade change (REVIEW -> SAFE in a later pass),
    // which is a new verdict and must replace the old one.
    if (prev && prev.grade === f.grade) return prev;
    findingsById.set(f.id, f);
    return f;
  };

  // ---- FP-6 cross-file class-attribute indexes (built once) ----
  // Frameworks consume class attributes via attribute lookup, not via
  // a code reference to the defining file — so the import graph alone
  // cannot see the use. Two narrow, binding-aware signals recover it:
  //  (R1) the override family: the attribute overrides one defined on
  //  an ancestor class, or a subclass overrides it. The override
  //  proves the attribute is part of the inherited interface.
  //  (R2) the attribute name is read as `obj.<name>` / `self.<name>`
  //  in another file. Only attribute syntax counts, and only to
  //  REVIEW: the same name can exist on an unrelated object.
  // Both signals are computed from the parsers' class inventories
  // (parse-py `classes`, per-definition `className`) and import edges
  // — no bare-name matching across files, no "all class attributes
  // are KEEP" widening. Files without a class inventory (JS/TS) simply
  // yield no matches: fail-open, never a new SAFE.
  const attrReaders = new Map(); // attr name -> Set<abs file> reading it as obj.name
  const classesByFile = new Map(); // abs file -> Map<className, {name, bases, file}>
  const classAttrs = new Map(); // "file\0class" -> Set<attr name defined in that class>
  for (const [gfile, ginfo] of graph.files) {
    if (!ginfo.parsed) continue;
    for (const n of ginfo.parsed.attributeRefs || []) {
      if (!attrReaders.has(n)) attrReaders.set(n, new Set());
      attrReaders.get(n).add(gfile);
    }
    const byName = new Map();
    for (const c of ginfo.parsed.classes || []) byName.set(c.name, { name: c.name, bases: c.bases || [], file: gfile });
    if (byName.size > 0) classesByFile.set(gfile, byName);
    for (const d of ginfo.parsed.definitions || []) {
      // A @property method (or a nested class) with the same name
      // overrides the base attribute too: Django's PostgreSQL backend
      // defines prohibits_null_characters_in_text_exception as a
      // @cached_property method over the base class's plain attribute,
      // and the override is real even though the kinds differ.
      if (!d.className || (d.kind !== 'variable' && d.kind !== 'method' && d.kind !== 'class')) continue;
      const key = `${gfile}\0${d.className}`;
      if (!classAttrs.has(key)) classAttrs.set(key, new Set());
      classAttrs.get(key).add(d.name);
    }
  }
  // Documented class attributes (Django `supports_get_result`): a
  // Sphinx `.. attribute:: Class.attr` directive in the repo's docs
  // (.txt / .md) documents the attribute as public API of its class,
  // even when no code in the repo reads it — the docs are the interface
  // contract for third-party backends. Only the exact `Class.attr`
  // pair counts (a bare attr name would collide across classes), and
  // the grade is REVIEW, never KEEP: docs can go stale, so a human
  // still checks. Prose files are read here on purpose: unlike the
  // string-reference pass, this is not a claim that the docs execute
  // the code — it is a claim that the docs promise the attribute exists.
  const documentedClassAttrs = new Map(); // "Class.attr" -> doc rel path
  for (const f of discovery.textFiles || []) {
    const ext = path.extname(f).toLowerCase();
    if (ext !== '.txt' && ext !== '.md') continue;
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const m of text.matchAll(/^\s*\.\.\s+(?:attribute|autoattribute)::\s+([\w.]+)\s*$/gm)) {
      const parts = m[1].split('.');
      if (parts.length < 2) continue;
      const key = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
      if (!documentedClassAttrs.has(key)) documentedClassAttrs.set(key, path.relative(root, f));
    }
  }
  // Resolve a base-class name to the class that defines it: the same
  // file first, then an import edge of the importing file — following
  // re-exports through package __init__ files, e.g. `from
  // django.db.models import Func` reaches expressions.py. Dotted bases
  // (`mod.Base`) are recorded by their leading name and do not resolve:
  // a known gap, fail-open. Only successful resolutions are cached; a
  // miss is recomputed, so a resolution that failed only because of a
  // cycle guard is never frozen in.
  const classDefCache = new Map();
  const resolveClass = (fromFile, name, seen) => {
    const key = `${fromFile}\0${name}`;
    if (classDefCache.has(key)) return classDefCache.get(key);
    let found = null;
    const local = classesByFile.get(fromFile);
    if (local && local.has(name)) found = { file: fromFile, name };
    if (!found) {
      const nextSeen = new Set(seen || []);
      nextSeen.add(key);
      const edges = graph.importsByFile ? graph.importsByFile.get(fromFile) : null;
      for (const e of edges || []) {
        const hit = (e.names || []).find((n) => n.local === name);
        if (!hit || hit.kind === 'namespace') continue;
        const targetClasses = classesByFile.get(e.target);
        if (targetClasses && targetClasses.has(hit.imported)) { found = { file: e.target, name: hit.imported }; break; }
        if (!nextSeen.has(`${e.target}\0${hit.imported}`)) {
          const via = resolveClass(e.target, hit.imported, nextSeen);
          if (via) { found = via; break; }
        }
      }
    }
    if (found) classDefCache.set(key, found);
    return found;
  };
  // Transitive ancestors of a class, as "file\0name" -> {file, name}.
  const ancestorsCache = new Map();
  const ancestorsOf = (file, name) => {
    const key = `${file}\0${name}`;
    if (ancestorsCache.has(key)) return ancestorsCache.get(key);
    const out = new Map();
    const cls = classesByFile.get(file) ? classesByFile.get(file).get(name) : null;
    const queue = (cls ? cls.bases : []).map((b) => ({ fromFile: file, base: b }));
    const seen = new Set([key]);
    while (queue.length > 0) {
      const { fromFile, base } = queue.pop();
      const parent = resolveClass(fromFile, base);
      if (!parent) continue;
      const pkey = `${parent.file}\0${parent.name}`;
      if (seen.has(pkey)) continue;
      seen.add(pkey);
      out.set(pkey, parent);
      const pcls = classesByFile.get(parent.file) ? classesByFile.get(parent.file).get(parent.name) : null;
      for (const b of pcls ? pcls.bases : []) queue.push({ fromFile: parent.file, base: b });
    }
    ancestorsCache.set(key, out);
    return out;
  };
  // Transitive descendants, via the inverted parent links.
  const childrenOf = new Map(); // "file\0class" -> Set<"file\0class">
  for (const [cfile, byName] of classesByFile) {
    for (const cls of byName.values()) {
      for (const b of cls.bases) {
        const parent = resolveClass(cfile, b);
        if (!parent) continue;
        const pkey = `${parent.file}\0${parent.name}`;
        if (!childrenOf.has(pkey)) childrenOf.set(pkey, new Set());
        childrenOf.get(pkey).add(`${cfile}\0${cls.name}`);
      }
    }
  }
  const descendantsCache = new Map();
  const descendantsOf = (file, name) => {
    const key = `${file}\0${name}`;
    if (descendantsCache.has(key)) return descendantsCache.get(key);
    const out = new Set();
    const queue = [...(childrenOf.get(key) || [])];
    const seen = new Set([key]);
    while (queue.length > 0) {
      const cur = queue.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.add(cur);
      for (const next of childrenOf.get(cur) || []) if (!seen.has(next)) queue.push(next);
    }
    descendantsCache.set(key, out);
    return out;
  };
  const attrsOfClass = (file, name) => classAttrs.get(`${file}\0${name}`) || new Set();
  const overrideCache = new Map(); // "file\0class\0attr" -> {fromAncestor, bySubclass} | null
  const classAttrOverride = (file, className, attr) => {
    const key = `${file}\0${className}\0${attr}`;
    if (overrideCache.has(key)) return overrideCache.get(key);
    let result = null;
    const fromAncestor = [...ancestorsOf(file, className).values()].find((a) => attrsOfClass(a.file, a.name).has(attr)) || null;
    let bySubclass = null;
    for (const dkey of descendantsOf(file, className)) {
      const sep = dkey.indexOf('\0');
      const d = { file: dkey.slice(0, sep), name: dkey.slice(sep + 1) };
      if (attrsOfClass(d.file, d.name).has(attr)) { bySubclass = d; break; }
    }
    if (fromAncestor || bySubclass) result = { fromAncestor, bySubclass };
    overrideCache.set(key, result);
    return result;
  };
  // Other files (relative paths) that read `attr` as an attribute,
  // excluding files already graded SAFE-dead: dead code citing dead
  // code does not keep an attribute alive.
  const attrReadElsewhere = (file, attr) => {
    const readers = attrReaders.get(attr);
    if (!readers) return [];
    return [...readers].filter((f) => f !== file && !deadFiles.has(f)).map((f) => path.relative(root, f)).sort();
  };

  // Cascade fixpoint (deadcode 2.7.0 shipped this shape): one run cannot
  // see second-order dead code — a symbol whose only importers are dead
  // files looks used in the first pass. So grading repeats, each time
  // ignoring usage that comes only from files already graded SAFE-dead,
  // until no new SAFE file appears. Findings that appear only in a later
  // pass carry evidence.cascade = { iteration, via: [dead files] } so the
  // report can group them under their dead root.
  //
  // Same-file cascade runs inside each pass too: the per-definition
  // reference scopes (see gradeOnce) mark a symbol live only when a
  // live definition in the same file uses it, so a helper used only by
  // a dead sibling is dead in the same pass. The outer fixpoint still
  // matters across files: a symbol whose only caller sat in a file
  // that became dead this iteration loses that caller next iteration.
  const deadFiles = new Set(); // abs paths graded SAFE as files
  const MAX_ITERATIONS = 6;
  let iteration = 0;
  while (iteration < MAX_ITERATIONS) {
    iteration += 1;
    gradeOnce(iteration);
    let addedDead = false;
    for (const f of findingsById.values()) {
      if (f.grade === 'SAFE' && f.category === 'file') {
        const abs = path.resolve(root, f.file);
        if (!deadFiles.has(abs)) { deadFiles.add(abs); addedDead = true; }
      }
    }
    if (!addedDead) break;
  }

  function gradeOnce(iteration) {
    for (const [file, info] of files) {
    const rel = info.rel;
    if (info.parseError) continue; // never flag what we could not parse
    const parsed = info.parsed;
    const gitInfo = git.info.get(file);
    const covFile = coverage ? coverage.get(path.resolve(file)) : null;
    const isEntry = discovery.entries.has(file);
    const entryReason = discovery.entries.get(file) || '';
    const isTest = TEST_FILE.test(rel) || TEST_DIR.test(rel);
    const isConfig = CONFIG_FILE.test(rel);
    const isManualScript = isManualScriptPath(rel);
    const fwReasons = frameworkKeepFile(rel, packs);
    // Library vs app, per file: a published library's exports are public
    // API (REVIEW at most); an app repo's exported-but-uncalled symbols
    // may be SAFE. Unknown (no manifest signal) keeps the old behaviour.
    const kind = discovery.fileKind ? discovery.fileKind(file) : (isLibrary ? 'library' : 'unknown');
    // The FILE is kept when it is an entry point / test / config / framework
    // file. But symbols inside an entry file are graded normally — a dead
    // helper inside main.py is still dead. Only test / config / framework
    // files keep their symbols, because those symbols are resolved by the
    // framework or test runner, not by imports. Manually-run scripts
    // (scripts/ or tools/) keep their symbols too: their functions are
    // invoked by the operator, not by the import graph — see
    // isManualScriptPath in discover.js.
    const keepFile = isEntry || isTest || isConfig || fwReasons.length > 0;
    const keepSymbols = isTest || isConfig || isManualScript || fwReasons.length > 0;
    // In a later cascade pass, a file already graded SAFE-dead keeps its
    // iteration-1 findings; re-grading its symbols would only add noise
    // inside an already-dead file.
    const alreadyDeadFile = deadFiles.has(file);

    const evidenceBase = {
      gitAgeDays: gitInfo ? gitInfo.ageDays : null,
      gitLastCommit: gitInfo ? gitInfo.lastCommit : null,
      gitCommits: gitInfo ? gitInfo.commits : null,
      coveragePct: covFile ? covFile.pct : null,
      coverageSource: covFile ? (covFile.source || null) : null,
    };

    // ---- Dead file ----
    // Importers that are themselves dead do not keep a file alive: if
    // the only importer of B is dead file A, B is dead in the same run.
    const liveImporters = [...(importers.get(file) || new Set())].filter((f) => !deadFiles.has(f));
    const importerCount = liveImporters.length;
    // Java files are never dead-file candidates in this landing: there
    // is no Java import resolution yet, so no file can be proven
    // unimported (whole dead classes are out of scope). Symbol
    // findings inside Java files still apply.
    const isJavaFile = info.parsed && info.parsed.language === 'java';
    if (!isJavaFile && !reachable.has(file) && importerCount === 0) {
      if (keepFile) {
        // KEEP findings are recorded but hidden by default.
        add({
          category: 'file', file: rel, symbol: null, grade: 'KEEP',
          startLine: 1, endLine: null, size: info.size,
          reason: isEntry ? `entry point: ${entryReason}` : isTest ? 'test file' : isConfig ? 'config file' : fwReasons[0],
          evidence: { importers: 0, reachable: false, ...evidenceBase },
        });
      } else {
        const stringRefs = filesMentioning(path.basename(file, path.extname(file)));
        // String mentions from dead files do not keep a file alive either
        // (dynamic.js mentioning './lazy-target.js' in a string is dead
        // code mentioning dead code) — but they are the cascade trail.
        const deadStringRefs = [...stringRefs].filter((f) => deadFiles.has(f));
        const mentionedElsewhere = [...stringRefs].filter((f) => f !== file && !deadFiles.has(f));
        // A file is also string-referenced when any of its symbols is
        // mentioned by name elsewhere (e.g. a config naming a handler).
        // Only top-level symbols count: a local (a `const url` inside a
        // component) is not the file's public name, and its mentions in
        // unrelated files are coincidences — umami's SettingsButton.tsx
        // was kept at REVIEW by its local `url` matching 116 files,
        // though neither the file nor the component is referenced
        // anywhere. Locals never keep a file alive.
        const symbolStringRefs = [];
        const deadSymbolStringRefs = [];
        for (const d of parsed.definitions) {
          if (d.local) continue;
          const hits = [...filesMentioning(d.name)];
          for (const h of hits) {
            if (h === file) continue;
            if (deadFiles.has(h)) deadSymbolStringRefs.push(path.relative(root, h));
            else symbolStringRefs.push(path.relative(root, h));
          }
        }
        const allStringRefs = [...new Set([...mentionedElsewhere.map((f) => path.relative(root, f)), ...symbolStringRefs])];
        if (allStringRefs.length > 0) {
          add({
            category: 'file', file: rel, symbol: null, grade: 'REVIEW',
            startLine: 1, endLine: null, size: info.size,
            reason: 'no importers, but referenced by name as a string elsewhere',
            evidence: { importers: 0, reachable: false, stringRefs: allStringRefs, ...evidenceBase },
          });
        } else {
          // Public API of a published library: a file with no importers
          // could still be part of the public surface.
          // Coverage demotes a dead file the same way it demotes a dead
          // symbol (see below): lines executed with no importers means
          // something runs this file (a script entry, dynamic loading,
          // or stale coverage data) — REVIEW, never SAFE.
          const covered = covFile && covFile.pct > 0;
          const grade = kind === 'library' || covered ? 'REVIEW' : 'SAFE';
          const finding = {
            category: 'file', file: rel, symbol: null, grade,
            startLine: 1, endLine: null, size: info.size,
            reason: kind === 'library'
              ? 'no importers, but this is a published library — public surface, review before deleting'
              : covered
                ? `no importers, but ${covFile.pct}% of its lines are covered by tests — something executes this file`
                : 'no importers, not an entry point, not referenced by name anywhere',
            evidence: { importers: 0, reachable: false, stringRefs: [], ...evidenceBase },
            deleteDiff: `delete ${rel} (${info.size} bytes)`,
          };
          if (iteration > 1 && grade === 'SAFE') {
            const via = [...new Set([
              ...[...(importers.get(file) || new Set())].filter((f) => deadFiles.has(f)).map((f) => path.relative(root, f)),
              ...deadStringRefs.map((f) => path.relative(root, f)),
              ...deadSymbolStringRefs,
            ])];
            finding.evidence = { ...finding.evidence, cascade: { iteration, via } };
          }
          add(finding);
        }
      }
    }
    if (alreadyDeadFile) continue;

    // ---- Dead symbols (functions / classes / variables / types / exports) ----
    const usageMap = symbolUsage.get(file) || new Map();
    // Names with at least one @overload-decorated definition form an
    // overload group: the stubs are type information and the
    // implementation is invoked through the overloaded name.
    const overloadedNames = new Set();
    for (const d of parsed.definitions) {
      if ((d.decorators || []).some((dec) => /(^|[@.])overload\b/.test(dec))) overloadedNames.add(d.name);
    }
    // Import bindings (const x = require('...') / import x from '...') are
    // covered by the dead-import findings below, not as dead symbols.
    const importLocals = new Set();
    for (const imp of parsed.imports) for (const n of imp.names || []) importLocals.add(n.local);
    const categoryOf = (kind) => ({ function: 'function', class: 'class', type: 'type', variable: 'variable', method: 'method' }[kind] || 'function');
    // ---- Same-file cascade: per-definition reference scopes ----
    // A symbol is kept alive by same-file use only when the use comes
    // from live code. The parsers record, per definition, the names
    // referenced inside its body (`uses`) plus the names referenced by
    // top-level code (`topLevelUses`, which runs on import). Liveness
    // is reachability from live roots over that definition graph:
    // top-level uses, live cross-file uses, framework-kept definitions
    // (they run via framework dispatch), dunder methods (they run
    // implicitly when their class is constructed), and exported
    // definitions of a library / public-API file (downstream code may
    // call them, and through them their helpers). A name used only
    // inside another dead definition — or only by itself, as in pure
    // recursion — is not reachable and is graded on its own evidence.
    // Reachability also catches dead cycles (mutual recursion with no
    // entry point), which a purely iterative cascade cannot see. When
    // the parsers predate scopes (stale cache), fall back to the old
    // file-level same-file flag — fail-open, never a new SAFE.
    // Limitation, stated honestly: names are matched, not bindings, so
    // a parameter or local that shadows a top-level name still counts
    // as a use of it (a false negative, never a false SAFE).
    //
    // Liveness is tracked per DEFINITION, not per name: two definitions
    // may share a name — a module-level const and a method of the same
    // name (NestJS `missingFile`: the const at line 61 and the
    // NodeStreamController route handler at line 694) — and the old
    // name-keyed graph merged them into one node. The kept method is a
    // conduit, not a live root, so the shared name was deleted from the
    // live set and the const it alone uses looked dead. Per-definition
    // nodes keep the method's conduit status from deleting the const's
    // liveness: the method still gets its own REVIEW finding, the const
    // is live through the method. Name resolution inside the graph is
    // still by name (a use of `foo` reaches every definition named
    // `foo`), so the only change is which definitions a kept-but-unreached
    // name takes down with it: none that it does not own.
    const scopes = Array.isArray(parsed.topLevelUses);
    let sameFileLiveDefs = null;
    // Java arity channel: the set of definition names whose bodies can
    // keep a private method alive, and the (name, arity) liveness test
    // for a private method / constructor. See the assignment below.
    let javaLiveScopeNames = null;
    let javaArityIsLive = null;
    if (scopes) {
      const defsByName = new Map(); // name -> definitions with that name
      for (const d of parsed.definitions) {
        if (!defsByName.has(d.name)) defsByName.set(d.name, []);
        defsByName.get(d.name).push(d);
      }
      const defUses = new Map(); // definition -> Set<used names>
      for (const d of parsed.definitions) defUses.set(d, new Set(d.uses || []));
      // Live roots: top-level code (runs on import) and live
      // cross-file uses. A kept definition is a CONDUIT, not a live
      // root: it still gets its own KEEP / REVIEW finding, but the
      // names it uses stay alive through it (a framework-dispatched
      // handler really runs, and a public-API function may be called
      // by downstream code). So liveness is reachability from the live
      // roots UNION reachability from the kept definitions, minus the
      // kept definitions themselves unless a live root reaches them.
      // Without that last step, every exported-but-never-imported
      // function vanished from the report instead of being REVIEW.
      const liveRootNames = new Set(parsed.topLevelUses || []);
      for (const [name, u] of usageMap) {
        const liveImporters = [...u.importedBy].filter((f) => !deadFiles.has(f));
        const liveCallers = [...u.calledIn].filter((f) => f !== file && !deadFiles.has(f));
        if (liveImporters.length > 0 || liveCallers.length > 0) liveRootNames.add(name);
      }
      const liveRootDefs = new Set();
      for (const name of liveRootNames) for (const d of defsByName.get(name) || []) liveRootDefs.add(d);
      // A method is a conduit too: the tool deliberately never proves
      // a method dead (methods are REVIEW at most — objects, tests and
      // frameworks call them through dispatch the static graph cannot
      // see), so a method's callees must not be provable dead through
      // it either. Without this, every helper called only from methods
      // of a live class looked dead: Click's _normalize_opt (called
      // from Parser methods), FastAPI's _dependency_semaphores (read in
      // a method), Flask's _got_registered_once, axios's normalizeDate
      // (called from a VitePress transform method) all went SAFE.
      // Narrowed (batch 4): a method is a conduit only when its
      // enclosing class is live. A method of a dead class — a class
      // nothing ever constructs, imports, or references — never runs,
      // so the helper it alone calls is dead too, and a dead method
      // forwarding to another method no longer rescues that target
      // either. The enclosing class is found by range containment (a
      // method's range sits inside its class's range), so this works
      // for JS and Python alike with no parser change. When no
      // enclosing class can be found (an object-literal method, a
      // class expression the parser did not record), the method stays
      // a conduit: fail-open, never a new SAFE. Class liveness comes
      // from the live roots, the kept (non-method) definitions, and —
      // by the fixpoint below — the classes kept-method conduits
      // reach: a class is live when live code references it, when it
      // is itself kept (framework / exported public API), when a kept
      // definition reaches it (a framework handler that instantiates
      // it really runs), or when a method of a live class reaches it
      // (that method really runs, so the class it builds really
      // exists). The cost of the old rule was false negatives —
      // helpers used only by methods of a dead class stayed hidden.
      // That is now fixed for the known-class case; the unknown-class
      // case keeps the safe direction.
      const classDefs = parsed.definitions.filter((d) => d.kind === 'class');
      const enclosingClassName = (def) => {
        let best = null;
        for (const c of classDefs) {
          if (c.range.startIndex <= def.range.startIndex && def.range.endIndex <= c.range.endIndex) {
            if (!best || (c.range.endIndex - c.range.startIndex) < (best.range.endIndex - best.range.startIndex)) best = c;
          }
        }
        return best ? best.name : null;
      };
      // Kept for a reason other than "is a method": framework dispatch,
      // a model field, declaration merging, an overload group, a dunder,
      // or exported public API. Methods are added by keepDef below,
      // once their enclosing class is known to be live.
      // Java: a method with any annotation (@PostConstruct, @Scheduled,
      // ...) runs by framework dispatch, an @Override method runs when
      // the supertype method is invoked, and a method of an anonymous
      // class (Runnable.run, ActionListener.actionPerformed) runs by
      // interface dispatch, never by name — all three are conduits.
      const baseKeepDef = (d) => keepSymbols
        || frameworkKeepSymbol(rel, d.name, d.decorators, packs).length > 0
        || d.frameworkField || d.ambient || overloadedNames.has(d.name)
        || (parsed.dunder && parsed.dunder.has(d.name))
        || (d.kind === 'method' && d.name.startsWith('__'))
        || (parsed.language === 'java' && d.kind === 'method' && ((d.annotations || []).length > 0 || d.anonymousClass === true))
        || (d.exported && (kind === 'library' || kind === 'unknown' || (reExportedFiles && reExportedFiles.has(file))));
      const baseKeepDefs = new Set();
      for (const d of parsed.definitions) if (baseKeepDef(d)) baseKeepDefs.add(d);
      const bfsDefs = (seeds) => {
        const seen = new Set();
        const queue = [...seeds];
        while (queue.length) {
          const cur = queue.pop();
          if (seen.has(cur)) continue;
          seen.add(cur);
          for (const used of defUses.get(cur) || []) {
            for (const nxt of defsByName.get(used) || []) if (!seen.has(nxt)) queue.push(nxt);
          }
        }
        return seen;
      };
      const liveDefs = bfsDefs(liveRootDefs);
      const viaBaseKeptDefs = bfsDefs(baseKeepDefs);
      const liveClassNames = new Set();
      for (const d of classDefs) {
        if (liveDefs.has(d) || baseKeepDefs.has(d) || viaBaseKeptDefs.has(d)) liveClassNames.add(d.name);
      }
      const keepDef = (d) => baseKeepDef(d)
        || (d.kind === 'method' && (enclosingClassName(d) === null || liveClassNames.has(enclosingClassName(d)))
          // Java private methods are NOT conduits: a helper called only
          // by a dead private method is dead too (same-file cascade for
          // private methods). An annotated private method is already
          // base-kept above, so only unannotated private methods lose
          // conduit status here. Public / protected / package-private
          // methods of a live class stay conduits, as before.
          && !(parsed.language === 'java' && d.visibility === 'private' && !(d.annotations || []).length));
      // Fixpoint (batch 8): a class reached only through a kept
      // method's callees is live too — its methods are conduits, and
      // the names they use are reachable. Without this, a nested class
      // built by a factory a live class's method calls (Django's
      // postgis `postgis_adapters` returning `PostGISTextDumper` /
      // `PostGISBinaryDumper`, whose `BaseDumper.get_key` / `upgrade`
      // reference `GeometryType` / `GeographyType` / `RasterType`)
      // never counted as live, so the names its methods use looked
      // dead. The loop only grows liveClassNames, bounded by the
      // number of classes in the file, so it always terminates; each
      // round can only add liveness, never a new SAFE.
      let keepDefs = new Set();
      let viaKeptDefs = new Set();
      for (;;) {
        keepDefs = new Set();
        for (const d of parsed.definitions) if (keepDef(d)) keepDefs.add(d);
        viaKeptDefs = bfsDefs(keepDefs);
        let grew = false;
        for (const d of viaKeptDefs) {
          if (d.kind === 'class' && !liveClassNames.has(d.name)) { liveClassNames.add(d.name); grew = true; }
        }
        if (!grew) break;
      }
      sameFileLiveDefs = new Set([...liveDefs, ...viaKeptDefs]);
      for (const d of keepDefs) if (!liveDefs.has(d)) sameFileLiveDefs.delete(d);
      // Java: a private method is live only when live code calls it
      // with a matching (name, arity). The name-based sameFileLive
      // cannot tell format/1 from format/2, so private methods get
      // their own arity-aware test over the same live-scope names:
      // calls from a definition whose name is reachable from a live
      // root or a kept definition, plus top-level (class-level) calls.
      // A method reference has no visible arity and counts for every
      // overload of the name; a varargs method matches any call with
      // arity >= its fixed arity; a call from the candidate itself
      // (pure recursion, or a dead overload's self-call) never rescues
      // it — the candidate's own (name, arity) key is excluded.
      // Constructors match by (name, arity, class): `new Foo()` and
      // `this()` carry the class, `super()` carries none and matches
      // nothing in this file.
      if (parsed.language === 'java') {
        javaLiveScopeNames = new Set([...liveDefs, ...viaKeptDefs].map((d) => d.name));
        javaArityIsLive = (def) => {
          const key = def.isConstructor
            ? `constructor/${def.arity}@${def.className || 'super'}`
            : `${def.name}/${def.arity}`;
          const calls = new Set(parsed.topLevelUsesArity || []);
          for (const d of parsed.definitions) {
            if (!javaLiveScopeNames.has(d.name)) continue;
            if (d.kind === 'method') {
              const dKey = d.isConstructor
                ? `constructor/${d.arity}@${d.className || 'super'}`
                : `${d.name}/${d.arity}`;
              if (dKey === key) continue;
            }
            for (const u of d.usesArity || []) calls.add(u);
          }
          if (def.isConstructor) {
            return calls.has(key) || calls.has(`constructor/*@${def.className || 'super'}`);
          }
          if (calls.has(`${def.name}/*`)) return true;
          if (calls.has(`${def.name}/${def.arity}`)) return true;
          if (def.varargs) {
            for (const c of calls) {
              const m = c.match(/^(.+)\/(\d+)$/);
              if (m && m[1] === def.name && parseInt(m[2], 10) >= (def.fixedArity || 0)) return true;
            }
          }
          return false;
        };
      }
    }
    for (const def of parsed.definitions) {
      if (importLocals.has(def.name)) continue;
      // Methods belong to a class; a method with no callers is a candidate
      // only when it is not an override / protocol method. Dunder methods
      // are recorded as KEEP (considered, never flagged) for transparency.
      if (def.kind === 'method' && ((parsed.dunder && parsed.dunder.has(def.name)) || def.name.startsWith('__'))) {
        add({
          category: 'method', file: rel, symbol: def.name, grade: 'KEEP',
          startLine: def.startLine, endLine: def.endLine,
          size: def.range.endIndex - def.range.startIndex,
          reason: `dunder / protocol method ${def.name}`,
          evidence: { importers: 0, callers: 0, stringRefs: [], exported: false, coveragePct: null, ...evidenceBase },
          deleteDiff: '',
        });
        continue;
      }
      const usage = usageMap.get(def.name) || { importedBy: new Set(), calledIn: new Set(), stringIn: new Set(), sameFile: false };
      // Cascade: usage from dead files does not count. A symbol whose
      // only importers/callers are dead files is dead in the same run.
      const importedBy = [...usage.importedBy].filter((f) => !deadFiles.has(f));
      const deadImporters = [...usage.importedBy].filter((f) => deadFiles.has(f));
      const calledIn = [...usage.calledIn].filter((f) => !deadFiles.has(f));
      const deadCallers = [...usage.calledIn].filter((f) => deadFiles.has(f));
      // A call from the symbol's own file is same-file use, not an external caller.
      const calledElsewhere = calledIn.filter((f) => f !== file);
      // Locals (nested functions, variables assigned in a body) keep
      // the old file-level rule: a local is part of its enclosing
      // function's implementation, so any reference in the file keeps
      // it alive — the cascade must not flag it merely because its
      // enclosing function is dead. Module- and class-level symbols
      // use the reachability scopes above (or the old rule when the
      // parsers predate scopes).
      const sameFileUse = def.local
        ? (usage.sameFile || calledIn.includes(file))
        : (scopes ? sameFileLiveDefs.has(def) : (usage.sameFile || calledIn.includes(file)));
      // Java private methods need arity-aware liveness, not the
      // name-based same-file flag: format/2 is dead even when format/1
      // is called from live code. The Java branch below decides with
      // (name, arity), so the name-based flag must not skip it here.
      // (Private fields keep the name-based flag: their reads are
      // already read-only occurrences, so it is exact for them.)
      const javaPrivateMethod = parsed.language === 'java' && def.kind === 'method' && def.visibility === 'private';
      const sameFileUseEffective = javaPrivateMethod ? false : sameFileUse;
      // Same-file use is real use: a symbol called or referenced in its
      // own file is alive, full stop. It used to be flagged REVIEW as
      // "unexport-to-local", but that turned every module's own helpers
      // into noise (e.g. our own isGitRepo / resolveRelative /
      // buildMapData). An export that is only used in its own file is
      // still used — never a finding.
      if (importedBy.length === 0 && calledElsewhere.length === 0 && sameFileUseEffective) {
        continue;
      }
      const isUsed = importedBy.length > 0 || calledElsewhere.length > 0;
      if (isUsed) continue;

      const stringHits = filesMentioning(def.name);
      const stringElsewhere = [...stringHits].filter((f) => f !== file && !deadFiles.has(f));
      const deadStringRefs = [...stringHits].filter((f) => deadFiles.has(f));
      const cov = coverage
        ? coverageForSymbol(coverage, file, def.startLine, def.endLine)
        : null;
      const snippet = info.src.slice(def.range.startIndex, Math.min(def.range.endIndex, def.range.startIndex + 400));

      const common = {
        category: categoryOf(def.kind),
        file: rel, symbol: def.name, grade: 'REVIEW',
        startLine: def.startLine, endLine: def.endLine,
        size: def.range.endIndex - def.range.startIndex,
        evidence: {
          // evidenceBase first: its coveragePct is the FILE pct, and the
          // symbol pct below must win for a symbol finding (the old
          // order silently showed the file pct for every symbol).
          ...evidenceBase,
          importers: importedBy.length, callers: calledElsewhere.length,
          stringRefs: stringElsewhere.map((f) => path.relative(root, f)),
          exported: def.exported, coveragePct: cov ? cov.pct : null,
        },
        deleteDiff: snippet,
      };
      // Cascade evidence: this finding only exists because dead files
      // were removed as users. Group it under its dead root.
      const cascadeVia = [...new Set([
        ...deadImporters, ...deadCallers, ...deadStringRefs,
      ])].map((f) => path.relative(root, f));
      const withCascade = (finding) => {
        if (iteration > 1 && finding.grade === 'SAFE' && cascadeVia.length > 0) {
          finding.evidence = { ...finding.evidence, cascade: { iteration, via: cascadeVia } };
        }
        return finding;
      };

      // KEEP: framework / decorator / dunder / entry-file symbols.
      // Framework checks here are per-symbol: only THIS definition's own
      // decorators count, never another symbol's decorator in the same file.
      const fwSym = frameworkKeepSymbol(rel, def.name, def.decorators, packs);
      if (fwSym.length > 0) {
        add({ ...common, grade: 'KEEP', reason: fwSym[0] });
        continue;
      }
      // Pydantic / dataclass model fields are populated by the framework
      // from external data, never read by attribute in-repo.
      if (def.frameworkField) {
        add({ ...common, grade: 'KEEP', reason: 'Pydantic/dataclass model field — populated by the framework, never read by attribute in-repo' });
        continue;
      }
      // `declare module` / `declare global` augmentation is declaration
      // merging: the declaration IS the use.
      if (def.ambient) {
        add({ ...common, grade: 'KEEP', reason: 'declare module/global augmentation — declaration merging, the declaration IS the use' });
        continue;
      }
      // An @overload group: the stubs are type information and the
      // implementation is invoked through the overloaded name (by the
      // framework or by callers the static graph cannot see). Keep the
      // whole group, not just the stubs.
      if (overloadedNames.has(def.name)) {
        add({ ...common, grade: 'KEEP', reason: '@overload group — stubs are type information and the implementation is invoked through the overloaded name' });
        continue;
      }
      // `__unittest = True` in a module tells unittest to trim that
      // module's frames from tracebacks: the test runner reads the
      // module attribute, so it is never dead code (Django's
      // contrib/messages/test.py sets it for its test-mixin module).
      if (def.name === '__unittest') {
        add({ ...common, grade: 'KEEP', reason: '__unittest module attribute — unittest trims this module\'s frames from tracebacks, the runner reads it' });
        continue;
      }
      if (parsed.dunder && parsed.dunder.has(def.name)) {
        add({ ...common, grade: 'KEEP', reason: `module dunder ${def.name} — read by the import system / packaging tooling, never auto-deleted` });
        continue;
      }
      if (keepSymbols) {
        add({ ...common, grade: 'KEEP', reason: isTest ? 'in a test file' : isConfig ? 'in a config file' : isManualScript ? 'in a manually-run script (scripts/ or tools/) — invoked by the operator, not by imports' : fwReasons[0] || 'framework / entry file' });
        continue;
      }
      // Class-attribute rules (FP-6). These sit AFTER the dunder and
      // test/config KEEP checks above on purpose: a dunder or a
      // test-file attribute keeps its existing KEEP reason, and these
      // rules only ever demote a finding that would otherwise be SAFE
      // (or a REVIEW string-mention) — never a KEEP.
      // Alias of a method defined in the same class (`x = method`, or
      // a chained assignment `__setitem__ = ... = popitem = _fail`):
      // the names are one object with a live method, part of the
      // class's interface — never SAFE.
      if (def.chainedAlias) {
        add({ ...common, grade: 'KEEP', reason: `alias of ${def.chainedAliasOf || 'a method'} in the same class — the name is the same object as the method, part of the class interface` });
        continue;
      }
      // A class that subclasses an externally-defined base and defines
      // only attributes (no methods) is a framework-consumed config
      // class (a Pygments Style subclass): the framework reads the
      // attributes at runtime, so they are KEEP, never SAFE.
      if (def.configClassAttr) {
        add({ ...common, grade: 'KEEP', reason: 'config class: subclass of an externally-defined base that defines only attributes — the framework reads the attributes at runtime' });
        continue;
      }
      // Class-attribute override family (FP-6). A class attribute that
      // overrides one defined on an ancestor class, or that a subclass
      // overrides, is part of the inherited class interface: the
      // framework reads it via attribute lookup on instances
      // (`connection.features.supports_x`, `self.arity`), not via a
      // code reference to the defining file. REVIEW, never SAFE. This
      // sits AFTER the config-class rule above on purpose: a config
      // class attribute is KEEP (the framework reads the whole class),
      // and these rules only ever demote a finding that would otherwise
      // be SAFE — never a KEEP.
      if (def.className && def.kind === 'variable') {
        const ovr = classAttrOverride(file, def.className, def.name);
        if (ovr && ovr.fromAncestor) {
          add({ ...common, grade: 'REVIEW', reason: `class attribute overrides ${def.name} defined on ancestor class ${ovr.fromAncestor.name} (${path.relative(root, ovr.fromAncestor.file)}) — part of the inherited interface, read via attribute lookup` });
          continue;
        }
        if (ovr && ovr.bySubclass) {
          add({ ...common, grade: 'REVIEW', reason: `class attribute overridden by subclass ${ovr.bySubclass.name} (${path.relative(root, ovr.bySubclass.file)}) — part of the class interface, read via attribute lookup` });
          continue;
        }
        // Cross-file attribute read (FP-6): another file reads this
        // name as an attribute (`obj.<name>` / `self.<name>`). Only
        // attribute syntax counts — a bare-name match elsewhere is not
        // the same evidence — and the grade is REVIEW, never KEEP: the
        // same attribute name can exist on an unrelated object (a
        // coincidental match is possible), so a human still checks, but
        // the attribute is never auto-deleted. Reads from files already
        // graded SAFE-dead do not count (dead code citing dead code).
        const readers = attrReadElsewhere(file, def.name);
        if (readers.length > 0) {
          add({ ...common, grade: 'REVIEW', reason: `read as .${def.name} in ${readers.length} other file${readers.length === 1 ? '' : 's'} (${readers.slice(0, 3).join(', ')}${readers.length > 3 ? ', ...' : ''}) — attribute lookup, not a code reference`, evidence: { ...common.evidence, attrReaders: readers } });
          continue;
        }
        // Documented in the repo's docs (Sphinx `.. attribute::`):
        // the docs promise the attribute exists, so it is public API
        // even when no code in the repo reads it (Django documents
        // BaseTaskBackend.supports_get_result in docs/ref/tasks.txt
        // as a backend capability third-party backends implement).
        const docPath = documentedClassAttrs.get(`${def.className}.${def.name}`);
        if (docPath) {
          add({ ...common, grade: 'REVIEW', reason: `documented as ${def.className}.${def.name} in ${docPath} — public API, review before deleting` });
          continue;
        }
      }
      // A class attribute documented with a Sphinx `#:` comment is part
      // of the class's documented public API (an extension-facing flag):
      // REVIEW, never SAFE.
      if (def.documentedAttr) {
        add({ ...common, grade: 'REVIEW', reason: 'documented class attribute (Sphinx #: comment) — part of the class public API' });
        continue;
      }
      // A class attribute assigned in a subclass of an externally-defined
      // base may override a parent attribute that parent-framework code
      // outside this repo reads (Werkzeug's Response.default_mimetype):
      // the parent source is not here to prove it dead, so REVIEW,
      // never SAFE.
      if (def.externalBase) {
        add({ ...common, grade: 'REVIEW', reason: 'class attribute in a subclass of an externally-defined base — may override a parent attribute read by the parent framework' });
        continue;
      }
      if (parsed.dynamic) {
        add({ ...common, grade: 'REVIEW', reason: `0 callers, but file uses dynamic imports/reflection (${parsed.dynamicReasons[0] || 'dynamic'}) — cannot prove safe` });
        continue;
      }
      // ---- Java: private-only SAFE scope ----
      // Public / protected / package-private Java members can be
      // reached from outside this file (another class, another
      // package, a framework), and whole dead classes are out of
      // scope: REVIEW at most, never SAFE. Private members are
      // provable in-file, and only they can be SAFE.
      //
      // This branch sits BEFORE the generic string-mention check
      // below on purpose: a local or parameter cannot be invoked by
      // name from another file, so a string that happens to contain
      // its name (single-letter names match everywhere) must not
      // demote it — locals grade on binding-resolved reads alone.
      // Non-local members still get the string check, inside the
      // branch, after the more specific annotation / framework
      // reasons.
      if (parsed.language === 'java') {
        // Locals and parameters grade on binding-resolved reads, not
        // on the file-level reference set: a same-named field read
        // elsewhere must not keep a local alive, and a local's own
        // reads resolve to the binding, not the name.
        if (def.local) {
          if ((def.readCount || 0) > 0) continue; // read somewhere: live, no finding
          if (def.isParameter) {
            // An unused parameter is never SAFE: deleting it changes
            // the method's arity, so every call site would break, and
            // --fix only deletes the declaration. A human removes the
            // parameter and updates its call sites together.
            add({ ...common, grade: 'REVIEW', reason: def.privateMethod ? 'unused parameter of a private method — removing it requires updating its call sites' : 'unused parameter of a non-private method — changing a public/protected signature is an API break, and removing it requires updating its call sites' });
            continue;
          }
          if ((def.writeCount || 0) > 0) {
            add({ ...common, grade: 'REVIEW', reason: 'local variable assigned but never read — deleting the declaration would leave the assignments behind' });
            continue;
          }
          add(withCascade({ ...common, grade: 'SAFE', reason: 'unused local variable — never read or written' }));
          continue;
        }
        if (def.kind === 'class') {
          add({ ...common, grade: 'REVIEW', reason: 'Java class — whole dead classes are out of scope for this tool' });
          continue;
        }
        if (def.kind !== 'method' && def.kind !== 'variable') {
          add({ ...common, grade: 'REVIEW', reason: 'Java member — REVIEW at most, never SAFE' });
          continue;
        }
        if (def.visibility !== 'private') {
          add({ ...common, grade: 'REVIEW', reason: `${def.visibility === 'package' ? 'package-private' : def.visibility} Java ${def.isConstructor ? 'constructor' : def.kind === 'method' ? 'method' : 'field'} — reachable from outside this file` });
          continue;
        }
        // Private member from here on.
        if ((def.annotations || []).length > 0) {
          add({ ...common, grade: 'KEEP', reason: `annotated @${def.annotations[0]} — framework-invoked, never auto-deleted` });
          continue;
        }
        if (def.native) {
          add({ ...common, grade: 'KEEP', reason: 'native method — implemented outside Java, never called from Java source' });
          continue;
        }
        if (def.name === 'serialVersionUID') {
          add({ ...common, grade: 'KEEP', reason: 'serialVersionUID — read by Java serialization, never auto-deleted' });
          continue;
        }
        // The enclosing-class stereotype check is data-driven as well as
        // hardcoded: FRAMEWORK_CLASS_ANNOTATIONS (parse-java.js) is the
        // fallback for the core stereotypes and Lombok, and the
        // framework packs contribute their keepClassAnnotations lists
        // (frameworks/spring.json, frameworks/jackson-jpa.json) — so a
        // pack-only stereotype such as @ControllerAdvice or
        // @JsonIgnoreProperties keeps members at REVIEW too, with no
        // annotation list hardcoded here for the new packs.
        const fwClassAnn = (def.classAnnotations || []).find((a) => FRAMEWORK_CLASS_ANNOTATIONS.has(a)
          || (packs || []).some((pack) => (pack.keepClassAnnotations || []).includes(a)));
        if (fwClassAnn) {
          add({ ...common, grade: 'REVIEW', reason: `enclosing class is annotated @${fwClassAnn} — the framework may invoke this member` });
          continue;
        }
        if (def.stringMention) {
          add({ ...common, grade: 'REVIEW', reason: 'referenced by name in a string literal in this file — possible reflective use' });
          continue;
        }
        if (stringElsewhere.length > 0) {
          add({ ...common, grade: 'REVIEW', reason: '0 callers, but referenced by name as a string elsewhere' });
          continue;
        }
        if (def.kind === 'variable') {
          if ((def.writeCount || 0) > 0) {
            add({ ...common, grade: 'REVIEW', reason: 'private field written but never read — deleting the declaration would leave the assignments behind' });
            continue;
          }
          add(withCascade({ ...common, grade: 'SAFE', reason: 'private field, never read or written, 0 string mentions' }));
          continue;
        }
        // Private method / constructor: arity-aware liveness.
        if (!javaArityIsLive) {
          add({ ...common, grade: 'REVIEW', reason: 'private method with 0 name-based callers, but arity data is unavailable (stale parse) — cannot prove safe' });
          continue;
        }
        if (javaArityIsLive(def)) continue; // called from live code: no finding
        add(withCascade({ ...common, grade: 'SAFE', reason: def.isConstructor ? 'private constructor, never called with this arity, 0 string mentions' : 'private method, no live callers by (name, arity), 0 string mentions' }));
        continue;
      }
      if (stringElsewhere.length > 0) {
        add({ ...common, grade: 'REVIEW', reason: '0 callers, but referenced by name as a string elsewhere' });
        continue;
      }
      // A module re-exported from a package __init__ (Python
      // `from . import colors as colors`) or a JS barrel is public API:
      // its contents are REVIEW at most, never SAFE — even in an app.
      if (def.exported && reExportedFiles && reExportedFiles.has(file)) {
        add({ ...common, grade: 'REVIEW', reason: 'exported via a package re-export — public API, never auto-deleted' });
        continue;
      }
      if (def.exported && kind === 'library') {
        add({ ...common, grade: 'REVIEW', reason: 'exported public API of a published package — never auto-deleted' });
        continue;
      }
      if (def.exported && kind === 'unknown') {
        // Exported but never imported anywhere. Same-file use already excluded
        // above (isUsed). This is a real candidate, but public surface —
        // REVIEW, not SAFE, unless it is also unexported in practice.
        add({ ...common, grade: 'REVIEW', reason: 'exported but never imported by any file in the repo' });
        continue;
      }
      if (def.kind === 'method') {
        // Methods are often called from outside the repo (objects, tests,
        // framework dispatch). Never SAFE on static evidence alone.
        add({ ...common, grade: 'REVIEW', reason: 'method with 0 in-repo callers — could be called via an object or framework' });
        continue;
      }
      // Unexported, 0 references, 0 string refs, no dynamic use — or an
      // exported symbol in an app repo, where there is no published
      // public surface to protect: SAFE — unless coverage says
      // otherwise. Coverage is a second, independent signal: a symbol
      // with no static callers whose body lines were executed (tests,
      // framework dispatch, dynamic calls the graph cannot see) is not
      // provably dead. Coverage can only demote SAFE to REVIEW, never
      // promote: stale or partial coverage data can add REVIEWs, never
      // false SAFEs. The check uses body lines only
      // (coverageForSymbolBody): a `def` / `function` / `class` line
      // executes when its module is imported, so counting it would
      // demote every function in an imported module. One-line
      // definitions have no body lines and are never demoted on
      // coverage.
      const bodyCov = coverage
        ? coverageForSymbolBody(coverage, file, def.startLine, def.endLine)
        : null;
      if (bodyCov && bodyCov.pct > 0) {
        add({ ...common, grade: 'REVIEW', reason: `0 static callers, but ${bodyCov.pct}% of its body lines are covered by tests — something executes it, likely dynamically or via a framework` });
      } else {
        add(withCascade({ ...common, grade: 'SAFE', reason: def.exported ? 'exported in an app repo, 0 callers, 0 references, 0 string mentions' : 'unexported, 0 callers, 0 references, 0 string mentions' }));
      }
    }

    // ---- Dead imports ----
    // A name the file ALSO defines at top level is a conditional
    // definition, not a dead import: `if PY313: from copy import
    // replace / else: def replace(...)` (Django's utils/copy.py) provides
    // the same public name under every version, and the import IS the
    // public API on the branch where it runs. Deleting the import would
    // remove the name on that branch. An unconditional shadowing
    // (`from x import y` then a later `def y()`) looks the same and is
    // missed instead — a false negative, never a false SAFE.
    const topLevelDefNames = new Set();
    const srcLines = (info.src || '').split('\n');
    for (const d of parsed.definitions) {
      if (d.local) continue;
      // A `const foo = require('./foo')` binding is the import itself,
      // not a second definition of the name: the definition sits on the
      // require line, so it must not shield the import. A genuine
      // shadowing definition (`def replace` under `else:` in Django's
      // utils/copy.py) sits on its own line. Only variable definitions
      // are excluded: a require binding is always a variable
      // declarator, while a function definition whose line merely
      // mentions require (a parameter named `require`) is still a
      // shadowing definition. (Same exclusion as the web analyzer,
      // docs/analyzer.js, which does not gate on kind.)
      if (d.kind === 'variable') {
        const defLine = srcLines[d.startLine - 1] || '';
        if (/require\s*\(/.test(defLine) || /^\s*import\b/.test(defLine)) continue;
      }
      topLevelDefNames.add(d.name);
    }
    for (const imp of parsed.imports) {
      if (imp.sideEffect || imp.reExport) continue;
      for (const n of imp.names || []) {
        if (n.kind === 'namespace') continue; // import * as ns — usage is via ns.x
        if (topLevelDefNames.has(n.local)) continue; // conditional definition of the same name
        if (!parsed.references.has(n.local) && !parsed.calls.some((c) => c.name === n.local)) {
          const isTestFile = isTest;
          // Import-as-probe (FP-13): an unused import inside try/except
          // exists to test whether the dependency is installed (Django's
          // `try: import numpy` flag, `try: from PIL import Image`); the
          // import IS the use. REVIEW, never SAFE — a leftover optional
          // import in a try block looks identical, so a human checks.
          const grade = isTestFile ? 'KEEP' : imp.inTryExcept ? 'REVIEW' : 'SAFE';
          add({
            category: 'import', file: rel, symbol: n.local, grade,
            startLine: imp.range.startLine, endLine: imp.range.endLine,
            size: imp.range.endIndex - imp.range.startIndex,
            reason: isTestFile ? 'unused import in a test file (kept)' : imp.inTryExcept ? `imported "${n.imported}" from "${imp.source}" inside try/except but never referenced — the import itself may be the availability probe` : `imported "${n.imported}" from "${imp.source}" but never referenced in this file`,
            evidence: { importers: 0, callers: 0, stringRefs: [], exported: false, coveragePct: null, ...evidenceBase },
            deleteDiff: `remove "${n.local}" from import of "${imp.source}" in ${rel}`,
          });
        }
      }
    }

    // ---- Unreachable code ----
    // Test files are KEEP at most: a test's unreachable branch is the
    // test's business (an assertion after a throw, a generator kept
    // alive), never a SAFE delete.
    for (const u of parsed.unreachable || []) {
      add({
        category: 'unreachable', file: rel, symbol: null, grade: isTest ? 'KEEP' : 'SAFE',
        startLine: u.line, endLine: u.line,
        size: u.snippet ? u.snippet.length : 0,
        reason: isTest ? 'unreachable code in a test file (kept)' : u.reason,
        evidence: { importers: 0, callers: 0, stringRefs: [], exported: false, coveragePct: null, ...evidenceBase },
        deleteDiff: u.snippet || '',
      });
    }
    }
  }

  // ---- Dead dependencies (JS only) ----
  if (discovery.pkg && discovery.pkg.dependencies) {
    // A dependency is used when a real import/require names it (exact
    // or subpath: lodash/fp, @scope/pkg/sub), when a package.json
    // script names it, or when a code/config string names it (the
    // strict string-reference pass — prose in a README never counts).
    // The old check scanned every text file for the bare name, so a
    // README mention counted as usage, and a scoped name (@scope/pkg)
    // could never match at all (\b fails before '@').
    const pkgJsons = new Set(discovery.textFiles.filter((f) => path.basename(f) === 'package.json'));
    for (const [dep] of Object.entries(discovery.pkg.dependencies)) {
      let found = false;
      for (const [, info] of graph.files) {
        if (info.language !== 'js' || !info.parsed) continue;
        if (info.parsed.imports.some((imp) => imp.source && (imp.source === dep || imp.source.startsWith(dep + '/')))) { found = true; break; }
      }
      // package.json scripts count as usage (but not the dependencies
      // block itself — a dep must not count as used by its own entry).
      if (!found && mentionRegExp(dep).test(JSON.stringify(discovery.pkg.scripts || {}))) found = true;
      if (!found) {
        for (const f of filesMentioning(dep)) {
          if (!pkgJsons.has(f)) { found = true; break; }
        }
      }
      if (!found) {
        add({
          category: 'dependency', file: 'package.json', symbol: dep, grade: 'REVIEW',
          startLine: 1, endLine: null, size: 0,
          reason: `dependency "${dep}" is never imported, required, named in a script, or referenced by a code/config string — the depsnap prove-unused bet`,
          evidence: { importers: 0, callers: 0, stringRefs: [], exported: false, coveragePct: null, gitAgeDays: null, gitLastCommit: null, gitCommits: null },
          deleteDiff: `npm uninstall ${dep}`,
        });
      }
    }
  }

  return [...findingsById.values()];
}

module.exports = { gradeFindings, loadFrameworks };
