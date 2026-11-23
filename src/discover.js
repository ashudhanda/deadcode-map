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
  '.nuxt', '.svelte-kit', '.output', '.astro', '.parcel-cache',
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

/** Normalize OS-specific path separators to POSIX forward slashes. */
function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

function isCodeFile(p) {
  return CODE_EXTS.has(path.extname(p).toLowerCase());
}

/**
 * Compile one .gitignore pattern into a matcher relative to the directory
 * containing that .gitignore file.
 */
function compileGitignoreLine(rawLine) {
  let line = rawLine.replace(/\r$/, '');
  if (!line || line.startsWith('#')) return null;
  // Strip unescaped trailing spaces.
  line = line.replace(/(?<!\\)\s+$/, '');
  if (!line) return null;

  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  } else if (line.startsWith('\\#') || line.startsWith('\\!')) {
    line = line.slice(1);
  }
  if (!line) return null;

  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (!line) return null;

  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);

  // Convert gitignore glob syntax to RegExp.
  let re = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '*') {
      if (line[i + 1] === '*') {
        if (line[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('[\\^$.|+(){}'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }

  const regex = anchored
    ? new RegExp(`^${re}(?:/.*)?$`)
    : new RegExp(`(?:^|/)${re}(?:/.*)?$`);

  return { negated, dirOnly, regex };
}

function loadGitignoreRules(dir) {
  const file = path.join(dir, '.gitignore');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return [];
  }
  const rules = [];
  for (const line of text.split('\n')) {
    const compiled = compileGitignoreLine(line);
    if (compiled) rules.push({ baseDir: dir, ...compiled });
  }
  return rules;
}

function isIgnoredByGitignore(fullPath, isDir, rules) {
  if (!rules.length) return false;
  let ignored = false;
  for (const rule of rules) {
    const rel = toPosix(path.relative(rule.baseDir, fullPath));
    if (!rel || rel.startsWith('..')) continue;
    if (rule.dirOnly && !isDir) {
      // A dir-only rule still ignores files inside a matched directory,
      // which the walk skips before descending, so check full path too.
      if (!rel.includes('/')) continue;
    }
    if (rule.regex.test(rel)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function walk(dir, out, includeFixtures, respectGitignore, inheritedRules) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }

  const rules = respectGitignore
    ? inheritedRules.concat(loadGitignoreRules(dir))
    : inheritedRules;

  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
      if (!includeFixtures && FIXTURE_DIRS.has(e.name)) continue;
      if (respectGitignore && isIgnoredByGitignore(full, true, rules)) continue;
      walk(full, out, includeFixtures, respectGitignore, rules);
    } else if (e.isFile()) {
      if (SKIP_FILES.has(e.name)) continue;
      if (respectGitignore && isIgnoredByGitignore(full, false, rules)) continue;
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
    if (/\.(js|jsx|ts|tsx|mjs|cjs|py)$/.test(dotted)) continue;
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
  /(^|\/)(pages|app|routes|views)\//,
  /(^|\/)examples\//,
  /(^|\/)(scripts|tools)\//,
  /\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /\.test-d\.[jt]sx?$/, /\.e2e-spec\.[jt]sx?$/, /_test\.py$/, /test_[^/]+\.py$/,
  /Test\.java$/,
  /\.stories\.[jt]sx?$/,
  /\.config\.[jt]s$/, /\.config\.mjs$/, /\.config\.cjs$/,
  /\/migrations\//, /\/seeds?\//,
  // Worker entry scripts (Node worker_threads / Web Workers): loaded by
  // the runtime via a string path (new Worker('...')), never imported,
  // so without this they read as dead files with only a string mention.
  /-worker\.[jt]sx?$/, /\.worker\.[jt]sx?$/,
  /setup\.py$/, /conftest\.py$/, /\/__init__\.py$/,
  /webpack\.config\./, /vite\.config\./, /rollup\.config\./,
  /tailwind\.config\./, /jest\.config\./, /babel\.config\./,
];

function isManualScriptPath(rel) {
  return /(^|\/)(scripts|tools)\//.test(toPosix(rel));
}

function looksLikeEntry(rel, abs, pkgEntries) {
  if (pkgEntries.has(abs)) return { entry: true, reason: 'package.json entry point' };
  const posixRel = toPosix(rel);
  const posixAbs = toPosix(abs);
  const base = path.basename(abs, path.extname(abs)).toLowerCase();
  if (ENTRY_BASENAMES.has(base)) return { entry: true, reason: `entry basename "${base}"` };
  for (const re of ENTRY_PATTERNS) {
    if (re.test(posixRel) || re.test(posixAbs)) return { entry: true, reason: `matches entry pattern ${re}` };
  }
  let src = '';
  try { src = fs.readFileSync(abs, 'utf8'); } catch (_) { return { entry: false, reason: '' }; }
  if (src.startsWith('#!')) return { entry: true, reason: 'has a shebang (CLI script)' };
  if (/__name__\s*==\s*['"]__main__['"]/.test(src)) return { entry: true, reason: 'runnable script (if __name__ == "__main__")' };
  if (/require\.main\s*===\s*module/.test(src)) return { entry: true, reason: 'runnable script (require.main === module)' };
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

function pyprojectHasProjectName(text) {
  if (!text || !text.includes('[project]')) return false;
  const section = text.slice(text.indexOf('[project]'));
  return /^\s*name\s*=\s*["'][^"']+["']/m.test(section);
}

function setupHasName(file, text) {
  if (!text) return false;
  if (file.endsWith('setup.py')) return /\bname\s*=\s*["'][^"']+["']/.test(text);
  return /\[metadata\][\s\S]*?^\s*name\s*=\s*\S/m.test(text);
}

function discover(root, opts) {
  const absRoot = path.resolve(root);
  const includeFixtures = Boolean(opts && opts.includeFixtures);
  const respectGitignore = !(opts && opts.noGitignore);
  let allFiles = walk(absRoot, [], includeFixtures, respectGitignore, []);

  const excludeFiles = opts && Array.isArray(opts.excludeFiles) ? opts.excludeFiles : [];
  if (excludeFiles.length) {
    const excluded = new Set(excludeFiles.map((p) => path.resolve(absRoot, p)));
    allFiles = allFiles.filter((f) => !excluded.has(f));
  }
  // Config-supplied ignore patterns (path prefixes or regexes).
  const ignorePatterns = opts && Array.isArray(opts.ignorePatterns) ? opts.ignorePatterns : [];
  if (ignorePatterns.length) {
    const compiledIgnores = [];
    for (const pat of ignorePatterns) {
      try { compiledIgnores.push(new RegExp(pat)); } catch (_) {}
    }
    if (compiledIgnores.length) {
      allFiles = allFiles.filter((f) => {
        const rel = toPosix(path.relative(absRoot, f));
        return !compiledIgnores.some((re) => re.test(rel));
      });
    }
  }
  const codeFiles = allFiles.filter(isCodeFile);
  const textFiles = allFiles.filter((f) => ALL_EXTS.has(path.extname(f).toLowerCase()));
  const pkgPath = path.join(absRoot, 'package.json');
  const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath) : null;

  const jsManifests = new Map();
  const pyManifests = new Map();
  const manageDirs = new Set();
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
      for (const p of configFileEntries(f)) pkgEntries.add(p);
    }
  }
  const isLibrary = Boolean(pkg && pkg.exports);

  const kindCache = new Map();
  function fileKind(abs) {
    if (kindCache.has(abs)) return kindCache.get(abs);
    let kind = 'unknown';
    const ext = path.extname(abs).toLowerCase();
    let dir = path.dirname(abs);
    let sawPrivate = false;
    let exhausted = false;
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

  const entries = new Map();
  for (const f of codeFiles) {
    const rel = toPosix(path.relative(absRoot, f));
    const r = looksLikeEntry(rel, f, pkgEntries);
    if (r.entry) entries.set(f, r.reason);
  }
  // Config-supplied extra entry points (exact paths or regexes over code files).
  const extraEntries = opts && Array.isArray(opts.extraEntries) ? opts.extraEntries : [];
  for (const entry of extraEntries) {
    if (typeof entry !== 'string') continue;
    const direct = path.resolve(absRoot, entry);
    if (fs.existsSync(direct)) {
      entries.set(direct, 'project config entry point');
      continue;
    }
    try {
      const re = new RegExp(entry);
      for (const f of codeFiles) {
        if (re.test(toPosix(path.relative(absRoot, f)))) {
          entries.set(f, `project config entry pattern ${entry}`);
        }
      }
    } catch (_) {}
  }
  return { root: absRoot, allFiles, codeFiles, textFiles, pkg, pkgEntries, isLibrary, entries, fileKind };
}

module.exports = { discover, isCodeFile, CODE_EXTS, readJson, FIXTURE_DIRS, isManualScriptPath, toPosix };
