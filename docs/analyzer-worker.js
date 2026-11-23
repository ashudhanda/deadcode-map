'use strict';

/* global importScripts, self */
importScripts('vendor/tree-sitter.js', 'parse-java-web.js', 'analyzer.js');

self.onmessage = async function (event) {
  var msg = event.data || {};
  try {
    var report = await self.DeadcodeMap.analyzeFilesAsync(msg.files || [], msg.opts || {});
    self.postMessage({ id: msg.id, ok: true, report: report });
  } catch (err) {
    self.postMessage({
      id: msg.id,
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
};
