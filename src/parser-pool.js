'use strict';

/**
 * Parallel tree-sitter parsing coordinator backed by Node worker_threads.
 * Automatically falls back to synchronous parsing for small repos or
 * environments where worker_threads cannot spawn.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { deserializeParsed, computeContentHash } = require('./cache');

const MIN_FILES_FOR_POOL = 80;
const MAX_WORKERS = 6;

function resolveWorkerCount(fileCount, requested) {
  if (requested === 0 || requested === 1) return 1;
  if (fileCount < MIN_FILES_FOR_POOL) return 1;
  const cpus = (os.cpus() || []).length || 1;
  const auto = Math.max(1, Math.min(cpus - 1, MAX_WORKERS));
  if (typeof requested === 'number' && requested > 1) {
    return Math.min(requested, MAX_WORKERS, fileCount);
  }
  return Math.min(auto, fileCount);
}

/**
 * Parse all code files in `discovery`, hitting `cacheCtx` first when enabled
 * and fanning out remaining cache misses across worker threads.
 * Returns Map<absPath, { parsed, src, parseError }> or null to use sync path.
 */
async function parseFilesParallel(root, discovery, cacheCtx, workerCountOpt) {
  const codeFiles = discovery.codeFiles || [];
  const absRoot = path.resolve(root);
  const preparsed = new Map();
  const toParse = [];
  const hitHashes = new Map(); // abs -> { rel, hash } for cache hits, counted only if the pool engages

  // Resolve cache hits on the main thread first so workers only parse misses.
  // peekHit does NOT touch hit/miss counters: if the pool does not engage,
  // the synchronous path counts them once through its wrapped parsers.
  if (cacheCtx) {
    for (const f of codeFiles) {
      let src;
      try { src = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
      const rel = path.relative(absRoot, f);
      const hash = computeContentHash(src);
      const cached = cacheCtx.peekHit ? cacheCtx.peekHit(rel, hash) : null;
      if (cached) {
        preparsed.set(f, { parsed: cached, src, parseError: cached.hasErrors ? 'parse errors' : null });
        hitHashes.set(f, { rel, hash });
      } else {
        toParse.push(f);
      }
    }
  } else {
    toParse.push(...codeFiles);
  }

  const workerCount = resolveWorkerCount(toParse.length, workerCountOpt);
  if (workerCount <= 1) return null; // let synchronous analyze() handle small sets

  // The pool engages: count the cache hits found above exactly once.
  if (cacheCtx && cacheCtx.lookupHit) {
    for (const { rel, hash } of hitHashes.values()) cacheCtx.lookupHit(rel, hash);
  }

  let Worker;
  try {
    ({ Worker } = require('worker_threads'));
  } catch (_) {
    return null;
  }

  const workerScript = path.join(__dirname, 'parse-worker.js');
  const chunks = Array.from({ length: workerCount }, () => []);
  for (let i = 0; i < toParse.length; i++) {
    chunks[i % workerCount].push(toParse[i]);
  }

  const runChunk = (files, id) => new Promise((resolve, reject) => {
    const worker = new Worker(workerScript);
    worker.once('message', (msg) => {
      worker.terminate().catch(() => {});
      resolve(msg.results || []);
    });
    worker.once('error', (err) => {
      worker.terminate().catch(() => {});
      reject(err);
    });
    worker.postMessage({ id, files });
  });

  try {
    const batches = await Promise.all(chunks.map((files, idx) => runChunk(files, idx)));
    for (const batch of batches) {
      for (const r of batch) {
        if (r.skipped) continue;
        const parsed = deserializeParsed(r.parsed);
        preparsed.set(r.file, { parsed, src: r.src, parseError: r.parseError });
        if (cacheCtx && cacheCtx.recordMiss) {
          const rel = path.relative(absRoot, r.file);
          cacheCtx.recordMiss(rel, r.contentHash, parsed, r.elapsedMs);
        }
      }
    }
    return preparsed;
  } catch (_) {
    return null; // fail-open to synchronous parsing
  }
}

module.exports = { parseFilesParallel };
