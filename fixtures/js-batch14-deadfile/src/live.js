import { sharedFn } from './shared.js';

export function liveFn() {
  sharedFn();
  // The two string literals below are the live-file mentions for the
  // controls: 'url' is also the name of a local inside deadRootFn (it
  // must not keep dead-root.js alive — locals are not the file's
  // public name), and 'stringKept' is the stem of stringKept.js (a
  // live mention keeps that file at REVIEW, never SAFE).
  return ['url', 'stringKept'];
}

export function liveUnusedExport() {
  return 'exported, but no file in this app repo imports it';
}
