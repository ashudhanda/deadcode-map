'use strict';

/**
 * Coverage evidence from Cobertura coverage.xml or lcov.info files,
 * if any exist. Maps file -> { linesCovered, linesTotal, pct,
 * coveredLines:Set<number>, allLines:Set<number>, source }.
 * `allLines` is every line number a report mentions for the file
 * (covered or not); it exists so several runs can be merged exactly —
 * the merged total is the size of the union of reported lines, not a
 * guess from per-run totals. Pure regex / line parsing — no XML
 * dependency.
 *
 * Merging: `parseCoverage` accepts one file, one directory, or a list
 * of either. Several runs merge by union of covered lines per file
 * (and union of reported lines for the total), so a line counts as
 * covered when ANY run covered it. Merging is one-way safe, like a
 * single report: it can only demote a would-be SAFE finding to
 * REVIEW, never invent a SAFE. Runs taken against different code
 * states mix line numbers the same way a single stale report does —
 * the cost is extra REVIEWs, never a false SAFE.
 */

const fs = require('fs');
const path = require('path');

function parseCoverageXml(root, explicitPath) {
  const candidates = explicitPath ? [path.resolve(root, explicitPath)] : [
    path.join(root, 'coverage.xml'),
    path.join(root, 'coverage', 'coverage.xml'),
  ];
  let xmlPath = null;
  for (const c of candidates) if (fs.existsSync(c)) { xmlPath = c; break; }
  if (!xmlPath) return null;
  let xml;
  try { xml = fs.readFileSync(xmlPath, 'utf8'); } catch (_) { return null; }

  const byFile = new Map();
  // <class name="..." filename="src/foo.js" line-rate="0.5" ...> ... <line number="12" hits="0"/>
  const classRe = /<class\b[^>]*filename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g;
  let m;
  while ((m = classRe.exec(xml)) !== null) {
    const filename = m[1];
    const body = m[2];
    const covered = new Set();
    const allLines = new Set();
    let total = 0;
    let hit = 0;
    const lineRe = /<line\b[^>]*number="(\d+)"[^>]*hits="(\d+)"[^>]*\/?>/g;
    let lm;
    while ((lm = lineRe.exec(body)) !== null) {
      total += 1;
      const ln = parseInt(lm[1], 10);
      allLines.add(ln);
      const hits = parseInt(lm[2], 10);
      if (hits > 0) { hit += 1; covered.add(ln); }
    }
    if (total > 0) {
      byFile.set(path.resolve(root, filename), {
        linesTotal: total, linesCovered: hit,
        pct: Math.round((hit / total) * 100), coveredLines: covered,
        allLines, source: 'cobertura',
      });
    }
  }
  return byFile.size ? byFile : null;
}

/**
 * lcov format (jest, vitest, coverage.py via lcov export, gcov):
 *   TN:<test name>
 *   SF:<source file path, absolute or relative to the repo root>
 *   DA:<line number>,<hit count>[,<checksum>]
 *   end_of_record
 * A file contributes one record; DA lines are counted per record, so a
 * repeated SF block for the same file overwrites the previous one.
 * Paths that do not resolve under the scanned root are kept as-is —
 * they simply never match a scanned file, which is fail-open.
 */
function parseLcov(root, explicitPath) {
  const candidates = explicitPath ? [path.resolve(root, explicitPath)] : [
    path.join(root, 'lcov.info'),
    path.join(root, 'coverage', 'lcov.info'),
  ];
  let lcovPath = null;
  for (const c of candidates) if (fs.existsSync(c)) { lcovPath = c; break; }
  if (!lcovPath) return null;
  let content;
  try { content = fs.readFileSync(lcovPath, 'utf8'); } catch (_) { return null; }

  const byFile = new Map();
  let current = null; // { file, covered:Set, allLines:Set, total, hit }
  const flush = () => {
    if (current && current.total > 0) {
      byFile.set(current.file, {
        linesTotal: current.total, linesCovered: current.hit,
        pct: Math.round((current.hit / current.total) * 100),
        coveredLines: current.covered, allLines: current.allLines, source: 'lcov',
      });
    }
    current = null;
  };
  for (const line of content.split('\n')) {
    if (line.startsWith('SF:')) {
      flush();
      const raw = line.slice(3).trim();
      const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
      current = { file: abs, covered: new Set(), allLines: new Set(), total: 0, hit: 0 };
    } else if (line.startsWith('DA:') && current) {
      const parts = line.slice(3).split(',');
      const ln = parseInt(parts[0], 10);
      const hits = parseInt(parts[1], 10);
      if (Number.isNaN(ln)) continue;
      current.total += 1;
      current.allLines.add(ln);
      if (hits > 0) { current.hit += 1; current.covered.add(ln); }
    } else if (line.startsWith('end_of_record')) {
      flush();
    }
  }
  flush();
  return byFile.size ? byFile : null;
}

/**
 * Merge several per-file coverage maps (one per run) into a single
 * map: per file, the union of covered lines and the union of reported
 * lines. A line counts as covered when ANY run covered it, so adding
 * a run can only raise coverage, never lower it. `linesTotal` is the
 * size of the union of reported lines; when an entry has no `allLines`
 * (a hand-built map), its total falls back to the largest per-run
 * total for that file. `source` keeps a single shared source
 * ('cobertura' / 'lcov') and becomes 'merged' when the runs disagree.
 * Null / empty maps are skipped. Returns null when nothing merges.
 * Merging is idempotent: merging a map with itself changes nothing.
 */
function mergeCoverage(maps) {
  const merged = new Map();
  for (const map of maps || []) {
    if (!map) continue;
    for (const [file, entry] of map) {
      const prev = merged.get(file);
      if (!prev) {
        merged.set(file, {
          linesTotal: entry.linesTotal, linesCovered: entry.linesCovered,
          pct: entry.pct, coveredLines: new Set(entry.coveredLines || []),
          allLines: entry.allLines ? new Set(entry.allLines) : null,
          source: entry.source || null,
        });
        continue;
      }
      const covered = new Set([...prev.coveredLines, ...(entry.coveredLines || [])]);
      let total;
      let allLines = null;
      if (prev.allLines && entry.allLines) {
        allLines = new Set([...prev.allLines, ...entry.allLines]);
        total = allLines.size;
      } else {
        // No exact line sets: the union of lines cannot exceed the
        // largest run's total, and cannot be smaller than either run's
        // covered count — take the largest total as the safe bound.
        total = Math.max(prev.linesTotal, entry.linesTotal, covered.size);
      }
      const sources = new Set([prev.source, entry.source].filter(Boolean));
      merged.set(file, {
        linesTotal: total, linesCovered: covered.size,
        pct: total > 0 ? Math.round((covered.size / total) * 100) : 0,
        coveredLines: covered, allLines,
        source: sources.size === 1 ? [...sources][0] : 'merged',
      });
    }
  }
  return merged.size ? merged : null;
}

/**
 * Parse one explicit coverage file (absolute path). Format by
 * extension (.info -> lcov, .xml -> Cobertura), with content sniffing
 * for unknown extensions. Returns null when the file is missing,
 * unreadable, or holds no coverage data.
 */
function parseSingleCoverageFile(root, absPath) {
  if (!fs.existsSync(absPath)) return null;
  if (/\.info$/i.test(absPath)) return parseLcov(root, absPath);
  if (/\.xml$/i.test(absPath)) return parseCoverageXml(root, absPath);
  // Unknown extension: sniff the content.
  try {
    const head = fs.readFileSync(absPath, 'utf8').slice(0, 200);
    if (head.includes('SF:') || head.startsWith('TN:')) return parseLcov(root, absPath);
    return parseCoverageXml(root, absPath);
  } catch (_) { return null; }
}

/**
 * Coverage report files inside a directory, recursively: files named
 * coverage.xml / lcov.info, or any *.xml / *.info file whose name
 * starts with `coverage` or `lcov` (coverage-run1.xml, lcov-e2e.info).
 * Other files are ignored, so a directory of mixed run outputs merges
 * only its reports. Sorted by path for a deterministic merge order.
 */
function collectCoverageFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) continue;
      const base = e.name.toLowerCase();
      if (base === 'coverage.xml' || base === 'lcov.info'
        || ((base.endsWith('.xml') || base.endsWith('.info'))
          && (base.startsWith('coverage') || base.startsWith('lcov')))) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Parse one explicit coverage input: a file path, a directory path,
 * or a list of either. A directory merges every report it holds; a
 * list merges its entries in order. Missing, empty, or unparsable
 * inputs are skipped, so one bad run never blocks the rest; when
 * every input is skipped the result is null. A single file input
 * behaves exactly as before (same map, same `source`).
 */
function parseCoverageInput(root, input) {
  const abs = path.resolve(root, input);
  let stat;
  try { stat = fs.statSync(abs); } catch (_) { return null; }
  if (stat.isDirectory()) {
    const maps = collectCoverageFiles(abs).map((f) => parseSingleCoverageFile(root, f));
    const found = maps.filter(Boolean);
    if (found.length === 0) return null;
    if (found.length === 1) return found[0];
    return mergeCoverage(found);
  }
  return parseSingleCoverageFile(root, abs);
}

/**
 * Coverage evidence for a scan: Cobertura XML or lcov, auto-discovered
 * or explicit. Returns the same file map as parseCoverageXml, with a
 * `source` field ('cobertura' | 'lcov' | 'merged') on each entry, or
 * null when no coverage file exists or none parses.
 *
 * `explicitPath` is one file path, one directory path, or a list of
 * either. A single file behaves exactly as before; a directory or a
 * list merges its reports by union of covered lines per file (see
 * mergeCoverage). With no explicit path, auto-discovery is unchanged:
 * the first file found in priority order wins (coverage.xml,
 * coverage/coverage.xml, lcov.info, coverage/lcov.info) — automatic
 * runs are NOT merged, only explicitly given ones are.
 */
function parseCoverage(root, explicitPath) {
  if (explicitPath) {
    if (Array.isArray(explicitPath)) {
      if (explicitPath.length === 0) return null;
      const maps = explicitPath.map((p) => parseCoverageInput(root, p)).filter(Boolean);
      if (maps.length === 0) return null;
      if (maps.length === 1) return maps[0];
      return mergeCoverage(maps);
    }
    return parseCoverageInput(root, explicitPath);
  }
  return parseCoverageXml(root) || parseLcov(root);
}

function coverageForSymbol(coverage, file, startLine, endLine) {
  if (!coverage) return null;
  const entry = coverage.get(path.resolve(file));
  if (!entry) return null;
  let total = 0;
  let hit = 0;
  for (let ln = startLine; ln <= endLine; ln++) {
    total += 1;
    if (entry.coveredLines.has(ln)) hit += 1;
  }
  if (total === 0) return null;
  return { pct: Math.round((hit / total) * 100), linesTotal: total, linesCovered: hit, source: entry.source || null };
}

/**
 * Body-line coverage for one definition: lines strictly after the
 * definition line up to its end line. The definition line itself is
 * excluded on purpose: a `def` / `function` / `class` line executes
 * when its module is imported, so counting it would mark every
 * function in an imported module as covered. Returns null when the
 * file has no coverage data or the definition has no body lines (a
 * one-line definition), so callers treat it as "no signal".
 */
function coverageForSymbolBody(coverage, file, startLine, endLine) {
  if (!coverage) return null;
  const entry = coverage.get(path.resolve(file));
  if (!entry) return null;
  let total = 0;
  let hit = 0;
  for (let ln = startLine + 1; ln <= endLine; ln++) {
    total += 1;
    if (entry.coveredLines.has(ln)) hit += 1;
  }
  if (total === 0) return null;
  return { pct: Math.round((hit / total) * 100), linesTotal: total, linesCovered: hit, source: entry.source || null };
}

module.exports = { parseCoverageXml, parseLcov, parseCoverage, mergeCoverage, coverageForSymbol, coverageForSymbolBody };
