'use strict';

/**
 * --prove: delete SAFE candidates (or SAFE + REVIEW with opts.includeReview)
 * in an isolated git worktree, verify the baseline test suite passes first,
 * run tests once per file-cluster, and binary-bisect only on failure.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const { applyFix } = require('./fix');

const LINKED_DEP_DIRS = ['node_modules', '.venv', 'venv'];

function runShell(cmd, cwd, timeoutMs) {
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    timeout: timeoutMs || 300000,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return { ok: r.status === 0, status: r.status, output: (r.stdout || '') + (r.stderr || '') };
}

function runGit(args, cwd, timeoutMs) {
  const r = spawnSync('git', args, {
    cwd,
    timeout: timeoutMs || 60000,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return { ok: r.status === 0, status: r.status, output: (r.stdout || '') + (r.stderr || '') };
}

function resetWorktree(worktree) {
  runGit(['checkout', '--', '.'], worktree);
  const cleanArgs = ['clean', '-fd'];
  for (const dir of LINKED_DEP_DIRS) cleanArgs.push('-e', dir);
  runGit(cleanArgs, worktree);
}

/**
 * Symlink (or Windows junction) gitignored dependency directories into the
 * scratch worktree so npm/pytest commands can run without reinstalling deps.
 */
function linkDependencies(root, worktree) {
  const linked = [];
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dir of LINKED_DEP_DIRS) {
    const src = path.join(root, dir);
    const dst = path.join(worktree, dir);
    try {
      if (fs.existsSync(src) && fs.statSync(src).isDirectory() && !fs.existsSync(dst)) {
        fs.symlinkSync(src, dst, linkType);
        linked.push(dst);
      }
    } catch (_) {
      /* best effort: repo may not need this dependency dir */
    }
  }
  return linked;
}

function unlinkDependencies(linked) {
  for (const dst of linked) {
    try { fs.unlinkSync(dst); } catch (_) { /* best effort */ }
  }
}

function defaultTimeoutMs(testCmd, overrideMs) {
  if (overrideMs) return overrideMs;
  if (/^(mvn|gradle|\.?[\\/]gradlew(?:\.bat)?)\b/i.test(testCmd || '')) return 900000;
  return 300000;
}

function prove(root, graph, findings, opts) {
  const options = opts || {};
  const testCmd = options.testCommand || null;
  if (!testCmd) {
    return {
      status: 'skipped',
      reason: 'no test command found (no test script detected and no --test-command given)',
      results: [],
      proven: 0,
      breaks: 0,
    };
  }

  const includeReview = Boolean(options.includeReview);
  const allowedGrades = includeReview ? new Set(['SAFE', 'REVIEW']) : new Set(['SAFE']);
  const candidates = findings.filter((f) => allowedGrades.has(f.grade) && f.category !== 'dependency');
  if (!candidates.length) {
    return {
      status: 'skipped',
      reason: 'no eligible findings to prove',
      results: [],
      proven: 0,
      breaks: 0,
    };
  }

  let worktree;
  try {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'deadcode-map-prove-'));
    execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', worktree, 'HEAD'], {
      stdio: 'ignore',
      timeout: 60000,
    });
  } catch (e) {
    return {
      status: 'skipped',
      reason: `could not create a git worktree: ${e.message}`,
      results: [],
      proven: 0,
      breaks: 0,
    };
  }

  const linkedDeps = linkDependencies(root, worktree);
  const timeoutMs = defaultTimeoutMs(testCmd, options.timeoutMs);
  const results = [];

  try {
    // Baseline verification: tests must pass on clean HEAD before proving deletions.
    const baseline = runShell(testCmd, worktree, timeoutMs);
    if (!baseline.ok) {
      return {
        status: 'skipped',
        reason: `baseline test suite failed on HEAD before any deletions: ${baseline.output.slice(-300).trim()}`,
        results: [],
        proven: 0,
        breaks: 0,
      };
    }

    const byFile = new Map();
    for (const f of candidates) {
      if (!byFile.has(f.file)) byFile.set(f.file, []);
      byFile.get(f.file).push(f);
    }

    // Re-run analysis inside the worktree with matching options so byte ranges align.
    const { analyze } = require('./graph');
    const { discover } = require('./discover');
    const { gradeFindings, loadFrameworks } = require('./confidence');
    const { parseCoverage } = require('./coverage');

    const wtDiscovery = discover(worktree, {
      includeFixtures: Boolean(options.includeFixtures),
      noGitignore: Boolean(options.noGitignore),
    });
    const wtGraph = analyze(worktree, wtDiscovery);
    const wtCoverage = options.noCoverage ? null : parseCoverage(worktree, options.coveragePath);
    const wtFindings = gradeFindings({
      root: worktree,
      discovery: wtDiscovery,
      graph: wtGraph,
      git: { isRepo: true, info: new Map() },
      coverage: wtCoverage,
      packs: loadFrameworks(path.join(__dirname, '..', 'frameworks')),
      isLibrary: wtDiscovery.isLibrary,
      javaSafe: Boolean(options.javaSafe),
    });
    const wtById = new Map(wtFindings.map((f) => [f.id, f]));

    const testSubset = (subset) => {
      resetWorktree(worktree);
      const mapped = subset
        .map((f) => wtById.get(f.id))
        .filter((f) => f && allowedGrades.has(f.grade));
      if (!mapped.length) return { changed: false, ok: false, output: '' };

      const before = runGit(['status', '--porcelain'], worktree).output;
      applyFix(worktree, wtGraph, mapped, { includeReview });
      const after = runGit(['status', '--porcelain'], worktree).output;
      if (after === before) return { changed: false, ok: false, output: '' };

      const test = runShell(testCmd, worktree, timeoutMs);
      return { changed: true, ok: test.ok, output: test.output };
    };

    const bisectCluster = (rel, subset) => {
      if (subset.length === 1) {
        const f = subset[0];
        const res = testSubset([f]);
        if (!res.changed) {
          results.push({ cluster: `${rel}:${f.symbol || f.category}`, status: 'skipped', reason: 'fix made no change', findings: 1 });
        } else if (res.ok) {
          results.push({ cluster: `${rel}:${f.symbol || f.category}`, status: 'proven', reason: 'tests pass without this item alone', findings: 1 });
        } else {
          results.push({ cluster: `${rel}:${f.symbol || f.category}`, status: 'breaks', reason: res.output.slice(-500), findings: 1 });
        }
        return;
      }

      const mid = Math.ceil(subset.length / 2);
      const halves = [subset.slice(0, mid), subset.slice(mid)];
      for (const half of halves) {
        if (!half.length) continue;
        const res = testSubset(half);
        if (!res.changed) {
          for (const f of half) {
            results.push({ cluster: `${rel}:${f.symbol || f.category}`, status: 'skipped', reason: 'fix made no change', findings: 1 });
          }
        } else if (res.ok) {
          results.push({
            cluster: half.length === 1 ? `${rel}:${half[0].symbol || half[0].category}` : `${rel} (${half.length} items)`,
            status: 'proven',
            reason: `tests pass without ${half.length} finding(s)`,
            findings: half.length,
          });
        } else {
          bisectCluster(rel, half);
        }
      }
    };

    for (const [rel, items] of byFile) {
      const clusterTest = testSubset(items);
      if (!clusterTest.changed) {
        results.push({ cluster: rel, status: 'skipped', reason: 'fix made no change', findings: items.length });
      } else if (clusterTest.ok) {
        results.push({
          cluster: rel,
          status: 'proven',
          reason: `tests pass without ${items.length} finding(s)`,
          findings: items.length,
        });
      } else if (items.length === 1) {
        const f = items[0];
        results.push({
          cluster: `${rel}:${f.symbol || f.category}`,
          status: 'breaks',
          reason: clusterTest.output.slice(-500),
          findings: 1,
        });
      } else {
        bisectCluster(rel, items);
      }
      resetWorktree(worktree);
    }
  } finally {
    unlinkDependencies(linkedDeps);
    try {
      execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', worktree], {
        stdio: 'ignore',
        timeout: 60000,
      });
    } catch (_) {}
    try { fs.rmSync(worktree, { recursive: true, force: true }); } catch (_) {}
  }

  const proven = results.filter((r) => r.status === 'proven').length;
  const breaks = results.filter((r) => r.status === 'breaks').length;
  return {
    status: proven > 0 && breaks === 0 ? 'proven' : breaks > 0 ? 'mixed' : 'skipped',
    results,
    proven,
    breaks,
  };
}

module.exports = { prove };
