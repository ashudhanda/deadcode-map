'use strict';

/**
 * SARIF 2.1.0 report generator (`--sarif <file>`).
 * Compatible with GitHub Code Scanning (`github/codeql-action/upload-sarif`),
 * GitLab SAST, and VS Code SARIF Viewer.
 */

const fs = require('fs');
const { toPosix } = require('./discover');

const VERSION = require('../package.json').version;
const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const HELP_URI = 'https://github.com/ashudhanda/deadcode-map#what-counts-as-dead';

const RULES = {
  file: {
    id: 'DCM001',
    name: 'DeadFile',
    shortDescription: 'Unreachable source file',
    fullDescription: 'File has zero importers, is not an entry point, and has no code-like string references.',
  },
  function: {
    id: 'DCM002',
    name: 'UnusedFunction',
    shortDescription: 'Unused function',
    fullDescription: 'Function is defined but never called or referenced from any live entry point.',
  },
  export: {
    id: 'DCM003',
    name: 'UnusedExport',
    shortDescription: 'Unused export',
    fullDescription: 'Exported symbol has zero importers or references in the repository.',
  },
  class: {
    id: 'DCM004',
    name: 'UnusedClass',
    shortDescription: 'Unused class',
    fullDescription: 'Class is declared but never instantiated, subclassed, or referenced.',
  },
  method: {
    id: 'DCM005',
    name: 'UnusedMethod',
    shortDescription: 'Unused method',
    fullDescription: 'Class method has zero callers in the repository.',
  },
  variable: {
    id: 'DCM006',
    name: 'UnusedVariable',
    shortDescription: 'Unused variable or field',
    fullDescription: 'Variable, constant, or private field is declared but never read.',
  },
  import: {
    id: 'DCM007',
    name: 'UnusedImport',
    shortDescription: 'Unused import',
    fullDescription: 'Imported binding is never referenced in the importing file.',
  },
  unreachable: {
    id: 'DCM008',
    name: 'UnreachableCode',
    shortDescription: 'Unreachable code',
    fullDescription: 'Statements after return, throw, break, continue, or constant-false guards never execute.',
  },
  dependency: {
    id: 'DCM009',
    name: 'UnusedDependency',
    shortDescription: 'Unused package dependency',
    fullDescription: 'Dependency declared in package.json is never imported, scripted, or referenced.',
  },
};

function ruleForCategory(category) {
  return RULES[category] || {
    id: 'DCM000',
    name: 'DeadCode',
    shortDescription: 'Unused code',
    fullDescription: 'Code element is unreachable from repository entry points.',
  };
}

function toSarifReport(root, findings) {
  const active = findings.filter((f) => f.grade === 'SAFE' || f.grade === 'REVIEW');
  const seenRules = new Map();
  const results = [];

  for (const f of active) {
    const rule = ruleForCategory(f.category);
    if (!seenRules.has(rule.id)) {
      seenRules.set(rule.id, {
        id: rule.id,
        name: rule.name,
        shortDescription: { text: rule.shortDescription },
        fullDescription: { text: rule.fullDescription },
        helpUri: HELP_URI,
        defaultConfiguration: { level: 'warning' },
      });
    }

    const startLine = Math.max(1, f.startLine || 1);
    const endLine = Math.max(startLine, f.endLine || startLine);
    const ev = f.evidence || {};
    const symbolLabel = f.symbol ? ` "${f.symbol}"` : '';

    results.push({
      ruleId: rule.id,
      level: f.grade === 'SAFE' ? 'error' : 'warning',
      message: {
        text: `[${f.grade}] ${f.category}${symbolLabel}: ${f.reason || rule.shortDescription}`,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: toPosix(f.file || '') },
            region: { startLine, endLine },
          },
        },
      ],
      partialFingerprints: {
        primaryLocationLineHash: f.id,
      },
      properties: {
        grade: f.grade,
        category: f.category,
        symbol: f.symbol || null,
        importers: ev.importers ?? null,
        callers: ev.callers ?? null,
        gitAgeDays: ev.gitAgeDays ?? null,
        coveragePct: ev.coveragePct ?? null,
      },
    });
  }

  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'deadcode-map',
            version: VERSION,
            informationUri: 'https://github.com/ashudhanda/deadcode-map',
            rules: [...seenRules.values()],
          },
        },
        results,
      },
    ],
  };
}

function writeSarif(root, findings, outPath) {
  const sarif = toSarifReport(root, findings);
  fs.writeFileSync(outPath, JSON.stringify(sarif, null, 2) + '\n', 'utf8');
  return sarif;
}

module.exports = { toSarifReport, writeSarif };
