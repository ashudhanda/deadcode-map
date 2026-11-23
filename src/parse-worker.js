'use strict';

/**
 * Worker thread entry point for parallel tree-sitter parsing.
 * Receives batches of { file, ext } tasks and returns serialized parse records.
 */

const fs = require('fs');
const path = require('path');
const { parentPort } = require('worker_threads');
const { parseJsTs } = require('./parse-js');
const { parsePy } = require('./parse-py');
const { parseJava } = require('./parse-java');
const { serializeParsed, computeContentHash } = require('./cache');

const JS_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

function parseOne(file) {
  const ext = path.extname(file).toLowerCase();
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return { file, skipped: true };
  }
  const contentHash = computeContentHash(src);
  const start = Date.now();
  let parsed = null;
  let parseError = null;
  try {
    parsed = JS_EXTS.has(ext)
      ? parseJsTs(file, src, ext)
      : ext === '.java'
        ? parseJava(file, src)
        : parsePy(file, src);
  } catch (_) {
    parsed = null;
    parseError = 'parse failed';
  }
  const elapsedMs = Date.now() - start;
  return {
    file,
    skipped: false,
    src,
    contentHash,
    elapsedMs,
    parsed: serializeParsed(parsed),
    parseError: parseError || (parsed && parsed.hasErrors ? 'parse errors' : null),
  };
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    const results = [];
    for (const file of msg.files || []) {
      results.push(parseOne(file));
    }
    parentPort.postMessage({ id: msg.id, results });
  });
}
