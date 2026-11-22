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

const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.java']);
const ALL_EXTS = new Set([...CODE_EXTS, '.json', '.md', '.txt', '.yaml', '.yml', '.toml', '.html', '.css', '.vue', '.xml', '.properties']);

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
  add(pkg.typings);
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
  // package.json `imports` (subpath imports, e.g. "#utils": "./src/utils.js")
  // are entries too: code resolves them by name, never by relative path.
  if (pkg.imports) {
    const collect = (v) => {
      if (typeof v === 'string') add(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    };
    collect(pkg.imports);
  }
  return out;
}

// File paths named in package.json scripts are entries: the script runs
// them directly (migrations, seeds, codegen, `tsx scripts/build.ts`).
// Tokens are resolved against the manifest's own directory, not the repo
// root — a workspace script must not resolve against the wrong package.
function scriptEntries(manifestDir, pkg) {
  const out = new Set();
  if (!pkg || !pkg.scripts) return out;
  for (const script of Object.values(pkg.scripts)) {
    if (typeof script !== 'string') continue;
    for (const token of script.split(/[\s'"]+/)) {
      if (!token || !/\.(js|jsx|ts|tsx|mjs|cjs|py)$/.test(token)) continue;
      if (/^https?:\/\//.test(token)) continue;
      const p = path.resolve(manifestDir, token);
      if (fs.existsSync(p)) out.add(p);
    }
  }
  return out;
}

// Config files name the scripts they load: MkDocs `extra_javascript`,
// plugin hooks (`scripts/agent_banner.py` under `markdown_extensions`
// or `plugins`), and similar. Any token ending in a code extension
// that resolves to a real file next to the config is an entry — and so
// is a dotted module reference (`scripts.mkdocs_hook` -> the file
// `scripts/mkdocs_hook.py`), which is how MkDocs names Python plugins.
function configFileEntries(configPath) {
  const out = new Set();
  let text;
  try { text = fs.readFileSync(configPath, 'utf8'); } catch (_) { return out; }
  const dir = path.dirname(configPath);
  for (const m of text.matchAll(/[\w./-]+\.(js|jsx|ts|tsx|mjs|cjs|py)\b/g)) {
    const p = path.resolve(dir, m[0]);
    if (fs.existsSync(p)) out.add(p);
  }
  for (const m of text.matchAll(/[A-Za-z_][\w]*(?:\.[\w]+)+/g)) {
    const dotted = m[0];
    if (/\.(js|jsx|ts|tsx|mjs|cjs|py)$/.test(dotted)) continue; // handled above
    for (const ext of ['.py', '.js', '.ts']) {
      const p = path.resolve(dir, dotted.replace(/\./g, '/') + ext);
      if (fs.existsSync(p)) { out.add(p); break; }
    }
  }
  return out;
}

const ENTRY_BASENAMES = new Set([
  'index', 'main', 'app', 'server', 'cli', 'bin', 'entry', 'setup',
  'wsgi', 'asgi', 'manage', '__main__', 'gulpfile', 'gruntfile',
]);

const ENTRY_PATTERNS = [
  /(^|\/)(pages|app|routes|views)\//, // framework route directories
  /(^|\/)examples\//, // example scripts are standalone entry points, run directly
  /(^|\/)(scripts|tools)\//, // manually-run tools: invoked by hand, never imported (see isManualScriptPath)
  /\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /\.e2e-spec\.[jt]sx?$/, /_test\.py$/, /test_[^/]+\.py$/,
  /Test\.java$/, // JUnit test class (src/test/java or *Test.java)
  /\.stories\.[jt]sx?$/,
  /\.config\.[jt]s$/, /\.config\.mjs$/, /\.config\.cjs$/,
  /\/migrations\//, /\/seeds?\//,
  /setup\.py$/, /conftest\.py$/, /\/__init__\.py$/,
  /webpack\.config\./, /vite\.config\./, /rollup\.config\./,
  /tailwind\.config\./, /jest\.config\./, /babel\.config\./,
];

// Heuristic: a code file under a scripts/ or tools/ directory at any
// depth is a manually-run tool — a seed, deploy, migration-helper, or
// one-off script an operator invokes directly (`node scripts/seed.js`,
// `python tools/audit.py`), not something the import graph reaches.
// It is an entry point (never a dead file), and its symbols are kept
// too (see confidence.js): the operator invokes its functions by name,
// by editing the script, or through argv dispatch the static graph
// cannot see, so an unreferenced function there cannot be proven dead.
// This is deliberately fail-open — a genuinely dead helper inside
// scripts/ stays hidden rather than risk flagging a tool the operator
// runs by hand. It only ever demotes findings, never creates a SAFE.
// Files the graph DOES reach (imported helpers under scripts/) are
// unaffected: their symbols were already live through their importers.
function isManualScriptPath(rel) {
  return /(^|\/)(scripts|tools)\//.test(rel);
}

function looksLikeEntry(rel, abs, pkgEntries) {
  if (pkgEntries.has(abs)) return { entry: true, reason: 'package.json entry point' };
  const base = path.basename(abs, path.extname(abs));
  if (ENTRY_BASENAMES.has(base)) return { entry: true, reason: `entry basename "${base}"` };
  for (const re of ENTRY_PATTERNS) {
    if (re.test(rel) || re.test(abs)) return { entry: true, reason: `matches entry pattern ${re}` };
  }
  // Shebang / executable CLI script, or a runnable script
  // (`if __name__ == "__main__":` in Python,
  // `if (require.main === module)` in Node) — the file is run directly.
  // One read serves all three checks.
  let src = '';
  try { src = fs.readFileSync(abs, 'utf8'); } catch (_) { return { entry: false, reason: '' }; }
  if (src.startsWith('#!')) return { entry: true, reason: 'has a shebang (CLI script)' };
  if (/__name__\s*==\s*['"]__main__['"]/.test(src)) return { entry: true, reason: 'runnable script (if __name__ == "__main__")' };
  if (/require\.main\s*===\s*module/.test(src)) return { entry: true, reason: 'runnable script (require.main === module)' };
  // Java: a public static void main(String[]) method is the entry point.
  if (/public\s+static\s+void\s+main\s*\(\s*String\s*\[/.test(src)) return { entry: true, reason: 'has a main() method (Java entry point)' };
  return { entry: false, reason: '' };
}

const APP_FRAMEWORK_DEPS = new Set([
  'next', 'nuxt', 'gatsby', 'astro', '@angular/core', '@sveltejs/kit',
  '@remix-run/node', 'ember-source',
]);

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

// A pyproject.toml with a [project] name is a published package.
function pyprojectHasProjectName(text) {
  if (!text || !text.includes('[project]')) return false;
  const section = text.slice(text.indexOf('[project]'));
  return /^\s*name\s*=\s*["'][^"']+["']/m.test(section);
}

// setup.py / setup.cfg naming a package: a published package too.
function setupHasName(file, text) {
  if (!text) return false;
  if (file.endsWith('setup.py')) return /\bname\s*=\s*["'][^"']+["']/.test(text);
  return /\[metadata\][\s\S]*?^\s*name\s*=\s*\S/m.test(text);
}

function discover(root, opts) {
  const absRoot = path.resolve(root);
  let allFiles = walk(absRoot, [], Boolean(opts && opts.includeFixtures));
  // Tool-generated output files must never be scanned: a report or map
  // written inside the scanned root on one run would otherwise count
  // as string references on the next run and change the findings (the
  // same reason the cache file is filtered in src/index.js). Only the
  // exact resolved paths in opts.excludeFiles are dropped — never a
  // directory, never a same-named file elsewhere. Paths need not exist
  // yet: the output file is written after the scan, so the first run
  // already excludes the path the second run finds on disk. A path
  // outside the scanned root matches nothing and changes nothing.
  const excludeFiles = opts && Array.isArray(opts.excludeFiles) ? opts.excludeFiles : [];
  if (excludeFiles.length) {
    const excluded = new Set(excludeFiles.map((p) => path.resolve(absRoot, p)));
    allFiles = allFiles.filter((f) => !excluded.has(f));
  }
  const codeFiles = allFiles.filter(isCodeFile);
  const textFiles = allFiles.filter((f) => ALL_EXTS.has(path.extname(f).toLowerCase()));
  const pkgPath = path.join(absRoot, 'package.json');
  const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath) : null;

  // Every manifest in the tree, not just the root: workspaces and
  // sub-packages have their own entries, scripts, and library/app kind.
  const jsManifests = new Map(); // dir -> { hasExports, isPrivate, hasMain, isAppFramework, hasAppDir }
  const pyManifests = new Map(); // dir -> { isLibrary }
  const manageDirs = new Set(); // dirs containing manage.py (Django app)
  const pkgEntries = new Set();
  for (const f of allFiles) {
    const base = path.basename(f);
    const dir = path.dirname(f);
    if (base === 'package.json') {
      const manifest = readJson(f);
      if (!manifest) continue;
      for (const p of packageJsonEntries(dir, manifest)) pkgEntries.add(p);
      for (const p of scriptEntries(dir, manifest)) pkgEntries.add(p);
      const deps = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
      jsManifests.set(dir, {
        hasExports: Boolean(manifest.exports),
        isPrivate: manifest.private === true,
        hasMain: typeof manifest.main === 'string' || typeof manifest.module === 'string',
        isAppFramework: [...APP_FRAMEWORK_DEPS].some((d) => d in deps),
        hasAppDir: fs.existsSync(path.join(dir, 'app')) || fs.existsSync(path.join(dir, 'src', 'app')),
      });
    } else if (base === 'pyproject.toml') {
      pyManifests.set(dir, { isLibrary: pyprojectHasProjectName(readText(f)) });
    } else if (base === 'setup.py' || base === 'setup.cfg') {
      if (setupHasName(f, readText(f))) pyManifests.set(dir, { isLibrary: true });
    } else if (base === 'manage.py') {
      manageDirs.add(dir);
    } else if (/^mkdocs.*\.ya?ml$/.test(base)) {
      // MkDocs loads scripts and JS assets named in its config.
      for (const p of configFileEntries(f)) pkgEntries.add(p);
    }
  }
  const isLibrary = Boolean(pkg && pkg.exports);

  // Library vs app, per file, from the nearest manifest above it.
  // Libraries keep public API at REVIEW; apps may grade exported but
  // uncalled app-internal symbols SAFE (see confidence.js). Unknown
  // (no manifest signal either way) keeps the old behaviour: REVIEW.
  // The rule is deliberately narrow so fixtures and plain packages do
  // not flip: a package.json with only `main` and no app signal is
  // unknown, not an app.
  const kindCache = new Map(); // abs file -> 'library' | 'app' | 'unknown'
  function fileKind(abs) {
    if (kindCache.has(abs)) return kindCache.get(abs);
    let kind = 'unknown';
    const ext = path.extname(abs).toLowerCase();
    let dir = path.dirname(abs);
    // A `private: true` manifest does not decide the kind by itself:
    // in a monorepo the sub-packages are private (published through the
    // root package) while the root has `exports` — preact's compat/ and
    // hooks/ sub-packages were graded 'app' and their exported symbols
    // went SAFE. So a private manifest is skipped and the walk continues
    // up; only a chain of nothing but private manifests is an app.
    let sawPrivate = false;
    let exhausted = false; // the walk ran out of ancestors without a decisive manifest
    while (true) {
      if (ext === '.py') {
        if (pyManifests.has(dir)) {
          kind = pyManifests.get(dir).isLibrary ? 'library' : 'unknown';
          break;
        }
        if (manageDirs.has(dir)) { kind = 'app'; break; }
      } else if (jsManifests.has(dir)) {
        const m = jsManifests.get(dir);
        if (m.hasExports) { kind = 'library'; break; }
        if (m.isAppFramework || (!m.hasMain && m.hasAppDir)) { kind = 'app'; break; }
        if (m.isPrivate) { sawPrivate = true; }
        else { kind = 'unknown'; break; }
      }
      if (dir === absRoot || path.dirname(dir) === dir) { exhausted = true; break; }
      dir = path.dirname(dir);
    }
    if (kind === 'unknown' && sawPrivate && exhausted) kind = 'app';
    kindCache.set(abs, kind);
    return kind;
  }

  const entries = new Map(); // abs path -> reason
  for (const f of codeFiles) {
    const rel = path.relative(absRoot, f);
    const r = looksLikeEntry(rel, f, pkgEntries);
    if (r.entry) entries.set(f, r.reason);
  }
  return { root: absRoot, allFiles, codeFiles, textFiles, pkg, pkgEntries, isLibrary, entries, fileKind };
}

module.exports = { discover, isCodeFile, CODE_EXTS, readJson, FIXTURE_DIRS, isManualScriptPath };
