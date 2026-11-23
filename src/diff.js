'use strict';

/**
 * PR Diff / Incremental CI mode (`--diff <baseRef>`).
 *
 * Computes changed files and added/modified line numbers against a git base
 * ref (e.g. `origin/main`, `HEAD~1`) plus untracked files, then filters
 * findings so CI gates only dead code introduced or touched in the PR.
 */

const { execFileSync } = require('child_process');
const { toPosix } = require('./discover');

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff --unified=0` output into:
 * - changedFiles: Set<posixRel>
 * - addedLines: Map<posixRel, Set<number>>
 */
function parseUnifiedDiff(diffText) {
  const changedFiles = new Set();
  const addedLines = new Map();
  let currentFile = null;

  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = toPosix(line.slice('+++ b/'.length).trim());
      changedFiles.add(currentFile);
      if (!addedLines.has(currentFile)) addedLines.set(currentFile, new Set());
      continue;
    }
    if (line.startsWith('+++ /dev/null')) {
      currentFile = null;
      continue;
    }
    if (!currentFile) continue;

    const m = line.match(HUNK_RE);
    if (m) {
      const start = parseInt(m[1], 10);
      const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
      const lineSet = addedLines.get(currentFile);
      if (count === 0) {
        // Pure deletion hunk: mark the adjacent line so newly-orphaned imports nearby still show.
        if (start > 0) lineSet.add(start);
      } else {
        for (let ln = start; ln < start + count; ln++) lineSet.add(ln);
      }
    }
  }

  return { changedFiles, addedLines };
}

function getGitDiff(root, baseRef) {
  let diffText = '';
  try {
    // Compare working tree against merge-base when possible; fall back to direct ref diff.
    let target = baseRef;
    try {
      const mb = execFileSync('git', ['-C', root, 'merge-base', baseRef, 'HEAD'], {
        encoding: 'utf8',
        timeout: 15000,
      }).trim();
      if (mb) target = mb;
    } catch (_) {
      /* e.g. unborn branch or direct commit hash */
    }
    diffText = execFileSync(
      'git',
      ['-C', root, '-c', 'core.quotepath=false', 'diff', '--unified=0', '--no-color', target],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    throw new Error(`--diff failed for ref "${baseRef}": ${e.message}`);
  }

  const parsed = parseUnifiedDiff(diffText);

  // Include untracked files as newly added so new dead files in a PR are caught.
  try {
    const untracked = execFileSync(
      'git',
      ['-C', root, '-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard'],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
    );
    for (const rel of untracked.split('\n')) {
      const clean = toPosix(rel.trim());
      if (!clean) continue;
      parsed.changedFiles.add(clean);
      parsed.addedLines.set(clean, null); // null = entire file is new
    }
  } catch (_) { /* best effort */ }

  return parsed;
}

/**
 * Filter findings to those touching changed files / lines.
 * scope: 'hunk' (default: overlaps changed lines, or whole new file) | 'file' (any finding in touched files).
 */
function filterFindingsByDiff(findings, diffData, opts) {
  const scope = (opts && opts.scope) || 'hunk';
  const kept = [];
  let hidden = 0;

  for (const f of findings) {
    const file = toPosix(f.file || '');
    if (!diffData.changedFiles.has(file)) {
      hidden += 1;
      continue;
    }
    if (scope === 'file' || f.category === 'file' || f.category === 'dependency') {
      kept.push(f);
      continue;
    }
    const lineSet = diffData.addedLines.get(file);
    if (lineSet === null) {
      // Newly untracked file: keep all findings inside it.
      kept.push(f);
      continue;
    }
    const start = f.startLine || 1;
    const end = f.endLine || start;
    let overlaps = false;
    if (lineSet) {
      for (let ln = start; ln <= end; ln++) {
        if (lineSet.has(ln)) { overlaps = true; break; }
      }
    }
    if (overlaps) kept.push(f);
    else hidden += 1;
  }

  return { findings: kept, hidden, changedFileCount: diffData.changedFiles.size };
}

module.exports = { parseUnifiedDiff, getGitDiff, filterFindingsByDiff };
