'use strict';

/** Public entry point: run a scan and return the report. */

const path = require('path');
const { discover } = require('./discover');
const { analyze } = require('./graph');
const { gradeFindings, loadFrameworks } = require('./confidence');
const { gitInfo } = require('./git');
const { parseCoverageXml } = require('./coverage');

function scan(root, opts) {
  const discovery = discover(root, opts);
  const graph = analyze(root, discovery);
  const git = gitInfo(root, discovery.codeFiles);
  const coverage = parseCoverageXml(root);
  const packs = loadFrameworks(path.join(__dirname, '..', 'frameworks'));
  const findings = gradeFindings({
    root: discovery.root, discovery, graph, git, coverage, packs,
    isLibrary: discovery.isLibrary,
  });
  return { root: discovery.root, discovery, graph, findings, git, coverage, packs };
}

module.exports = { scan };
