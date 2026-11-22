'use strict';

/**
 * --prove: delete SAFE candidates in an isolated git worktree, run the
 * test suite once per cluster, report proven / breaks / skipped.
 *
 * Batching: one test run proves a whole file-cluster. Only if that run
 * fails do we bisect by single finding. Repos with no test command are
 * reported as skipped, never as proven.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');
const { applyFix } = require('./fix');

function run(cmd, cwd, timeoutMs) {
  const r = spawnSync(cmd, { cwd, shell: true, timeout: timeoutMs || 300000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return { ok: r.status === 0, status: r.status, output: (r.stdout || '') + (r.stderr || '') };
}

function prove(root, graph, findings, opts) {
  const testCmd = opts.testCommand || null;
  if (!testCmd) {
    return { status: 'skipped', reason: 'no test command found (no npm test script and no --test-command given)', results: [] };
  }
  // Isolated git worktree.
  let worktree;
  try {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'deadcode-map-prove-'));
    execSync(`git -C "${root}" worktree add --detach "${worktree}" HEAD`, { stdio: 'ignore', timeout: 60000 });
  } catch (e) {
    return { status: 'skipped', reason: `could not create a git worktree: ${e.message}`, results: [] };
  }

  const results = [];
  try {
    const safe = findings.filter((f) => f.grade === 'SAFE' && f.category !== 'dependency');
    const byFile = new Map();
    for (const f of safe) {
      if (!byFile.has(f.file)) byFile.set(f.file, []);
      byFile.get(f.file).push(f);
    }
    // Re-run analysis inside the worktree so ranges match its files.
    const { analyze } = require('./graph');
    const { discover } = require('./discover');
    const { gradeFindings, loadFrameworks } = require('./confidence');
    const wtDiscovery = discover(worktree);
    const wtGraph = analyze(worktree, wtDiscovery);
    const wtFindings = gradeFindings({
      root: worktree, discovery: wtDiscovery, graph: wtGraph,
      git: { isRepo: true, info: new Map() }, coverage: null,
      packs: loadFrameworks(path.join(__dirname, '..', 'frameworks')), isLibrary: wtDiscovery.isLibrary,
    });

    for (const [rel, items] of byFile) {
      // Apply this file's SAFE deletions in the worktree.
      const before = run('git status --porcelain', worktree).output;
      applyFix(worktree, wtGraph, wtFindings.filter((f) => f.file === rel && f.grade === 'SAFE'));
      const changed = run('git status --porcelain', worktree).output;
      if (changed === before) {
        results.push({ cluster: rel, status: 'skipped', reason: 'fix made no change', findings: items.length });
        continue;
      }
      // JVM builds download dependencies and compile on the first run:
      // Maven / Gradle get a longer timeout than the JS/Python path.
      const timeoutMs = opts.timeoutMs || (/^(mvn|gradle|\.\/gradlew)\b/.test(testCmd || '') ? 900000 : 300000);
      const test = run(testCmd, worktree, timeoutMs);
      if (test.ok) {
        results.push({ cluster: rel, status: 'proven', reason: `tests pass without ${items.length} SAFE finding(s)`, findings: items.length });
      } else {
        // Bisect: revert, then try each finding alone.
        run('git checkout -- .', worktree);
        run('git clean -fd', worktree);
        let provenAny = false;
        for (const f of items) {
          applyFix(worktree, wtGraph, wtFindings.filter((x) => x.id === f.id));
          const single = run(testCmd, worktree, timeoutMs);
          if (single.ok) {
            results.push({ cluster: `${rel}:${f.symbol || f.category}`, status: 'proven', reason: 'tests pass without this item alone', findings: 1 });
            provenAny = true;
          } else {
            results.push({ cluster: `${rel}:${f.symbol || f.category}`, status: 'breaks', reason: single.output.slice(-500), findings: 1 });
          }
          run('git checkout -- .', worktree);
          run('git clean -fd', worktree);
        }
        if (!provenAny) {
          results.push({ cluster: rel, status: 'breaks', reason: 'tests fail when the whole cluster is removed', findings: items.length });
        }
      }
      // Clean the worktree for the next cluster.
      run('git checkout -- .', worktree);
      run('git clean -fd', worktree);
    }
  } finally {
    try { execSync(`git -C "${root}" worktree remove --force "${worktree}"`, { stdio: 'ignore', timeout: 60000 }); } catch (_) {}
    try { fs.rmSync(worktree, { recursive: true, force: true }); } catch (_) {}
  }

  const proven = results.filter((r) => r.status === 'proven').length;
  const breaks = results.filter((r) => r.status === 'breaks').length;
  return { status: proven > 0 && breaks === 0 ? 'proven' : breaks > 0 ? 'mixed' : 'skipped', results, proven, breaks };
}

module.exports = { prove };
