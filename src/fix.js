'use strict';

/**
 * --fix: delete SAFE findings only (or SAFE + REVIEW when opts.includeReview
 * is explicitly true), one file at a time.
 *
 * Deletions use parse-time byte ranges, merged safely to prevent partial
 * overlap corruption, preserving the file's original line endings (LF/CRLF).
 * Dead files are unlinked. Dead imports remove either the whole statement
 * (when all bound specifiers are dead) or only the unused specifiers.
 */

const fs = require('fs');
const path = require('path');

const ID_CHAR = 'A-Za-z0-9_$';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Expand an AST node end offset to include an optional trailing semicolon and newline. */
function expandToLineEnd(src, end) {
  let e = end;
  if (src[e] === ';') e += 1;
  if (src[e] === '\r' && src[e + 1] === '\n') e += 2;
  else if (src[e] === '\n') e += 1;
  return e;
}

/**
 * Merge overlapping or nested byte ranges and clamp them to [0, maxLen].
 * Returns non-overlapping ranges sorted ascending by start offset.
 */
function mergeRanges(rawRanges, maxLen) {
  const valid = [];
  for (const [rawStart, rawEnd] of rawRanges) {
    const s = Math.max(0, Math.min(maxLen, rawStart));
    const e = Math.max(0, Math.min(maxLen, rawEnd));
    if (e > s) valid.push([s, e]);
  }
  if (!valid.length) return [];
  valid.sort((a, b) => (a[0] - b[0]) || (b[1] - a[1]));

  const merged = [valid[0]];
  for (let i = 1; i < valid.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = valid[i];
    if (curr[0] <= prev[1]) {
      prev[1] = Math.max(prev[1], curr[1]);
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

/**
 * Build a regex that matches an import specifier cleanly even when it starts
 * or ends with `$` (where plain `\b` fails).
 */
function specifierMatch(lineText, spec) {
  const esc = escapeRegExp(spec);
  const lb = `(?<![${ID_CHAR}])`;
  const la = `(?![${ID_CHAR}])`;
  return lineText.match(new RegExp(`${lb}${esc}${la}\\s*,\\s*`))
    || lineText.match(new RegExp(`,\\s*${lb}${esc}${la}`))
    || lineText.match(new RegExp(`${lb}${esc}${la}`));
}

function applyFix(root, graph, findings, opts) {
  const includeReview = Boolean(opts && opts.includeReview);
  const dryRun = Boolean(opts && opts.dryRun);
  const allowedGrades = includeReview ? new Set(['SAFE', 'REVIEW']) : new Set(['SAFE']);
  const candidates = findings.filter((f) => allowedGrades.has(f.grade));

  const byFile = new Map();
  for (const f of candidates) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  const changed = [];
  const deletedFiles = [];
  let appliedCount = 0;

  for (const [rel, items] of byFile) {
    const abs = path.resolve(root, rel);
    const fileFindings = items.filter((f) => f.category !== 'file' && f.category !== 'dependency');
    const fileFinding = items.find((f) => f.category === 'file');

    if (fileFinding) {
      if (dryRun) {
        deletedFiles.push(rel);
        appliedCount += 1;
      } else {
        try {
          fs.unlinkSync(abs);
          deletedFiles.push(rel);
          appliedCount += 1;
        } catch (e) {
          changed.push({ file: rel, removed: 0, error: e.message });
        }
      }
      continue;
    }

    if (!fs.existsSync(abs)) continue;
    const origSrc = fs.readFileSync(abs, 'utf8');
    let src = origSrc;
    const eol = src.includes('\r\n') ? '\r\n' : '\n';

    const lineStarts = [0];
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '\n') lineStarts.push(i + 1);
    }
    const srcLines = src.split('\n');

    const javadocStart = (defStartLine) => {
      const row = defStartLine - 2;
      if (row < 0 || !(srcLines[row] || '').replace(/\r$/, '').trim().endsWith('*/')) return null;
      if (/^\s*\/\*\*/.test(srcLines[row])) return lineStarts[row];
      let r = row;
      while (r >= 0) {
        const t = (srcLines[r] || '').replace(/\r$/, '').trim();
        if (t.startsWith('/**')) return lineStarts[r];
        if (t.startsWith('*') || t === '') { r -= 1; continue; }
        return null;
      }
      return null;
    };

    const commaRange = (start, end) => {
      let s = start;
      let e = end;
      let after = e;
      while (src[after] === ' ' || src[after] === '\t') after += 1;
      if (src[after] === ',') {
        e = after + 1;
        while (src[e] === ' ' || src[e] === '\t') e += 1;
      } else {
        let before = s - 1;
        while (src[before] === ' ' || src[before] === '\t') before -= 1;
        if (src[before] === ',') s = before;
      }
      return [s, e];
    };

    const info = graph.files.get(abs);
    if (!info || !info.parsed) continue;

    const ranges = [];
    let fileApplied = 0;

    // Group import findings by their statement range so we can detect when
    // every bound specifier in a multi-specifier import is being deleted.
    const importGroups = new Map();
    for (const f of fileFindings) {
      if (f.category !== 'import') continue;
      const imp = info.parsed.imports.find((i) => i.range.startLine === f.startLine
        && (i.names || []).some((n) => n.local === f.symbol));
      if (!imp) continue;
      const key = `${imp.range.startIndex}:${imp.range.endIndex}`;
      if (!importGroups.has(key)) {
        importGroups.set(key, {
          range: imp.range,
          records: info.parsed.imports.filter(
            (i) => i.range.startIndex === imp.range.startIndex && i.range.endIndex === imp.range.endIndex,
          ),
          findings: [],
        });
      }
      importGroups.get(key).findings.push({ finding: f, imp });
    }

    for (const group of importGroups.values()) {
      const allBoundLocals = new Set();
      for (const rec of group.records) {
        for (const n of rec.names || []) {
          if (n.local) allBoundLocals.add(n.local);
        }
      }
      const slatedLocals = new Set(group.findings.map((x) => x.finding.symbol));
      const deleteWholeStatement = allBoundLocals.size > 0
        && [...allBoundLocals].every((name) => slatedLocals.has(name));

      if (deleteWholeStatement) {
        // A require() record covers only its declarator
        // (`unused = require('./dead')`), not the `const` keyword, so
        // deleting from the record start would leave a bare `const `
        // behind. Expand to the statement start when this declarator
        // is alone on its line; when declarators share the line,
        // remove only this one (with a neighbouring comma).
        const lineStart = src.lastIndexOf('\n', group.range.startIndex - 1) + 1;
        const prefix = src.slice(lineStart, group.range.startIndex);
        const nlAfter = src.indexOf('\n', group.range.endIndex);
        const suffix = src.slice(group.range.endIndex, nlAfter === -1 ? src.length : nlAfter);
        const soleDecl = /^\s*(const|let|var)\s+$/.test(prefix);
        if (soleDecl && /^\s*;?\s*(?:\/\/.*)?$/.test(suffix)) {
          ranges.push([lineStart, expandToLineEnd(src, group.range.endIndex)]);
        } else if (/^\s*(const|let|var)\s/.test(prefix) || suffix.trimStart().startsWith(',')) {
          ranges.push(commaRange(group.range.startIndex, group.range.endIndex));
        } else {
          ranges.push([group.range.startIndex, expandToLineEnd(src, group.range.endIndex)]);
        }
        fileApplied += group.findings.length;
        continue;
      }

      const lineText = src.slice(group.range.startIndex, group.range.endIndex);
      for (const { finding: f, imp } of group.findings) {
        const entry = (imp.names || []).find((n) => n.local === f.symbol);
        let spec = entry ? entry.imported : f.symbol;
        if (entry && entry.local !== entry.imported) {
          const aliasForm = `${entry.imported} as ${entry.local}`;
          spec = lineText.includes(aliasForm)
            ? aliasForm
            : (entry.kind === 'default' ? entry.local : entry.imported);
        }
        const m = specifierMatch(lineText, spec);
        if (m) {
          ranges.push([group.range.startIndex + m.index, group.range.startIndex + m.index + m[0].length]);
          fileApplied += 1;
        }
      }
    }

    // Non-import findings: unreachable code and unused definitions.
    for (const f of fileFindings) {
      if (f.category === 'import') continue;
      if (f.category === 'unreachable') {
        const u = info.parsed.unreachable.find((x) => x.line === f.startLine);
        if (u) {
          ranges.push([u.range.startIndex, expandToLineEnd(src, u.range.endIndex)]);
          fileApplied += 1;
        }
        continue;
      }

      const def = info.parsed.definitions.find((d) => d.name === f.symbol && d.startLine === f.startLine);
      if (!def) continue;

      if (def.isParameter || def.multiDeclarator) {
        if (def.multiDeclarator && def.statementRange) {
          const siblings = info.parsed.definitions.filter((d) => d.statementRange
            && d.statementRange.startIndex === def.statementRange.startIndex
            && d.statementRange.endIndex === def.statementRange.endIndex);
          const slated = new Set(fileFindings.map((x) => `${x.symbol}:${x.startLine}`));
          if (siblings.length > 1 && siblings.every((s) => slated.has(`${s.name}:${s.startLine}`))) {
            ranges.push([def.statementRange.startIndex, expandToLineEnd(src, def.statementRange.endIndex)]);
          } else {
            ranges.push(commaRange(def.range.startIndex, def.range.endIndex));
          }
        } else {
          ranges.push(commaRange(def.range.startIndex, def.range.endIndex));
        }
        fileApplied += 1;
      } else {
        let start = def.range.startIndex;
        const end = expandToLineEnd(src, def.range.endIndex);
        if (info.language === 'java' && (def.kind === 'method' || (def.kind === 'variable' && !def.local))) {
          const js = javadocStart(def.startLine);
          if (js !== null) start = js;
        }
        ranges.push([start, end]);
        fileApplied += 1;
      }
    }

    const merged = mergeRanges(ranges, src.length);
    if (!merged.length) continue;

    // Apply edits from end of file to start so earlier offsets remain exact.
    for (let i = merged.length - 1; i >= 0; i--) {
      const [s, e] = merged[i];
      src = src.slice(0, s) + src.slice(e);
    }

    // Clean up empty named brace left behind in mixed JS imports (`import def, { } from 'x'`).
    src = src.replace(/(import\s+[A-Za-z_$][\w$]*)\s*,\s*\{\s*\}\s*(from\s+['"])/g, '$1 $2');
    // Collapse 3+ consecutive newlines while preserving original EOL style.
    src = src.replace(/(\r?\n){3,}/g, eol + eol);

    if (src !== origSrc) {
      if (!dryRun) fs.writeFileSync(abs, src, 'utf8');
      changed.push({ file: rel, removed: fileApplied });
      appliedCount += fileApplied;
    }
  }

  return {
    changed,
    deletedFiles,
    safeCount: candidates.length,
    appliedCount,
  };
}

/**
 * Iteratively apply SAFE deletions and re-scan until convergence (or maxPasses)
 * so helpers / imports orphaned by earlier deletions are cleaned up too.
 */
function applyFixCascade(root, scanFn, opts) {
  const options = opts || {};
  const maxPasses = Math.max(1, options.maxPasses || 5);
  const passes = [];
  const allDeletedFiles = [];
  const changedByFile = new Map();
  let totalRemoved = 0;

  for (let pass = 1; pass <= maxPasses; pass++) {
    const { graph, findings } = scanFn();
    const candidates = options.includeReview
      ? findings.filter((f) => f.grade === 'SAFE' || f.grade === 'REVIEW')
      : findings.filter((f) => f.grade === 'SAFE');

    if (!candidates.length) break;

    const res = applyFix(root, graph, candidates, {
      includeReview: Boolean(options.includeReview),
    });

    const madeProgress = res.appliedCount > 0 || res.deletedFiles.length > 0;
    passes.push({
      pass,
      removed: res.appliedCount,
      deletedFiles: res.deletedFiles.length,
      changedFiles: res.changed.length,
    });

    totalRemoved += res.appliedCount;
    for (const df of res.deletedFiles) allDeletedFiles.push(df);
    for (const c of res.changed) {
      const prev = changedByFile.get(c.file) || { file: c.file, removed: 0 };
      prev.removed += c.removed || 0;
      if (c.error) prev.error = c.error;
      changedByFile.set(c.file, prev);
    }

    if (!madeProgress) break;
  }

  return {
    passes,
    changed: [...changedByFile.values()],
    deletedFiles: allDeletedFiles,
    safeCount: totalRemoved,
    appliedCount: totalRemoved,
  };
}

module.exports = { applyFix, applyFixCascade, mergeRanges };
