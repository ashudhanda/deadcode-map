'use strict';

/**
 * deadcode-map web workbench — controller, worker bridge, local folder loader,
 * directory heatmap, and 60 FPS cooled cluster graph.
 */

(function () {
  var MAX_FILES = 500;
  var MAX_TOTAL_BYTES = 5 * 1024 * 1024;
  var MAX_FILE_BYTES = 200 * 1024;
  var MAX_TEXT_FILES = 100;
  var MAX_TEXT_BYTES = 1024 * 1024;
  var CONCURRENCY = 10;

  var CODE_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.java'];
  var TEXT_EXTS = ['.json', '.md', '.txt', '.yaml', '.yml', '.toml', '.html', '.css', '.vue', '.xml', '.properties'];
  var SKIP_DIRS = {
    node_modules: 1, '.git': 1, dist: 1, build: 1, out: 1, '.next': 1,
    '.nuxt': 1, '.svelte-kit': 1, coverage: 1, __pycache__: 1, '.venv': 1,
    venv: 1, vendor: 1, target: 1, '.turbo': 1, '.cache': 1,
  };

  /* DOM refs */
  var repoInput = document.getElementById('repo-url');
  var tokenInput = document.getElementById('gh-token');
  var includeFixturesInput = document.getElementById('include-fixtures');
  var analyzeBtn = document.getElementById('analyze-btn');
  var pickFolderBtn = document.getElementById('pick-folder-btn');
  var localFolderInput = document.getElementById('local-folder-input');
  var progressWrap = document.getElementById('progress-wrap');
  var progressBar = document.getElementById('progress-bar');
  var statusEl = document.getElementById('status');
  var errorEl = document.getElementById('error');
  var resultsEl = document.getElementById('results');
  var findingsEl = document.getElementById('findings');
  var fileTreeEl = document.getElementById('file-tree');
  var resetFileBtn = document.getElementById('reset-file-btn');
  var activeFileBanner = document.getElementById('active-file-banner');
  var heatmapEl = document.getElementById('viz-heatmap');
  var graphStageEl = document.getElementById('viz-graph');
  var graphCanvas = document.getElementById('graph-canvas');
  var graphTooltip = document.getElementById('graph-tooltip');
  var graphFitBtn = document.getElementById('graph-fit-btn');
  var mapLegendEl = document.getElementById('map-legend');
  var filtersEl = document.getElementById('filters');
  var categoryFilterEl = document.getElementById('category-filter');
  var searchEl = document.getElementById('finding-search');
  var exportJsonBtn = document.getElementById('export-json-btn');
  var copyCliBtn = document.getElementById('copy-cli-btn');

  /* App state */
  var lastReport = null;
  var lastSource = null; // { kind: 'github'|'local', label, owner, repo, branch, subpath }
  var activeGrade = 'ALL';
  var activeCategory = 'ALL';
  var activeFile = null;
  var activeViz = 'heatmap';
  var graphCtrl = null;

  function extOf(p) {
    var i = p.lastIndexOf('.');
    return i >= 0 ? p.slice(i).toLowerCase() : '';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatBytes(n) {
    if (!n || n <= 0) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function showError(msg) {
    errorEl.hidden = false;
    errorEl.textContent = msg;
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function setProgress(pct, msg) {
    progressWrap.hidden = false;
    progressBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    statusEl.textContent = msg || '';
  }

  function clearProgress() {
    progressWrap.hidden = true;
    progressBar.style.width = '0%';
    statusEl.textContent = '';
  }

  /* ---------------- URL & Fetch helpers ---------------- */

  function parseRepoUrl(raw) {
    var url = (raw || '').trim();
    if (!url) throw new Error('Enter a GitHub repository URL or owner/repo.');
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url)) {
      url = 'https://github.com/' + url;
    }
    url = url.replace(/\.git\/?$/, '');
    var m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/tree\/([^/\s#?]+)(?:\/(.*))?)?/i);
    if (!m) throw new Error('Invalid GitHub URL. Example: https://github.com/owner/repo or owner/repo');
    return {
      owner: m[1],
      repo: m[2],
      branch: m[3] || null,
      subpath: m[4] ? m[4].replace(/\/$/, '') : '',
    };
  }

  function authHeaders(token) {
    var h = { Accept: 'application/vnd.github+json' };
    if (token) h.Authorization = 'token ' + token;
    return h;
  }

  function isRateLimit(res) {
    if (res.status === 429) return true;
    return res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0';
  }

  async function fetchJson(url, token) {
    var res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      if (isRateLimit(res)) {
        throw new Error('GitHub API rate limit reached (60 req/hr unauthenticated). Open Options and paste a token for 5,000 req/hr, or use Local Folder mode.');
      }
      if (res.status === 404) {
        throw new Error('Repository not found. GitHub mode supports public repos only — use Local Folder mode for private repos.');
      }
      throw new Error('GitHub API request failed (HTTP ' + res.status + ').');
    }
    return res.json();
  }

  async function fetchText(url, token) {
    var res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      if (isRateLimit(res)) throw new Error('GitHub rate limit reached. Add a token in Options or try Local Folder mode.');
      throw new Error('Failed to fetch file (HTTP ' + res.status + ').');
    }
    return res.text();
  }

  async function mapLimit(items, limit, fn) {
    var out = new Array(items.length);
    var next = 0;
    async function worker() {
      while (next < items.length) {
        var i = next++;
        out[i] = await fn(items[i], i);
      }
    }
    var workers = [];
    for (var w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  /* ---------------- Web Worker Bridge ---------------- */

  function runAnalyzer(files, opts) {
    if (typeof Worker !== 'undefined') {
      return new Promise(function (resolve, reject) {
        var worker;
        try {
          worker = new Worker('analyzer-worker.js');
        } catch (_) {
          window.DeadcodeMap.analyzeFilesAsync(files, opts).then(resolve, reject);
          return;
        }
        var id = Date.now();
        worker.onmessage = function (e) {
          worker.terminate();
          if (e.data && e.data.ok) resolve(e.data.report);
          else reject(new Error((e.data && e.data.error) || 'Analyzer worker failed'));
        };
        worker.onerror = function () {
          worker.terminate();
          window.DeadcodeMap.analyzeFilesAsync(files, opts).then(resolve, reject);
        };
        worker.postMessage({ id: id, files: files, opts: opts });
      });
    }
    return window.DeadcodeMap.analyzeFilesAsync(files, opts);
  }

  /* ---------------- File Aggregation ---------------- */

  function summarizeByFile(report) {
    var map = {};
    (report.findings || []).forEach(function (f) {
      if (!map[f.file]) map[f.file] = { file: f.file, safe: 0, review: 0, keep: 0, total: 0, bytes: 0 };
      var entry = map[f.file];
      entry.total += 1;
      if (f.grade === 'SAFE') {
        entry.safe += 1;
        entry.bytes += f.size || 0;
      } else if (f.grade === 'REVIEW') {
        entry.review += 1;
      } else {
        entry.keep += 1;
      }
    });
    return Object.keys(map).map(function (k) {
      var e = map[k];
      e.worst = e.safe > 0 ? 'safe' : e.review > 0 ? 'review' : 'keep';
      return e;
    }).sort(function (a, b) {
      if (b.safe !== a.safe) return b.safe - a.safe;
      if (b.review !== a.review) return b.review - a.review;
      return a.file < b.file ? -1 : 1;
    });
  }

  function selectFile(filePath) {
    activeFile = activeFile === filePath ? null : filePath;
    renderFileTree(lastReport);
    renderHeatmap(lastReport);
    renderFindings(lastReport);
    if (graphCtrl) graphCtrl.setSelected(activeFile);
  }

  /* ---------------- Directory Heatmap ---------------- */

  function renderHeatmap(report) {
    var files = summarizeByFile(report);
    var cleanCount = Math.max((report.filesScanned || 0) - files.length, 0);
    mapLegendEl.textContent = files.length + ' files with findings · ' + cleanCount + ' clean files · click a file tile to filter.';

    if (!files.length) {
      heatmapEl.innerHTML = '<div class="empty-state" style="grid-column:1/-1">Zero findings across ' + (report.filesScanned || 0) + ' scanned files.</div>';
      return;
    }

    var dirs = {};
    files.forEach(function (f) {
      var slash = f.file.lastIndexOf('/');
      var dir = slash >= 0 ? f.file.slice(0, slash) : '.';
      var base = slash >= 0 ? f.file.slice(slash + 1) : f.file;
      if (!dirs[dir]) dirs[dir] = [];
      dirs[dir].push({ info: f, base: base });
    });

    var dirNames = Object.keys(dirs).sort();
    var html = '';
    dirNames.forEach(function (dir) {
      html += '<div class="dir-block"><div class="dir-title" title="' + escapeHtml(dir) + '">' + escapeHtml(dir) + '/</div><div class="dir-tiles">';
      dirs[dir].forEach(function (item) {
        var f = item.info;
        var isActive = activeFile === f.file ? ' active' : '';
        var tip = f.file + ' — ' + f.safe + ' SAFE, ' + f.review + ' REVIEW, ' + f.keep + ' KEEP';
        html += '<button type="button" class="file-tile ' + f.worst + isActive + '" data-file="' + escapeHtml(f.file) + '" title="' + escapeHtml(tip) + '">'
          + escapeHtml(item.base) + ' (' + f.total + ')</button>';
      });
      html += '</div></div>';
    });

    heatmapEl.innerHTML = html;
    heatmapEl.querySelectorAll('.file-tile').forEach(function (btn) {
      btn.addEventListener('click', function () {
        selectFile(btn.getAttribute('data-file'));
      });
    });
  }

  /* ---------------- 60 FPS Cooled Cluster Graph ---------------- */

  function mountGraph(report) {
    if (graphCtrl && graphCtrl.destroy) graphCtrl.destroy();
    var files = summarizeByFile(report);
    var ctx = graphCanvas.getContext('2d');
    var COLOR = { safe: '#ef4444', review: '#f59e0b', keep: '#22c55e' };

    var W = 600, H = 320, scale = 1, ox = 0, oy = 0;
    var alpha = 1.0, raf = null;
    var panning = false, moved = false, px = 0, py = 0;
    var hovered = null, selectedFile = activeFile;

    var nodes = files.map(function (f, i) {
      var a = i * 2.399963229728653;
      var rad = 24 * Math.sqrt(i + 1);
      var slash = f.file.lastIndexOf('/');
      return {
        file: f.file,
        dir: slash >= 0 ? f.file.slice(0, slash) : '.',
        base: slash >= 0 ? f.file.slice(slash + 1) : f.file,
        worst: f.worst,
        safe: f.safe,
        review: f.review,
        total: f.total,
        x: Math.cos(a) * rad,
        y: Math.sin(a) * rad,
        vx: 0,
        vy: 0,
        r: Math.min(18, 7 + Math.sqrt(f.total) * 2.4),
      };
    });

    // Cluster sibling files inside the same directory softly together.
    var byDir = {};
    nodes.forEach(function (n) {
      if (!byDir[n.dir]) byDir[n.dir] = [];
      byDir[n.dir].push(n);
    });
    var edges = [];
    Object.keys(byDir).forEach(function (d) {
      var list = byDir[d];
      for (var i = 1; i < list.length; i++) {
        edges.push({ a: list[0], b: list[i] });
      }
    });

    function resize() {
      var rect = graphCanvas.getBoundingClientRect();
      W = Math.max(1, rect.width);
      H = Math.max(1, rect.height);
      var dpr = window.devicePixelRatio || 1;
      graphCanvas.width = Math.round(W * dpr);
      graphCanvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      schedule();
    }

    function step() {
      for (var i = 0; i < nodes.length; i++) {
        var a = nodes[i];
        a.vx += -a.x * 0.004 * alpha;
        a.vy += -a.y * 0.004 * alpha;
        for (var j = i + 1; j < nodes.length; j++) {
          var b = nodes[j];
          var dx = b.x - a.x;
          var dy = b.y - a.y;
          var d2 = dx * dx + dy * dy + 25;
          if (d2 < 24000) {
            var f = (650 * alpha) / d2;
            var d = Math.sqrt(d2);
            var fx = (dx / d) * f;
            var fy = (dy / d) * f;
            a.vx -= fx; a.vy -= fy;
            b.vx += fx; b.vy += fy;
          }
        }
      }
      for (var k = 0; k < edges.length; k++) {
        var e = edges[k];
        var ex = e.b.x - e.a.x;
        var ey = e.b.y - e.a.y;
        var ed = Math.hypot(ex, ey) || 1;
        var ef = (ed - 48) * 0.03 * alpha;
        e.a.vx += (ex / ed) * ef; e.a.vy += (ey / ed) * ef;
        e.b.vx -= (ex / ed) * ef; e.b.vy -= (ey / ed) * ef;
      }
      for (var m = 0; m < nodes.length; m++) {
        var n = nodes[m];
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += n.vx; n.y += n.vy;
      }
      alpha *= 0.98;
    }

    function fit() {
      if (!nodes.length) return;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      nodes.forEach(function (n) {
        minX = Math.min(minX, n.x - n.r);
        minY = Math.min(minY, n.y - n.r);
        maxX = Math.max(maxX, n.x + n.r);
        maxY = Math.max(maxY, n.y + n.r);
      });
      var gw = Math.max(120, maxX - minX + 100);
      var gh = Math.max(120, maxY - minY + 80);
      scale = Math.max(0.2, Math.min(2, Math.min(W / gw, H / gh)));
      ox = W / 2 - ((minX + maxX) / 2) * scale;
      oy = H / 2 - ((minY + maxY) / 2) * scale;
      schedule();
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);

      ctx.strokeStyle = 'rgba(63, 63, 70, 0.45)';
      ctx.lineWidth = 1;
      for (var i = 0; i < edges.length; i++) {
        ctx.beginPath();
        ctx.moveTo(edges[i].a.x, edges[i].a.y);
        ctx.lineTo(edges[i].b.x, edges[i].b.y);
        ctx.stroke();
      }

      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        var isSel = selectedFile && n.file === selectedFile;
        ctx.globalAlpha = selectedFile && !isSel ? 0.3 : 1;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = COLOR[n.worst] || '#71717a';
        ctx.fill();
        if (isSel || n === hovered) {
          ctx.strokeStyle = '#fafafa';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        if (scale > 0.65 || isSel || n === hovered) {
          ctx.fillStyle = '#e4e4e7';
          ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.fillText(n.base, n.x + n.r + 5, n.y + 3.5);
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    function tick() {
      raf = null;
      if (alpha > 0.015) {
        step();
        draw();
        raf = requestAnimationFrame(tick);
      } else {
        draw();
      }
    }

    function schedule() {
      if (!raf) raf = requestAnimationFrame(tick);
    }

    function hit(clientX, clientY) {
      var r = graphCanvas.getBoundingClientRect();
      var mx = (clientX - r.left - ox) / scale;
      var my = (clientY - r.top - oy) / scale;
      var best = null, bd = Infinity;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var d = Math.hypot(n.x - mx, n.y - my);
        if (d <= n.r + 6 / scale && d < bd) { bd = d; best = n; }
      }
      return best;
    }

    function onDown(e) {
      panning = true; moved = false; px = e.clientX; py = e.clientY;
      graphCanvas.classList.add('grabbing');
    }
    function onUp() {
      panning = false;
      graphCanvas.classList.remove('grabbing');
    }
    function onMove(e) {
      if (panning) {
        var dx = e.clientX - px, dy = e.clientY - py;
        if (Math.hypot(dx, dy) > 2) moved = true;
        ox += dx; oy += dy; px = e.clientX; py = e.clientY;
        schedule();
        return;
      }
      var r = graphCanvas.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        var h = hit(e.clientX, e.clientY);
        if (h !== hovered) { hovered = h; schedule(); }
        if (h) {
          graphTooltip.hidden = false;
          graphTooltip.style.left = (e.clientX - r.left + 12) + 'px';
          graphTooltip.style.top = (e.clientY - r.top + 12) + 'px';
          graphTooltip.textContent = h.file + ' (' + h.safe + ' SAFE, ' + h.review + ' REVIEW)';
        } else {
          graphTooltip.hidden = true;
        }
      }
    }
    function onWheel(e) {
      e.preventDefault();
      var r = graphCanvas.getBoundingClientRect();
      var mx = e.clientX - r.left, my = e.clientY - r.top;
      var factor = e.deltaY < 0 ? 1.12 : 0.89;
      var next = Math.max(0.15, Math.min(3.5, scale * factor));
      ox = mx - ((mx - ox) / scale) * next;
      oy = my - ((my - oy) / scale) * next;
      scale = next;
      schedule();
    }
    function onClick(e) {
      if (moved) return;
      var h = hit(e.clientX, e.clientY);
      if (h) selectFile(h.file);
    }

    graphCanvas.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('mousemove', onMove);
    graphCanvas.addEventListener('wheel', onWheel, { passive: false });
    graphCanvas.addEventListener('click', onClick);
    window.addEventListener('resize', resize);

    for (var t = 0; t < 50; t++) step();
    resize();
    fit();

    graphCtrl = {
      resize: function () { resize(); fit(); },
      fit: fit,
      setSelected: function (f) { selectedFile = f; schedule(); },
      destroy: function () {
        if (raf) cancelAnimationFrame(raf);
        graphCanvas.removeEventListener('mousedown', onDown);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('mousemove', onMove);
        graphCanvas.removeEventListener('wheel', onWheel);
        graphCanvas.removeEventListener('click', onClick);
        window.removeEventListener('resize', resize);
      },
    };
  }

  /* ---------------- File Tree & Findings ---------------- */

  function renderFileTree(report) {
    var files = summarizeByFile(report);
    resetFileBtn.hidden = !activeFile;
    if (!files.length) {
      fileTreeEl.innerHTML = '<div style="padding:12px;color:var(--dim);font-size:0.78rem">All scanned files clean.</div>';
      return;
    }
    var html = '';
    files.forEach(function (f) {
      var cls = activeFile === f.file ? ' active' : '';
      html += '<button type="button" class="tree-item' + cls + '" data-file="' + escapeHtml(f.file) + '" title="' + escapeHtml(f.file) + '">'
        + '<span class="tree-dot ' + f.worst + '"></span>'
        + '<span class="tree-name">' + escapeHtml(f.file) + '</span>'
        + '<span class="tree-count">' + f.total + '</span>'
        + '</button>';
    });
    fileTreeEl.innerHTML = html;
    fileTreeEl.querySelectorAll('.tree-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        selectFile(btn.getAttribute('data-file'));
      });
    });
  }

  function githubLineUrl(file, line) {
    if (!lastSource || lastSource.kind !== 'github') return null;
    var fullPath = lastSource.subpath ? lastSource.subpath + '/' + file : file;
    return 'https://github.com/' + encodeURIComponent(lastSource.owner) + '/' + encodeURIComponent(lastSource.repo)
      + '/blob/' + encodeURIComponent(lastSource.branch || 'main') + '/' + fullPath
      + (line ? '#L' + line : '');
  }

  function renderFindings(report) {
    var q = (searchEl.value || '').trim().toLowerCase();

    if (activeFile) {
      activeFileBanner.hidden = false;
      activeFileBanner.innerHTML = '<span>Filtered: <strong>' + escapeHtml(activeFile) + '</strong></span>'
        + '<button type="button" id="banner-reset" class="btn-secondary btn-xs">Show all files</button>';
      var bReset = document.getElementById('banner-reset');
      if (bReset) bReset.addEventListener('click', function () { selectFile(activeFile); });
    } else {
      activeFileBanner.hidden = true;
    }

    var list = (report.findings || []).filter(function (f) {
      if (activeGrade !== 'ALL' && f.grade !== activeGrade) return false;
      if (activeCategory !== 'ALL' && f.category !== activeCategory) return false;
      if (activeFile && f.file !== activeFile) return false;
      if (q) {
        var hay = ((f.file || '') + ' ' + (f.symbol || '') + ' ' + (f.category || '') + ' ' + (f.reason || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

    if (!list.length) {
      findingsEl.innerHTML = '<div class="empty-state">No findings match the current filter.</div>';
      return;
    }

    var byFile = {};
    list.forEach(function (f) {
      if (!byFile[f.file]) byFile[f.file] = [];
      byFile[f.file].push(f);
    });

    var fileKeys = Object.keys(byFile).sort();
    var html = '';
    var diffStore = [];

    fileKeys.forEach(function (file) {
      var items = byFile[file];
      html += '<div class="file-group"><div class="file-group-head"><span>' + escapeHtml(file)
        + '</span><span class="count">' + items.length + ' finding' + (items.length === 1 ? '' : 's') + '</span></div>';

      items.forEach(function (f) {
        var g = (f.grade || 'REVIEW').toLowerCase();
        var ev = f.evidence || {};
        var pills = [];
        if (typeof ev.importers === 'number') pills.push(ev.importers + ' importers');
        if (typeof ev.callers === 'number') pills.push(ev.callers + ' callers');
        if (ev.exported) pills.push('exported');
        if (ev.stringRefs && ev.stringRefs.length) pills.push('string refs: ' + ev.stringRefs.slice(0, 3).join(', '));
        if (f.size) pills.push(formatBytes(f.size));

        var line = f.startLine || 1;
        var ghUrl = githubLineUrl(file, line);
        var lineHtml = ghUrl
          ? '<a class="line-link" href="' + escapeHtml(ghUrl) + '" target="_blank" rel="noreferrer">L' + line + ' ↗</a>'
          : '<span class="line-link">line ' + line + '</span>';

        var diffHtml = '';
        if (f.deleteDiff) {
          var idx = diffStore.length;
          diffStore.push(f.deleteDiff);
          diffHtml = '<div class="diff-box"><button type="button" class="copy-diff-btn" data-diff-idx="' + idx + '">Copy</button><pre>'
            + escapeHtml(f.deleteDiff) + '</pre></div>';
        }

        html += '<div class="finding-card ' + g + '">'
          + '<div class="finding-top">'
          + '<span class="badge ' + g + '">' + escapeHtml(f.grade) + '</span>'
          + '<span class="cat-tag">' + escapeHtml(f.category) + '</span>'
          + (f.symbol ? '<span class="sym-name">' + escapeHtml(f.symbol) + '</span>' : '')
          + lineHtml
          + '</div>'
          + '<p class="finding-reason">' + escapeHtml(f.reason || '') + '</p>'
          + (pills.length ? '<div class="evidence-pills">' + pills.map(function (p) { return '<span class="ev-pill">' + escapeHtml(p) + '</span>'; }).join('') + '</div>' : '')
          + diffHtml
          + '</div>';
      });
      html += '</div>';
    });

    findingsEl.innerHTML = html;
    findingsEl.querySelectorAll('.copy-diff-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var text = diffStore[Number(btn.getAttribute('data-diff-idx'))] || '';
        if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {});
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = 'Copy'; }, 1200);
      });
    });
  }

  function renderResults(report, source, warnings) {
    lastReport = report;
    lastSource = source;
    activeGrade = 'ALL';
    activeCategory = 'ALL';
    activeFile = null;
    searchEl.value = '';

    filtersEl.querySelectorAll('.seg-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-grade') === 'ALL');
    });

    // Populate categories dynamically.
    var cats = {};
    (report.findings || []).forEach(function (f) { if (f.category) cats[f.category] = 1; });
    categoryFilterEl.innerHTML = '<option value="ALL">All categories</option>'
      + Object.keys(cats).sort().map(function (c) {
        return '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>';
      }).join('');

    document.getElementById('results-title').textContent = source.label;
    var meta = (report.filesScanned || 0) + ' code files scanned';
    if (warnings.length) meta += ' · ' + warnings.join(' · ');
    document.getElementById('results-meta').textContent = meta;

    var fileSummaries = summarizeByFile(report);
    var scanned = report.filesScanned || 0;
    var safeFiles = fileSummaries.filter(function (f) { return f.safe > 0; }).length;
    var reviewOnlyFiles = fileSummaries.filter(function (f) { return f.safe === 0 && f.review > 0; }).length;
    var cleanFiles = Math.max(scanned - safeFiles - reviewOnlyFiles, 0);
    var cleanPct = scanned > 0 ? Math.round((cleanFiles / scanned) * 100) : 100;

    var safeBytes = (report.findings || []).reduce(function (sum, f) {
      return sum + (f.grade === 'SAFE' ? (f.size || 0) : 0);
    }, 0);

    document.getElementById('stat-files').textContent = scanned;
    document.getElementById('stat-clean-sub').textContent = cleanPct + '% clean (' + cleanFiles + ' files)';
    document.getElementById('stat-safe').textContent = report.summary.safe;
    document.getElementById('stat-safe-bytes').textContent = formatBytes(safeBytes) + ' reclaimable';
    document.getElementById('stat-review').textContent = report.summary.review;
    document.getElementById('stat-keep').textContent = report.summary.keep;

    var denom = Math.max(scanned, 1);
    document.getElementById('bar-clean').style.width = ((cleanFiles / denom) * 100).toFixed(1) + '%';
    document.getElementById('bar-review').style.width = ((reviewOnlyFiles / denom) * 100).toFixed(1) + '%';
    document.getElementById('bar-safe').style.width = ((safeFiles / denom) * 100).toFixed(1) + '%';
    document.getElementById('health-legend').textContent =
      cleanFiles + ' clean · ' + reviewOnlyFiles + ' review-only · ' + safeFiles + ' with SAFE dead code';

    resultsEl.hidden = false;
    renderHeatmap(report);
    renderFileTree(report);
    renderFindings(report);
    mountGraph(report);
    if (activeViz === 'graph' && graphCtrl) graphCtrl.resize();
  }

  /* ---------------- GitHub Scan Flow ---------------- */

  async function analyzeGithub() {
    clearError();
    resultsEl.hidden = true;
    analyzeBtn.disabled = true;

    var repo;
    try {
      repo = parseRepoUrl(repoInput.value);
    } catch (e) {
      showError(e.message);
      analyzeBtn.disabled = false;
      return;
    }

    var token = (tokenInput.value || '').trim();
    try {
      setProgress(8, 'Fetching repository metadata…');
      var info = await fetchJson('https://api.github.com/repos/' + repo.owner + '/' + repo.repo, token);
      var branch = repo.branch || info.default_branch || 'main';

      setProgress(18, 'Reading git tree (' + branch + ')…');
      var tree = await fetchJson('https://api.github.com/repos/' + repo.owner + '/' + repo.repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1', token);
      if (tree.truncated) {
        throw new Error('This repo is too large for the browser API (truncated tree). Run locally: npx deadcode-map <path>.');
      }

      var blobs = (tree.tree || []).filter(function (t) { return t.type === 'blob'; });
      if (repo.subpath) {
        blobs = blobs.filter(function (t) { return t.path === repo.subpath || t.path.indexOf(repo.subpath + '/') === 0; });
      }

      var codeBlobs = blobs.filter(function (t) { return CODE_EXTS.indexOf(extOf(t.path)) >= 0 && t.size <= MAX_FILE_BYTES; });
      var textBlobs = blobs.filter(function (t) { return TEXT_EXTS.indexOf(extOf(t.path)) >= 0 && t.size <= MAX_FILE_BYTES; }).slice(0, MAX_TEXT_FILES);
      var warnings = [];

      if (codeBlobs.length > MAX_FILES) {
        warnings.push('capped at ' + MAX_FILES + ' of ' + codeBlobs.length + ' code files');
        codeBlobs = codeBlobs.slice(0, MAX_FILES);
      }

      // Strictly enforce the 5 MB total code cap.
      var cappedCode = [];
      var runningBytes = 0;
      for (var ci = 0; ci < codeBlobs.length; ci++) {
        var sz = codeBlobs[ci].size || 0;
        if (runningBytes + sz > MAX_TOTAL_BYTES && cappedCode.length > 0) break;
        runningBytes += sz;
        cappedCode.push(codeBlobs[ci]);
      }
      if (cappedCode.length < codeBlobs.length) {
        warnings.push('5 MB cap reached (' + cappedCode.length + '/' + codeBlobs.length + ' files)');
        codeBlobs = cappedCode;
      }

      var skippedLarge = blobs.filter(function (t) { return CODE_EXTS.indexOf(extOf(t.path)) >= 0 && t.size > MAX_FILE_BYTES; }).length;
      if (skippedLarge) warnings.push(skippedLarge + ' file(s) > 200 KB skipped');

      var rawBase = 'https://raw.githubusercontent.com/' + repo.owner + '/' + repo.repo + '/' + encodeURIComponent(branch) + '/';
      var done = 0;
      setProgress(25, 'Downloading ' + codeBlobs.length + ' code files…');
      var files = await mapLimit(codeBlobs, CONCURRENCY, async function (t) {
        var content = await fetchText(rawBase + t.path.split('/').map(encodeURIComponent).join('/'), token);
        done += 1;
        setProgress(25 + Math.round((done / Math.max(codeBlobs.length, 1)) * 45), 'Downloading code (' + done + '/' + codeBlobs.length + ')…');
        return { path: t.path, content: content };
      });

      var textBytes = 0;
      var textFiles = [];
      for (var i = 0; i < textBlobs.length; i++) {
        if (textBytes + (textBlobs[i].size || 0) > MAX_TEXT_BYTES) break;
        textBytes += textBlobs[i].size || 0;
        textFiles.push(textBlobs[i]);
      }
      if (textFiles.length) {
        setProgress(75, 'Downloading ' + textFiles.length + ' config/text files…');
        var texts = await mapLimit(textFiles, CONCURRENCY, async function (t) {
          var content = await fetchText(rawBase + t.path.split('/').map(encodeURIComponent).join('/'), token);
          return { path: t.path, content: content };
        });
        files = files.concat(texts);
      }

      if (repo.subpath) {
        files = files.map(function (f) {
          return { path: f.path.indexOf(repo.subpath + '/') === 0 ? f.path.slice(repo.subpath.length + 1) : f.path, content: f.content };
        });
      }

      setProgress(88, 'Running static analysis in Web Worker…');
      var report = await runAnalyzer(files, { includeFixtures: Boolean(includeFixturesInput && includeFixturesInput.checked) });
      if (report.javaSkipped) warnings.push('Java skipped (' + (report.javaSkipReason || 'WASM unavailable') + ')');

      setProgress(100, 'Done.');
      renderResults(report, {
        kind: 'github',
        label: repo.owner + '/' + repo.repo + (repo.subpath ? '/' + repo.subpath : ''),
        owner: repo.owner,
        repo: repo.repo,
        branch: branch,
        subpath: repo.subpath,
      }, warnings);
      setTimeout(clearProgress, 450);
    } catch (e) {
      clearProgress();
      showError(e && e.message ? e.message : String(e));
    } finally {
      analyzeBtn.disabled = false;
    }
  }

  /* ---------------- Local Folder Scan Flow ---------------- */

  async function analyzeLocalFiles(fileList) {
    clearError();
    resultsEl.hidden = true;
    var all = Array.prototype.slice.call(fileList || []);
    if (!all.length) return;

    var warnings = [];
    var rootName = (all[0].webkitRelativePath || 'local-folder').split('/')[0];

    function normalizePath(file) {
      var rel = file.webkitRelativePath || file.name;
      var slash = rel.indexOf('/');
      return slash >= 0 ? rel.slice(slash + 1) : rel;
    }

    function isSkipped(rel) {
      var parts = rel.split('/');
      for (var i = 0; i < parts.length - 1; i++) {
        if (SKIP_DIRS[parts[i]]) return true;
      }
      return false;
    }

    var codeEntries = [];
    var textEntries = [];
    var skippedLarge = 0;

    for (var i = 0; i < all.length; i++) {
      var f = all[i];
      var rel = normalizePath(f);
      if (!rel || isSkipped(rel)) continue;
      var ext = extOf(rel);
      if (CODE_EXTS.indexOf(ext) >= 0) {
        if (f.size > MAX_FILE_BYTES) { skippedLarge += 1; continue; }
        codeEntries.push({ file: f, path: rel });
      } else if (TEXT_EXTS.indexOf(ext) >= 0 && f.size <= MAX_FILE_BYTES) {
        textEntries.push({ file: f, path: rel });
      }
    }

    if (!codeEntries.length) {
      showError('No supported JS/TS, Python, or Java files found in that folder.');
      return;
    }

    if (codeEntries.length > MAX_FILES) {
      warnings.push('capped at ' + MAX_FILES + ' of ' + codeEntries.length + ' code files');
      codeEntries = codeEntries.slice(0, MAX_FILES);
    }

    var cappedCode = [];
    var totalBytes = 0;
    for (var j = 0; j < codeEntries.length; j++) {
      if (totalBytes + codeEntries[j].file.size > MAX_TOTAL_BYTES && cappedCode.length > 0) break;
      totalBytes += codeEntries[j].file.size;
      cappedCode.push(codeEntries[j]);
    }
    if (cappedCode.length < codeEntries.length) {
      warnings.push('5 MB cap reached (' + cappedCode.length + '/' + codeEntries.length + ' files)');
      codeEntries = cappedCode;
    }
    if (skippedLarge) warnings.push(skippedLarge + ' file(s) > 200 KB skipped');

    var cappedTexts = [];
    var textBytes = 0;
    for (var k = 0; k < Math.min(textEntries.length, MAX_TEXT_FILES); k++) {
      if (textBytes + textEntries[k].file.size > MAX_TEXT_BYTES) break;
      textBytes += textEntries[k].file.size;
      cappedTexts.push(textEntries[k]);
    }

    try {
      setProgress(20, 'Reading ' + codeEntries.length + ' local code files…');
      var payload = [];
      for (var c = 0; c < codeEntries.length; c++) {
        payload.push({ path: codeEntries[c].path, content: await codeEntries[c].file.text() });
        if (c % 20 === 0) setProgress(20 + Math.round((c / codeEntries.length) * 50), 'Reading local files (' + c + '/' + codeEntries.length + ')…');
      }
      for (var t = 0; t < cappedTexts.length; t++) {
        payload.push({ path: cappedTexts[t].path, content: await cappedTexts[t].file.text() });
      }

      setProgress(82, 'Running static analysis in Web Worker…');
      var report = await runAnalyzer(payload, { includeFixtures: Boolean(includeFixturesInput && includeFixturesInput.checked) });
      if (report.javaSkipped) warnings.push('Java skipped (' + (report.javaSkipReason || 'WASM unavailable') + ')');

      setProgress(100, 'Done.');
      renderResults(report, { kind: 'local', label: rootName + ' (local)' }, warnings);
      setTimeout(clearProgress, 450);
    } catch (e) {
      clearProgress();
      showError(e && e.message ? e.message : String(e));
    }
  }

  /* ---------------- UI Wiring ---------------- */

  // Engine info drawer
  var infoBtn = document.getElementById('engine-info-btn');
  var infoDrawer = document.getElementById('engine-drawer');
  var infoClose = document.getElementById('engine-drawer-close');
  infoBtn.addEventListener('click', function () {
    var open = infoDrawer.hidden;
    infoDrawer.hidden = !open;
    infoBtn.setAttribute('aria-expanded', String(open));
  });
  infoClose.addEventListener('click', function () {
    infoDrawer.hidden = true;
    infoBtn.setAttribute('aria-expanded', 'false');
  });

  // Options toggle
  var optionsToggle = document.getElementById('options-toggle');
  var optionsPanel = document.getElementById('options-panel');
  optionsToggle.addEventListener('click', function () {
    var open = optionsPanel.hidden;
    optionsPanel.hidden = !open;
    optionsToggle.setAttribute('aria-expanded', String(open));
  });

  // Mode tabs (GitHub vs Local)
  var tokenRow = document.getElementById('token-row');
  document.querySelectorAll('.mode-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var mode = tab.getAttribute('data-mode');
      document.querySelectorAll('.mode-tab').forEach(function (t) {
        var isActive = t === tab;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', String(isActive));
      });
      document.getElementById('mode-github').hidden = mode !== 'github';
      document.getElementById('mode-local').hidden = mode !== 'local';
      tokenRow.hidden = mode !== 'github';
      clearError();
    });
  });

  // Presets
  document.querySelectorAll('.preset-chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      repoInput.value = chip.getAttribute('data-repo');
      analyzeGithub();
    });
  });

  analyzeBtn.addEventListener('click', analyzeGithub);
  repoInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') analyzeGithub();
  });

  pickFolderBtn.addEventListener('click', function () {
    localFolderInput.value = '';
    localFolderInput.click();
  });
  localFolderInput.addEventListener('change', function () {
    if (localFolderInput.files && localFolderInput.files.length) {
      analyzeLocalFiles(localFolderInput.files);
    }
  });

  // Visualization switcher
  document.getElementById('viz-tabs').addEventListener('click', function (e) {
    var btn = e.target.closest('.seg-btn[data-viz]');
    if (!btn) return;
    activeViz = btn.getAttribute('data-viz');
    document.querySelectorAll('#viz-tabs .seg-btn').forEach(function (b) {
      b.classList.toggle('active', b === btn);
    });
    heatmapEl.hidden = activeViz !== 'heatmap';
    graphStageEl.hidden = activeViz !== 'graph';
    graphFitBtn.hidden = activeViz !== 'graph';
    if (activeViz === 'graph' && graphCtrl) graphCtrl.resize();
  });
  graphFitBtn.addEventListener('click', function () {
    if (graphCtrl) graphCtrl.fit();
  });

  // Grade, category, search, file reset
  filtersEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.seg-btn[data-grade]');
    if (!btn || !lastReport) return;
    activeGrade = btn.getAttribute('data-grade');
    filtersEl.querySelectorAll('.seg-btn').forEach(function (b) {
      b.classList.toggle('active', b === btn);
    });
    renderFindings(lastReport);
  });

  categoryFilterEl.addEventListener('change', function () {
    activeCategory = categoryFilterEl.value;
    if (lastReport) renderFindings(lastReport);
  });

  searchEl.addEventListener('input', function () {
    if (lastReport) renderFindings(lastReport);
  });

  resetFileBtn.addEventListener('click', function () {
    if (activeFile) selectFile(activeFile);
  });

  window.addEventListener('keydown', function (e) {
    if (e.key === '/' && lastReport && document.activeElement !== searchEl && document.activeElement !== repoInput && document.activeElement !== tokenInput) {
      e.preventDefault();
      searchEl.focus();
    } else if (e.key === 'Escape' && document.activeElement === searchEl) {
      searchEl.value = '';
      searchEl.blur();
      if (lastReport) renderFindings(lastReport);
    }
  });

  // Export JSON & Copy CLI
  exportJsonBtn.addEventListener('click', function () {
    if (!lastReport) return;
    var blob = new Blob([JSON.stringify(lastReport, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'deadcode-map-report.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  copyCliBtn.addEventListener('click', function () {
    var cmd = 'npx deadcode-map . --map deadcode-map.html';
    if (navigator.clipboard) navigator.clipboard.writeText(cmd).catch(function () {});
    copyCliBtn.textContent = 'Copied!';
    setTimeout(function () { copyCliBtn.textContent = 'Copy CLI command'; }, 1200);
  });
})();
