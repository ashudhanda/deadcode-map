'use strict';

/**
 * File discovery + entry-point detection.
 *
 * Entry points are the roots of the import graph. A file that is never
 * imported is only a dead-file candidate when it is not an entry point,
 * not a test / story / config / migration, and not framework magic.
 */

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next',
  'coverage', '.coverage', '__pycache__', '.venv', 'venv', '.tox',
  '.pytest_cache', '.mypy_cache', '.turbo', 'vendor', 'target',
]);

// Test-data directories: planted dead code lives here on purpose, so
// scanning them as real code is noise — a repo's own fixtures would
// report its own test data as dead. Excluded at any depth by default
// (fixtures/, __fixtures__/, test/fixtures, tests/fixtures, ...);
// --include-fixtures opts back in.
const FIXTURE_DIRS = new Set(['fixtures', '__fixtures__']);

const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py']);
const ALL_EXTS = new Set([...CODE_EXTS, '.json', '.md', '.txt', '.yaml', '.yml', '.toml', '.html', '.css', '.vue']);

function isCodeFile(p) {
  return CODE_EXTS.has(path.extname(p).toLowerCase());
}

function walk(dir, out, includeFixtures) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.') && e.name !== '.github') continue;
      if (!includeFixtures && FIXTURE_DIRS.has(e.name)) continue;
      walk(full, out, includeFixtures);
    } else if (e.isFile()) {
      if (SKIP_FILES.has(e.name)) continue;
      out.push(full);
    }
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Collect package.json entry points (main / bin / exports) as file paths. */
function packageJsonEntries(root, pkg) {
  const out = new Set();
  if (!pkg) return out;
  const add = (v) => {
    if (typeof v !== 'string') return;
    const p = path.resolve(root, v);
    out.add(p);
  };
  add(pkg.main);
  add(pkg.module);
  add(pkg.types);
  if (pkg.bin) {
    if (typeof pkg.bin === 'string') add(pkg.bin);
    else Object.values(pkg.bin).forEach(add);
  }
  if (pkg.exports) {
    const collect = (v) => {
      if (typeof v === 'string') add(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    };
    collect(pkg.exports);
  }
  return out;
}

const ENTRY_BASENAMES = new Set([
  'index', 'main', 'app', 'server', 'cli', 'bin', 'entry', 'setup',
  'wsgi', 'asgi', 'manage', '__main__',
]);

const ENTRY_PATTERNS = [
  /(^|\/)(pages|app|routes|views)\//, // framework route directories
  /\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /_test\.py$/, /test_[^/]+\.py$/,
  /\.stories\.[jt]sx?$/,
  /\.config\.[jt]s$/, /\.config\.mjs$/, /\.config\.cjs$/,
  /\/migrations\//, /\/seeds?\//,
  /setup\.py$/, /conftest\.py$/, /\/__init__\.py$/,
  /webpack\.config\./, /vite\.config\./, /rollup\.config\./,
  /tailwind\.config\./, /jest\.config\./, /babel\.config\./,
];

function looksLikeEntry(rel, abs, pkgEntries) {
  if (pkgEntries.has(abs)) return { entry: true, reason: 'package.json entry point' };
  const base = path.basename(abs, path.extname(abs));
  if (ENTRY_BASENAMES.has(base)) return { entry: true, reason: `entry basename "${base}"` };
  for (const re of ENTRY_PATTERNS) {
    if (re.test(rel) || re.test(abs)) return { entry: true, reason: `matches entry pattern ${re}` };
  }
  // Shebang / executable CLI script.
  try {
    const head = fs.readFileSync(abs, 'utf8').slice(0, 200);
    if (head.startsWith('#!')) return { entry: true, reason: 'has a shebang (CLI script)' };
  } catch (_) { /* ignore */ }
  // Runnable scripts: `if __name__ == "__main__":` (Python) or
  // `if (require.main === module)` (Node) — the file is run directly.
  try {
    const src = fs.readFileSync(abs, 'utf8');
    if (/__name__\s*==\s*['"]__main__['"]/.test(src)) return { entry: true, reason: 'runnable script (if __name__ == "__main__")' };
    if (/require\.main\s*===\s*module/.test(src)) return { entry: true, reason: 'runnable script (require.main === module)' };
  } catch (_) { /* ignore */ }
  return { entry: false, reason: '' };
}

function discover(root, opts) {
  const absRoot = path.resolve(root);
  const allFiles = walk(absRoot, [], Boolean(opts && opts.includeFixtures));
  const codeFiles = allFiles.filter(isCodeFile);
  const textFiles = allFiles.filter((f) => ALL_EXTS.has(path.extname(f).toLowerCase()));
  const pkgPath = path.join(absRoot, 'package.json');
  const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath) : null;
  const pkgEntries = packageJsonEntries(absRoot, pkg);
  const isLibrary = Boolean(pkg && pkg.exports);
  const entries = new Map(); // abs path -> reason
  for (const f of codeFiles) {
    const rel = path.relative(absRoot, f);
    const r = looksLikeEntry(rel, f, pkgEntries);
    if (r.entry) entries.set(f, r.reason);
  }
  return { root: absRoot, allFiles, codeFiles, textFiles, pkg, pkgEntries, isLibrary, entries };
}

module.exports = { discover, isCodeFile, CODE_EXTS, readJson, FIXTURE_DIRS };
