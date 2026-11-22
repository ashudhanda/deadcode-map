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

const TEST_FILE = /(\.test\.|\.spec\.|_test\.py$|test_[^/]+\.py$|conftest\.py$|(^|\/)test\.[jt]sx?$)/;
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
    if (!reachable.has(file) && importerCount === 0) {
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
    const scopes = Array.isArray(parsed.topLevelUses);
    let sameFileLive = null;
    if (scopes) {
      const defUses = new Map(); // name -> Set<used names>
      for (const d of parsed.definitions) {
        if (!defUses.has(d.name)) defUses.set(d.name, new Set());
        for (const u of d.uses || []) defUses.get(d.name).add(u);
      }
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
      const liveRoots = new Set(parsed.topLevelUses || []);
      for (const [name, u] of usageMap) {
        const liveImporters = [...u.importedBy].filter((f) => !deadFiles.has(f));
        const liveCallers = [...u.calledIn].filter((f) => f !== file && !deadFiles.has(f));
        if (liveImporters.length > 0 || liveCallers.length > 0) liveRoots.add(name);
      }
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
      // from the live roots and the kept (non-method) definitions, so
      // the computation is not circular: a class is live when live
      // code references it, when it is itself kept (framework /
      // exported public API), or when a kept definition reaches it (a
      // framework handler that instantiates it really runs). The
      // cost of the old rule was false negatives — helpers used only
      // by methods of a dead class stayed hidden. That is now fixed
      // for the known-class case; the unknown-class case keeps the
      // safe direction.
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
      const baseKeepDef = (d) => keepSymbols
        || frameworkKeepSymbol(rel, d.name, d.decorators, packs).length > 0
        || d.frameworkField || d.ambient || overloadedNames.has(d.name)
        || (parsed.dunder && parsed.dunder.has(d.name))
        || (d.kind === 'method' && d.name.startsWith('__'))
        || (d.exported && (kind === 'library' || kind === 'unknown' || (reExportedFiles && reExportedFiles.has(file))));
      const baseKeepNames = new Set();
      for (const d of parsed.definitions) if (baseKeepDef(d)) baseKeepNames.add(d.name);
      const bfs = (seeds) => {
        const seen = new Set();
        const queue = [...seeds];
        while (queue.length) {
          const cur = queue.pop();
          if (seen.has(cur)) continue;
          seen.add(cur);
          for (const nxt of defUses.get(cur) || []) if (!seen.has(nxt)) queue.push(nxt);
        }
        return seen;
      };
      const live = bfs(liveRoots);
      const viaBaseKept = bfs(baseKeepNames);
      const liveClassNames = new Set();
      for (const d of classDefs) {
        if (live.has(d.name) || baseKeepNames.has(d.name) || viaBaseKept.has(d.name)) liveClassNames.add(d.name);
      }
      const keepDef = (d) => baseKeepDef(d)
        || (d.kind === 'method' && (enclosingClassName(d) === null || liveClassNames.has(enclosingClassName(d))));
      const keepNames = new Set();
      for (const d of parsed.definitions) if (keepDef(d)) keepNames.add(d.name);
      const viaKept = bfs(keepNames);
      sameFileLive = new Set([...live, ...viaKept]);
      for (const name of keepNames) if (!live.has(name)) sameFileLive.delete(name);
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
        : (scopes ? sameFileLive.has(def.name) : (usage.sameFile || calledIn.includes(file)));
      // Same-file use is real use: a symbol called or referenced in its
      // own file is alive, full stop. It used to be flagged REVIEW as
      // "unexport-to-local", but that turned every module's own helpers
      // into noise (e.g. our own isGitRepo / resolveRelative /
      // buildMapData). An export that is only used in its own file is
      // still used — never a finding.
      if (importedBy.length === 0 && calledElsewhere.length === 0 && sameFileUse) {
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
      // Chained-assignment alias of a method defined in the same class
      // (`__setitem__ = ... = popitem = _fail`): the names are aliases
      // of one live method, part of the class's interface — never SAFE.
      if (def.chainedAlias) {
        add({ ...common, grade: 'KEEP', reason: `chained-assignment alias of ${def.chainedAliasOf || 'a method'} in the same class — the name is the same object as the method, part of the class interface` });
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
    for (const imp of parsed.imports) {
      if (imp.sideEffect || imp.reExport) continue;
      for (const n of imp.names || []) {
        if (n.kind === 'namespace') continue; // import * as ns — usage is via ns.x
        if (!parsed.references.has(n.local) && !parsed.calls.some((c) => c.name === n.local)) {
          const isTestFile = isTest;
          add({
            category: 'import', file: rel, symbol: n.local, grade: isTestFile ? 'KEEP' : 'SAFE',
            startLine: imp.range.startLine, endLine: imp.range.endLine,
            size: imp.range.endIndex - imp.range.startIndex,
            reason: isTestFile ? 'unused import in a test file (kept)' : `imported "${n.imported}" from "${imp.source}" but never referenced in this file`,
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
