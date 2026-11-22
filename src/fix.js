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
        // Include a trailing newline / semicolon when present.
        let end = def.range.endIndex;
        if (src[end] === ';') end += 1;
        if (src[end] === '\n') end += 1;
        ranges.push([def.range.startIndex, end]);
      }
    }
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
