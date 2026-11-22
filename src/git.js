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

// One batched `git log` for the whole repo instead of two processes per
// file (log + rev-list). On a 1500-file repo that was ~3000 spawns —
// the single biggest fixed cost after parsing. The log is newest-first:
// the first time a file appears is its last touch, and every appearance
// is one commit touching it.
function gitInfo(root, files) {
  const info = new Map(); // abs path -> { lastCommit, ageDays, commits }
  if (!isGitRepo(root)) return { isRepo: false, info };
  const now = Date.now();
  let out;
  try {
    out = execFileSync('git', ['-C', root, 'log', '--format=COMMIT:%ct', '--name-only', '--'], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  } catch (_) {
    return { isRepo: true, info };
  }
  let ts = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('COMMIT:')) {
      const parsed = parseInt(line.slice('COMMIT:'.length), 10);
      ts = Number.isNaN(parsed) ? null : parsed;
    } else if (line.trim() === '' || ts === null) {
      continue;
    } else {
      const abs = path.resolve(root, line.trim());
      const entry = info.get(abs);
      if (entry) {
        entry.commits += 1;
      } else {
        info.set(abs, {
          lastCommit: new Date(ts * 1000).toISOString().slice(0, 10),
          ageDays: Math.floor((now - ts * 1000) / 86400000),
          commits: 1,
        });
      }
    }
  }
  // Only report files the scan asked about; untracked files have no entry.
  const wanted = new Set(files.map((f) => path.resolve(f)));
  for (const key of [...info.keys()]) {
    if (!wanted.has(key)) info.delete(key);
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
