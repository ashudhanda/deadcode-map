'use strict';

/**
 * Framework rule-pack loader and matcher.
 * Pre-compiles regexes and Sets once at load time instead of recompiling
 * on every file / symbol during grading.
 *
 * Behaviour is identical to the inline helpers this replaces: decorator
 * matching stays a substring check (`d.includes(kd)`) with the same
 * reason strings — the web-batch15 tests pin
 * `decorator "register"` etc. exactly, and the substring rule is
 * documented there. Only the regex compilation is hoisted.
 */

const fs = require('fs');
const path = require('path');
const { toPosix } = require('../discover');

function compilePatterns(list) {
  const out = [];
  for (const pat of list || []) {
    try {
      out.push({ raw: pat, re: new RegExp(pat) });
    } catch (_) {
      /* ignore malformed regex in user pack */
    }
  }
  return out;
}

function loadFrameworks(dir) {
  const packs = [];
  if (!fs.existsSync(dir)) return packs;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    try {
      const pack = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      pack._file = f;
      // Non-enumerable compiled indexes so JSON.stringify(packs) for the
      // cache config hash stays deterministic and identical to raw JSON.
      Object.defineProperty(pack, '_compiled', {
        enumerable: false,
        value: {
          entryPatterns: compilePatterns(pack.entryPatterns),
          keepFiles: compilePatterns(pack.keepFiles),
          keepExports: new Set(pack.keepExports || []),
          keepNames: new Set(pack.keepNames || []),
          keepDecorators: pack.keepDecorators || [],
          keepClassAnnotations: new Set(pack.keepClassAnnotations || []),
        },
      });
      packs.push(pack);
    } catch (_) {
      /* bad pack — skip, do not crash */
    }
  }
  return packs;
}

function frameworkKeepFile(rel, packs) {
  const posixRel = toPosix(rel);
  const reasons = [];
  for (const pack of packs || []) {
    const compiled = pack._compiled;
    if (compiled) {
      for (const { raw, re } of compiled.entryPatterns) {
        if (re.test(posixRel)) reasons.push(`framework pack ${pack._file}: matches ${raw}`);
      }
      for (const { raw, re } of compiled.keepFiles) {
        if (re.test(posixRel)) reasons.push(`framework pack ${pack._file}: matches ${raw}`);
      }
    } else {
      for (const pat of [...(pack.entryPatterns || []), ...(pack.keepFiles || [])]) {
        try { if (new RegExp(pat).test(posixRel)) reasons.push(`framework pack ${pack._file}: matches ${pat}`); } catch (_) {}
      }
    }
  }
  return reasons;
}

function frameworkKeepSymbol(rel, name, decorators, packs) {
  const reasons = [];
  for (const pack of packs || []) {
    const c = pack._compiled;
    if (name && (c ? c.keepExports.has(name) : (pack.keepExports || []).includes(name))) {
      reasons.push(`framework pack ${pack._file}: export "${name}" is framework-resolved`);
    }
    if (name && (c ? c.keepNames.has(name) : (pack.keepNames || []).includes(name))) {
      reasons.push(`framework pack ${pack._file}: name "${name}" is framework-resolved`);
    }
    // Substring match, as before: a decorator string contains the pack
    // entry (e.g. "@admin.register" contains "register").
    const keepDecs = c ? c.keepDecorators : (pack.keepDecorators || []);
    for (const d of decorators || []) {
      for (const kd of keepDecs) {
        if (d.includes(kd)) reasons.push(`framework pack ${pack._file}: decorator "${kd}"`);
      }
    }
  }
  return reasons;
}

function collectFrameworkClassAnnotations(packs, fallbackSet) {
  const out = new Set(fallbackSet || []);
  for (const pack of packs || []) {
    const list = pack._compiled ? pack._compiled.keepClassAnnotations : (pack.keepClassAnnotations || []);
    for (const ann of list) out.add(ann);
  }
  return out;
}

module.exports = {
  loadFrameworks,
  frameworkKeepFile,
  frameworkKeepSymbol,
  collectFrameworkClassAnnotations,
};
