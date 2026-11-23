'use strict';

/**
 * Inline ignore directives across JS/TS, Python, and Java.
 *
 * Supported forms:
 *   // deadcode-map-ignore-file [reason]
 *   /* deadcode-map-ignore-file [reason] *\/
 *   # deadcode-map: ignore-file [reason]
 *
 *   // deadcode-map-ignore-next [reason]
 *   /* deadcode-map-ignore-next [reason] *\/
 *   # deadcode-map: ignore-next [reason]
 *
 *   // deadcode-map-ignore [reason]          (same line or directly above)
 *   # deadcode-map: ignore [reason]          (same line or directly above)
 */

const path = require('path');

const FILE_IGNORE_RE = /(?:\/\/|\/\*|#)\s*deadcode-map(?::\s*|\s*-)ignore-file\b([^\n*]*)/i;
const NEXT_IGNORE_RE = /(?:\/\/|\/\*|#)\s*deadcode-map(?::\s*|\s*-)ignore-next\b([^\n*]*)/i;
const LINE_IGNORE_RE = /(?:\/\/|\/\*|#)\s*deadcode-map(?::\s*|\s*-)ignore\b(?!-file|-next)([^\n*]*)/i;

function cleanReason(raw) {
  const txt = String(raw || '').replace(/\*\/.*$/, '').replace(/^[\s:-]+/, '').trim();
  return txt || null;
}

/**
 * Check if a line is blank, a comment, or a decorator/annotation sitting
 * between an ignore-next comment and the target declaration.
 */
function isTransparentLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*') || t.endsWith('*/')) return true;
  if (t.startsWith('@')) return true; // Python decorator or Java/TS annotation
  return false;
}

/**
 * Parse inline ignore directives for a single file's source text.
 * Returns { ignoreFile: string|null, ignoredLines: Map<1-based line, string> }.
 */
function parseInlineIgnores(src) {
  const lines = String(src || '').split(/\r?\n/);
  const ignoredLines = new Map();
  let ignoreFile = null;

  // File-level directives are honored in the top header (first 30 lines).
  const headerLimit = Math.min(lines.length, 30);
  for (let i = 0; i < headerLimit; i++) {
    const fm = lines[i].match(FILE_IGNORE_RE);
    if (fm) {
      ignoreFile = cleanReason(fm[1]) || 'inline deadcode-map-ignore-file directive';
      break;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    const nm = line.match(NEXT_IGNORE_RE);
    if (nm) {
      const reason = cleanReason(nm[1]) || 'inline deadcode-map-ignore-next directive';
      // Attach to the next substantive code line (skipping blank lines and decorators).
      let target = i + 1;
      while (target < lines.length && isTransparentLine(lines[target])) target += 1;
      if (target < lines.length) ignoredLines.set(target + 1, reason);
      // Also record the immediate next line in case the parser anchored on a decorator.
      if (i + 2 <= lines.length) ignoredLines.set(i + 2, reason);
      continue;
    }

    const lm = line.match(LINE_IGNORE_RE);
    if (lm) {
      const reason = cleanReason(lm[1]) || 'inline deadcode-map-ignore directive';
      // Determine whether the directive is trailing on a code line or standalone above a declaration.
      const before = line.slice(0, lm.index).trim();
      if (before.length > 0) {
        ignoredLines.set(lineNo, reason);
      } else {
        let target = i + 1;
        while (target < lines.length && isTransparentLine(lines[target])) target += 1;
        if (target < lines.length) ignoredLines.set(target + 1, reason);
        if (i + 2 <= lines.length) ignoredLines.set(i + 2, reason);
      }
    }
  }

  return { ignoreFile, ignoredLines };
}

/**
 * Downgrade findings covered by inline ignore comments to KEEP.
 * Mutates nothing in place; returns a new findings array.
 */
function applyInlineIgnores(root, graph, findings) {
  const cache = new Map(); // abs -> parsed ignores

  const getIgnores = (rel) => {
    const abs = path.resolve(root, rel);
    if (cache.has(abs)) return cache.get(abs);
    const info = graph.files.get(abs);
    const parsed = info && typeof info.src === 'string'
      ? parseInlineIgnores(info.src)
      : { ignoreFile: null, ignoredLines: new Map() };
    cache.set(abs, parsed);
    return parsed;
  };

  return findings.map((f) => {
    if (f.grade === 'KEEP' || !f.file) return f;
    const ig = getIgnores(f.file);
    if (ig.ignoreFile) {
      return {
        ...f,
        grade: 'KEEP',
        reason: `suppressed (${ig.ignoreFile})`,
      };
    }
    const line = f.startLine || 1;
    if (ig.ignoredLines.has(line)) {
      return {
        ...f,
        grade: 'KEEP',
        reason: `suppressed (${ig.ignoredLines.get(line)})`,
      };
    }
    return f;
  });
}

module.exports = { parseInlineIgnores, applyInlineIgnores };
