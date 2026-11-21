'use strict';

/**
 * Single-file offline HTML map.
 * No CDN, no server, no external assets: open by double-clicking.
 * Nodes = files (circles) + dead symbols (small squares inside their file).
 * Edges = imports. Dead = red, REVIEW = amber, live = grey/green.
 * Click a node for evidence + the delete diff. Search + confidence filter.
 */

const fs = require('fs');

function buildMapData(root, graph, findings) {
  const nodes = [];
  const edges = [];
  const fileIndex = new Map();
  let id = 0;
  for (const [file, info] of graph.files) {
    const fileFindings = findings.filter((f) => f.file === info.rel);
    const worst = fileFindings.some((f) => f.grade === 'SAFE') ? 'SAFE'
      : fileFindings.some((f) => f.grade === 'REVIEW') ? 'REVIEW' : 'LIVE';
    const node = {
      id: id++, kind: 'file', label: info.rel, file: info.rel,
      language: info.language, grade: worst,
      size: info.size, findings: fileFindings,
    };
    fileIndex.set(file, node.id);
    nodes.push(node);
  }
  for (const [from, edgesList] of graph.importsByFile) {
    for (const e of edgesList) {
      if (fileIndex.has(from) && fileIndex.has(e.target)) {
        edges.push({ from: fileIndex.get(from), to: fileIndex.get(e.target) });
      }
    }
  }
  // Dead symbols as child nodes, linked to their file.
  for (const f of findings) {
    if (!f.symbol || f.grade === 'KEEP') continue;
    const fileNode = nodes.find((n) => n.file === f.file);
    if (!fileNode) continue;
    nodes.push({
      id: id++, kind: 'symbol', label: f.symbol, file: f.file,
      language: fileNode.language, grade: f.grade, category: f.category,
      reason: f.reason, evidence: f.evidence, deleteDiff: f.deleteDiff || '',
      startLine: f.startLine, size: f.size, parent: fileNode.id,
    });
  }
  return { nodes, edges, root, generatedAt: new Date().toISOString() };
}

function renderHtml(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>deadcode-map — ${escapeHtml(data.root)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0f1115; color: #e6e6e6; }
  header { padding: 12px 16px; background: #171a21; border-bottom: 1px solid #2a2e39; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 18px; margin: 0; }
  header h1 span { color: #ff5c5c; }
  .legend { font-size: 13px; color: #aaa; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin: 0 4px 0 12px; }
  #controls { padding: 8px 16px; background: #14161c; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  #controls input, #controls select { background: #22262f; color: #eee; border: 1px solid #333; border-radius: 6px; padding: 6px 8px; }
  #wrap { display: flex; height: calc(100vh - 110px); }
  #canvas { flex: 1; cursor: grab; }
  #panel { width: 360px; background: #171a21; border-left: 1px solid #2a2e39; padding: 16px; overflow-y: auto; }
  #panel h2 { font-size: 15px; margin-top: 0; word-break: break-all; }
  #panel pre { background: #0d0f13; padding: 10px; border-radius: 6px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 700; }
  .SAFE { background: #ff5c5c; color: #fff; }
  .REVIEW { background: #f5a623; color: #111; }
  .LIVE { background: #3aa655; color: #fff; }
  .ev { font-size: 13px; line-height: 1.6; color: #ccc; }
  .muted { color: #888; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>deadcode<span>-map</span></h1>
  <div class="legend">
    <span class="dot" style="background:#ff5c5c"></span>SAFE — provably dead
    <span class="dot" style="background:#f5a623"></span>REVIEW — human eye needed
    <span class="dot" style="background:#3aa655"></span>Live
    <span class="dot" style="background:#888"></span>File
  </div>
</header>
<div id="controls">
  <input id="search" type="text" placeholder="Search files / symbols…" size="32">
  <select id="filter"><option value="all">All confidence</option><option value="SAFE">SAFE only</option><option value="REVIEW">REVIEW only</option><option value="LIVE">Live only</option></select>
  <span class="muted" id="counts"></span>
  <span class="muted">Drag to pan · scroll to zoom · click a node for evidence</span>
</div>
<div id="wrap">
  <canvas id="canvas"></canvas>
  <aside id="panel"><h2>Click a node</h2><p class="ev">Red nodes are SAFE dead code: no importers, no callers, no string mentions. Click one to see why it was flagged, who does not call it, its git age, coverage, and the exact delete diff.</p></aside>
</div>
<script>
const DATA = ${json};
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const panel = document.getElementById('panel');
let W, H, scale = 1, ox = 0, oy = 0;
function resize() { W = canvas.clientWidth; H = canvas.clientHeight; canvas.width = W * devicePixelRatio; canvas.height = H * devicePixelRatio; ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); }
addEventListener('resize', resize); resize();
const COLOR = { SAFE: '#ff5c5c', REVIEW: '#f5a623', LIVE: '#3aa655' };
const nodes = DATA.nodes.map((n, i) => ({ ...n, x: Math.random() * 800, y: Math.random() * 500, vx: 0, vy: 0, r: n.kind === 'file' ? 14 : 7 }));
const byId = new Map(nodes.map(n => [n.id, n]));
const edges = DATA.edges.map(e => ({ a: byId.get(e.from), b: byId.get(e.to) })).filter(e => e.a && e.b);
let selected = null, drag = null, panning = false, px = 0, py = 0;
function step() {
  for (const n of nodes) { n.vx += (400 - n.x) * 0.0002; n.vy += (250 - n.y) * 0.0002; }
  for (const e of edges) {
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy) || 1;
    const f = (d - 90) * 0.002;
    e.a.vx += dx / d * f; e.a.vy += dy / d * f; e.b.vx -= dx / d * f; e.b.vy -= dy / d * f;
  }
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j], dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy || 1;
    if (d2 < 9000) { const f = 30 / d2; a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f; }
  }
  for (const n of nodes) { n.x += n.vx; n.y += n.vy; n.vx *= 0.85; n.vy *= 0.85; }
}
function visible(n) {
  const q = document.getElementById('search').value.toLowerCase();
  const f = document.getElementById('filter').value;
  if (q && !n.label.toLowerCase().includes(q)) return false;
  if (f !== 'all' && n.grade !== f) return false;
  return true;
}
function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.save(); ctx.translate(ox, oy); ctx.scale(scale, scale);
  ctx.strokeStyle = '#2a2e39'; ctx.lineWidth = 1;
  for (const e of edges) { if (!visible(e.a) || !visible(e.b)) continue; ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke(); }
  for (const n of nodes) {
    if (!visible(n)) continue;
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = n.kind === 'file' ? '#888' : (COLOR[n.grade] || '#888');
    if (n.kind === 'file' && n.grade !== 'LIVE') ctx.fillStyle = COLOR[n.grade];
    ctx.fill();
    if (selected === n) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
    if (n.kind === 'file' || scale > 0.8) { ctx.fillStyle = '#ccc'; ctx.font = '11px system-ui'; ctx.fillText(n.label.length > 34 ? n.label.slice(0, 34) + '…' : n.label, n.x + n.r + 4, n.y + 4); }
  }
  ctx.restore();
}
function loop() { step(); draw(); requestAnimationFrame(loop); }
loop();
function show(n) {
  selected = n;
  const ev = n.evidence || {};
  const rows = [];
  if (n.kind === 'file') {
    rows.push('<h2>' + esc(n.label) + '</h2><span class="badge ' + n.grade + '">' + n.grade + '</span>');
    rows.push('<p class="ev">' + (n.findings || []).length + ' findings in this file · ' + n.size + ' bytes · ' + n.language + '</p>');
    for (const f of (n.findings || [])) rows.push('<p class="ev"><span class="badge ' + f.grade + '">' + f.grade + '</span> <b>' + esc(f.symbol || f.category) + '</b> — ' + esc(f.reason) + '</p>');
  } else {
    rows.push('<h2>' + esc(n.label) + '</h2><span class="badge ' + n.grade + '">' + n.grade + ' · ' + esc(n.category || '') + '</span>');
    rows.push('<p class="ev">' + esc(n.reason || '') + '</p>');
    rows.push('<p class="ev">File: ' + esc(n.file) + (n.startLine ? ' line ' + n.startLine : '') + '</p>');
    rows.push('<p class="ev">Importers: ' + (ev.importers ?? '?') + ' · Callers: ' + (ev.callers ?? '?') + '<br>String refs: ' + ((ev.stringRefs || []).join(', ') || 'none') + '<br>Last touched: ' + (ev.gitAgeDays != null ? ev.gitAgeDays + ' days ago (' + ev.gitLastCommit + ')' : 'no git data') + '<br>Coverage: ' + (ev.coveragePct != null ? ev.coveragePct + '%' : 'no coverage data') + '</p>');
    if (n.deleteDiff) rows.push('<h3>Delete diff</h3><pre>' + esc(n.deleteDiff) + '</pre>');
  }
  panel.innerHTML = rows.join('');
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
canvas.addEventListener('mousedown', e => { px = e.clientX; py = e.clientY; panning = true; });
addEventListener('mouseup', () => { panning = false; });
addEventListener('mousemove', e => { if (panning) { ox += e.clientX - px; oy += e.clientY - py; px = e.clientX; py = e.clientY; } });
canvas.addEventListener('wheel', e => { e.preventDefault(); scale = Math.max(0.3, Math.min(3, scale * (e.deltaY < 0 ? 1.1 : 0.9))); }, { passive: false });
canvas.addEventListener('click', e => {
  if (Math.abs(e.movementX) > 2) return;
  const r = canvas.getBoundingClientRect();
  const mx = (e.clientX - r.left - ox) / scale, my = (e.clientY - r.top - oy) / scale;
  let best = null, bd = 1e9;
  for (const n of nodes) { if (!visible(n)) continue; const d = Math.hypot(n.x - mx, n.y - my); if (d < n.r + 6 && d < bd) { bd = d; best = n; } }
  if (best) show(best);
});
document.getElementById('search').addEventListener('input', () => {});
document.getElementById('filter').addEventListener('change', () => {});
const safe = DATA.nodes.filter(n => n.grade === 'SAFE').length;
const review = DATA.nodes.filter(n => n.grade === 'REVIEW').length;
document.getElementById('counts').textContent = DATA.nodes.length + ' nodes · ' + DATA.edges.length + ' import edges · ' + safe + ' SAFE · ' + review + ' REVIEW';
</script>
</body>
</html>
`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function writeMap(root, graph, findings, outPath) {
  const data = buildMapData(root, graph, findings);
  const html = renderHtml(data);
  fs.writeFileSync(outPath, html, 'utf8');
  return outPath;
}

module.exports = { writeMap, buildMapData };
