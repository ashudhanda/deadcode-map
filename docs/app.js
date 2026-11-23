'use strict';

/**
 * deadcode-map web checker — UI wiring.
 *
 * Flow: parse the repo URL -> GitHub API tree (recursive) -> download code
 * and text files from raw.githubusercontent.com -> analyze in the browser
 * with docs/analyzer.js -> render summary, map, and per-file findings.
 *
 * Limits (stated in the UI): public repos only, at most 500 files and
 * 5 MB of code, files over 200 KB are skipped. Unauthenticated GitHub API
 * calls are limited to 60/hour; an optional token raises that to 5,000/hour.
 * The token is kept only in memory for this one check and is never stored.
 */

(function () {
  var MAX_FILES = 500;
  var MAX_TOTAL_BYTES = 5 * 1024 * 1024;
  var MAX_FILE_BYTES = 200 * 1024;
  var MAX_TEXT_FILES = 100;
  var MAX_TEXT_BYTES = 1024 * 1024;
  var CODE_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.java'];
  var TEXT_EXTS = ['.json', '.md', '.txt', '.yaml', '.yml', '.toml', '.html', '.css', '.vue', '.xml', '.properties'];
  var CONCURRENCY = 10;

  var repoInput = document.getElementById('repo-url');
  var tokenInput = document.getElementById('gh-token');
  var includeFixturesInput = document.getElementById('include-fixtures');
  var analyzeBtn = document.getElementById('analyze-btn');
  var tryBtn = document.getElementById('try-btn');
  var statusEl = document.getElementById('status');
  var errorEl = document.getElementById('error');
  var resultsEl = document.getElementById('results');
  var findingsEl = document.getElementById('findings');
  var mapEl = document.getElementById('map');
  var mapLegendEl = document.getElementById('map-legend');
  var filtersEl = document.getElementById('filters');

  var lastReport = null;
  var activeGrade = 'ALL';
  var activeFile = null;

  function extOf(p) {
    var i = p.lastIndexOf('.');
    return i >= 0 ? p.slice(i).toLowerCase() : '';
  }

  function showError(msg) {
    errorEl.hidden = false;
    errorEl.textContent = msg;
  }
  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }
  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  function parseRepoUrl(raw) {
    var url = (raw || '').trim();
    if (!url) throw new Error('Paste a GitHub repo URL first.');
    url = url.replace(/\.git\/?$/, '');
    var m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/tree\/([^/\s#?]+)(?:\/(.*))?)?/i);
    if (!m) throw new Error('That does not look like a GitHub repo URL. Use https://github.com/owner/repo');
    var branch = m[3] || null;
    var subpath = m[4] ? m[4].replace(/\/$/, '') : '';
    return { owner: m[1], repo: m[2], branch: branch, subpath: subpath };
  }

  function authHeaders(token) {
    var h = { Accept: 'application/vnd.github+json' };
    if (token) h.Authorization = 'token ' + token;
    return h;
  }

  function isRateLimit(res) {
    if (res.status === 403 || res.status === 429) return true;
    var remaining = res.headers.get('x-ratelimit-remaining');
    return res.status === 403 && remaining === '0';
  }

  async function fetchJson(url, token) {
    var res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      if (isRateLimit(res)) {
        throw new Error('GitHub API rate limit reached (60 requests/hour without a token). Wait an hour, or paste a GitHub personal access token above — it is never stored, it only raises your limit to 5,000/hour.');
      }
      if (res.status === 404) throw new Error('Repo not found. Check the owner/repo name — and note this checker only works on public repos.');
      throw new Error('GitHub API request failed (HTTP ' + res.status + ').');
    }
    return res.json();
  }

  async function fetchText(url, token) {
    var res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      if (isRateLimit(res)) {
        throw new Error('GitHub API rate limit reached (60 requests/hour without a token). Wait an hour, or paste a GitHub personal access token above.');
      }
      throw new Error('Could not download a file (HTTP ' + res.status + ').');
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

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------------- rendering ---------------- */

  function gradeClass(g) { return g.toLowerCase(); }

  function renderMap(report) {
    var byFile = {};
    report.findings.forEach(function (f) {
      if (!byFile[f.file]) byFile[f.file] = { safe: 0, review: 0, keep: 0 };
      byFile[f.file][gradeClass(f.grade)]++;
    });
    var files = Object.keys(byFile).sort();
    var cleanCount = Math.max(report.filesScanned - files.length, 0);
    var cols = 12;
    var cell = 26;
    var rows = Math.ceil(files.length / cols) || 1;
    var width = cols * cell;
    var height = rows * cell;
    var svg = '<svg width="' + width + '" height="' + height + '" role="img" aria-label="File map: red files have SAFE dead code, amber have REVIEW findings, green are clean or kept">';
    files.forEach(function (file, i) {
      var x = (i % cols) * cell + cell / 2;
      var y = Math.floor(i / cols) * cell + cell / 2;
      var worst = byFile[file].safe > 0 ? '#f87171' : byFile[file].review > 0 ? '#fbbf24' : '#34d399';
      svg += '<g class="map-node" data-file="' + escapeHtml(file) + '"><circle cx="' + x + '" cy="' + y + '" r="8" fill="' + worst + '" opacity="0.9"><title>' + escapeHtml(file) + ' — ' + byFile[file].safe + ' SAFE, ' + byFile[file].review + ' REVIEW, ' + byFile[file].keep + ' KEEP</title></circle></g>';
    });
    svg += '</svg>';
    mapEl.innerHTML = svg;
    mapLegendEl.textContent = files.length + ' files with findings · ' + cleanCount + ' files clean or kept · click a dot to see that file.';
    mapEl.querySelectorAll('.map-node').forEach(function (node) {
      node.addEventListener('click', function () {
        activeFile = node.getAttribute('data-file');
        renderFindings(report);
        document.getElementById('findings').scrollIntoView({ behavior: 'smooth' });
      });
    });
  }

  function renderFindings(report) {
    var list = report.findings.filter(function (f) {
      if (activeGrade !== 'ALL' && f.grade !== activeGrade) return false;
      if (activeFile && f.file !== activeFile) return false;
      return true;
    });
    var byFile = {};
    list.forEach(function (f) {
      if (!byFile[f.file]) byFile[f.file] = [];
      byFile[f.file].push(f);
    });
    var files = Object.keys(byFile).sort();
    var filterBanner = activeFile
      ? '<div class="row" style="margin:0 0 12px"><span class="status">Filtered to <strong>'
        + escapeHtml(activeFile)
        + '</strong></span><button type="button" id="clear-file-filter" class="secondary" style="padding:4px 10px;font-size:0.8rem">Show all files</button></div>'
      : '';
    function bindClearFilter() {
      var clearBtn = document.getElementById('clear-file-filter');
      if (clearBtn) {
        clearBtn.addEventListener('click', function () {
          activeFile = null;
          renderFindings(report);
        });
      }
    }
    if (files.length === 0) {
      findingsEl.innerHTML = filterBanner + '<p class="status">No findings match this filter' + (activeFile ? ' for ' + escapeHtml(activeFile) : '') + '.</p>';
      bindClearFilter();
      return;
    }
    var html = '';
    files.forEach(function (file) {
      var items = byFile[file];
      html += '<div class="file-group"><h3>' + escapeHtml(file) + ' <span class="count">(' + items.length + ' finding' + (items.length === 1 ? '' : 's') + ')</span></h3>';
      items.forEach(function (f) {
        var ev = f.evidence || {};
        var evBits = [];
        if (typeof ev.importers === 'number') evBits.push(ev.importers + ' importers');
        if (typeof ev.callers === 'number') evBits.push(ev.callers + ' callers');
        if (ev.stringRefs && ev.stringRefs.length) evBits.push('string refs: ' + ev.stringRefs.join(', '));
        if (ev.exported) evBits.push('exported');
        html += '<div class="finding ' + gradeClass(f.grade) + '"><div class="head">'
          + '<span class="badge ' + gradeClass(f.grade) + '">' + escapeHtml(f.grade) + '</span>'
          + '<span class="cat">' + escapeHtml(f.category) + '</span>'
          + (f.symbol ? '<span class="sym">' + escapeHtml(f.symbol) + '</span>' : '')
          + '<span class="cat">line ' + (f.startLine || 1) + '</span>'
          + '</div>'
          + '<p class="reason">' + escapeHtml(f.reason || '') + '</p>'
          + (evBits.length ? '<p class="evidence">' + escapeHtml(evBits.join(' · ')) + '</p>' : '')
          + (f.deleteDiff ? '<pre class="diff">' + escapeHtml(f.deleteDiff) + '</pre>' : '')
          + '</div>';
      });
      html += '</div>';
    });
    findingsEl.innerHTML = filterBanner + html;
    bindClearFilter();
  }

  function renderResults(report, repo, warnings) {
    lastReport = report;
    activeGrade = 'ALL';
    activeFile = null;
    filtersEl.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-grade') === 'ALL');
    });
    document.getElementById('results-title').textContent = 'Results — ' + repo.owner + '/' + repo.repo;
    var meta = report.filesScanned + ' code files scanned';
    if (warnings.length) meta += ' · ' + warnings.join(' · ');
    document.getElementById('results-meta').textContent = meta;
    document.getElementById('stat-total').textContent = report.summary.total;
    document.getElementById('stat-safe').textContent = report.summary.safe;
    document.getElementById('stat-review').textContent = report.summary.review;
    document.getElementById('stat-keep').textContent = report.summary.keep;
    resultsEl.hidden = false;
    renderMap(report);
    renderFindings(report);
  }

  /* ---------------- analysis ---------------- */

  // Run the analyzer in a Web Worker so a 500-file repo does not freeze
  // the tab; any worker failure (load error, or the worker reporting a
  // failure) falls back to the main thread, which handles the same
  // input identically.
  function runAnalyzer(files, opts) {
    if (typeof Worker !== 'undefined') {
      return new Promise(function (resolve, reject) {
        var worker = new Worker('analyzer-worker.js');
        var id = Date.now();
        var fallback = function () {
          worker.terminate();
          window.DeadcodeMap.analyzeFilesAsync(files, opts).then(resolve, reject);
        };
        worker.onmessage = function (e) {
          if (e.data && e.data.ok) {
            worker.terminate();
            resolve(e.data.report);
          } else {
            fallback();
          }
        };
        worker.onerror = fallback;
        worker.postMessage({ id: id, files: files, opts: opts });
      });
    }
    return window.DeadcodeMap.analyzeFilesAsync(files, opts);
  }

  async function analyze() {
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
      setStatus('Reading repo info…');
      var info = await fetchJson('https://api.github.com/repos/' + repo.owner + '/' + repo.repo, token);
      var branch = repo.branch || info.default_branch || 'main';
      setStatus('Reading file tree (' + branch + ')…');
      var tree = await fetchJson('https://api.github.com/repos/' + repo.owner + '/' + repo.repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1', token);
      if (tree.truncated) throw new Error('This repo is too large to map in the browser (GitHub truncated the file tree). Use the CLI instead: npx deadcode-map <path>.');
      var blobs = (tree.tree || []).filter(function (t) { return t.type === 'blob'; });
      if (repo.subpath) {
        blobs = blobs.filter(function (t) { return t.path === repo.subpath || t.path.indexOf(repo.subpath + '/') === 0; });
      }
      var codeBlobs = blobs.filter(function (t) { return CODE_EXTS.indexOf(extOf(t.path)) >= 0 && t.size <= MAX_FILE_BYTES; });
      var textBlobs = blobs.filter(function (t) { return TEXT_EXTS.indexOf(extOf(t.path)) >= 0 && t.size <= MAX_FILE_BYTES; }).slice(0, MAX_TEXT_FILES);
      var warnings = [];
      if (codeBlobs.length > MAX_FILES) {
        warnings.push('only the first ' + MAX_FILES + ' of ' + codeBlobs.length + ' code files were checked');
        codeBlobs = codeBlobs.slice(0, MAX_FILES);
      }
      var totalBytes = codeBlobs.reduce(function (sum, t) { return sum + (t.size || 0); }, 0);
      if (totalBytes > MAX_TOTAL_BYTES) {
        var cappedCodeBlobs = [];
        var runningBytes = 0;
        for (var ci = 0; ci < codeBlobs.length; ci++) {
          var sz = codeBlobs[ci].size || 0;
          if (runningBytes + sz > MAX_TOTAL_BYTES && cappedCodeBlobs.length > 0) break;
          runningBytes += sz;
          cappedCodeBlobs.push(codeBlobs[ci]);
        }
        if (cappedCodeBlobs.length < codeBlobs.length) {
          warnings.push('repo exceeded the 5 MB code cap — analyzed first ' + cappedCodeBlobs.length + ' of ' + codeBlobs.length + ' files');
          codeBlobs = cappedCodeBlobs;
        }
      }
      var skippedLarge = blobs.filter(function (t) { return CODE_EXTS.indexOf(extOf(t.path)) >= 0 && t.size > MAX_FILE_BYTES; }).length;
      if (skippedLarge) warnings.push(skippedLarge + ' file(s) over 200 KB skipped');

      setStatus('Downloading ' + codeBlobs.length + ' code files…');
      var rawBase = 'https://raw.githubusercontent.com/' + repo.owner + '/' + repo.repo + '/' + encodeURIComponent(branch) + '/';
      var files = await mapLimit(codeBlobs, CONCURRENCY, async function (t) {
        var content = await fetchText(rawBase + t.path.split('/').map(encodeURIComponent).join('/'), token);
        return { path: t.path, content: content };
      });
      // Text files only feed the string-reference pass (config naming a
      // handler, a README mentioning a symbol). Cap their total size.
      var textBytes = 0;
      var textFiles = [];
      for (var i = 0; i < textBlobs.length; i++) {
        if (textBytes + (textBlobs[i].size || 0) > MAX_TEXT_BYTES) break;
        textBytes += textBlobs[i].size || 0;
        textFiles.push(textBlobs[i]);
      }
      if (textFiles.length) {
        setStatus('Downloading ' + textFiles.length + ' text files for reference checks…');
        var texts = await mapLimit(textFiles, CONCURRENCY, async function (t) {
          var content = await fetchText(rawBase + t.path.split('/').map(encodeURIComponent).join('/'), token);
          return { path: t.path, content: content };
        });
        files = files.concat(texts);
      }
      // Prefix subpath scans so entry-point detection still works.
      if (repo.subpath) {
        files = files.map(function (f) {
          return { path: f.path.indexOf(repo.subpath + '/') === 0 ? f.path.slice(repo.subpath.length + 1) : f.path, content: f.content };
        });
      }

      setStatus('Analyzing…');
      var report = await runAnalyzer(files, { includeFixtures: includeFixturesInput && includeFixturesInput.checked });
      if (report.javaSkipped) warnings.push('Java files were skipped (' + (report.javaSkipReason || 'parser unavailable') + ') — use the CLI for Java');
      setStatus('');
      renderResults(report, repo, warnings);
      setStatus('Done.');
    } catch (e) {
      showError(e && e.message ? e.message : String(e));
      setStatus('');
    } finally {
      analyzeBtn.disabled = false;
    }
  }

  analyzeBtn.addEventListener('click', analyze);
  repoInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') analyze();
  });
  tryBtn.addEventListener('click', function () {
    repoInput.value = 'https://github.com/ashudhanda/deadcode-map';
    analyze();
  });
  filtersEl.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-grade]');
    if (!btn || !lastReport) return;
    activeGrade = btn.getAttribute('data-grade');
    filtersEl.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('active', b === btn);
    });
    renderFindings(lastReport);
  });
})();
