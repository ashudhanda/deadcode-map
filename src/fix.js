'use strict';

/**
 * --fix: delete SAFE findings only, git-backed.
 *
 * One cluster = one file. Deletions are applied per file, largest first,
 * using the byte ranges recorded at parse time. Dead files are deleted.
 * Dead imports have the specifier removed (or the whole line when empty).
 * Returns a report of what changed; the caller decides whether to commit.
 * Never touches REVIEW / KEEP.
 */

const fs = require('fs');
const path = require('path');

function applyFix(root, graph, findings) {
  const safe = findings.filter((f) => f.grade === 'SAFE');
  const byFile = new Map();
  for (const f of safe) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  const changed = [];
  const deletedFiles = [];

  for (const [rel, items] of byFile) {
    const abs = path.resolve(root, rel);
    const fileFindings = items.filter((f) => f.category !== 'file' && f.category !== 'dependency');
    const fileFinding = items.find((f) => f.category === 'file');
    if (fileFinding) {
      try { fs.unlinkSync(abs); deletedFiles.push(rel); } catch (e) { changed.push({ file: rel, error: e.message }); }
      continue;
    }
    if (!fs.existsSync(abs)) continue;
    let src = fs.readFileSync(abs, 'utf8');
    // Line starts for the Javadoc scan below (Java only).
    const lineStarts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
    // The start offset of a Javadoc `/** ... */` block directly above
    // a definition (1-based defStartLine), or null. Only Javadoc is
    // removed: a plain `/* ... */` comment could be a license header
    // or commented-out code, so it stays. Annotations are part of the
    // definition's range, so nothing sits between the comment and the
    // modifiers — the block must end on the line directly above.
    const srcLines = src.split('\n');
    const javadocStart = (defStartLine) => {
      let row = defStartLine - 2; // 0-based line directly above
      if (row < 0 || !(srcLines[row] || '').trim().endsWith('*/')) return null;
      if (/^\s*\/\*\*/.test(srcLines[row])) return lineStarts[row];
      let r = row;
      while (r >= 0) {
        const t = (srcLines[r] || '').trim();
        if (t.startsWith('/**')) return lineStarts[r];
        if (t.startsWith('*') || t === '') { r -= 1; continue; }
        return null;
      }
      return null;
    };
    // Remove one item of a comma-separated list (a parameter, or one
    // declarator of a multi-declarator statement), taking a
    // neighbouring comma with it so the list stays valid — trailing
    // comma first (`int a, int b` deleting a -> `int b`), else the
    // preceding comma (deleting b -> `int a`). A lone item has no comma.
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
    // Collect byte ranges to remove, largest start first so offsets stay valid.
    const ranges = [];
    for (const f of fileFindings) {
      const info = graph.files.get(abs);
      if (!info || !info.parsed) continue;
      if (f.category === 'import') {
        // Find the import record that actually binds this symbol: one
        // Python statement can hold several imports on the same line
        // (`import os.path, json` is two records with one shared range),
        // so matching by line alone can pick the wrong record.
        const imp = info.parsed.imports.find((i) => i.range.startLine === f.startLine
          && (i.names || []).some((n) => n.local === f.symbol));
        if (imp) {
          const lineText = src.slice(imp.range.startIndex, imp.range.endIndex);
          const entry = (imp.names || []).find((n) => n.local === f.symbol);
          // The specifier as written: "os.path" for a dotted import
          // (its local name is only the top-level package, not the text
          // to delete), "y as z" for an explicit alias, and the local
          // name itself for a JS default import (`import def from 'x'`,
          // where `imported` is the placeholder "default").
          let spec = entry ? entry.imported : f.symbol;
          if (entry && entry.local !== entry.imported) {
            const aliasForm = `${entry.imported} as ${entry.local}`;
            spec = lineText.includes(aliasForm)
              ? aliasForm
              : (entry.kind === 'default' ? entry.local : entry.imported);
          }
          const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const sameLine = info.parsed.imports.filter((i) => i.range.startLine === f.startLine);
          if (sameLine.length === 1 && (imp.names || []).length === 1) {
            ranges.push([imp.range.startIndex, imp.range.endIndex + 1]);
          } else {
            // Remove just this specifier, taking a neighbouring comma
            // with it so the line stays valid: trailing comma first,
            // else the preceding comma (last specifier), else bare.
            const m = lineText.match(new RegExp(`\\b${esc}\\b\\s*,\\s*`))
              || lineText.match(new RegExp(`,\\s*\\b${esc}\\b`))
              || lineText.match(new RegExp(`\\b${esc}\\b`));
            if (m) ranges.push([imp.range.startIndex + m.index, imp.range.startIndex + m.index + m[0].length]);
          }
        }
        continue;
      }
      if (f.category === 'unreachable') {
        const info2 = info.parsed.unreachable.find((u) => u.line === f.startLine);
        if (info2) ranges.push([info2.range.startIndex, info2.range.endIndex]);
        continue;
      }
      // function / class / type: remove the definition node range.
      const def = info.parsed.definitions.find((d) => d.name === f.symbol && d.startLine === f.startLine);
      if (def) {
        if (def.isParameter || def.multiDeclarator) {
          // A parameter or one declarator of a multi-declarator list.
          // When EVERY declarator of the statement is being removed,
          // delete the whole statement instead: removing the items one
          // by one would leave a bare type (`private int ;`), because
          // the shared comma belongs to both ranges at once.
          if (def.multiDeclarator && def.statementRange) {
            const siblings = info.parsed.definitions.filter((d) => d.statementRange
              && d.statementRange.startIndex === def.statementRange.startIndex
              && d.statementRange.endIndex === def.statementRange.endIndex);
            const slated = new Set(fileFindings.map((x) => `${x.symbol}:${x.startLine}`));
            if (siblings.length > 1 && siblings.every((s) => slated.has(`${s.name}:${s.startLine}`))) {
              let end = def.statementRange.endIndex;
              if (src[end] === ';') end += 1;
              if (src[end] === '\n') end += 1;
              ranges.push([def.statementRange.startIndex, end]);
            } else {
              ranges.push(commaRange(def.range.startIndex, def.range.endIndex));
            }
          } else {
            ranges.push(commaRange(def.range.startIndex, def.range.endIndex));
          }
        } else {
          // Include a trailing newline / semicolon when present.
          let start = def.range.startIndex;
          let end = def.range.endIndex;
          // A Javadoc comment above a deleted Java method or field is
          // orphaned without it: remove the `/** ... */` block too.
          if (info.language === 'java' && (def.kind === 'method' || (def.kind === 'variable' && !def.local))) {
            const js = javadocStart(def.startLine);
            if (js !== null) start = js;
          }
          if (src[end] === ';') end += 1;
          if (src[end] === '\n') end += 1;
          ranges.push([start, end]);
        }
      }
    }
    // A range fully inside another range (an unused local inside a dead
    // method, an unreachable statement inside a dead function) must be
    // dropped: applying both would slice by stale offsets and corrupt
    // the file. The outer deletion removes the inner code with it.
    ranges.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
    const keptRanges = [];
    for (const r of ranges) {
      if (!keptRanges.some(([s, e]) => s <= r[0] && r[1] <= e)) keptRanges.push(r);
    }
    ranges.length = 0;
    ranges.push(...keptRanges);
    ranges.sort((a, b) => b[0] - a[0]);
    for (const [s, e] of ranges) src = src.slice(0, s) + src.slice(e);
    // Clean up empty lines left behind (max two consecutive newlines).
    src = src.replace(/\n{3,}/g, '\n\n');
    fs.writeFileSync(abs, src, 'utf8');
    changed.push({ file: rel, removed: items.length });
  }

  return { changed, deletedFiles, safeCount: safe.length };
}

module.exports = { applyFix };
