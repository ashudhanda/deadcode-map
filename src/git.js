'use strict';

/** Git evidence: last-touch age + churn per file. Best effort, never fatal. */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
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
  const info = new Map();
  if (!isGitRepo(root)) return { isRepo: false, info };
  const now = Date.now();
  let out;
  try {
    out = execFileSync(
      'git',
      ['-C', root, '-c', 'core.quotepath=false', 'log', '--format=COMMIT:%ct', '--name-only', '--'],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
    );
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
  const wanted = new Set(files.map((f) => path.resolve(f)));
  for (const key of [...info.keys()]) {
    if (!wanted.has(key)) info.delete(key);
  }
  return { isRepo: true, info };
}

function hasCommand(cmd) {
  if (!/^[A-Za-z0-9._-]+$/.test(cmd)) return false;
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    return spawnSync(checker, [cmd], { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch (_) {
    return false;
  }
}

function defaultTestCommand(root, pkg) {
  if (pkg && pkg.scripts && pkg.scripts.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
    return 'npm test';
  }
  // Python: pytest when config or tests exist and pytest is available.
  const looksPython = fs.existsSync(path.join(root, 'pyproject.toml'))
    || fs.existsSync(path.join(root, 'pytest.ini'))
    || fs.existsSync(path.join(root, 'setup.py'))
    || fs.existsSync(path.join(root, 'setup.cfg'));
  if (looksPython && hasCommand('pytest')) return 'pytest -q';

  // Java: Maven or Gradle, when Java + build tool are installed.
  if (hasCommand('java')) {
    if (fs.existsSync(path.join(root, 'pom.xml')) && hasCommand('mvn')) return 'mvn -q test';
    if (process.platform === 'win32' && fs.existsSync(path.join(root, 'gradlew.bat'))) return 'gradlew.bat test';
    if (fs.existsSync(path.join(root, 'gradlew'))) return './gradlew test';
    if (fs.existsSync(path.join(root, 'build.gradle')) || fs.existsSync(path.join(root, 'build.gradle.kts'))) {
      if (hasCommand('gradle')) return 'gradle test';
    }
  }
  return null;
}

module.exports = { isGitRepo, gitInfo, defaultTestCommand, hasCommand };
