'use strict';

/** Terminal + JSON output. */

const COLORS = {
  SAFE: '\x1b[31m', REVIEW: '\x1b[33m', KEEP: '\x1b[90m', reset: '\x1b[0m',
  bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m',
};

function colorize(s, color, useColor) {
  return useColor ? `${COLORS[color] || ''}${s}${COLORS.reset}` : s;
}

function summarize(findings) {
  const byGrade = { SAFE: 0, REVIEW: 0, KEEP: 0 };
  const byCategory = {};
  let bytes = 0;
  for (const f of findings) {
    byGrade[f.grade] = (byGrade[f.grade] || 0) + 1;
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    if (f.grade === 'SAFE') bytes += f.size || 0;
  }
  return { byGrade, byCategory, safeBytes: bytes, total: findings.length };
}

function printTerminal(findings, opts) {
  const useColor = opts.color !== false && process.stdout.isTTY;
  const visible = findings.filter((f) => f.grade !== 'KEEP' || opts.showKeep);
  const s = summarize(findings);
  console.log('');
  console.log(`${colorize('deadcode-map', 'bold', useColor)}  ${opts.root}`);
  console.log(`  ${s.total} findings — ${colorize(`${s.byGrade.SAFE || 0} SAFE`, 'SAFE', useColor)} · ${colorize(`${s.byGrade.REVIEW || 0} REVIEW`, 'REVIEW', useColor)} · ${s.byGrade.KEEP || 0} KEEP (hidden)`);
  console.log(`  SAFE dead code: ~${s.safeBytes} bytes across ${s.byGrade.SAFE || 0} findings`);
  if (Object.keys(s.byCategory).length) {
    console.log(`  by category: ${Object.entries(s.byCategory).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  console.log('');
  const top = [...visible]
    .filter((f) => f.grade !== 'KEEP')
    .sort((a, b) => (b.size || 0) - (a.size || 0))
    .slice(0, opts.top || 10);
  for (const f of top) {
    const label = f.symbol ? `${f.file}:${f.startLine} ${f.symbol}` : `${f.file} (${f.category})`;
    console.log(`  ${colorize(f.grade.padEnd(6), f.grade, useColor)} ${label}`);
    console.log(`         ${f.reason}`);
    if (f.evidence && f.evidence.gitAgeDays != null) {
      console.log(`         evidence: last touched ${f.evidence.gitAgeDays}d ago${f.evidence.coveragePct != null ? `, coverage ${f.evidence.coveragePct}%` : ''}`);
    }
  }
  if (visible.filter((f) => f.grade !== 'KEEP').length > top.length) {
    console.log(`  ... and ${visible.filter((f) => f.grade !== 'KEEP').length - top.length} more (use --json for the full list)`);
  }
  console.log('');
  console.log(`  Map: run with --map deadcode-map.html to see the visual map.`);
  console.log(`  Prove it: run with --prove to delete SAFE items in a scratch worktree and run the tests.`);
  console.log('');
}

function toJsonReport(root, findings, summary, meta) {
  return {
    tool: 'deadcode-map',
    version: require('../package.json').version,
    root,
    generatedAt: new Date().toISOString(),
    summary,
    findings,
    meta: meta || {},
  };
}

module.exports = { printTerminal, summarize, toJsonReport };
