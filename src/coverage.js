'use strict';

/**
 * Coverage evidence from a Cobertura coverage.xml, if one exists.
 * Maps file -> { linesCovered, linesTotal, pct, coveredLines:Set<number> }.
 * Pure regex parsing — no XML dependency.
 */

const fs = require('fs');
const path = require('path');

function parseCoverageXml(root) {
  const candidates = [
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
      });
    }
  }
  return byFile.size ? byFile : null;
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
  return { pct: Math.round((hit / total) * 100), linesTotal: total, linesCovered: hit };
}

module.exports = { parseCoverageXml, coverageForSymbol };
