'use strict';

/**
 * Coverage evidence from a Cobertura coverage.xml or an lcov.info file,
 * if one exists. Maps file -> { linesCovered, linesTotal, pct,
 * coveredLines:Set<number>, source }.
 * Pure regex / line parsing — no XML dependency.
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
    let total = 0;
    let hit = 0;
    const lineRe = /<line\b[^>]*number="(\d+)"[^>]*hits="(\d+)"[^>]*\/?>/g;
    let lm;
    while ((lm = lineRe.exec(body)) !== null) {
      total += 1;
      const hits = parseInt(lm[2], 10);
      if (hits > 0) { hit += 1; covered.add(parseInt(lm[1], 10)); }
    }
    if (total > 0) {
      byFile.set(path.resolve(root, filename), {
        linesTotal: total, linesCovered: hit,
        pct: Math.round((hit / total) * 100), coveredLines: covered,
        source: 'cobertura',
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
  let current = null; // { file, covered:Set, total, hit }
  const flush = () => {
    if (current && current.total > 0) {
      byFile.set(current.file, {
        linesTotal: current.total, linesCovered: current.hit,
        pct: Math.round((current.hit / current.total) * 100),
        coveredLines: current.covered, source: 'lcov',
      });
    }
    current = null;
  };
  for (const line of content.split('\n')) {
    if (line.startsWith('SF:')) {
      flush();
      const raw = line.slice(3).trim();
      const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
      current = { file: abs, covered: new Set(), total: 0, hit: 0 };
    } else if (line.startsWith('DA:') && current) {
      const parts = line.slice(3).split(',');
      const ln = parseInt(parts[0], 10);
      const hits = parseInt(parts[1], 10);
      if (Number.isNaN(ln)) continue;
      current.total += 1;
      if (hits > 0) { current.hit += 1; current.covered.add(ln); }
    } else if (line.startsWith('end_of_record')) {
      flush();
    }
  }
  flush();
  return byFile.size ? byFile : null;
}

/**
 * Coverage evidence for a scan: Cobertura XML or lcov, auto-discovered
 * or explicit. Returns the same file map as parseCoverageXml, with a
 * `source` field ('cobertura' | 'lcov') on each entry, or null when no
 * coverage file exists or none parses. An explicit path wins; otherwise
 * the first file found in priority order wins (coverage.xml,
 * coverage/coverage.xml, lcov.info, coverage/lcov.info). Only the first
 * found report is used — merging reports from different runs would mix
 * line numbers from different code states.
 */
function parseCoverage(root, explicitPath) {
  if (explicitPath) {
    const abs = path.resolve(root, explicitPath);
    if (!fs.existsSync(abs)) return null;
    if (/\.info$/i.test(abs)) return parseLcov(root, explicitPath);
    if (/\.xml$/i.test(abs)) return parseCoverageXml(root, explicitPath);
    // Unknown extension: sniff the content.
    try {
      const head = fs.readFileSync(abs, 'utf8').slice(0, 200);
      if (head.includes('SF:') || head.startsWith('TN:')) return parseLcov(root, explicitPath);
      return parseCoverageXml(root, explicitPath);
    } catch (_) { return null; }
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

module.exports = { parseCoverageXml, parseLcov, parseCoverage, coverageForSymbol, coverageForSymbolBody };
