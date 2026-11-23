'use strict';

/**
 * Single-file offline HTML map (v2).
 * No CDN, no server, no external assets: open by double-clicking.
 *
 * Improvements over v1:
 * - O(Files + Findings) graph construction with typed edges (import + contains).
 * - Barnes-Hut quadtree O(N log N) repulsion with alpha cooling (0% idle CPU).
 * - Crisp HiDPI rendering, node dragging, zoom-to-fit, keyboard shortcuts,
 *   directional import edges, and copyable delete diffs.
 */

const fs = require('fs');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[c]));
}

function buildMapData(root, graph, findings) {
  const nodes = [];
  const edges = [];
  const fileIndex = new Map(); // abs -> node id
  const fileNodeByRel = new Map(); // rel -> file node
  const findingsByFile = new Map(); // rel -> finding[]

  for (const f of findings) {
    if (!findingsByFile.has(f.file)) findingsByFile.set(f.file, []);
    findingsByFile.get(f.file).push(f);
  }

  let id = 0;
  for (const [file, info] of graph.files) {
    const fileFindings = findingsByFile.get(info.rel) || [];
    const safeCount = fileFindings.filter((f) => f.grade === 'SAFE').length;
    const reviewCount = fileFindings.filter((f) => f.grade === 'REVIEW').length;
    const worst = safeCount > 0 ? 'SAFE' : reviewCount > 0 ? 'REVIEW' : 'LIVE';
    const node = {
      id: id++,
      kind: 'file',
      label: info.rel,
      file: info.rel,
      language: info.language,
      grade: worst,
      size: info.size,
      safeCount,
      reviewCount,
      findings: fileFindings,
    };
    fileIndex.set(file, node.id);
    fileNodeByRel.set(info.rel, node);
    nodes.push(node);
  }

  // Directed import edges between files (deduplicated).
  const seenImports = new Set();
  for (const [from, edgesList] of graph.importsByFile) {
    const fromId = fileIndex.get(from);
    if (fromId === undefined) continue;
    for (const e of edgesList) {
      const toId = fileIndex.get(e.target);
      if (toId === undefined || fromId === toId) continue;
      const key = `${fromId}->${toId}`;
      if (seenImports.has(key)) continue;
      seenImports.add(key);
      edges.push({ from: fromId, to: toId, kind: 'import', dynamic: Boolean(e.dynamic) });
    }
  }

  // Dead/review symbols as child nodes tethered to their parent file.
  for (const f of findings) {
    if (!f.symbol || f.grade === 'KEEP') continue;
    const fileNode = fileNodeByRel.get(f.file);
    if (!fileNode) continue;
    const symId = id++;
    nodes.push({
      id: symId,
      kind: 'symbol',
      label: f.symbol,
      file: f.file,
      language: fileNode.language,
      grade: f.grade,
      category: f.category,
      reason: f.reason,
      evidence: f.evidence,
      deleteDiff: f.deleteDiff || '',
      startLine: f.startLine,
      size: f.size,
      parent: fileNode.id,
    });
    edges.push({ from: fileNode.id, to: symId, kind: 'contains' });
  }

  return {
    nodes,
    edges,
    root,
    generatedAt: new Date().toISOString(),
  };
}

function renderHtml(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>deadcode-map — ${escapeHtml(data.root)}</title>
<style>
  :root {
    --bg: #09090b;
    --surface: #111113;
    --surface-2: #18181b;
    --border: #27272a;
    --border-strong: #3f3f46;
    --text: #fafafa;
    --muted: #a1a1aa;
    --dim: #71717a;
    --silver: #e4e4e7;
    --safe: #ef4444;
    --review: #f59e0b;
    --live: #22c55e;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif; overflow: hidden; }
  header {
    height: 48px; padding: 0 16px; background: var(--surface); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
  }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
  .brand .mark { width: 8px; height: 8px; border-radius: 50%; background: var(--safe); box-shadow: 0 0 0 3px rgba(239,68,68,0.18); }
  .brand .path { color: var(--dim); font-weight: 400; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; max-width: 38vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .legend { display: flex; align-items: center; gap: 14px; font-size: 12px; color: var(--muted); }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  #toolbar {
    height: 44px; padding: 0 16px; background: var(--bg); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 10px;
  }
  #toolbar input, #toolbar select, #toolbar button {
    height: 28px; background: var(--surface); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 0 10px; font-size: 12px; font-family: inherit;
  }
  #toolbar input { width: 240px; }
  #toolbar input:focus, #toolbar select:focus { outline: none; border-color: var(--silver); }
  #toolbar button { cursor: pointer; color: var(--silver); transition: border-color 120ms, background 120ms; }
  #toolbar button:hover { background: var(--surface-2); border-color: var(--border-strong); }
  #toolbar button.active { background: var(--silver); color: var(--bg); border-color: var(--silver); font-weight: 600; }
  .spacer { flex: 1; }
  .meta-counts { font-size: 12px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  #workspace { display: flex; height: calc(100vh - 92px); position: relative; }
  #stage { flex: 1; position: relative; overflow: hidden; background: radial-gradient(circle at 50% 45%, #111115 0%, #09090b 75%); }
  #canvas { width: 100%; height: 100%; display: block; cursor: grab; }
  #canvas.grabbing { cursor: grabbing; }
  #tooltip {
    position: absolute; pointer-events: none; display: none; z-index: 10;
    background: rgba(17, 17, 19, 0.96); border: 1px solid var(--border-strong); border-radius: 6px;
    padding: 6px 9px; font-size: 12px; color: var(--text); max-width: 300px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.45);
  }
  #tooltip .tt-sub { color: var(--muted); font-size: 11px; margin-top: 2px; font-family: ui-monospace, monospace; }
  #shortcuts {
    position: absolute; left: 12px; bottom: 10px; font-size: 11px; color: var(--dim);
    background: rgba(9,9,11,0.75); padding: 4px 8px; border-radius: 5px; border: 1px solid var(--border);
    pointer-events: none;
  }
  #panel {
    width: 380px; background: var(--surface); border-left: 1px solid var(--border);
    padding: 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px;
  }
  #panel h2 { font-size: 14px; margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; line-height: 1.4; }
  #panel h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dim); margin: 8px 0 4px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: 0.03em; }
  .pill.SAFE { background: rgba(239,68,68,0.16); color: #fca5a5; border: 1px solid rgba(239,68,68,0.35); }
  .pill.REVIEW { background: rgba(245,158,11,0.16); color: #fcd34d; border: 1px solid rgba(245,158,11,0.35); }
  .pill.LIVE { background: rgba(34,197,94,0.14); color: #86efac; border: 1px solid rgba(34,197,94,0.3); }
  .ev-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .ev-card { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; }
  .ev-card .k { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--dim); }
  .ev-card .v { font-size: 13px; font-weight: 600; margin-top: 2px; font-family: ui-monospace, monospace; }
  .reason { font-size: 13px; color: var(--muted); line-height: 1.5; margin: 0; }
  .finding-row {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; cursor: pointer; transition: border-color 120ms;
  }
  .finding-row:hover { border-color: var(--border-strong); }
  .finding-row .fr-head { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .finding-row .fr-sym { font-family: ui-monospace, monospace; font-weight: 600; color: var(--text); }
  .finding-row .fr-reason { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .diff-wrap { position: relative; }
  .diff-wrap pre {
    background: var(--bg); border: 1px solid var(--border); padding: 10px; border-radius: 6px;
    overflow-x: auto; font-size: 11.5px; line-height: 1.5; margin: 0; color: #fca5a5;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word;
  }
  .copy-btn {
    position: absolute; top: 6px; right: 6px; font-size: 11px; padding: 3px 8px;
    background: var(--surface-2); color: var(--silver); border: 1px solid var(--border);
    border-radius: 4px; cursor: pointer;
  }
  .copy-btn:hover { border-color: var(--silver); }
  @media (max-width: 820px) {
    #workspace { flex-direction: column; }
    #panel { width: 100%; height: 42%; border-left: none; border-top: 1px solid var(--border); }
  }
</style>
</head>
<body>
<header>
  <div class="brand">
    <span class="mark"></span>
    <span>deadcode-map</span>
    <span class="path" title="${escapeHtml(data.root)}">${escapeHtml(data.root)}</span>
  </div>
  <div class="legend">
    <span class="legend-item"><span class="dot" style="background:var(--safe)"></span>SAFE</span>
    <span class="legend-item"><span class="dot" style="background:var(--review)"></span>REVIEW</span>
    <span class="legend-item"><span class="dot" style="background:var(--live)"></span>Live</span>
    <span class="legend-item"><span class="dot" style="background:#71717a"></span>Clean file</span>
  </div>
</header>
<div id="toolbar">
  <input id="search" type="text" placeholder="Search files or symbols… ( / )" autocomplete="off">
  <select id="filter">
    <option value="all">All grades</option>
    <option value="SAFE">SAFE only</option>
    <option value="REVIEW">REVIEW only</option>
    <option value="LIVE">Live only</option>
  </select>
  <button id="toggle-symbols" type="button" class="active">Symbols</button>
  <button id="fit-btn" type="button" title="Fit visible graph (F)">Fit</button>
  <button id="reheat-btn" type="button" title="Re-run layout">Relayout</button>
  <div class="spacer"></div>
  <span class="meta-counts" id="counts"></span>
</div>
<div id="workspace">
  <div id="stage">
    <canvas id="canvas"></canvas>
    <div id="tooltip"></div>
    <div id="shortcuts">Drag canvas to pan · Drag node to pin · Scroll to zoom · / search · F fit · Esc reset</div>
  </div>
  <aside id="panel">
    <h2>Select a node</h2>
    <p class="reason">Red nodes are <strong>SAFE</strong> provably dead code (0 importers, 0 callers, 0 string refs). Amber nodes need a human check. Click any file or symbol to inspect evidence, git age, coverage, and delete diff.</p>
  </aside>
</div>
<script>
(() => {
  const DATA = ${json};
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const panel = document.getElementById('panel');
  const tooltip = document.getElementById('tooltip');
  const searchEl = document.getElementById('search');
  const filterEl = document.getElementById('filter');
  const symBtn = document.getElementById('toggle-symbols');

  const COLOR = { SAFE: '#ef4444', REVIEW: '#f59e0b', LIVE: '#22c55e' };
  let W = 800, H = 600, scale = 1, ox = 0, oy = 0;
  let showSymbols = true;
  let selected = null, hovered = null;
  let draggingNode = null, panning = false, moved = false;
  let px = 0, py = 0;
  let alpha = 1.0;
  let rafId = null;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    W = Math.max(1, rect.width);
    H = Math.max(1, rect.height);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scheduleDraw();
  }
  window.addEventListener('resize', resize);

  // Deterministic spiral seed so layout is reproducible and avoids center blow-ups.
  const nodes = DATA.nodes.map((n, i) => {
    const angle = i * 2.399963229728653;
    const radius = 28 * Math.sqrt(i + 1);
    return {
      ...n,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      r: n.kind === 'file' ? Math.min(18, 9 + Math.sqrt((n.findings || []).length) * 2.2) : 5.5,
      pinned: false,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Place symbol nodes right beside their parent file before simulation begins.
  for (const n of nodes) {
    if (n.kind === 'symbol' && byId.has(n.parent)) {
      const p = byId.get(n.parent);
      const a = (n.id * 1.7) % (Math.PI * 2);
      n.x = p.x + Math.cos(a) * 26;
      n.y = p.y + Math.sin(a) * 26;
    }
  }

  const edges = DATA.edges
    .map((e) => ({ a: byId.get(e.from), b: byId.get(e.to), kind: e.kind || 'import', dynamic: Boolean(e.dynamic) }))
    .filter((e) => e.a && e.b);

  const neighborIds = new Map();
  for (const e of edges) {
    if (!neighborIds.has(e.a.id)) neighborIds.set(e.a.id, new Set());
    if (!neighborIds.has(e.b.id)) neighborIds.set(e.b.id, new Set());
    neighborIds.get(e.a.id).add(e.b.id);
    neighborIds.get(e.b.id).add(e.a.id);
  }

  // Barnes-Hut quadtree for O(N log N) repulsion on large graphs.
  class Quad {
    constructor(x, y, s) { this.x = x; this.y = y; this.s = s; this.mass = 0; this.cx = 0; this.cy = 0; this.body = null; this.children = null; }
    insert(b) {
      if (this.mass === 0 && !this.children) {
        this.body = b; this.mass = 1; this.cx = b.x; this.cy = b.y; return;
      }
      if (!this.children) {
        if (this.s < 2) { this.mass += 1; return; }
        const h = this.s / 2;
        this.children = [
          new Quad(this.x, this.y, h),
          new Quad(this.x + h, this.y, h),
          new Quad(this.x, this.y + h, h),
          new Quad(this.x + h, this.y + h, h),
        ];
        if (this.body) { this._put(this.body); this.body = null; }
      }
      this._put(b);
      this.cx = (this.cx * this.mass + b.x) / (this.mass + 1);
      this.cy = (this.cy * this.mass + b.y) / (this.mass + 1);
      this.mass += 1;
    }
    _put(b) {
      const h = this.s / 2;
      const idx = (b.x >= this.x + h ? 1 : 0) + (b.y >= this.y + h ? 2 : 0);
      this.children[idx].insert(b);
    }
    applyForce(b, theta, k) {
      if (this.mass === 0 || this.body === b) return;
      const dx = this.cx - b.x;
      const dy = this.cy - b.y;
      const d2 = dx * dx + dy * dy + 25;
      const d = Math.sqrt(d2);
      if (!this.children || (this.s / d) < theta) {
        const f = (k * this.mass) / d2;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      } else {
        for (let i = 0; i < 4; i++) this.children[i].applyForce(b, theta, k);
      }
    }
  }

  function step() {
    if (nodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    const size = Math.max(maxX - minX, maxY - minY, 200) + 40;
    const qt = new Quad(minX - 20, minY - 20, size);
    for (const n of nodes) qt.insert(n);

    const repulse = 1200 * alpha;
    for (const n of nodes) {
      if (n.pinned) continue;
      qt.applyForce(n, 0.75, repulse);
      // Gentle gravity toward origin.
      n.vx += -n.x * 0.0025 * alpha;
      n.vy += -n.y * 0.0025 * alpha;
    }

    for (const e of edges) {
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const d = Math.hypot(dx, dy) || 1;
      const target = e.kind === 'contains' ? 28 : 115;
      const stiffness = e.kind === 'contains' ? 0.08 : 0.014;
      const f = (d - target) * stiffness * alpha;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (!e.a.pinned) { e.a.vx += fx; e.a.vy += fy; }
      if (!e.b.pinned) { e.b.vx -= fx; e.b.vy -= fy; }
    }

    for (const n of nodes) {
      if (n.pinned) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= 0.82;
      n.vy *= 0.82;
      n.x += Math.max(-25, Math.min(25, n.vx));
      n.y += Math.max(-25, Math.min(25, n.vy));
    }

    alpha *= 0.986;
  }

  function isVisible(n) {
    if (!showSymbols && n.kind === 'symbol') return false;
    const q = searchEl.value.trim().toLowerCase();
    const f = filterEl.value;
    if (f !== 'all' && n.grade !== f) return false;
    if (q) {
      const hay = (n.label + ' ' + n.file).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function fitView() {
    const vis = nodes.filter(isVisible);
    const list = vis.length ? vis : nodes;
    if (!list.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of list) {
      minX = Math.min(minX, n.x - n.r);
      minY = Math.min(minY, n.y - n.r);
      maxX = Math.max(maxX, n.x + n.r);
      maxY = Math.max(maxY, n.y + n.r);
    }
    const gw = Math.max(100, maxX - minX + 120);
    const gh = Math.max(100, maxY - minY + 120);
    scale = Math.max(0.15, Math.min(2.2, Math.min(W / gw, H / gh)));
    ox = W / 2 - ((minX + maxX) / 2) * scale;
    oy = H / 2 - ((minY + maxY) / 2) * scale;
    scheduleDraw();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);

    const activeSet = selected ? (neighborIds.get(selected.id) || new Set()) : null;

    for (const e of edges) {
      if (!isVisible(e.a) || !isVisible(e.b)) continue;
      const isHighlighted = selected && (e.a === selected || e.b === selected);
      ctx.beginPath();
      if (e.kind === 'contains') {
        ctx.strokeStyle = isHighlighted ? 'rgba(228,228,231,0.55)' : 'rgba(113,113,122,0.28)';
        ctx.lineWidth = isHighlighted ? 1.3 : 0.8;
        ctx.setLineDash([2, 2]);
      } else {
        ctx.strokeStyle = isHighlighted ? 'rgba(228,228,231,0.75)' : (selected ? 'rgba(63,63,70,0.22)' : 'rgba(82,82,91,0.45)');
        ctx.lineWidth = isHighlighted ? 1.5 : 1;
        ctx.setLineDash(e.dynamic ? [4, 4] : []);
      }
      ctx.moveTo(e.a.x, e.a.y);
      ctx.lineTo(e.b.x, e.b.y);
      ctx.stroke();

      // Directional arrowhead on import edges when zoomed in enough.
      if (e.kind === 'import' && scale > 0.45) {
        const angle = Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x);
        const ax = e.b.x - Math.cos(angle) * (e.b.r + 4);
        const ay = e.b.y - Math.sin(angle) * (e.b.r + 4);
        const sz = 5;
        ctx.setLineDash([]);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - sz * Math.cos(angle - 0.45), ay - sz * Math.sin(angle - 0.45));
        ctx.lineTo(ax - sz * Math.cos(angle + 0.45), ay - sz * Math.sin(angle + 0.45));
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.setLineDash([]);

    for (const n of nodes) {
      if (!isVisible(n)) continue;
      const dimmed = selected && n !== selected && !activeSet.has(n.id);
      ctx.globalAlpha = dimmed ? 0.22 : 1;

      const fill = n.kind === 'file'
        ? (n.grade === 'LIVE' ? '#52525b' : (COLOR[n.grade] || '#71717a'))
        : (COLOR[n.grade] || '#a1a1aa');

      ctx.beginPath();
      if (n.kind === 'symbol') {
        const s = n.r;
        ctx.rect(n.x - s, n.y - s, s * 2, s * 2);
      } else {
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      }
      ctx.fillStyle = fill;
      ctx.fill();

      if (n === selected || n === hovered) {
        ctx.strokeStyle = '#fafafa';
        ctx.lineWidth = n === selected ? 2.2 : 1.4;
        ctx.stroke();
      }

      if ((n.kind === 'file' && scale > 0.52) || (n.kind === 'symbol' && scale > 1.05) || n === selected || n === hovered) {
        ctx.fillStyle = n === selected ? '#fafafa' : '#d4d4d8';
        ctx.font = (n.kind === 'file' ? '500 11px' : '400 10px') + ' ui-monospace, SFMono-Regular, Menlo, monospace';
        const txt = n.label.length > 36 ? '…' + n.label.slice(-35) : n.label;
        ctx.fillText(txt, n.x + n.r + 5, n.y + 3.5);
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function tick() {
    rafId = null;
    if (alpha > 0.012) {
      step();
      draw();
      rafId = requestAnimationFrame(tick);
    } else {
      draw();
    }
  }

  function scheduleDraw() {
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function show(n) {
    selected = n;
    scheduleDraw();
    if (!n) {
      panel.innerHTML = '<h2>Select a node</h2><p class="reason">Click any file circle or dead-symbol square to inspect evidence and its delete diff.</p>';
      return;
    }
    const ev = n.evidence || {};
    const parts = [];
    if (n.kind === 'file') {
      parts.push('<h2>' + esc(n.label) + '</h2>');
      parts.push('<div><span class="pill ' + n.grade + '">' + n.grade + '</span></div>');
      parts.push('<div class="ev-grid">'
        + '<div class="ev-card"><div class="k">SAFE</div><div class="v">' + n.safeCount + '</div></div>'
        + '<div class="ev-card"><div class="k">REVIEW</div><div class="v">' + n.reviewCount + '</div></div>'
        + '<div class="ev-card"><div class="k">Size</div><div class="v">' + n.size + ' B</div></div>'
        + '<div class="ev-card"><div class="k">Language</div><div class="v">' + esc(n.language) + '</div></div>'
        + '</div>');
      if ((n.findings || []).length) {
        parts.push('<h3>Findings (' + n.findings.length + ')</h3>');
        for (const f of n.findings) {
          parts.push('<div class="finding-row" data-sym="' + esc(f.symbol || '') + '" data-line="' + (f.startLine || 1) + '">'
            + '<div class="fr-head"><span class="pill ' + f.grade + '">' + f.grade + '</span>'
            + '<span class="fr-sym">' + esc(f.symbol || f.category) + '</span>'
            + '<span style="color:var(--dim);margin-left:auto">:' + (f.startLine || 1) + '</span></div>'
            + '<div class="fr-reason">' + esc(f.reason) + '</div></div>');
        }
      } else {
        parts.push('<p class="reason">No dead code findings in this file.</p>');
      }
    } else {
      parts.push('<h2>' + esc(n.label) + '</h2>');
      parts.push('<div><span class="pill ' + n.grade + '">' + n.grade + ' · ' + esc(n.category || '') + '</span></div>');
      parts.push('<p class="reason">' + esc(n.reason || '') + '</p>');
      parts.push('<div class="ev-grid">'
        + '<div class="ev-card"><div class="k">Importers</div><div class="v">' + (ev.importers ?? '—') + '</div></div>'
        + '<div class="ev-card"><div class="k">Callers</div><div class="v">' + (ev.callers ?? '—') + '</div></div>'
        + '<div class="ev-card"><div class="k">Last touched</div><div class="v">' + (ev.gitAgeDays != null ? ev.gitAgeDays + 'd ago' : 'no git') + '</div></div>'
        + '<div class="ev-card"><div class="k">Coverage</div><div class="v">' + (ev.coveragePct != null ? ev.coveragePct + '%' : 'n/a') + '</div></div>'
        + '</div>');
      parts.push('<p class="reason" style="font-family:ui-monospace,monospace;font-size:12px">' + esc(n.file) + ':' + (n.startLine || 1) + '</p>');
      if (ev.stringRefs && ev.stringRefs.length) {
        parts.push('<p class="reason">String refs: ' + esc(ev.stringRefs.join(', ')) + '</p>');
      }
      if (n.deleteDiff) {
        parts.push('<h3>Delete diff</h3><div class="diff-wrap"><button type="button" class="copy-btn" id="copy-diff">Copy</button><pre>' + esc(n.deleteDiff) + '</pre></div>');
      }
    }
    panel.innerHTML = parts.join('');
    const copyBtn = document.getElementById('copy-diff');
    if (copyBtn && n.deleteDiff) {
      copyBtn.addEventListener('click', () => {
        if (navigator.clipboard) navigator.clipboard.writeText(n.deleteDiff).catch(() => {});
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
      });
    }
    panel.querySelectorAll('.finding-row').forEach((row) => {
      row.addEventListener('click', () => {
        const sym = row.getAttribute('data-sym');
        const ln = Number(row.getAttribute('data-line'));
        const match = nodes.find((x) => x.kind === 'symbol' && x.file === n.file && x.label === sym && (x.startLine || 1) === ln);
        if (match) show(match);
      });
    });
  }

  function hitTest(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const mx = (clientX - r.left - ox) / scale;
    const my = (clientY - r.top - oy) / scale;
    let best = null, bd = Infinity;
    for (const n of nodes) {
      if (!isVisible(n)) continue;
      const d = Math.hypot(n.x - mx, n.y - my);
      const pad = Math.max(5, 6 / scale);
      if (d <= n.r + pad && d < bd) { bd = d; best = n; }
    }
    return best;
  }

  canvas.addEventListener('mousedown', (e) => {
    px = e.clientX; py = e.clientY; moved = false;
    const hit = hitTest(e.clientX, e.clientY);
    if (hit) {
      draggingNode = hit;
      hit.pinned = true;
    } else {
      panning = true;
    }
    canvas.classList.add('grabbing');
  });

  window.addEventListener('mouseup', () => {
    draggingNode = null;
    panning = false;
    canvas.classList.remove('grabbing');
  });

  window.addEventListener('mousemove', (e) => {
    const dx = e.clientX - px;
    const dy = e.clientY - py;
    if (draggingNode) {
      if (Math.hypot(dx, dy) > 2) moved = true;
      draggingNode.x += dx / scale;
      draggingNode.y += dy / scale;
      px = e.clientX; py = e.clientY;
      alpha = Math.max(alpha, 0.25);
      scheduleDraw();
      return;
    }
    if (panning) {
      if (Math.hypot(dx, dy) > 2) moved = true;
      ox += dx; oy += dy;
      px = e.clientX; py = e.clientY;
      scheduleDraw();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
      const hit = hitTest(e.clientX, e.clientY);
      if (hit !== hovered) {
        hovered = hit;
        scheduleDraw();
      }
      if (hit) {
        tooltip.style.display = 'block';
        tooltip.style.left = (e.clientX - rect.left + 12) + 'px';
        tooltip.style.top = (e.clientY - rect.top + 12) + 'px';
        tooltip.innerHTML = '<strong>' + esc(hit.label) + '</strong><div class="tt-sub">'
          + hit.grade + ' · ' + (hit.kind === 'file' ? ((hit.findings || []).length + ' findings') : (hit.category || 'symbol'))
          + '</div>';
      } else {
        tooltip.style.display = 'none';
      }
    }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const nextScale = Math.max(0.12, Math.min(4, scale * factor));
    ox = mx - ((mx - ox) / scale) * nextScale;
    oy = my - ((my - oy) / scale) * nextScale;
    scale = nextScale;
    scheduleDraw();
  }, { passive: false });

  canvas.addEventListener('click', (e) => {
    if (moved) return;
    const hit = hitTest(e.clientX, e.clientY);
    show(hit);
  });

  searchEl.addEventListener('input', () => scheduleDraw());
  filterEl.addEventListener('change', () => scheduleDraw());
  symBtn.addEventListener('click', () => {
    showSymbols = !showSymbols;
    symBtn.classList.toggle('active', showSymbols);
    scheduleDraw();
  });
  document.getElementById('fit-btn').addEventListener('click', fitView);
  document.getElementById('reheat-btn').addEventListener('click', () => {
    for (const n of nodes) n.pinned = false;
    alpha = 0.8;
    scheduleDraw();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== searchEl) {
      e.preventDefault();
      searchEl.focus();
    } else if (e.key === 'Escape') {
      searchEl.blur();
      show(null);
    } else if ((e.key === 'f' || e.key === 'F') && document.activeElement !== searchEl) {
      fitView();
    }
  });

  const fileCount = DATA.nodes.filter((n) => n.kind === 'file').length;
  const safeCount = DATA.nodes.filter((n) => n.kind === 'symbol' && n.grade === 'SAFE').length
    + DATA.nodes.filter((n) => n.kind === 'file' && (n.findings || []).some((f) => f.category === 'file' && f.grade === 'SAFE')).length;
  const reviewCount = DATA.nodes.filter((n) => n.kind === 'symbol' && n.grade === 'REVIEW').length;
  const importCount = DATA.edges.filter((e) => e.kind === 'import').length;
  document.getElementById('counts').textContent = fileCount + ' files · ' + importCount + ' imports · ' + safeCount + ' SAFE · ' + reviewCount + ' REVIEW';

  resize();
  // Pre-warm layout synchronously for 60 ticks so initial frame opens cleanly spread out.
  for (let i = 0; i < 60; i++) step();
  fitView();
  scheduleDraw();
})();
</script>
</body>
</html>
`;
}

function writeMap(root, graph, findings, outPath) {
  const data = buildMapData(root, graph, findings);
  const html = renderHtml(data);
  fs.writeFileSync(outPath, html, 'utf8');
  return outPath;
}

module.exports = { writeMap, buildMapData, renderHtml };
