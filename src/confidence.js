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
 *  - Same-file-only use: not dead — REVIEW as "unexport-to-local".
 *  - String reference anywhere else: REVIEW, never SAFE.
 *  - Everything else with 0 importers / 0 callers / 0 string refs: SAFE.
 */

const fs = require('fs');
const path = require('path');
const { mentionRegExp } = require('./graph');

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

const TEST_FILE = /(\.test\.|\.spec\.|_test\.py$|test_[^/]+\.py$|conftest\.py$)/;
const CONFIG_FILE = /(\.config\.[jt]s|webpack\.config|vite\.config|jest\.config|babel\.config|tailwind\.config|\.d\.ts$)/;

function gradeFindings(ctx) {
  const { root, discovery, graph, git, coverage, packs, isLibrary } = ctx;
  const findings = [];
  const { files, importers, reachable, filesMentioning, symbolUsage } = graph;

  const add = (f) => {
    f.id = `${f.category}:${f.file}:${f.symbol || ''}:${f.startLine || 0}`;
    findings.push(f);
    return f;
  };

  for (const [file, info] of files) {
    const rel = info.rel;
    if (info.parseError) continue; // never flag what we could not parse
    const parsed = info.parsed;
    const gitInfo = git.info.get(file);
    const covFile = coverage ? coverage.get(path.resolve(file)) : null;
    const isEntry = discovery.entries.has(file);
    const entryReason = discovery.entries.get(file) || '';
    const isTest = TEST_FILE.test(rel);
    const isConfig = CONFIG_FILE.test(rel);
    const fwReasons = frameworkKeepFile(rel, packs);
    // The FILE is kept when it is an entry point / test / config / framework
    // file. But symbols inside an entry file are graded normally — a dead
    // helper inside main.py is still dead. Only test / config / framework
    // files keep their symbols, because those symbols are resolved by the
    // framework or test runner, not by imports.
    const keepFile = isEntry || isTest || isConfig || fwReasons.length > 0;
    const keepSymbols = isTest || isConfig || fwReasons.length > 0;

    const evidenceBase = {
      gitAgeDays: gitInfo ? gitInfo.ageDays : null,
      gitLastCommit: gitInfo ? gitInfo.lastCommit : null,
      gitCommits: gitInfo ? gitInfo.commits : null,
      coveragePct: covFile ? covFile.pct : null,
    };

    // ---- Dead file ----
    const importerCount = (importers.get(file) || new Set()).size;
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
        const mentionedElsewhere = [...stringRefs].filter((f) => f !== file);
        // A file is also string-referenced when any of its symbols is
        // mentioned by name elsewhere (e.g. a config naming a handler).
        const symbolStringRefs = [];
        for (const d of parsed.definitions) {
          const hits = [...filesMentioning(d.name)].filter((f) => f !== file);
          if (hits.length) symbolStringRefs.push(...hits.map((f) => path.relative(root, f)));
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
          const grade = isLibrary ? 'REVIEW' : 'SAFE';
          add({
            category: 'file', file: rel, symbol: null, grade,
            startLine: 1, endLine: null, size: info.size,
            reason: isLibrary
              ? 'no importers, but this is a published library — public surface, review before deleting'
              : 'no importers, not an entry point, not referenced by name anywhere',
            evidence: { importers: 0, reachable: false, stringRefs: [], ...evidenceBase },
            deleteDiff: `delete ${rel} (${info.size} bytes)`,
          });
        }
      }
    }

    // ---- Dead symbols (functions / classes / variables / types / exports) ----
    const usageMap = symbolUsage.get(file) || new Map();
    // Import bindings (const x = require('...') / import x from '...') are
    // covered by the dead-import findings below, not as dead symbols.
    const importLocals = new Set();
    for (const imp of parsed.imports) for (const n of imp.names || []) importLocals.add(n.local);
    const categoryOf = (kind) => ({ function: 'function', class: 'class', type: 'type', variable: 'variable', method: 'method' }[kind] || 'function');
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
      const importedBy = [...usage.importedBy];
      const calledIn = [...usage.calledIn];
      // A call from the symbol's own file is same-file use, not an external caller.
      const calledElsewhere = calledIn.filter((f) => f !== file);
      const sameFileUse = usage.sameFile || calledIn.includes(file);
      // Same-file-only use is NOT dead — it is "unexport-to-local": the
      // symbol is used, but only in its own file, so it need not be exported.
      if (importedBy.length === 0 && calledElsewhere.length === 0 && sameFileUse) {
        // Entry files are scripts, not libraries: their functions are entry
        // logic, not exports to remove.
        if (def.exported && def.kind !== 'variable' && !isEntry) {
          const covSame = coverage
            ? require('./coverage').coverageForSymbol(coverage, file, def.startLine, def.endLine)
            : null;
          add({
            category: categoryOf(def.kind),
            file: rel, symbol: def.name, grade: 'REVIEW',
            startLine: def.startLine, endLine: def.endLine,
            size: def.range.endIndex - def.range.startIndex,
            reason: 'used only in its own file — could be unexported, not deleted',
            evidence: { importers: 0, callers: calledElsewhere.length, stringRefs: [], exported: true, coveragePct: covSame ? covSame.pct : null, ...evidenceBase },
            deleteDiff: `remove "export" from ${def.name} in ${rel}`,
          });
        }
        continue;
      }
      const isUsed = importedBy.length > 0 || calledElsewhere.length > 0;
      if (isUsed) continue;

      const stringHits = filesMentioning(def.name);
      const stringElsewhere = [...stringHits].filter((f) => f !== file);
      const cov = coverage
        ? require('./coverage').coverageForSymbol(coverage, file, def.startLine, def.endLine)
        : null;
      const snippet = info.src.slice(def.range.startIndex, Math.min(def.range.endIndex, def.range.startIndex + 400));

      const common = {
        category: categoryOf(def.kind),
        file: rel, symbol: def.name, grade: 'REVIEW',
        startLine: def.startLine, endLine: def.endLine,
        size: def.range.endIndex - def.range.startIndex,
        evidence: {
          importers: importedBy.length, callers: calledElsewhere.length,
          stringRefs: stringElsewhere.map((f) => path.relative(root, f)),
          exported: def.exported, coveragePct: cov ? cov.pct : null,
          ...evidenceBase,
        },
        deleteDiff: snippet,
      };

      // KEEP: framework / decorator / dunder / entry-file symbols.
      // Framework checks here are per-symbol: only THIS definition's own
      // decorators count, never another symbol's decorator in the same file.
      const fwSym = frameworkKeepSymbol(rel, def.name, def.decorators, packs);
      if (fwSym.length > 0) {
        add({ ...common, grade: 'KEEP', reason: fwSym[0] });
        continue;
      }
      if (parsed.dunder && parsed.dunder.has(def.name)) {
        add({ ...common, grade: 'KEEP', reason: `module dunder ${def.name} — read by the import system / packaging tooling, never auto-deleted` });
        continue;
      }
      if (keepSymbols) {
        add({ ...common, grade: 'KEEP', reason: isTest ? 'in a test file' : isConfig ? 'in a config file' : fwReasons[0] || 'framework / entry file' });
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
      if (def.exported && isLibrary) {
        add({ ...common, grade: 'REVIEW', reason: 'exported public API of a published package — never auto-deleted' });
        continue;
      }
      if (def.exported) {
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
      // Unexported, 0 references, 0 string refs, no dynamic use: SAFE.
      add({ ...common, grade: 'SAFE', reason: 'unexported, 0 callers, 0 references, 0 string mentions' });
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
    for (const u of parsed.unreachable || []) {
      add({
        category: 'unreachable', file: rel, symbol: null, grade: 'SAFE',
        startLine: u.line, endLine: u.line,
        size: u.snippet ? u.snippet.length : 0,
        reason: u.reason,
        evidence: { importers: 0, callers: 0, stringRefs: [], exported: false, coveragePct: null, ...evidenceBase },
        deleteDiff: u.snippet || '',
      });
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

  return findings;
}

module.exports = { gradeFindings, loadFrameworks };
