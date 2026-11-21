'use strict';

/** Git evidence: last-touch age + churn per file. Best effort, never fatal. */

const { execFileSync } = require('child_process');
const path = require('path');

function isGitRepo(root) {
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--git-dir'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch (_) {
    return false;
  }
}

function gitInfo(root, files) {
  const info = new Map(); // abs path -> { lastCommit, ageDays, commits }
  if (!isGitRepo(root)) return { isRepo: false, info };
  const now = Date.now();
  for (const f of files) {
    try {
      const rel = path.relative(root, f);
      const out = execFileSync('git', ['-C', root, 'log', '-1', '--format=%ct', '--', rel], { encoding: 'utf8', timeout: 5000 }).trim();
      const count = execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD', '--', rel], { encoding: 'utf8', timeout: 5000 }).trim();
      const ts = parseInt(out, 10);
      if (!Number.isNaN(ts)) {
        info.set(f, {
          lastCommit: new Date(ts * 1000).toISOString().slice(0, 10),
          ageDays: Math.floor((now - ts * 1000) / 86400000),
          commits: parseInt(count, 10) || 0,
        });
      }
    } catch (_) { /* file untracked or git error — no evidence */ }
  }
  return { isRepo: true, info };
}

function defaultTestCommand(root, pkg) {
  if (pkg && pkg.scripts && pkg.scripts.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
    return 'npm test';
  }
  return null;
}

module.exports = { isGitRepo, gitInfo, defaultTestCommand };
