'use strict';

/** Baseline: .deadcode-map.json — grandfathered findings CI must not fail on. */

const fs = require('fs');
const path = require('path');

const BASELINE_FILE = '.deadcode-map.json';

function baselinePath(root) {
  return path.join(root, BASELINE_FILE);
}

function loadBaseline(root) {
  const p = baselinePath(root);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return new Set((data.findings || []).map((f) => f.id || f));
  } catch (_) {
    return null;
  }
}

function saveBaseline(root, findings) {
  const p = baselinePath(root);
  const data = {
    tool: 'deadcode-map',
    version: require('../package.json').version,
    generatedAt: new Date().toISOString(),
    findings: findings.map((f) => ({ id: f.id, category: f.category, file: f.file, symbol: f.symbol, grade: f.grade })),
  };
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return p;
}

function splitBaseline(findings, baseline) {
  if (!baseline) return { fresh: findings, baseline: [] };
  const fresh = [];
  const old = [];
  for (const f of findings) (baseline.has(f.id) ? old : fresh).push(f);
  return { fresh, baseline: old };
}

module.exports = { loadBaseline, saveBaseline, splitBaseline, BASELINE_FILE };
